import { describe, expect, it } from "vitest";
import { deviceInsights } from "../src/analysis/devices";
import { keywordInsights } from "../src/analysis/keywords";
import { competitorStats, minAllowedPrice, recommendPrice, removeOutliersIqr } from "../src/analysis/pricing";
import { classifyText, reviewInsights } from "../src/analysis/reviews";
import { competitor, type FeeQuote, type Review } from "../src/connectors/base";

const L = (price: number, sold = 10, title = "Teclado mecanico sem fio rgb", free = true) =>
  competitor({ item_id: `I${price}`, title, price, sold_quantity: sold, free_shipping: free });
const fee = (p: number): FeeQuote => ({ commission: Math.round(p * 16) / 100, fixed_fee: 0, source: "teste" });
const R = (rate: number, content: string): Review => ({ item_id: "a", rate, content, title: "" });
const range = (a: number, b: number, step: number) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);

describe("preços (UC06, UC10)", () => {
  it("remove preços discrepantes pelo intervalo interquartil", () => {
    const [kept, dropped] = removeOutliersIqr([100, 102, 98, 101, 99, 103, 20, 500].map((p) => L(p)));
    expect(new Set(dropped.map((d) => d.price))).toEqual(new Set([20, 500]));
    expect(kept.length).toBe(6);
  });

  it("estatísticas e posição do meu preço", () => {
    const s = competitorStats([90, 100, 110, 120, 130].map((p) => L(p)), 125);
    expect([s.lowest_price, s.median_price, s.highest_price]).toEqual([90, 110, 130]);
    expect(s.my_price_percentile).toBe(80);
    expect(s.diff_to_median).toBe(15);
  });

  it("respeita a margem mínima", () => {
    const s = competitorStats(range(100, 130, 2).map((p) => L(p)));
    const r = recommendPrice(s, 95, null, fee, 15);
    // preço precisa cobrir custo + 16% de comissão + 15% de margem: p >= 95 / 0,69 = 137,68
    expect(r.strategy).toBe("preco_minimo");
    expect(r.recommended_price).toBeGreaterThanOrEqual(137.6);
    expect(r.recommended_price).toBeLessThan(137.9);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("escolhe o maior lucro esperado dentro do mercado", () => {
    const s = competitorStats(range(200, 300, 5).map((p) => L(p)));
    const r = recommendPrice(s, 100, 150, fee, 15, 280);
    expect(r.strategy).toBe("lucro_esperado");
    expect(r.recommended_price).toBeGreaterThanOrEqual(s.q1_price * 0.95);
    expect(r.recommended_price).toBeLessThanOrEqual(s.q3_price);
    expect(String(r.recommended_price).endsWith(".9")).toBe(true);
    expect(r.margin_pct_at_recommended).toBeGreaterThanOrEqual(15);
  });

  it("sem custo, avisa e posiciona pelo mercado", () => {
    const s = competitorStats(range(200, 300, 5).map((p) => L(p)));
    const r = recommendPrice(s, null, null, fee);
    expect(r.strategy).toBe("posicao_de_mercado");
    expect(r.recommended_price).toBeLessThan(s.median_price);
  });

  it("menor preço permitido acha a janela logo antes da virada de faixa", () => {
    // aceita só entre 78,50 e 78,99 (antes da virada de R$ 79) ou a partir de 120
    const ok = (p: number) => (p >= 78.5 && p < 79) || p >= 120;
    expect(minAllowedPrice(50, 500, ok)).toBe(78.5);
    expect(minAllowedPrice(80, 500, ok)).toBe(120);
    expect(minAllowedPrice(10, 20, () => false)).toBe(20);
  });
});

describe("avaliações (UC09)", () => {
  it("classifica pelo léxico", async () => {
    expect(classifyText("Veio com defeito, não liga")).toContain("defeito");
    expect(classifyText("A entrega atrasou demais")).toContain("entrega");
    expect(classifyText("Cor errada, diferente da foto")).toContain("divergente");
    const res = await reviewInsights({ mercado: [R(1, "Quebrou em uma semana, material frágil"), R(2, "quebrou fácil"),
      R(1, "atrasou a entrega"), R(5, "ótimo")] });
    const g = res.groups.mercado;
    expect(g.bad_reviews).toBe(3);
    expect(g.main_reason.reason).toBe("durabilidade");
    expect(g.small_sample).toBe(true);
  });
});

describe("palavras-chave (UC07) e dispositivos (UC08)", () => {
  it("combina tendências e títulos", () => {
    const comps = [L(100, 500, "Teclado Mecanico Gamer RGB Switch Azul"), L(110, 50, "Teclado Mecanico Gamer Bluetooth"), L(120, 5, "Mouse sem fio")];
    const kw = keywordInsights("Teclado Mecânico RGB", comps, ["teclado gamer", "geladeira", "teclado mecanico"]);
    const terms = kw.top_keywords.map((k: any) => k.term);
    expect(terms).not.toContain("geladeira");
    expect(terms).toContain("teclado gamer");
    expect(terms).toContain("teclado mecanico");
    expect(kw.missing_in_title).toContain("teclado gamer");
  });

  it("prioridade das fontes de dispositivo", () => {
    expect(deviceInsights("MLB1051").source).toBe("estimativa");
    expect(deviceInsights("X", null, { mobile: 40, desktop: 10 }).mobile_share_pct).toBe(80);
    expect(deviceInsights("X", { mobile: 0.3 }).predominant).toBe("computador");
  });
});
