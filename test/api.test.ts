// Fluxo completo pela API: multiempresa, papéis, várias contas por loja, painéis, relatórios e anúncios.
import { beforeAll, describe, expect, it } from "vitest";
import { dueTrackedItems, snapshotItems } from "../src/ad_service";
import * as auth from "../src/auth";
import * as dash from "../src/dashboard";
import { connectAccount, AccountError } from "../src/services";
import { call, cfg, db, DEMO_EMAIL, DEMO_PASSWORD, login, seedDemo } from "./helpers";

let ctx: Awaited<ReturnType<typeof seedDemo>>;
beforeAll(async () => { ctx = await seedDemo(); });

describe("sistema", () => {
  it("a análise responde as cinco perguntas", async () => {
    const snap = (await db().market_snapshots.findOne({ seller_id: ctx.sellerId }))!;
    expect(snap.competitor_data.competitors_used).toBeGreaterThanOrEqual(10);
    expect(snap.search_intelligence.keywords.top_keywords.length).toBeGreaterThan(0);
    expect(snap.search_intelligence.traffic_breakdown.source).toBe("estimativa");
    expect(snap.review_insights.groups.mercado.main_reason).toBeTruthy();
    expect(snap.pricing.recommended_price).toBeTruthy();
    expect(snap.ai_recommendations.length).toBeGreaterThan(0);
  });

  it("métricas dos painéis", async () => {
    const s = await dash.salesSummary(db(), ctx.sellerId, "30d");
    expect(s.orders).toBeGreaterThan(0);
    expect(s.gross_revenue).toBeGreaterThan(s.net_revenue);
    expect(s.net_revenue).toBeGreaterThan(0);
    expect(s.daily_curve.length).toBe(30);
    expect(s.top_products.length).toBeLessThanOrEqual(5);
    expect(s.top_products[0].product_id).toBeTruthy();
    expect(s.current_month.gross_revenue).toBeGreaterThanOrEqual(0);
    const q = await dash.questionsSummary(db(), ctx.sellerId);
    expect(q.unanswered_count === q.unanswered.length || q.unanswered_count > 20).toBe(true);
    expect(q.avg_response_minutes_30d).toBeGreaterThan(0);
    const st = await dash.stockSummary(db(), ctx.sellerId, 15);
    expect(st.items.filter((i: any) => i.stock === 0).every((i: any) => i.alert === "SEM_ESTOQUE")).toBe(true);
    expect(st.out_of_stock).toBe(st.items.filter((i: any) => i.stock === 0).length);
    const alerts = st.items.map((i: any) => i.alert !== null);
    expect(alerts).toEqual([...alerts].sort((a, b) => Number(b) - Number(a))); // alertas primeiro
  });

  it("períodos", () => {
    const now = new Date(Date.UTC(2026, 9, 3, 15));
    expect(dash.periodRange("mes", now)[0].toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(dash.periodRange("7d", now)[0].toISOString()).toBe("2026-09-27T00:00:00.000Z");
  });

  it("fluxo pela API com relatórios", async () => {
    const h = await login(DEMO_EMAIL, DEMO_PASSWORD);
    const sellers = (await call("GET", "/api/sellers", { token: h })).data;
    const sid = sellers[0]._id;
    const products = (await call("GET", `/api/sellers/${sid}/products`, { token: h })).data;
    const pid = products[0]._id;
    expect((await call("PATCH", `/api/products/${pid}`, { body: { cost_price: 100 }, token: h })).status).toBe(200);
    const acc = sellers[0].accounts[1]._id;
    const r = await call("POST", `/api/products/${pid}/analyze`, { token: h });
    expect(r.status).toBe(200);
    expect(r.data.recommended_price).toBeTruthy();
    const html = await call("GET", `/api/products/${pid}/report.html?token=${h}`);
    expect(html.status).toBe(200);
    expect(html.data).toContain("Melhor preço de venda");
    expect(html.data).toContain("Estimativa");
    expect(html.data).toContain("<svg");
    expect((await call("GET", `/api/products/${pid}/report.html`)).status).toBe(401);
    const xlsx = await call("GET", `/api/products/${pid}/report.xlsx?token=${h}`);
    expect(xlsx.headers.get("content-type")).toMatch(/^application\/vnd\.openxml/);
    expect(String.fromCharCode(xlsx.data[0], xlsx.data[1])).toBe("PK");
    const hist = await call("GET", `/api/products/${pid}/history`, { token: h });
    expect(hist.data.length).toBe(2);
    const d = (await call("GET", `/api/sellers/${sid}/dashboard?period=mes&account_id=${acc}`, { token: h })).data;
    expect(Object.keys(d).sort()).toEqual(["questions", "sales", "stock"]);
    expect((await call("GET", `/api/sellers/${sid}/dashboard?period=xx`, { token: h })).status).toBe(422);
    const all = (await call("GET", `/api/sellers/${sid}/dashboard`, { token: h })).data;
    const qid = all.questions.unanswered[0].id;
    expect((await call("POST", `/api/questions/${qid}/answer`, { body: { text: "Sim!" }, token: h })).data.status).toBe("ANSWERED");
    expect((await call("POST", `/api/questions/${qid}/answer`, { body: { text: "de novo" }, token: h })).status).toBe(409);
    // sincronizar de novo não volta a pergunta respondida para pendente
    await call("POST", `/api/accounts/${acc}/sync`, { token: h });
    expect((await db().customer_questions.get(qid))!.status).toBe("ANSWERED");
    const s = (await call("PATCH", "/api/org/settings", { body: { gemini_api_key: "AIza-xyz", min_margin_pct: 20 }, token: h })).data;
    expect(s.has_own_gemini_key).toBe(true);
    expect(s.gemini_api_key).toBeUndefined();
    expect(s.min_margin_pct).toBe(20);
    expect((await call("PATCH", "/api/org/settings", { body: { gemini_api_key: "" }, token: h })).data.has_own_gemini_key).toBe(false);
    expect((await call("GET", "/healthz")).data).toEqual({ ok: true });
  });

  it("sincronizar a loja inteira não duplica produtos nem pedidos", async () => {
    const before = await db().orders.count({ seller_id: ctx.sellerId });
    const r = await call("POST", `/api/sellers/${ctx.sellerId}/sync`, { token: ctx.token });
    expect(r.status).toBe(200);
    expect(r.data.length).toBe(2);
    expect(await db().orders.count({ seller_id: ctx.sellerId })).toBe(before);
    expect(await db().products.count({ seller_id: ctx.sellerId })).toBe(5);
    const p = (await db().products.findOne({ seller_id: ctx.sellerId, internal_sku: "MEC-RGB-WL" }))!;
    expect(p.cost_price).toBe(120); // custo cadastrado continua
  });
});

describe("multiempresa e papéis", () => {
  it("senha e token", async () => {
    const h = await auth.hashPassword("segredo123", 1000);
    expect(await auth.verifyPassword("segredo123", h)).toBe(true);
    expect(await auth.verifyPassword("errada123", h)).toBe(false);
    await expect(auth.hashPassword("curta")).rejects.toThrow(auth.AuthError);
    const tok = await auth.issueToken(cfg(), { _id: "u1", org_id: "o1", role: "owner" });
    expect((await auth.readToken(cfg(), tok)).uid).toBe("u1");
    const [body, sig] = tok.split(".");
    await expect(auth.readToken(cfg(), body + "x." + sig)).rejects.toThrow(auth.AuthError);
    await expect(auth.readToken(cfg(), tok, 10 ** 14)).rejects.toThrow("Sessão expirada");
  });

  it("exige login", async () => {
    expect((await call("GET", "/api/sellers")).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { body: { email: DEMO_EMAIL, password: "errada123" } })).status).toBe(401);
    expect((await call("GET", "/api/nao-existe")).status).toBe(404);
  });

  it("empresas não se enxergam", async () => {
    const a = ctx.token;
    const r = await call("POST", "/api/auth/register", { body: { org_name: "Outra Empresa", name: "Bia", email: "bia@outra.com", password: "senha-forte-1" } });
    expect(r.status).toBe(200);
    const b = r.data.token;
    expect((await call("POST", "/api/auth/register", { body: { org_name: "Xx", name: "Yy", email: "bia@outra.com", password: "senha-forte-1" } })).status).toBe(400);
    expect((await call("POST", "/api/auth/register", { body: { org_name: "Xx", name: "Yy", email: "nao-e-email", password: "senha-forte-1" } })).status).toBe(422);

    const aSellers = (await call("GET", "/api/sellers", { token: a })).data;
    const bSellers = (await call("GET", "/api/sellers", { token: b })).data;
    expect(aSellers.some((s: any) => bSellers.some((x: any) => x._id === s._id))).toBe(false);
    const aSid = aSellers[0]._id;
    const product = (await call("GET", `/api/sellers/${aSid}/products`, { token: a })).data[0];
    expect((await call("GET", `/api/sellers/${aSid}/products`, { token: b })).status).toBe(404);
    expect((await call("GET", `/api/sellers/${aSid}/dashboard`, { token: b })).status).toBe(404);
    expect((await call("GET", `/api/products/${product._id}/report`, { token: b })).status).toBe(404);
    expect((await call("PATCH", `/api/products/${product._id}`, { body: { cost_price: 1 }, token: b })).status).toBe(404);
    expect((await call("DELETE", `/api/accounts/${aSellers[0].accounts[0]._id}`, { token: b })).status).toBe(404);
    const q = (await db().customer_questions.findOne({ org_id: ctx.orgId, status: "UNANSWERED" }))!;
    expect((await call("POST", `/api/questions/${q._id}/answer`, { body: { text: "x" }, token: b })).status).toBe(404);

    // B começa do zero e conecta a própria conta de demonstração
    const bSid = bSellers[0]._id;
    const demo = await call("POST", `/api/sellers/${bSid}/accounts/demo`, { body: { nickname: "Conta da Bia" }, token: b });
    expect(demo.status).toBe(200);
    expect(demo.data.sync.listings).toBe(5);
    expect((await call("GET", `/api/sellers/${bSid}/products`, { token: b })).data.length).toBe(5);
    expect((await call("GET", `/api/sellers/${aSid}/products`, { token: a })).data.length).toBe(5);
  });

  it("papéis", async () => {
    const a = ctx.token;
    const r = await call("POST", "/api/users", { body: { name: "Ana", email: "ana@demo.com", password: "senha-ana-1", role: "analyst" }, token: a });
    expect(r.status).toBe(200);
    const ana = await login("ana@demo.com", "senha-ana-1");
    expect((await call("GET", "/api/me", { token: ana })).data.user.role).toBe("analyst");
    const sid = (await call("GET", "/api/sellers", { token: ana })).data[0]._id;
    expect((await call("GET", `/api/sellers/${sid}/dashboard`, { token: ana })).status).toBe(200);
    expect((await call("POST", "/api/users", { body: { name: "Z", email: "z@demo.com", password: "senha-z-12" }, token: ana })).status).toBe(403);
    expect((await call("POST", `/api/sellers/${sid}/accounts/demo`, { body: {}, token: ana })).status).toBe(403);
    // desativar usuário corta o acesso
    expect((await call("PATCH", `/api/users/${r.data._id}`, { body: { active: false }, token: a })).status).toBe(200);
    expect((await call("GET", "/api/me", { token: ana })).status).toBe(401);
  });

  it("várias contas por loja", async () => {
    const accounts = await db().marketplace_accounts.find({ seller_id: ctx.sellerId }, { order: "connected_at" });
    expect(accounts.length).toBe(2);
    const total = await dash.salesSummary(db(), ctx.sellerId, "30d");
    expect(total.by_account.length).toBe(2);
    const one = await dash.salesSummary(db(), ctx.sellerId, "30d", new Date(), accounts[1]._id);
    expect(one.gross_revenue).toBeGreaterThan(0);
    expect(one.gross_revenue).toBeLessThan(total.gross_revenue);
    expect(Math.abs(total.by_account.reduce((s: number, x: any) => s + x.gross_revenue, 0) - total.gross_revenue)).toBeLessThan(0.05);
    const shared = (await db().products.find({ seller_id: ctx.sellerId })).find((p) => p.listings.length > 1)!;
    expect(new Set(shared.listings.map((l: any) => l.account_id))).toEqual(new Set(accounts.map((x) => x._id)));
    expect((await dash.stockSummary(db(), ctx.sellerId, 15, new Date(), accounts[1]._id)).products).toBe(3);
  });

  it("a mesma conta não entra em duas empresas", async () => {
    const acc = (await db().marketplace_accounts.findOne({ seller_id: ctx.sellerId }))!;
    const other = await db().organizations.insert({ name: "Intrusa" });
    await expect(connectAccount(db(), cfg(), other._id, ctx.sellerId, acc.marketplace, acc.external_id, "x")).rejects.toThrow(AccountError);
  });

  it("desconectar conta", async () => {
    const r = (await call("POST", `/api/sellers/${ctx.sellerId}/accounts/demo`, { body: { nickname: "Temporária" }, token: ctx.token })).data;
    const accId = r.account._id;
    expect((await call("DELETE", `/api/accounts/${accId}`, { token: ctx.token })).data.status).toBe("REVOKED");
    expect((await call("POST", `/api/accounts/${accId}/sync`, { token: ctx.token })).status).toBe(409);
    const saved = (await db().marketplace_accounts.get(accId))!;
    expect(saved.access_token).toBeUndefined();
  });

  it("rotas internas exigem assinatura", async () => {
    expect((await call("POST", "/internal/sync", { body: { account_id: "x" } })).status).toBe(403);
  });
});

