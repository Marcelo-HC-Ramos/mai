// IA generativa (Gemini), sempre com alternativa local.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MarketAgent } from "../src/agent";
import { llmForOrg } from "../src/ai";
import { GeminiClient } from "../src/ai/gemini";
import { classifyReviews, executiveSummary, suggestAnswerAi } from "../src/ai/tasks";
import { reviewInsights } from "../src/analysis/reviews";
import { DemoConnector } from "../src/connectors/demo";
import { renderHtml } from "../src/report/html";
import { encrypt } from "../src/security";
import { cfg, db, FakeLLM, seedDemo } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("IA", () => {
  let ctx: Awaited<ReturnType<typeof seedDemo>>;
  beforeAll(async () => { ctx = await seedDemo(); });

  it("sem chave não há IA", async () => {
    expect(await llmForOrg(cfg(), { settings: {} })).toBeNull();
  });

  it("usa a chave da empresa", async () => {
    const llm = await llmForOrg(cfg(), { settings: { gemini_api_key: await encrypt(cfg().encryptionKey, "AIza-teste"), gemini_model: "gemini-x" } });
    expect((llm as GeminiClient).apiKey).toBe("AIza-teste");
    expect(llm!.model).toBe("gemini-x");
    expect(await llmForOrg(cfg(), { settings: { gemini_api_key: await encrypt(cfg().encryptionKey, "k"), ai_enabled: false } })).toBeNull();
  });

  it("cliente do Gemini lê JSON", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok": true}' }] } }] })));
    const c = new GeminiClient("chave-123", "gemini-2.5-flash");
    expect(await c.generate("oi", { schema: { type: "OBJECT" } })).toEqual({ ok: true });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("gemini-2.5-flash:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("chave-123");
    expect(JSON.parse(String(init.body)).generationConfig.responseMimeType).toBe("application/json");
  });

  it("falha do Gemini devolve null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"error":"bad"}', { status: 400 }));
    expect(await new GeminiClient("k2").generate("oi")).toBeNull();
  });

  it("classificação com IA e alternativa local", async () => {
    const reviews = [{ item_id: "a", rate: 1, content: "Demorou muito" }, { item_id: "a", rate: 2, content: "quebrou rápido" }];
    const withAi = await reviewInsights({ mercado: reviews }, (t) => classifyReviews(new FakeLLM(), t));
    expect(withAi.method).toBe("ia");
    expect(withAi.groups.mercado.main_reason.reason).toBe("entrega");
    const broken = await reviewInsights({ mercado: reviews }, async () => null);
    expect(broken.method).toBe("lexico");
    expect(broken.groups.mercado.main_reason).toBeTruthy();
  });

  it("resumo e resposta sugerida", async () => {
    const llm = new FakeLLM();
    const out = (await executiveSummary(llm, { title: "X" }, {}, {}, { top_keywords: [] }, {}, { groups: {} }))!;
    expect(out.summary).toBe("Resumo de teste.");
    expect(out.title_suggestion.length).toBeLessThanOrEqual(60);
    expect(out.provider).toBe("fake");
    expect(await suggestAnswerAi(llm, "Tem garantia?", { title: "X" })).toMatch(/^Olá!/);
    expect(await suggestAnswerAi(null, "Tem garantia?", {})).toBeNull();
  });

  it("o agente usa a IA quando disponível", async () => {
    const fake = new FakeLLM();
    const product = (await db().products.findOne({ org_id: ctx.orgId }))!;
    const account = (await db().marketplace_accounts.findOne({ seller_id: ctx.sellerId }))!;
    const agent = new MarketAgent(db(), cfg(), new DemoConnector({ accountKey: account.external_id }), { account, llm: fake });
    const snap = await agent.analyzeProduct(product);
    expect(snap.ai_summary.summary).toBe("Resumo de teste.");
    expect(snap.review_insights.method).toBe("ia");
    expect(fake.calls.some((c) => c.includes("Classifique"))).toBe(true);
    expect(renderHtml(snap, product)).toContain("Resumo da análise");
  });
});
