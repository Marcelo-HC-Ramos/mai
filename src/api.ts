// API REST e interface web, multiempresa.
//
// Toda rota /api (exceto cadastro e login) exige `Authorization: Bearer <token>` e só enxerga dados da empresa do
// usuário. Links abertos em nova aba (relatório HTML/XLSX) aceitam o token em `?token=`.
import * as ads from "./ad_service";
import { latestSnapshot } from "./agent";
import { MODES } from "./analysis/logistics";
import * as auth from "./auth";
import { API as ML_API, authorizationUrl, exchangeCode } from "./connectors/mercadolivre";
import { CostCalculator, DEFAULT_PROFILE, type CostInputs } from "./costs";
import * as dash from "./dashboard";
import { newId, type Doc } from "./db";
import { HttpError, json, readJson, Router, validate, type Ctx, type Schema } from "./http";
import { DAY, nowIso } from "./lib/time";
import { renderHtml } from "./report/html";
import { renderXlsx } from "./report/xlsx";
import { encrypt } from "./security";
import { AccountError, activeAccounts, connectAccount, connectorForAccount, disconnectAccount, NotFoundError, runAnalysis } from "./services";
import { syncAccount } from "./sync";
import { callInternal, dispatchInternal } from "./internal";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DIMS = /^\d+x\d+x\d+$/;

export const router = new Router();

// -- Autenticação e escopo por empresa ------------------------------------------------------------------
async function currentUser(c: Ctx): Promise<Doc> {
  const header = c.req.headers.get("authorization") || "";
  const raw = c.url.searchParams.get("token") || (header.toLowerCase().startsWith("bearer ") ? header.slice(7) : null);
  if (!raw) throw new HttpError(401, "Faça login");
  let payload;
  try { payload = await auth.readToken(c.cfg, raw); } catch (e) {
    if (e instanceof auth.AuthError) throw new HttpError(401, e.message);
    throw e;
  }
  const user = await c.db.users.findOne({ _id: payload.uid, active: true });
  if (!user) throw new HttpError(401, "Usuário inativo");
  return user;
}

async function manager(c: Ctx): Promise<Doc> {
  const user = await currentUser(c);
  if (!["owner", "admin"].includes(user.role)) throw new HttpError(403, "Apenas donos e administradores podem fazer isso");
  return user;
}

type Coll = "users" | "sellers" | "marketplace_accounts" | "products" | "customer_questions";

/** Busca um documento garantindo que pertence à empresa do usuário (404 se não pertencer). */
async function owned(c: Ctx, coll: Coll, id: string | null | undefined, user: Doc): Promise<Doc> {
  const doc = id ? await c.db[coll].get(id) : null;
  if (!doc || doc.org_id !== user.org_id) throw new HttpError(404, "Não encontrado");
  return doc;
}

const publicUser = (u: Doc) => ({ _id: u._id, name: u.name ?? null, email: u.email ?? null, role: u.role ?? null,
  active: u.active ?? null, created_at: u.created_at ?? null });

function modes(value: string | null): string[] | null {
  const picked = (value || "").split(",").map((m) => m.trim()).filter((m) => MODES.includes(m));
  return picked.length ? picked : null;
}

const conflict = (e: unknown): never => {
  if (e instanceof AccountError || e instanceof NotFoundError) throw new HttpError(409, e.message);
  throw e;
};

router.on("GET", "/healthz", async (c) => {
  await c.db.raw.prepare("SELECT 1").first();
  return { ok: true };
});

router.on("POST", "/api/auth/register", async (c) => {
  const b = validate(await readJson(c.req), { org_name: { type: "str", required: true, minLen: 2, label: "Nome da empresa" },
    name: { type: "str", required: true, minLen: 2, label: "Seu nome" }, email: { type: "str", required: true, pattern: EMAIL, label: "E-mail" },
    password: { type: "str", required: true, label: "Senha" }, document: { type: "str" } });
  let org: Doc, user: Doc;
  try { [org, user] = await auth.registerOrganization(c.db, c.cfg, b.org_name, b.name, b.email, b.password, b.document); } catch (e) {
    if (e instanceof auth.AuthError) throw new HttpError(400, e.message);
    throw e;
  }
  await c.db.sellers.insert({ org_id: org._id, name: b.org_name, created_at: nowIso() });
  return { token: await auth.issueToken(c.cfg, user as any) };
});

