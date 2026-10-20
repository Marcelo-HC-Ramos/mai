// Sincronização de anúncios, estoque, pedidos e perguntas de uma conta de marketplace (UC01 passo 6).
//
// Uma loja pode ter várias contas. Anúncios de contas diferentes com o mesmo SKU viram um único produto com várias
// entradas em `listings`, cada uma marcada com `account_id`. As gravações vão em lote (uma consulta para muitos
// registros), para caber nos limites do plano grátis da Cloudflare.
import { llmForOrg, type Llm } from "./ai";
import { suggestAnswerAi } from "./ai/tasks";
import type { MarketplaceConnector } from "./connectors/base";
import type { Doc, Store } from "./db";
import type { Settings } from "./env";
import { round, sum } from "./lib/num";
import { DAY, nowIso } from "./lib/time";
import { suggestAnswer, topicOf } from "./questions";
import { connectorForAccount } from "./services";

const CHUNK = 150;

async function upsertChunks(db: Store, name: "products" | "orders" | "customer_questions", docs: Record<string, any>[], conflict: string[]) {
  for (let i = 0; i < docs.length; i += CHUNK) await db[name].bulkUpsert(docs.slice(i, i + CHUNK), conflict);
}

export async function syncListings(db: Store, account: Doc, conn: MarketplaceConnector): Promise<number> {
  const existing = new Map((await db.products.find({ seller_id: account.seller_id })).map((p) => [p.internal_sku, p]));
  const docs = new Map<string, Record<string, any>>();
  let n = 0;
  for (const l of await conn.getSellerListings()) {
    const listing = { account_id: account._id, marketplace: account.marketplace, account_nickname: account.nickname ?? null,
      external_item_id: l.external_item_id, url: l.url, current_price: l.price, stock_quantity: l.stock_quantity, status: l.status,
      category_id: l.category_id, sold_quantity: l.sold_quantity, shipping_mode: l.shipping_mode, listing_type: l.listing_type };
    const current = docs.get(l.sku) || existing.get(l.sku);
    if (current) {
      const others = (current.listings || []).filter((x: any) => !(x.account_id === account._id && x.external_item_id === l.external_item_id));
      docs.set(l.sku, { ...current, listings: [...others, listing], category_id: current.category_id || l.category_id });
    } else {
      docs.set(l.sku, { seller_id: account.seller_id, internal_sku: l.sku, org_id: account.org_id, ean: l.ean || null, title: l.title,
        category_id: l.category_id, cost_price: null, min_selling_price: null, listings: [listing], created_at: nowIso() });
    }
    n++;
  }
  await upsertChunks(db, "products", [...docs.values()], ["seller_id", "internal_sku"]);
  await db.marketplace_accounts.update(account._id, { last_sync_at: nowIso() });
  return n;
}

async function itemIndex(db: Store, account: Doc): Promise<Map<string, Doc>> {
  const index = new Map<string, Doc>();
  for (const p of await db.products.find({ seller_id: account.seller_id })) {
    for (const l of p.listings || []) if (l.account_id === account._id) index.set(l.external_item_id, p);
  }
  return index;
}

export async function syncOrders(db: Store, account: Doc, conn: MarketplaceConnector, days = 90, index?: Map<string, Doc>): Promise<number> {
  index = index || await itemIndex(db, account);
  const docs: Record<string, any>[] = [];
  for (const o of await conn.getOrders(new Date(Date.now() - days * DAY))) {
    const items = o.items.map((it) => {
      const p = index!.get(it.external_item_id);
      return { ...it, product_id: p?._id ?? null, unit_cost: p?.cost_price ?? null };
    });
    const doc: Record<string, any> = { org_id: account.org_id, seller_id: account.seller_id, account_id: account._id,
      marketplace: account.marketplace, external_order_id: o.external_order_id, created_at: o.created_at, status: o.status,
      total_amount: o.total_amount, marketplace_fee: o.marketplace_fee, shipping_cost: o.shipping_cost,
      net_amount: round(o.total_amount - o.marketplace_fee - o.shipping_cost, 2), units: sum(items.map((i) => i.quantity)), items };
    if (o.buyer_device) doc.buyer_device = o.buyer_device;
    docs.push(doc);
  }
  await upsertChunks(db, "orders", docs, ["account_id", "external_order_id"]);
  return docs.length;
}

/** Importa perguntas. Pendentes novas recebem resposta sugerida pela IA (até `maxAi` por rodada) ou por modelo. */
export async function syncQuestions(db: Store, account: Doc, conn: MarketplaceConnector, llm?: Llm | null, maxAi = 5,
  index?: Map<string, Doc>): Promise<number> {
  index = index || await itemIndex(db, account);
  const { results } = await db.raw.prepare("SELECT external_question_id AS q, status FROM customer_questions WHERE account_id = ?")
    .bind(account._id).all<{ q: string; status: string }>();
  const known = new Map(results.map((r) => [r.q, r.status]));
  const docs: Record<string, any>[] = [];
  let aiUsed = 0;
  for (const q of await conn.getQuestions()) {
    const product = index.get(q.external_item_id);
    // uma resposta dada pelo MAI não volta a "pendente" se o marketplace ainda não refletiu
    const status = known.get(q.external_question_id) === "ANSWERED" ? "ANSWERED" : q.status;
    const doc: Record<string, any> = { org_id: account.org_id, seller_id: account.seller_id, account_id: account._id,
      product_id: product?._id ?? null, marketplace: account.marketplace, external_question_id: q.external_question_id,
      external_item_id: q.external_item_id, buyer_nickname: q.buyer_nickname, question_text: q.text, topic: topicOf(q.text),
      received_at: q.received_at, status };
    if (status === q.status) Object.assign(doc, { answer_text: q.answer_text, answered_at: q.answered_at });
    if (!known.has(q.external_question_id)) {
      let suggestion: string | null = null;
      if (llm && q.status === "UNANSWERED" && aiUsed < maxAi) {
        aiUsed++;
        try { suggestion = await suggestAnswerAi(llm, q.text, product); } catch { suggestion = null; }
      }
      doc.suggested_ai_answer = suggestion || suggestAnswer(q.text, product);
      doc.suggestion_method = suggestion ? "ia" : "modelo";
    }
    docs.push(doc);
  }
  await upsertChunks(db, "customer_questions", docs, ["account_id", "external_question_id"]);
  return docs.length;
}

export async function fullSync(db: Store, account: Doc, conn: MarketplaceConnector, llm?: Llm | null) {
  const listings = await syncListings(db, account, conn);
  const index = await itemIndex(db, account);
  return { account: account.nickname ?? null, listings, orders: await syncOrders(db, account, conn, 90, index),
    questions: await syncQuestions(db, account, conn, llm, 5, index) };
}

/** Sincroniza uma conta pelo id, resolvendo conector e IA da empresa. */
export async function syncAccount(db: Store, cfg: Settings, accountId: string, recentOnly = false): Promise<Record<string, any>> {
  const account = await db.marketplace_accounts.get(accountId);
  if (!account) throw new Error("Conta não encontrada");
  const conn = await connectorForAccount(db, cfg, account);
  const llm = await llmForOrg(cfg, await db.organizations.get(account.org_id));
  if (recentOnly) {
    const index = await itemIndex(db, account);
    const out = { orders: await syncOrders(db, account, conn, 2, index), questions: await syncQuestions(db, account, conn, llm, 5, index) };
    await db.marketplace_accounts.update(account._id, { last_sync_at: nowIso() });
    return out;
  }
  return fullSync(db, account, conn, llm);
}
