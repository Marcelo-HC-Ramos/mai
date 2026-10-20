// UC14: calculadora de custos e lucro por anúncio, no estilo das extensões de vendedor (ex.: Zinx).
//
// Para cada preço de venda calcula, por unidade: comissão do marketplace (por tipo de anúncio), tarifa fixa, frete
// pago pelo vendedor (coleta/agência, Full, Flex ou envio próprio), impostos, Mercado Ads, embalagem, custos extras e
// custo do produto. Devolve lucro, margem, ROI, markup, preço de equilíbrio e o preço que atinge a margem desejada.
//
// A comissão e o frete vêm do marketplace numa consulta só (`prepare`); depois o cálculo é local e instantâneo.
import { LISTING_TYPES, SHIPPING_MODES, type FeeQuote } from "./connectors/base";
import { g, round, sum } from "./lib/num";

export const DEFAULT_PROFILE: Record<string, any> = {
  listing_type: "gold_pro",        // gold_special = Clássico, gold_pro = Premium
  shipping_mode: "coleta",         // coleta | full | flex | proprio
  tax_pct: 6.0,                    // imposto sobre a venda (ex.: Simples Nacional)
  ads_pct: 0.0,                    // Mercado Ads como % do faturamento (TACOS)
  installment_pct: 0.0,            // custo de parcelamento sem juros oferecido ao comprador
  other_cost_pct: 0.0,             // outros custos em % da venda (antecipação, gateway...)
  packaging_cost: 0.0,             // embalagem e etiqueta por unidade (R$)
  other_cost_fixed: 0.0,           // outros custos fixos por unidade (mão de obra, insumos) (R$)
  flex_cost: 12.0,                 // custo médio da sua entrega Flex por pedido (R$)
  full_storage_cost: 0.0,          // armazenagem/serviço do Full por unidade (R$)
  own_shipping_cost: 0.0,          // custo do envio próprio por pedido, quando você paga (R$)
  shipping_discount_pct: 0.0,      // desconto de frete da sua reputação sobre a tabela (%)
  free_shipping_threshold: 79.0,   // a partir deste preço o frete grátis é obrigatório no Mercado Livre
  target_margin_pct: 20.0,         // margem líquida desejada
};

// Tabela de referência do frete grátis pago pelo vendedor no Mercado Livre, por peso (kg -> R$), já com o desconto
// típico de reputação verde. Valores aproximados: a loja pode trocar em `shipping_table` e, com conta conectada, o MAI
// consulta o valor real na API (/users/{id}/shipping_options/free).
export const SHIPPING_TABLE: [number, number][] = [[0.3, 19.95], [0.5, 21.45], [1, 22.45], [2, 23.45], [3, 24.95],
  [4, 26.95], [5, 28.45], [9, 44.45], [13, 68.45], [17, 73.95], [23, 84.95], [30, 98.95]];

/** Tarifa fixa por unidade do Mercado Livre para itens abaixo de R$ 79. */
export function mlFixedFee(price: number): number {
  if (price >= 79) return 0;
  if (price < 12.5) return round(price * 0.5, 2);
  if (price < 29) return 6.25;
  if (price < 50) return 6.5;
  return 6.75;
}
const FIXED_FEE_BREAKS = [12.5, 29, 50, 79];

export function tableShipping(weightG: number | null | undefined, table?: [number, number][] | null): number {
  const t = table && table.length ? table : SHIPPING_TABLE;
  const kg = (weightG || 500) / 1000;
  for (const [limit, cost] of t) if (kg <= limit) return cost;
  return t[t.length - 1][1];
}

export interface CostInputs {
  cost_price: number;
  weight_g?: number | null;
  dimensions_cm?: string | null;
  commission_pct?: number | null;   // se vazio, vem do marketplace
  shipping_cost?: number | null;    // se vazio, calcula pela modalidade
  packaging_cost?: number | null;   // se vazio, usa o perfil da loja
}

export type FeesFn = (price: number, listingType: string) => Promise<FeeQuote>;
export type ShippingFn = (price: number, weightG: number, dims: string | null, listingType: string) => Promise<number | null>;

const isSet = (v: any) => v !== null && v !== undefined;

export class CostCalculator {
  readonly profile: Record<string, any>;
  private commission = new Map<string, [number, string]>();
  private freeShipping = new Map<string, [number, string]>();

  constructor(profile?: Record<string, any> | null, private feesFn?: FeesFn | null, private shippingFn?: ShippingFn | null) {
    const clean = Object.fromEntries(Object.entries(profile || {}).filter(([, v]) => isSet(v)));
    this.profile = { ...DEFAULT_PROFILE, ...clean };
  }