describe("calculadora e anúncios pela API", () => {
  it("calculadora e perfil de custos", async () => {
    const h = ctx.token, sid = ctx.sellerId;
    const product = (await call("GET", `/api/sellers/${sid}/products`, { token: h })).data[0];
    const r = await call("POST", "/api/calculator", { body: { seller_id: sid, product_id: product._id, price: 199.9, cost_price: 80, tax_pct: 8 }, token: h });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.profile.tax_pct).toBe(8);
    expect(r.data.scenarios.length).toBe(6);
    expect(r.data.break_even_price).toBeLessThan(r.data.price_for_target);
    // simulação não altera o perfil salvo
    expect((await call("GET", `/api/sellers/${sid}/cost-profile`, { token: h })).data.tax_pct).toBe(6);
    const saved = (await call("PUT", `/api/sellers/${sid}/cost-profile`, { body: { tax_pct: 4.5, flex_cost: 10 }, token: h })).data;
    expect([saved.tax_pct, saved.flex_cost]).toEqual([4.5, 10]);
    expect((await call("POST", "/api/calculator", { body: { seller_id: sid, price: 50, cost_price: 20, dimensions_cm: "grande" }, token: h })).status).toBe(422);
    await auth.createUser(db(), cfg(), ctx.orgId, "Rui", "rui@demo.com", "senha-rui-1", "analyst");
    const rui = await login("rui@demo.com", "senha-rui-1");
    expect((await call("PUT", `/api/sellers/${sid}/cost-profile`, { body: { tax_pct: 1 }, token: rui })).status).toBe(403);
    expect((await call("POST", "/api/calculator", { body: { seller_id: sid, price: 50, cost_price: 20 }, token: rui })).status).toBe(200);
  });

  it("análise com filtro de modalidade", async () => {
    const h = ctx.token;
    const product = (await call("GET", `/api/sellers/${ctx.sellerId}/products`, { token: h })).data[0];
    expect((await call("POST", `/api/products/${product._id}/analyze?modes=full`, { token: h })).status).toBe(200);
    const snap = (await call("GET", `/api/products/${product._id}/report`, { token: h })).data;
    expect(snap.logistics.filter).toEqual(["full"]);
    const top = snap.competitor_data.top_competitors;
    expect(top.length).toBeGreaterThan(0);
    expect(top.every((c: any) => c.shipping_mode === "full")).toBe(true);
    // a visão de logística continua mostrando o mercado inteiro, não só o filtro
    expect(snap.logistics.by_mode.reduce((s: number, m: any) => s + m.listings, 0)).toBeGreaterThan(snap.competitor_data.total_competitors_found);
    expect(snap.pricing.cost_breakdown).toBeTruthy();
    expect((await call("GET", `/api/products/${product._id}/report.html`, { token: h })).data).toContain("Full, Flex ou coleta?");
  });

  it("raio-x, pesquisa de mercado e monitoramento", async () => {
    const h = ctx.token;
    const r = await call("POST", "/api/ads/analyze", { body: { item: "https://produto.mercadolivre.com.br/MLB-9000003-x" }, token: h });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.item.item_id).toBe("MLB9000003");
    expect(r.data.quality.score).toBeGreaterThanOrEqual(0);
    expect(r.data.quality.score).toBeLessThanOrEqual(100);
    expect(r.data.sales.source).toBe("estimativa");
    expect(r.data.keywords.associated.length).toBeGreaterThan(0);
    expect((await call("GET", "/api/ads/recent", { token: h })).data[0].item_id).toBe("MLB9000003");

    const m = (await call("GET", "/api/market/research?q=teclado%20mecanico", { token: h })).data;
    expect(m.listings).toBeGreaterThan(10);
    expect(m.revenue_total_estimate).toBeGreaterThan(0);
    expect(m.top_sellers.length).toBeGreaterThan(0);
    expect(m.monthly_revenue_top_count).toBeGreaterThan(0);
    const full = (await call("GET", "/api/market/research?q=teclado%20mecanico&modes=full", { token: h })).data;
    expect(full.listings).toBeGreaterThan(0);
    expect(full.listings).toBeLessThan(m.listings);
    expect(full.ads.every((x: any) => x.shipping_mode === "full")).toBe(true);

    expect((await call("POST", "/api/ads/tracked", { body: { item: "MLB9000003" }, token: h })).status).toBe(200);
    const rows = (await call("GET", "/api/ads/tracked", { token: h })).data;
    expect([rows[0].item_id, rows[0].snapshots, rows[0].sales_7d]).toEqual(["MLB9000003", 1, null]);
    // uma segunda foto, 2 dias depois, com 6 vendas a mais: vendas passam a ser calculadas
    const first = (await db().ad_snapshots.findOne({ item_id: "MLB9000003" }))!;
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await db().ad_snapshots.replace({ ...first, captured_at: twoDaysAgo, sold_quantity: first.sold_quantity - 6 });
    const due = await dueTrackedItems(db(), new Date(Date.now() - 86_400_000).toISOString(), 50);
    expect(due.map((d) => d.item_id)).toEqual(["MLB9000003"]);
    expect(await snapshotItems(db(), cfg(), due[0].org_id, ["MLB9000003"])).toBe(1);
    const row = (await call("GET", "/api/ads/tracked", { token: h })).data[0];
    expect(row.sales_7d).toBe(6);
    expect(row.revenue_30d).toBe(Math.round(6 * row.price * 100) / 100);
    const again = (await call("POST", "/api/ads/analyze", { body: { item: "MLB9000003" }, token: h })).data;
    expect(again.tracked).toBe(true);
    expect(again.sales.source).toBe("calculado");
    await call("DELETE", "/api/ads/tracked/MLB9000003", { token: h });
    expect((await call("GET", "/api/ads/tracked", { token: h })).data).toEqual([]);
  });

  it("anúncios monitorados são de cada empresa", async () => {
    await call("POST", "/api/ads/tracked", { body: { item: "MLB9000004" }, token: ctx.token });
    await auth.registerOrganization(db(), cfg(), "Concorrente SA", "Lia", "lia@conc.com", "senha-lia-1");
    const lia = await login("lia@conc.com", "senha-lia-1");
    expect((await call("GET", "/api/ads/tracked", { token: lia })).data).toEqual([]);
    expect((await call("GET", "/api/ads/recent", { token: lia })).data).toEqual([]);
    // empresa sem conta conectada não usa a conta de outra
    expect((await call("GET", "/api/market/research?q=teclado", { token: lia })).status).toBe(409);
  });
});
