import { describe, expect, it } from "vitest";
import { estimateSales, marketOverview, parseItemId, qualityScore } from "../src/analysis/ads";
import { filterByModes, logisticsInsights } from "../src/analysis/logistics";
import { competitor, itemDetails, shippingMode, type FeeQuote } from "../src/connectors/base";
import { asFeeFn, CostCalculator, mlFixedFee, tableShipping } from "../src/costs";
import { DAY } from "../src/lib/time";

const NOW = new Date(Date.UTC(2026, 9, 6));

describe("calculadora (UC14)", () => {
  it("tarifa fixa e tabela de frete", () => {
    expect([mlFixedFee(10), mlFixedFee(20), mlFixedFee(40), mlFixedFee(60), mlFixedFee(79)]).toEqual([5, 6.25, 6.5, 6.75, 0]);
    expect([tableShipping(250), tableShipping(1500), tableShipping(99_000)]).toEqual([19.95, 23.45, 98.95]);
  });

  it("confere com a conta feita à mão", () => {
    const calc = new CostCalculator({ tax_pct: 10, packaging_cost: 2, ads_pct: 0 });
    const r = calc.calculate(100, { cost_price: 40, weight_g: 400, commission_pct: 15 }, "gold_pro", "coleta");
    // 40 produto + 15 comissão + 21,45 frete (até 500 g) + 10 imposto + 2 embalagem = 88,45
    expect([r.total_costs, r.profit, r.margin_pct]).toEqual([88.45, 11.55, 11.6]);
    expect(r.marketplace_payout).toBe(Math.round((100 - 15 - 21.45) * 100) / 100);
    expect([r.roi_pct, r.markup]).toEqual([28.9, 2.5]);
  });

  it("frete depende da modalidade e do limite do frete grátis", () => {
    const calc = new CostCalculator({ flex_cost: 9, full_storage_cost: 1.5, own_shipping_cost: 4 });
    const i = { cost_price: 10, weight_g: 400, commission_pct: 10 };
    const ship = (price: number, mode: string) => calc.calculate(price, i, "gold_special", mode).breakdown.find((b) => b.key === "shipping")!.value;
    expect(ship(50, "coleta")).toBe(0); // abaixo de R$ 79 o comprador paga o frete
    expect(ship(100, "coleta")).toBe(21.45);
    expect(ship(100, "full")).toBe(22.95); // frete + armazenagem
    expect(ship(100, "flex")).toBe(9);
    expect(ship(100, "proprio")).toBe(4);
  });

  it("consulta o marketplace uma vez por tipo de anúncio", async () => {
    const calls: string[] = [];
    const fees = async (price: number, lt: string): Promise<FeeQuote> => { calls.push(lt); return { commission: price * 0.12, fixed_fee: 0, source: "api" }; };
    const calc = new CostCalculator({}, fees, async () => 30);
    const i = { cost_price: 50, weight_g: 800 };
    await calc.prepare(i, 150);
    const r = calc.report(150, i);
    const shipping = r.breakdown.find((b) => b.key === "shipping")!;
    expect([shipping.value, shipping.source]).toEqual([30, "api"]);
    expect(r.breakdown.find((b) => b.key === "commission")!.source).toBe("api");
    expect([...new Set(calls)].sort()).toEqual(["gold_pro", "gold_special"]);
    expect(calls.length).toBe(2);
    expect(r.scenarios.length).toBe(6);
  });

  it("preço para a margem considera o degrau do frete grátis", () => {
    const calc = new CostCalculator({ tax_pct: 0 });
    // custo 40: abaixo de R$ 79 o frete não entra; 0,7p >= 40 + 6,75 de tarifa fixa -> R$ 66,79
    expect(calc.priceForMargin(20, { cost_price: 40, weight_g: 400, commission_pct: 10 }, "gold_special", "coleta")).toBe(66.79);
    // custo 50: R$ 78,99 não chega a 20%; acima de R$ 79 entra o frete de R$ 21,45 -> 0,7p >= 71,45 -> R$ 102,08
    const i = { cost_price: 50, weight_g: 400, commission_pct: 10 };
    const p = calc.priceForMargin(20, i, "gold_special", "coleta")!;
    expect(p).toBe(102.08); // não aceita R$ 102,00, que dá 19,95% e só "arredonda" para 20%
    const be = calc.priceForMargin(0, i, "gold_special", "coleta")!;
    expect(be).toBeLessThanOrEqual(p);
    expect(calc.calculate(be, i, "gold_special", "coleta").profit).toBeGreaterThanOrEqual(0);
    expect(calc.calculate(Math.round(be * 100 - 1) / 100, i, "gold_special", "coleta").profit).toBeLessThan(0);
  });

  it("preço para a margem bate com a busca centavo a centavo", () => {
    const calc = new CostCalculator({ tax_pct: 6, packaging_cost: 1.5 });
    for (const cost of [3, 8, 15, 22, 35, 48, 55, 61, 90, 140]) {
      for (const target of [0, 10, 25]) {
        for (const mode of ["coleta", "full", "flex"]) {
          const i = { cost_price: cost, weight_g: 700 };
          const fast = calc.priceForMargin(target, i, "gold_special", mode);
          let slow: number | null = null;
          for (let c = Math.round(Math.max(0.5, cost) * 100); c <= Math.round((cost * 20 + 50) * 100); c++) {
            const pr = c / 100;
            if (calc.calculate(pr, i, "gold_special", mode).profit >= pr * target / 100 - 1e-9) { slow = pr; break; }
          }
          expect(fast, `custo ${cost}, margem ${target}, ${mode}`).toBe(slow);
        }
      }
    }
  });

  it("alimenta a recomendação de preço com os custos variáveis", () => {
    const q = asFeeFn(new CostCalculator({ tax_pct: 5 }), { cost_price: 30, weight_g: 300, commission_pct: 10 })(100);
    expect(q.commission).toBe(10);
    expect(q.fixed_fee).toBe(Math.round((19.95 + 5) * 100) / 100);
    expect(q.source).toBe("calculado");
  });
});