  /** Consulta comissão e frete no marketplace (uma vez por tipo de anúncio). Sem conta, fica a estimativa local. */
  async prepare(inputs: CostInputs, refPrice: number, listingTypes = ["gold_special", "gold_pro"]): Promise<this> {
    const ref = Math.max(refPrice, 100);
    await Promise.all(listingTypes.map(async (lt) => {
      if (!isSet(inputs.commission_pct) && !this.commission.has(lt)) {
        let pct = lt === "gold_special" ? 11.5 : 16.5, src = "estimativa";
        if (this.feesFn) {
          try { const q = await this.feesFn(ref, lt); pct = round(100 * q.commission / ref, 2); src = q.source; } catch { /* fica a estimativa */ }
        }
        this.commission.set(lt, [pct, src]);
      }
      const key = this.shipKey(inputs, lt);
      if (!this.freeShipping.has(key)) {
        let cost = tableShipping(inputs.weight_g, this.profile.shipping_table), src = "estimativa";
        if (this.shippingFn) {
          try {
            const api = await this.shippingFn(Math.max(refPrice, this.profile.free_shipping_threshold), inputs.weight_g || 500,
              inputs.dimensions_cm || null, lt);
            if (isSet(api)) { cost = api as number; src = "api"; }
          } catch { /* fica a estimativa */ }
        }
        if (src === "estimativa") cost = cost * (1 - this.profile.shipping_discount_pct / 100);
        this.freeShipping.set(key, [round(cost, 2), src]);
      }
    }));
    return this;
  }

  private shipKey(inputs: CostInputs, lt: string) {
    return `${inputs.weight_g ?? ""}|${inputs.dimensions_cm ?? ""}|${lt}`;
  }

  commissionPct(lt: string, inputs: CostInputs): [number, string] {
    if (isSet(inputs.commission_pct)) return [inputs.commission_pct as number, "informado"];
    return this.commission.get(lt) || [lt === "gold_special" ? 11.5 : 16.5, "estimativa"];
  }

  freeShippingCost(inputs: CostInputs, lt: string): [number, string] {
    const hit = this.freeShipping.get(this.shipKey(inputs, lt));
    if (hit) return hit;
    const cost = tableShipping(inputs.weight_g, this.profile.shipping_table) * (1 - this.profile.shipping_discount_pct / 100);
    return [round(cost, 2), "estimativa"];
  }

  /** [custo, fonte, explicação] do frete pago pelo vendedor por unidade. */
  shippingFor(price: number, mode: string, inputs: CostInputs, lt: string): [number, string, string] {
    const p = this.profile;
    if (isSet(inputs.shipping_cost)) return [inputs.shipping_cost as number, "informado", "Frete informado na simulação"];
    if (mode === "proprio") return [p.own_shipping_cost, "perfil", "Envio próprio (custo do perfil da loja)"];
    if (mode === "flex") return [p.flex_cost, "perfil", "Entrega Flex feita por você (custo médio do perfil)"];
    if (price < p.free_shipping_threshold) return [0, "regra", `Abaixo de R$ ${Math.round(p.free_shipping_threshold)} o comprador paga o frete`];
    const [cost, src] = this.freeShippingCost(inputs, lt);
    if (mode === "full") return [round(cost + p.full_storage_cost, 2), src, "Frete grátis Full + armazenagem"];
    return [cost, src, "Frete grátis Mercado Envios (coleta/agência)"];
  }

  calculate(price: number, inputs: CostInputs, listingType?: string | null, mode?: string | null) {
    const p = this.profile;
    const lt: string = listingType || p.listing_type;
    const m: string = mode || p.shipping_mode;
    const [pct, pctSrc] = this.commissionPct(lt, inputs);
    const [ship, shipSrc, shipNote] = this.shippingFor(price, m, inputs, lt);
    const packaging = isSet(inputs.packaging_cost) ? (inputs.packaging_cost as number) : p.packaging_cost;
    const br = (v: number) => g(v).replace(".", ",");
    const items: [string, string, number, string][] = [
      ["product", "Custo do produto", inputs.cost_price, "informado"],
      ["commission", `Comissão ${LISTING_TYPES[lt] || lt} (${pct.toFixed(1).replace(".", ",")}%)`, price * pct / 100, pctSrc],
      ["fixed_fee", "Tarifa fixa do marketplace", mlFixedFee(price), "regra"],
      ["shipping", shipNote, ship, shipSrc],
      ["tax", `Impostos (${br(p.tax_pct)}%)`, price * p.tax_pct / 100, "perfil"],
      ["ads", `Mercado Ads (${br(p.ads_pct)}%)`, price * p.ads_pct / 100, "perfil"],
      ["installments", `Parcelamento (${br(p.installment_pct)}%)`, price * p.installment_pct / 100, "perfil"],
      ["other_pct", `Outros (${br(p.other_cost_pct)}%)`, price * p.other_cost_pct / 100, "perfil"],
      ["packaging", "Embalagem", packaging, "perfil"],
      ["other_fixed", "Outros custos por unidade", p.other_cost_fixed, "perfil"],
    ];
    const breakdown = items.filter(([k, , v]) => v || ["product", "commission", "shipping"].includes(k)).map(([key, label, v, source]) => (
      { key, label, value: round(v, 2), pct_of_price: price ? round(100 * v / price, 1) : 0, source }));
    const total = round(sum(breakdown.map((b) => b.value)), 2);
    const profit = round(price - total, 2);
    const received = round(price - sum(breakdown.filter((b) => ["commission", "fixed_fee", "shipping"].includes(b.key)).map((b) => b.value)), 2);
    return {
      price: round(price, 2), listing_type: lt, listing_type_label: LISTING_TYPES[lt] || lt,
      shipping_mode: m, shipping_mode_label: SHIPPING_MODES[m] || m,
      breakdown, total_costs: total,
      marketplace_payout: received,   // o que o marketplace repassa (preço - comissão - tarifa - frete)
      profit,
      margin_pct: price ? round(100 * profit / price, 1) : 0,
      roi_pct: inputs.cost_price ? round(100 * profit / inputs.cost_price, 1) : null,
      markup: inputs.cost_price ? round(price / inputs.cost_price, 2) : null,
    };
  }