router.on("POST", "/api/auth/login", async (c) => {
  const b = validate(await readJson(c.req), { email: { type: "str", required: true }, password: { type: "str", required: true } });
  try { return { token: await auth.issueToken(c.cfg, (await auth.authenticate(c.db, b.email, b.password)) as any) }; } catch (e) {
    if (e instanceof auth.AuthError) throw new HttpError(401, e.message);
    throw e;
  }
});

router.on("GET", "/api/me", async (c) => {
  const user = await currentUser(c);
  const org = await c.db.organizations.get(user.org_id);
  return { user: publicUser(user), organization: { _id: org?._id, name: org?.name } };
});

// -- Usuários e configurações da empresa -----------------------------------------------------------------
router.on("GET", "/api/users", async (c) => {
  const user = await manager(c);
  return (await c.db.users.find({ org_id: user.org_id })).map(publicUser).sort((a, b) => String(a.name).localeCompare(String(b.name)));
});

router.on("POST", "/api/users", async (c) => {
  const user = await manager(c);
  const b = validate(await readJson(c.req), { name: { type: "str", required: true, label: "Nome" },
    email: { type: "str", required: true, pattern: EMAIL, label: "E-mail" }, password: { type: "str", required: true, label: "Senha" },
    role: { type: "str" } });
  const role = b.role || "analyst";
  if (role === "owner" && user.role !== "owner") throw new HttpError(403, "Só o dono pode criar outro dono");
  try { return publicUser(await auth.createUser(c.db, c.cfg, user.org_id, b.name, b.email, b.password, role)); } catch (e) {
    if (e instanceof auth.AuthError) throw new HttpError(400, e.message);
    throw e;
  }
});

router.on("PATCH", "/api/users/:id", async (c) => {
  const user = await manager(c);
  const target = await owned(c, "users", c.params.id, user);
  const changes = validate(await readJson(c.req), { role: { type: "str" }, active: { type: "bool" } });
  if (target._id === user._id) throw new HttpError(400, "Você não pode alterar o próprio acesso");
  if ((target.role === "owner" || changes.role === "owner") && user.role !== "owner") throw new HttpError(403, "Só o dono pode alterar outro dono");
  if (changes.role && !(auth.ROLES as readonly string[]).includes(changes.role)) throw new HttpError(400, "Papel inválido");
  await c.db.users.update(target._id, changes);
  return { updated: Object.keys(changes) };
});

function settingsView(c: Ctx, org: Doc | null) {
  const cfg: Record<string, any> = { ...(org?.settings || {}) };
  cfg.has_own_gemini_key = !!cfg.gemini_api_key;
  delete cfg.gemini_api_key;
  if (cfg.min_margin_pct === undefined || cfg.min_margin_pct === null) cfg.min_margin_pct = c.cfg.minMarginPct;
  cfg.ai_available = cfg.ai_enabled !== false && (cfg.has_own_gemini_key || !!c.cfg.geminiApiKey);
  return cfg;
}

router.on("GET", "/api/org/settings", async (c) => {
  const user = await currentUser(c);
  return settingsView(c, await c.db.organizations.get(user.org_id));
});

router.on("PATCH", "/api/org/settings", async (c) => {
  const user = await manager(c);
  const b = validate(await readJson(c.req), { min_margin_pct: { type: "num", min: 0, max: 90, label: "Margem mínima" },
    gemini_api_key: { type: "str" }, gemini_model: { type: "str" }, ai_enabled: { type: "bool" } });
  const changes: Record<string, any> = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === "gemini_api_key") changes["settings.gemini_api_key"] = v.trim() ? await encrypt(c.cfg.encryptionKey, v.trim()) : undefined;
    else changes[`settings.${k}`] = v;
  }
  const org = Object.keys(changes).length ? await c.db.organizations.update(user.org_id, changes) : await c.db.organizations.get(user.org_id);
  return settingsView(c, org);
});