const l = (i: number, mode: string, sold: number, price = 100) => competitor({ item_id: `MLB${i}`, title: `Produto ${i}`, price, sold_quantity: sold, shipping_mode: mode });

describe("Full e Flex", () => {
  it("lê a modalidade da API", () => {
    expect(shippingMode("fulfillment", [])).toBe("full");
    expect(shippingMode("self_service", [])).toBe("flex");
    expect(shippingMode("cross_docking", ["self_service_in"])).toBe("flex");
    expect(shippingMode("drop_off", [])).toBe("coleta");
    expect(shippingMode("custom", [])).toBe("proprio");
    expect(shippingMode(null, [])).toBe("desconhecido");
  });

  it("retrato da logística e filtro", () => {
    const ls = [l(1, "full", 500, 120), l(2, "full", 300, 110), l(3, "flex", 100, 95), l(4, "coleta", 20, 90), l(5, "coleta", 10, 100)];
    const r = logisticsInsights(ls, "coleta", 3);
    expect(r.leader_mode).toBe("full");
    expect(r.full_share_top_pct).toBeCloseTo(66.7);
    const full = r.by_mode.find((m: any) => m.mode === "full");
    expect(full.listings).toBe(2);
    expect(full.sales_share_pct).toBeCloseTo(86.0, 1);
    expect(r.full_price_premium_pct).toBeCloseTo(Math.round(1000 * (115 / 95 - 1)) / 10);
    expect(filterByModes(ls, ["flex", "full"]).map((x) => x.item_id)).toEqual(["MLB1", "MLB2", "MLB3"]);
    expect(filterByModes(ls, null).length).toBe(5);
    expect(filterByModes(ls, ["xpto"]).length).toBe(5);
  });
});

describe("anúncios (UC15, UC16)", () => {
  it.each([
    ["MLB123456789", "MLB123456789"],
    ["mlb-123456789", "MLB123456789"],
    ["https://produto.mercadolivre.com.br/MLB-3456789012-teclado-mecanico-_JM", "MLB3456789012"],
    ["https://www.mercadolivre.com.br/teclado/p/MLB19876543?item_id=MLB1234567890", "MLB1234567890"],
  ])("lê o código de %s", (text, expected) => expect(parseItemId(text)).toBe(expected));

  const details = (p: Record<string, any> = {}) => itemDetails({ item_id: "MLB1", title: "Teclado Mecânico Gamer RGB Switch Blue ABNT2 Sem Fio",
    price: 200, sold_quantity: 300, date_created: new Date(NOW.getTime() - 300 * DAY).toISOString(), visits_30d: 1000, ...p });

  it("estima vendas pela média e depois pelo monitoramento", () => {
    const s = estimateSales(details(), null, NOW);
    expect([s.monthly_units, s.monthly_revenue, s.source]).toEqual([30, 6000, "estimativa"]);
    expect([s.revenue_total_estimate, s.conversion_pct]).toEqual([60000, 3]);
    const hist = [{ captured_at: new Date(NOW.getTime() - 10 * DAY), sold_quantity: 280, price: 190 },
      { captured_at: new Date(NOW.getTime() - 5 * DAY), sold_quantity: 290, price: 200 }, { captured_at: NOW, sold_quantity: 300, price: 200 }];
    const t = estimateSales(details(), hist, NOW);
    expect([t.source, t.tracked_units, t.monthly_units, t.tracked_revenue]).toEqual(["calculado", 20, 60, 4000]);
  });

  it("nota de qualidade soma 100 pontos", () => {
    const perfect = details({ pictures: 8, has_video: true, attributes_filled: 30, attributes_total: 30, description_length: 800,
      free_shipping: true, shipping_mode: "full", listing_type: "gold_pro", rating_average: 4.8 });
    const q = qualityScore(perfect, ["teclado mecanico", "rgb", "switch blue"]);
    expect(q.score).toBe(100);
    expect(q.checks.reduce((s: number, c: any) => s + c.weight, 0)).toBe(100);
    expect(qualityScore(details({ title: "Teclado" }), ["rgb"]).score).toBeLessThan(20);
  });

  it("pesquisa de mercado: faturamento e concentração", () => {
    const ls = [[100, 50], [50, 100], [10, 100], [5, 20]].map(([sold, price], i) => l(i, i < 3 ? "full" : "coleta", sold, price));
    const m = marketOverview("x", ls);
    expect(m.revenue_total_estimate).toBe(5000 + 5000 + 1000 + 100);
    expect([m.listings, m.units_total, m.full_share_pct]).toEqual([4, 165, 75]);
  });
});
