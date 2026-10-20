// Serviços da análise de anúncios (UC15), pesquisa de mercado (UC16) e monitoramento (UC17).
//
// As consultas ao marketplace usam uma conta conectada da empresa (dados públicos de anúncios). As fotos de
// monitoramento (`ad_snapshots`) são dados públicos e ficam compartilhadas por anúncio; a lista de anúncios
// monitorados (`ad_tracking`) é de cada empresa.
import { analyzeAd, estimateSales, marketOverview, parseItemId, type HistoryPoint } from "./analysis/ads";
import { filterByModes, logisticsInsights } from "./analysis/logistics";
import type { ItemDetails, MarketplaceConnector } from "./connectors/base";
import type { Doc, Store } from "./db";
import type { Settings } from "./env";
import { mostCommon } from "./lib/num";
import { DAY, nowIso } from "./lib/time";
import { AccountError, activeAccounts, connectorForAccount } from "./services";

export async function connectorForOrg(db: Store, cfg: Settings, orgId: string, accountId?: string | null): Promise<[MarketplaceConnector, Doc]> {
  const accounts = await activeAccounts(db, { org_id: orgId, ...(accountId ? { _id: accountId } : {}) });
  if (!accounts.length) throw new AccountError("Conecte uma conta de marketplace para pesquisar anúncios.");
  return [await connectorForAccount(db, cfg, accounts[0]), accounts[0]];
}

async function safe<T>(fn: () => Promise<T>, dflt: T): Promise<T> {
  try { return await fn(); } catch (e) { console.warn("fonte indisponível:", String(e)); return dflt; }
}

export async function history(db: Store, itemId: string, days = 90): Promise<HistoryPoint[]> {
  const since = new Date(Date.now() - days * DAY).toISOString();
  return (await db.ad_snapshots.find({ item_id: itemId, captured_at: { gte: since } }, { order: "captured_at" }))
    .map(({ _id, ...rest }) => rest as HistoryPoint);
}

/** Histórico de vários anúncios numa consulta só. */
async function histories(db: Store, itemIds: string[], days = 90): Promise<Map<string, HistoryPoint[]>> {
  const out = new Map<string, HistoryPoint[]>(itemIds.map((id) => [id, []]));
  if (!itemIds.length) return out;
  const since = new Date(Date.now() - days * DAY).toISOString();
  for (const row of await db.ad_snapshots.find({ item_id: { in: itemIds }, captured_at: { gte: since } }, { order: "captured_at" })) {
    out.get(row.item_id)?.push(row as unknown as HistoryPoint);
  }
  return out;
}

function snapshotDoc(d: ItemDetails) {
  return { item_id: d.item_id, captured_at: nowIso(), price: d.price, sold_quantity: d.sold_quantity,
    available_quantity: d.available_quantity, visits_30d: d.visits_30d, shipping_mode: d.shipping_mode };
}

export async function takeSnapshot(db: Store, conn: MarketplaceConnector, itemId: string): Promise<ItemDetails> {
  const d = await conn.getItemDetails(itemId);
  await db.ad_snapshots.insert(snapshotDoc(d));
  return d;
}

export async function analyzeAdForOrg(db: Store, cfg: Settings, orgId: string, item: string, accountId?: string | null) {
  const [conn, account] = await connectorForOrg(db, cfg, orgId, accountId);
  const d = await conn.getItemDetails(parseItemId(item));
  const competitors = (await safe(() => conn.searchCompetitors(d.title, 50), [])).filter((c) => c.item_id !== d.item_id);
  const category = d.category_id || mostCommon(competitors.map((c) => c.category_id)) || null;
  const trends = await safe(() => conn.getSearchTrends(category), [] as string[]);
  // o termo mais buscado da categoria descreve o produto melhor que as primeiras palavras do título
  const seed = trends.length ? trends[0] : d.title.split(/\s+/).slice(0, 3).join(" ");
  const [suggestions, hist, tracked] = await Promise.all([
    safe(() => conn.getSearchSuggestions(seed), [] as string[]),
    history(db, d.item_id),
    db.ad_tracking.findOne({ org_id: orgId, item_id: d.item_id, active: true }),
  ]);
  const result: Record<string, any> = analyzeAd(d, competitors, trends, suggestions, hist);
  result.logistics = logisticsInsights(competitors, d.shipping_mode);
  result.tracked = !!tracked;
  result.analyzed_at = nowIso();
  result.account_nickname = account.nickname ?? null;
  await db.ad_analyses.insert({ org_id: orgId, item_id: d.item_id, title: d.title, analyzed_at: result.analyzed_at, result });
  return result;
}

