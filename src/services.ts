// Funções de alto nível usadas pela API e pelas tarefas agendadas.
//
// Contas de marketplace ficam em `marketplace_accounts` (uma loja pode ter várias, inclusive duas contas do mesmo
// marketplace). Os tokens são gravados criptografados com AES-256-GCM (RN04).
import { MarketAgent } from "./agent";
import { llmForOrg } from "./ai";
import type { MarketplaceConnector } from "./connectors/base";
import { getConnector } from "./connectors";
import { DuplicateKeyError, type Doc, type Store, type Where } from "./db";
import type { Settings } from "./env";
import { nowIso } from "./lib/time";
import { decrypt, encrypt } from "./security";

export class AccountError extends Error {}
export class NotFoundError extends Error {}

/** Liga uma conta de marketplace a uma loja (UC01). Reconectar a mesma conta só renova os tokens. */
export async function connectAccount(db: Store, cfg: Settings, orgId: string, sellerId: string, marketplace: string,
  externalId: string, nickname: string, accessToken?: string | null, refreshToken?: string | null, expiresIn?: number | null): Promise<Doc> {
  externalId = String(externalId);
  const existing = await db.marketplace_accounts.findOne({ marketplace, external_id: externalId });
  if (existing && existing.org_id !== orgId) throw new AccountError("Esta conta de marketplace já está conectada a outra empresa.");
  const doc: Record<string, any> = { ...(existing || {}), org_id: orgId, seller_id: sellerId, marketplace, external_id: externalId,
    nickname, status: "ACTIVE", updated_at: nowIso() };
  delete doc.revoked_at;
  if (accessToken) doc.access_token = await encrypt(cfg.encryptionKey, accessToken);
  if (refreshToken) doc.refresh_token = await encrypt(cfg.encryptionKey, refreshToken);
  if (expiresIn) doc.token_expires_at = new Date(Date.now() + expiresIn * 1000).toISOString();
  try {
    if (existing) return await db.marketplace_accounts.replace(doc as Doc);
    return await db.marketplace_accounts.insert({ ...doc, connected_at: nowIso() });
  } catch (e) {
    if (e instanceof DuplicateKeyError) throw new AccountError("Esta conta de marketplace já está conectada.");
    throw e;
  }
}

/** Revoga a integração (RF01): apaga os tokens e marca a conta como REVOKED. O histórico continua. */
export async function disconnectAccount(db: Store, accountId: string): Promise<void> {
  await db.marketplace_accounts.update(accountId, { status: "REVOKED", revoked_at: nowIso(), access_token: undefined, refresh_token: undefined });
}

export async function connectorForAccount(db: Store, cfg: Settings, account: Doc): Promise<MarketplaceConnector> {
  if (account.status !== "ACTIVE") throw new AccountError(`A conta ${account.nickname} está desconectada.`);
  if (account.marketplace === "DEMO") return getConnector("DEMO", { accountKey: account.external_id });
  const saveTokens = async (data: Record<string, any>) => {
    await db.marketplace_accounts.update(account._id, {
      access_token: await encrypt(cfg.encryptionKey, data.access_token),
      refresh_token: await encrypt(cfg.encryptionKey, data.refresh_token || ""),
      token_expires_at: new Date(Date.now() + (data.expires_in || 21600) * 1000).toISOString(),
    });
  };
  return getConnector(account.marketplace, {
    cfg, accessToken: await decrypt(cfg.encryptionKey, account.access_token),
    refreshToken: account.refresh_token ? await decrypt(cfg.encryptionKey, account.refresh_token) : null,
    userId: account.external_id, onTokenRefresh: saveTokens,
  });
}

export function activeAccounts(db: Store, where: Where = {}): Promise<Doc[]> {
  return db.marketplace_accounts.find({ ...where, status: "ACTIVE" }, { order: "connected_at" });
}

/** Roda o agente para um produto, usando a conta do anúncio escolhido (ou a primeira conta ativa do produto). */
export async function runAnalysis(db: Store, cfg: Settings, productId: string, accountId?: string | null,
  shippingModes?: string[] | null): Promise<Record<string, any>> {
  const product = await db.products.get(productId);
  if (!product) throw new NotFoundError("Produto não encontrado");
  let accountIds: string[] = (product.listings || []).map((l: any) => l.account_id).filter(Boolean);
  if (accountId) accountIds = [accountId];
  const accounts = (await db.marketplace_accounts.find({ _id: { in: [...new Set(accountIds)] }, status: "ACTIVE" }))
    .sort((a, b) => accountIds.indexOf(a._id) - accountIds.indexOf(b._id));
  if (!accounts.length) throw new AccountError("Nenhuma conta ativa ligada a este produto.");
  const account = accounts[0];
  const org = (await db.organizations.get(product.org_id)) || {};
  const own = await db.raw.prepare("SELECT external_id FROM marketplace_accounts WHERE org_id = ?").bind(product.org_id)
    .all<{ external_id: string }>();
  const agent = new MarketAgent(db, cfg, await connectorForAccount(db, cfg, account), {
    ownSellerIds: new Set(own.results.map((r) => r.external_id)), account, llm: await llmForOrg(cfg, org as any),
    minMarginPct: (org as any).settings?.min_margin_pct,
  });
  return agent.analyzeProduct(product, shippingModes);
}