// -- Lojas e contas de marketplace (UC01) ----------------------------------------------------------------
const accountView = (a: Doc) => ({ _id: a._id, marketplace: a.marketplace, nickname: a.nickname ?? null, external_id: a.external_id,
  status: a.status, connected_at: a.connected_at ?? null, last_sync_at: a.last_sync_at ?? null });

router.on("GET", "/api/sellers", async (c) => {
  const user = await currentUser(c);
  const [sellers, accounts] = await Promise.all([
    c.db.sellers.find({ org_id: user.org_id }, { order: "name" }),
    c.db.marketplace_accounts.find({ org_id: user.org_id }, { order: "connected_at" }),
  ]);
  return sellers.map((s) => ({ _id: s._id, name: s.name, accounts: accounts.filter((a) => a.seller_id === s._id).map(accountView) }));
});

router.on("POST", "/api/sellers", async (c) => {
  const user = await manager(c);
  const b = validate(await readJson(c.req), { name: { type: "str", required: true, minLen: 2, label: "Nome da loja" }, document: { type: "str" } });
  return c.db.sellers.insert({ org_id: user.org_id, name: b.name, document: b.document ?? null, created_at: nowIso() });
});

router.on("POST", "/api/sellers/:id/accounts/demo", async (c) => {
  const user = await manager(c);
  const seller = await owned(c, "sellers", c.params.id, user);
  const b = validate(await readJson(c.req), { nickname: { type: "str" } });
  const n = (await c.db.marketplace_accounts.count({ org_id: user.org_id, marketplace: "DEMO" })) + 1;
  const account = await connectAccount(c.db, c.cfg, user.org_id, seller._id, "DEMO", `DEMO-${user.org_id}-${n}`,
    b.nickname || "Conta de demonstração");
  return { account, sync: await callInternal(c, "/internal/sync", { account_id: account._id }) };
});

router.on("POST", "/api/sellers/:id/accounts/mercadolivre/connect", async (c) => {
  const user = await manager(c);
  const seller = await owned(c, "sellers", c.params.id, user);
  if (!c.cfg.mlClientId) throw new HttpError(409, "O aplicativo do Mercado Livre ainda não foi configurado (rode npm run configurar).");
  const state = newId() + newId();
  await c.db.oauth_states.insert({ state, org_id: user.org_id, seller_id: seller._id, user_id: user._id, created_at: nowIso() });
  return { url: authorizationUrl(c.cfg, state) };
});

router.on("DELETE", "/api/accounts/:id", async (c) => {
  const user = await manager(c);
  const acc = await owned(c, "marketplace_accounts", c.params.id, user);
  await disconnectAccount(c.db, acc._id);
  return { status: "REVOKED" };
});

router.on("POST", "/api/accounts/:id/sync", async (c) => {
  const user = await currentUser(c);
  const acc = await owned(c, "marketplace_accounts", c.params.id, user);
  if (acc.status !== "ACTIVE") throw new HttpError(409, `A conta ${acc.nickname} está desconectada.`);
  return callInternal(c, "/internal/sync", { account_id: acc._id });
});

router.on("POST", "/api/sellers/:id/sync", async (c) => {
  const user = await currentUser(c);
  const seller = await owned(c, "sellers", c.params.id, user);
  const accounts = await activeAccounts(c.db, { seller_id: seller._id });
  // cada conta sincroniza na sua própria execução (limites do plano grátis valem por execução)
  return Promise.all(accounts.map((a) => callInternal(c, "/internal/sync", { account_id: a._id })));
});