export async function marketResearch(db: Store, cfg: Settings, orgId: string, query: string, accountId?: string | null,
  modes?: string[] | null, enrichTop?: number) {
  const [conn] = await connectorForOrg(db, cfg, orgId, accountId);
  const listings = filterByModes(await conn.searchCompetitors(query, 50), modes);
  const top = [...listings].sort((a, b) => b.sold_quantity * b.price - a.sold_quantity * a.price).slice(0, enrichTop ?? conn.detailBudget);
  // vendas por mês exigem a data de criação: busca os dados só dos principais (vários por requisição)
  const [details, hist] = await Promise.all([
    safe(() => conn.getItemsBasic(top.map((l) => l.item_id)), [] as ItemDetails[]),
    histories(db, top.map((l) => l.item_id)),
  ]);
  const enriched: Record<string, Record<string, any>> = {};
  for (const d of details) enriched[d.item_id] = estimateSales(d, hist.get(d.item_id));
  const out = marketOverview(query, listings, enriched);
  out.logistics = logisticsInsights(listings);
  out.filter_modes = modes || [];
  return out;
}

export async function track(db: Store, cfg: Settings, orgId: string, item: string, accountId?: string | null) {
  const [conn] = await connectorForOrg(db, cfg, orgId, accountId);
  const d = await takeSnapshot(db, conn, parseItemId(item));
  const existing = await db.ad_tracking.findOne({ org_id: orgId, item_id: d.item_id });
  const fields = { title: d.title, url: d.url, active: true, seller: d.seller_nickname };
  if (existing) await db.ad_tracking.replace({ ...existing, ...fields });
  else await db.ad_tracking.insert({ org_id: orgId, item_id: d.item_id, ...fields, added_at: nowIso() });
  return { item_id: d.item_id, title: d.title };
}

export async function untrack(db: Store, orgId: string, itemId: string): Promise<void> {
  const t = await db.ad_tracking.findOne({ org_id: orgId, item_id: itemId });
  if (t) await db.ad_tracking.update(t._id, { active: false });
}

export async function trackedList(db: Store, orgId: string) {
  const now = Date.now();
  const tracked = await db.ad_tracking.find({ org_id: orgId, active: true }, { order: "added_at DESC" });
  const hist = await histories(db, tracked.map((t) => t.item_id), 30);
  return tracked.map((t) => {
    const h: any[] = hist.get(t.item_id) || [];
    const last = h.length ? h[h.length - 1] : {};
    const salesSince = (days: number) => {
      const cut = now - days * DAY;
      const w = h.filter((p) => new Date(p.captured_at).getTime() >= cut);
      return w.length < 2 ? null : Math.max(0, w[w.length - 1].sold_quantity - w[0].sold_quantity);
    };
    const s7 = salesSince(7), s30 = salesSince(30);
    return {
      item_id: t.item_id, title: t.title ?? null, url: t.url ?? null, seller: t.seller ?? null,
      price: last.price ?? null, price_change_30d: h.length ? Math.round((last.price - h[0].price) * 100) / 100 : null,
      sold_total: last.sold_quantity ?? null, shipping_mode: last.shipping_mode ?? null,
      sales_7d: s7, sales_30d: s30,
      revenue_30d: s30 !== null && last.price ? Math.round(s30 * last.price * 100) / 100 : null,
      snapshots: h.length, last_capture: last.captured_at ?? null,
    };
  });
}

/** Anúncios monitorados que ainda não têm foto desde `since` (um por anúncio, com uma empresa que o monitora). */
export async function dueTrackedItems(db: Store, since: string, limit: number): Promise<{ item_id: string; org_id: string }[]> {
  const { results } = await db.raw.prepare(`SELECT t.item_id, min(t.org_id) AS org_id FROM ad_tracking t
    WHERE t.active = 1 AND NOT EXISTS (SELECT 1 FROM ad_snapshots s WHERE s.item_id = t.item_id AND s.captured_at >= ?)
    GROUP BY t.item_id LIMIT ?`).bind(since, limit).all<{ item_id: string; org_id: string }>();
  return results;
}

/** Tarefa diária: fotografa um lote de anúncios monitorados de uma empresa (vários por requisição quando possível). */
export async function snapshotItems(db: Store, cfg: Settings, orgId: string, itemIds: string[]): Promise<number> {
  const [conn] = await connectorForOrg(db, cfg, orgId);
  const details = await conn.getItemsBasic(itemIds);
  if (details.length) await db.ad_snapshots.bulkUpsert(details.map(snapshotDoc), ["id"]);
  return details.length;
}