  /** Menor preço (em centavos) que atinge a margem alvo; null se nenhum até 20x o custo.
   *
   * O lucro é linear por trechos: só muda de inclinação nas faixas da tarifa fixa (12,50 / 29 / 50 / 79) e no limite
   * do frete grátis, onde o frete entra e o lucro cai. Em cada trecho a conta resolve a equação direto e confere os
   * centavos vizinhos, em vez de testar preço por preço (o plano grátis da Cloudflare dá poucos milissegundos). */
  priceForMargin(targetPct: number, inputs: CostInputs, listingType?: string | null, mode?: string | null): number | null {
    // compara o lucro sem arredondar a margem (19,95% não conta como 20%)
    const gap = (price: number) => this.calculate(price, inputs, listingType, mode).profit - price * targetPct / 100;
    const ok = (price: number) => gap(price) >= -1e-9;
    const cents = (x: number) => Math.round(x * 100);
    const lo = cents(Math.max(0.5, round(inputs.cost_price, 2)));
    const hi = cents(inputs.cost_price * 20 + 50);
    const breaks = [...FIXED_FEE_BREAKS, this.profile.free_shipping_threshold].map((b) => Math.ceil(b * 100 - 1e-6))
      .filter((b) => b > lo && b <= hi).sort((a, b) => a - b);
    const starts = [lo, ...new Set(breaks)];
    for (let i = 0; i < starts.length; i++) {
      const a = starts[i], b = (i + 1 < starts.length ? starts[i + 1] : hi + 1) - 1;   // trecho [a, b] em centavos
      if (b < a) continue;
      if (ok(a / 100)) return a / 100;
      if (!ok(b / 100)) continue;
      // raiz por interpolação linear e ajuste fino (arredondamentos de centavo)
      const ga = gap(a / 100), gb = gap(b / 100);
      let c = Math.min(b, Math.max(a + 1, Math.ceil(a + (b - a) * (-ga) / (gb - ga))));
      for (let n = 0; n < 200 && c > a + 1 && ok((c - 1) / 100); n++) c--;
      for (let n = 0; n < 200 && c < b && !ok(c / 100); n++) c++;
      if (!ok(c / 100)) c = b;
      // garante o menor centavo do trecho: o arredondamento de cada custo pode alternar sim/não perto da raiz
      let best = c;
      for (let d = c - 1; d > a && d >= c - 10; d--) if (ok(d / 100)) best = d;
      return best / 100;
    }
    return null;
  }

  /** Resultado completo para a tela: cálculo no preço, equilíbrio, preço alvo e cenários comparados. */
  report(price: number, inputs: CostInputs, targetPct?: number | null) {
    const target = isSet(targetPct) ? (targetPct as number) : this.profile.target_margin_pct;
    const main = this.calculate(price, inputs);
    const scenarios: Record<string, any>[] = [];
    for (const lt of ["gold_special", "gold_pro"]) {
      for (const mode of ["coleta", "full", "flex"]) {
        const r = this.calculate(price, inputs, lt, mode);
        scenarios.push({ listing_type: r.listing_type, listing_type_label: r.listing_type_label, shipping_mode: r.shipping_mode,
          shipping_mode_label: r.shipping_mode_label, total_costs: r.total_costs, profit: r.profit, margin_pct: r.margin_pct });
      }
    }
    return {
      ...main,
      break_even_price: this.priceForMargin(0, inputs),
      target_margin_pct: target,
      price_for_target: this.priceForMargin(target, inputs),
      scenarios,
      profile: this.profile,
    };
  }
}

/** Adapta a calculadora ao `recommendPrice`: custos variáveis completos (sem o custo do produto). */
export function asFeeFn(calc: CostCalculator, inputs: CostInputs): (price: number) => FeeQuote {
  return (price: number) => {
    const r = calc.calculate(price, inputs);
    const commission = sum(r.breakdown.filter((b) => b.key === "commission").map((b) => b.value));
    const others = sum(r.breakdown.filter((b) => b.key !== "commission" && b.key !== "product").map((b) => b.value));
    return { commission: round(commission, 2), fixed_fee: round(others, 2), source: "calculado" };
  };
}