router.on("GET", "/auth/mercadolivre/callback", async (c) => {
  const q = c.url.searchParams;
  const code = q.get("code"), state = q.get("state");
  const st = state ? await c.db.oauth_states.findOne({ state }) : null;
  if (st) await c.db.oauth_states.deleteWhere({ state });
  const fresh = st && Date.now() - new Date(st.created_at).getTime() < DAY;
  if (q.get("error") || !code || !st || !fresh) return Response.redirect(new URL("/?integracao=cancelada", c.url).toString(), 302);
  const tokens = await exchangeCode(c.cfg, code);
  let nickname = String(tokens.user_id);
  try {
    const resp = await fetch(`${ML_API}/users/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    nickname = ((await resp.json()) as any)?.nickname || nickname;
  } catch { /* fica o id */ }
  let account: Doc;
  try {
    account = await connectAccount(c.db, c.cfg, st.org_id, st.seller_id, "MERCADO_LIVRE", String(tokens.user_id), nickname,
      tokens.access_token, tokens.refresh_token, tokens.expires_in);
  } catch (e) {
    if (e instanceof AccountError) return Response.redirect(new URL("/?integracao=conta-em-uso", c.url).toString(), 302);
    throw e;
  }
  dispatchInternal(c, "/internal/sync", { account_id: account._id });
  return Response.redirect(new URL("/?integracao=ok", c.url).toString(), 302);
});

/** Notificações do Mercado Livre (orders_v2, questions, items). Responde 200 rápido e processa depois. */
router.on("POST", "/webhooks/mercadolivre", async (c) => {
  const payload = await readJson(c.req).catch(() => ({}));
  const account = await c.db.marketplace_accounts.findOne({ marketplace: "MERCADO_LIVRE", status: "ACTIVE", external_id: String(payload.user_id) });
  if (account) dispatchInternal(c, "/internal/sync", { account_id: account._id, recent_only: true });
  return { ok: true };
});

// -- Produtos, agente e relatório (UC02, UC03) -----------------------------------------------------------
router.on("GET", "/api/sellers/:id/products", async (c) => {
  const user = await currentUser(c);
  const seller = await owned(c, "sellers", c.params.id, user);
  const [products, latest] = await Promise.all([
    c.db.products.find({ seller_id: seller._id, org_id: user.org_id }, { order: "title" }),
    c.db.raw.prepare(`SELECT product_id, max(captured_at) AS last, recommended_price FROM market_snapshots WHERE seller_id = ?
      GROUP BY product_id`).bind(seller._id).all<{ product_id: string; last: string; recommended_price: number | null }>(),
  ]);
  const snaps = new Map(latest.results.map((r) => [r.product_id, r]));
  return products.map((p) => ({ ...p, last_analysis: snaps.get(p._id)?.last ?? null, recommended_price: snaps.get(p._id)?.recommended_price ?? null }));
});

const PRODUCT_FIELDS: Schema = {
  cost_price: { type: "num", min: 0, label: "Custo" }, min_selling_price: { type: "num", min: 0, label: "Preço mínimo" },
  ean: { type: "str" }, warranty: { type: "str" }, keyword_volumes: { type: "dict" }, traffic_devices: { type: "dict" },
  weight_g: { type: "int", min: 0, label: "Peso" }, dimensions_cm: { type: "str", pattern: DIMS, label: "Dimensões" },
  packaging_cost: { type: "num", min: 0, label: "Embalagem" },
};

router.on("PATCH", "/api/products/:id", async (c) => {
  const user = await currentUser(c);
  const product = await owned(c, "products", c.params.id, user);
  const changes = validate(await readJson(c.req), PRODUCT_FIELDS);
  if (!Object.keys(changes).length) throw new HttpError(400, "Nada para atualizar");
  await c.db.products.update(product._id, changes);
  return { updated: Object.keys(changes) };
});

/** `modes` (ex.: "full" ou "full,flex") limita os concorrentes comparados à modalidade de envio. */
router.on("POST", "/api/products/:id/analyze", async (c) => {
  const user = await currentUser(c);
  const product = await owned(c, "products", c.params.id, user);
  const accountId = c.url.searchParams.get("account_id");
  const acc = accountId ? (await owned(c, "marketplace_accounts", accountId, user))._id : null;
  const snap = await runAnalysis(c.db, c.cfg, product._id, acc, modes(c.url.searchParams.get("modes"))).catch(conflict);
  return { snapshot_id: snap._id, captured_at: snap.captured_at, recommended_price: snap.pricing.recommended_price ?? null,
    ai_summary: snap.ai_summary ?? null, recommendations: snap.ai_recommendations };
});

async function snapshotAndProduct(c: Ctx): Promise<[Doc, Doc]> {
  const user = await currentUser(c);
  const product = await owned(c, "products", c.params.id, user);
  const snap = await latestSnapshot(c.db, product._id);
  if (!snap) throw new HttpError(404, "Ainda não há análise para este produto. Execute a análise primeiro.");
  return [snap, product];
}

router.on("GET", "/api/products/:id/report", async (c) => (await snapshotAndProduct(c))[0]);

router.on("GET", "/api/products/:id/report.html", async (c) => {
  const [snap, product] = await snapshotAndProduct(c);
  return new Response(renderHtml(snap, product), { headers: { "content-type": "text/html; charset=utf-8" } });
});

router.on("GET", "/api/products/:id/report.xlsx", async (c) => {
  const [snap, product] = await snapshotAndProduct(c);
  const name = `relatorio-mercado-${String(product.internal_sku || product._id).replace(/[^\w.-]/g, "_")}.xlsx`;
  return new Response(renderXlsx(snap, product), { headers: {
    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${name}"` } });
});

router.on("GET", "/api/products/:id/history", async (c) => {
  const user = await currentUser(c);
  const product = await owned(c, "products", c.params.id, user);
  const days = Number(c.url.searchParams.get("days") || 90);
  if (!Number.isFinite(days)) throw new HttpError(422, "days precisa ser um número");
  const since = new Date(Date.now() - days * DAY).toISOString();
  const rows = await c.db.market_snapshots.find({ product_id: product._id, captured_at: { gte: since } }, { order: "captured_at" });
  return rows.map((r) => ({ captured_at: r.captured_at, account: r.account_nickname ?? null, median: r.competitor_data?.median_price ?? null,
    lowest: r.competitor_data?.lowest_price ?? null, recommended: r.pricing?.recommended_price ?? null, current: r.pricing?.current_price ?? null }));
});

// -- Painéis (UC04, UC05, UC11) ---------------------------------------------------------------------------
router.on("GET", "/api/sellers/:id/dashboard", async (c) => {
  const user = await currentUser(c);
  const seller = await owned(c, "sellers", c.params.id, user);
  const period = c.url.searchParams.get("period") || "30d";
  if (!(period in dash.PERIODS)) throw new HttpError(422, `Período inválido: ${period}. Use ${Object.keys(dash.PERIODS).join(", ")}`);
  const accountId = c.url.searchParams.get("account_id");
  const acc = accountId ? (await owned(c, "marketplace_accounts", accountId, user))._id : null;
  const now = new Date();
  const [sales, questions, stock] = await Promise.all([
    dash.salesSummary(c.db, seller._id, period, now, acc),
    dash.questionsSummary(c.db, seller._id, now, 20, acc),
    dash.stockSummary(c.db, seller._id, c.cfg.stockAlertDays, now, acc),
  ]);
  return { sales, questions, stock };
});

router.on("POST", "/api/questions/:id/answer", async (c) => {
  const user = await currentUser(c);
  const q = await owned(c, "customer_questions", c.params.id, user);
  const b = validate(await readJson(c.req), { text: { type: "str", required: true, minLen: 1, maxLen: 2000, label: "Resposta" } });
  if (q.status === "ANSWERED") throw new HttpError(409, "Pergunta já respondida");
  try {
    const account = await c.db.marketplace_accounts.get(q.account_id);
    if (!account) throw new Error("conta não encontrada");
    await (await connectorForAccount(c.db, c.cfg, account)).answerQuestion(q.external_question_id, b.text);
  } catch (e: any) { // UC05 exceção 4e
    throw new HttpError(502, `O marketplace recusou a resposta: ${e?.message || e}`);
  }
  await c.db.customer_questions.update(q._id, { status: "ANSWERED", answer_text: b.text, answered_at: nowIso(), answered_by: user._id });
  return { status: "ANSWERED" };
});

// -- Calculadora de custos (UC14) ------------------------------------------------------------------------
const COST_PROFILE: Schema = {
  listing_type: { type: "str", pattern: /^(gold_special|gold_pro)$/, label: "Tipo de anúncio" },
  shipping_mode: { type: "str", pattern: /^(coleta|full|flex|proprio)$/, label: "Modalidade de envio" },
  tax_pct: { type: "num", min: 0, max: 60, label: "Impostos" }, ads_pct: { type: "num", min: 0, max: 100, label: "Mercado Ads" },
  installment_pct: { type: "num", min: 0, max: 30, label: "Parcelamento" }, other_cost_pct: { type: "num", min: 0, max: 60, label: "Outros (%)" },
  packaging_cost: { type: "num", min: 0, label: "Embalagem" }, other_cost_fixed: { type: "num", min: 0, label: "Outros custos" },
  flex_cost: { type: "num", min: 0, label: "Custo do Flex" }, full_storage_cost: { type: "num", min: 0, label: "Armazenagem Full" },
  own_shipping_cost: { type: "num", min: 0, label: "Envio próprio" },
  shipping_discount_pct: { type: "num", min: 0, max: 100, label: "Desconto de frete" },
  target_margin_pct: { type: "num", min: -50, max: 90, label: "Margem desejada" },
};

router.on("GET", "/api/sellers/:id/cost-profile", async (c) => {
  const user = await currentUser(c);
  const seller = await owned(c, "sellers", c.params.id, user);
  return { ...DEFAULT_PROFILE, ...(seller.cost_profile || {}) };
});

router.on("PUT", "/api/sellers/:id/cost-profile", async (c) => {
  const user = await manager(c);
  const seller = await owned(c, "sellers", c.params.id, user);
  const changes = validate(await readJson(c.req), COST_PROFILE);
  const updated = Object.keys(changes).length ? await c.db.sellers.update(seller._id, { cost_profile: { ...(seller.cost_profile || {}), ...changes } }) : seller;
  return { ...DEFAULT_PROFILE, ...(updated!.cost_profile || {}) };
});

/** Simula custos e lucro de um preço. Campos do perfil enviados aqui valem só para esta simulação. */
router.on("POST", "/api/calculator", async (c) => {
  const user = await currentUser(c);
  const raw = await readJson(c.req);
  const overrides = validate(raw, COST_PROFILE);
  const b = validate(raw, { seller_id: { type: "str", required: true }, price: { type: "num", required: true, gt: 0, label: "Preço" },
    cost_price: { type: "num", required: true, min: 0, label: "Custo" }, product_id: { type: "str" }, account_id: { type: "str" },
    weight_g: { type: "int", min: 0, label: "Peso" }, dimensions_cm: { type: "str", pattern: DIMS, label: "Dimensões" },
    commission_pct: { type: "num", min: 0, max: 50, label: "Comissão" }, shipping_cost: { type: "num", min: 0, label: "Frete" } });
  const seller = await owned(c, "sellers", b.seller_id, user);
  const product: Record<string, any> = b.product_id ? await owned(c, "products", b.product_id, user) : {};
  const profile = { ...(seller.cost_profile || {}), ...overrides };
  const accountId = b.account_id ? (await owned(c, "marketplace_accounts", b.account_id, user))._id : undefined;
  const accounts = await activeAccounts(c.db, { seller_id: seller._id, ...(accountId ? { _id: accountId } : {}) });
  let calc = new CostCalculator(profile);
  if (accounts.length) {
    const conn = await connectorForAccount(c.db, c.cfg, accounts[0]);
    const category = product.category_id ?? null;
    calc = new CostCalculator(profile, (p, lt) => conn.getFees(p, category, lt), (p, w, d, lt) => conn.getShippingCost(p, w, d, lt));
  }
  const inputs: CostInputs = { cost_price: b.cost_price, weight_g: b.weight_g || product.weight_g, dimensions_cm: b.dimensions_cm || product.dimensions_cm,
    commission_pct: b.commission_pct, shipping_cost: b.shipping_cost,
    packaging_cost: overrides.packaging_cost !== undefined ? overrides.packaging_cost : product.packaging_cost };
  await calc.prepare(inputs, b.price);
  return calc.report(b.price, inputs, overrides.target_margin_pct);
});

// -- Análise de anúncios, pesquisa de mercado e monitoramento (UC15-UC17) --------------------------------
const AD_INPUT: Schema = { item: { type: "str", required: true, minLen: 3, label: "Anúncio" }, account_id: { type: "str" } };

async function accOf(c: Ctx, accountId: string | null | undefined, user: Doc) {
  return accountId ? (await owned(c, "marketplace_accounts", accountId, user))._id : null;
}

router.on("POST", "/api/ads/analyze", async (c) => {
  const user = await currentUser(c);
  const b = validate(await readJson(c.req), AD_INPUT);
  const acc = await accOf(c, b.account_id, user);
  try { return await ads.analyzeAdForOrg(c.db, c.cfg, user.org_id, b.item, acc); } catch (e: any) {
    if (e instanceof AccountError) throw new HttpError(409, e.message);
    throw new HttpError(404, `Não foi possível ler o anúncio: ${e?.message || e}`);
  }
});

router.on("GET", "/api/ads/recent", async (c) => {
  const user = await currentUser(c);
  const { results } = await c.db.raw.prepare(`SELECT id AS _id, org_id, item_id, analyzed_at, json_extract(data,'$.title') AS title
    FROM ad_analyses WHERE org_id = ? ORDER BY analyzed_at DESC LIMIT 20`).bind(user.org_id).all();
  return results;
});

router.on("GET", "/api/market/research", async (c) => {
  const user = await currentUser(c);
  const q = c.url.searchParams.get("q") || "";
  if (q.length < 2) throw new HttpError(422, "Digite pelo menos 2 caracteres para pesquisar");
  const acc = await accOf(c, c.url.searchParams.get("account_id"), user);
  return ads.marketResearch(c.db, c.cfg, user.org_id, q, acc, modes(c.url.searchParams.get("modes"))).catch(conflict);
});

router.on("GET", "/api/ads/tracked", async (c) => ads.trackedList(c.db, (await currentUser(c)).org_id));

router.on("POST", "/api/ads/tracked", async (c) => {
  const user = await currentUser(c);
  const b = validate(await readJson(c.req), AD_INPUT);
  return ads.track(c.db, c.cfg, user.org_id, b.item, await accOf(c, b.account_id, user)).catch(conflict);
});

router.on("DELETE", "/api/ads/tracked/:item", async (c) => {
  const user = await currentUser(c);
  await ads.untrack(c.db, user.org_id, c.params.item);
  return { tracked: false };
});

// Rotas internas: chamadas pelo próprio Worker (agendador e sincronizações), assinadas com o segredo do MAI.
router.on("POST", "/internal/sync", async (c) => {
  const b = await readJson(c.req);
  return syncAccount(c.db, c.cfg, b.account_id, !!b.recent_only).catch(conflict);
});

router.on("POST", "/internal/analyze", async (c) => {
  const b = await readJson(c.req);
  const snap = await runAnalysis(c.db, c.cfg, b.product_id).catch(conflict);
  return { snapshot_id: snap._id };
});

router.on("POST", "/internal/snapshots", async (c) => {
  const b = await readJson(c.req);
  return { snapshots: await ads.snapshotItems(c.db, c.cfg, b.org_id, b.item_ids) };
});

export { json };
