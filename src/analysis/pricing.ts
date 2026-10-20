// UC06 (preços dos concorrentes) e UC10 (melhor preço de venda).
import type { CompetitorListing, FeeQuote } from "../connectors/base";
import { feeTotal } from "../connectors/base";
import { mean, pstdev, quantile, round } from "../lib/num";

/** RN03: remove preços fora de [Q1 - 1,5·IQR, Q3 + 1,5·IQR]. Retorna [mantidos, descartados]. */
export function removeOutliersIqr(listings: CompetitorListing[], factor = 1.5): [CompetitorListing[], CompetitorListing[]] {
  const prices = listings.map((l) => l.price).sort((a, b) => a - b);
  if (prices.length < 4) return [[...listings], []];
  const q1 = quantile(prices, 0.25), q3 = quantile(prices, 0.75), iqr = q3 - q1;
  const lo = q1 - factor * iqr, hi = q3 + factor * iqr;
  const inside = (l: CompetitorListing) => lo <= l.price && l.price <= hi;
  return [listings.filter(inside), listings.filter((l) => !inside(l))];
}

export function competitorStats(listings: CompetitorListing[], myPrice?: number | null): Record<string, any> {
  const [kept, dropped] = removeOutliersIqr(listings);
  const prices = kept.map((l) => l.price).sort((a, b) => a - b);
  if (!prices.length) return { total_competitors_found: 0, confidence: "baixa", source: "api" };
  const free = kept.filter((l) => l.free_shipping);
  const bestSeller = kept.reduce((a, b) => (b.sold_quantity > a.sold_quantity ? b : a));
  const stats: Record<string, any> = {
    total_competitors_found: listings.length,
    competitors_used: kept.length,
    outliers_removed: dropped.length,
    lowest_price: prices[0],
    q1_price: round(quantile(prices, 0.25), 2),
    median_price: round(quantile(prices, 0.5), 2),
    average_price: round(mean(prices), 2),
    q3_price: round(quantile(prices, 0.75), 2),
    highest_price: prices[prices.length - 1],
    std_dev: round(pstdev(prices), 2),
    free_shipping_share_pct: round(100 * free.length / kept.length, 1),
    lowest_free_shipping_price: free.length ? Math.min(...free.map((l) => l.price)) : null,
    best_seller: { ...bestSeller },
    top_competitors: [...kept].sort((a, b) => b.sold_quantity - a.sold_quantity || a.price - b.price).slice(0, 10).map((l) => ({ ...l })),
    price_distribution: prices,
    confidence: kept.length >= 10 ? "alta" : kept.length >= 3 ? "media" : "baixa",
    source: "api",
  };
  if (myPrice) {
    const below = prices.filter((p) => p < myPrice).length;
    stats.my_price = myPrice;
    stats.my_price_percentile = round(100 * below / prices.length, 1);
    stats.diff_to_median = round(myPrice - stats.median_price, 2);
    stats.diff_to_lowest = round(myPrice - prices[0], 2);
  }
  return stats;
}

/** Arredonda para o final ,90 mais próximo abaixo (ex.: 233,47 -> 232,90). */
export function psychological(price: number): number {
  const base = Math.floor(price);
  const candidate = base + 0.9;
  return round(candidate <= price ? candidate : base - 0.1, 2);
}

/** Chance relativa de conversão (0-1) pela posição do preço frente à mediana.
 * Curva logística: preço na mediana = 0,5. Quanto mais concorrentes e menor a dispersão, mais o comprador compara
 * preços e mais íngreme a curva. É um modelo de apoio à decisão, não uma previsão de vendas. */
export function conversionScore(price: number, median: number, nCompetitors: number, std: number): number {
  const spread = Math.max(std, median * 0.03);
  const steepness = 1.5 + Math.min(nCompetitors, 50) / 25;
  return 1 / (1 + Math.exp(steepness * (price - median) / spread));
}

/** Menor preço da grade `start + R$ 0,10·k` aceito por `ok` (para em `limit`). A margem só cresce com o preço dentro de
 * cada faixa de tarifa; nas viradas (12,50 / 29 / 50 / 79) ela pode cair. Por isso a busca anda de R$ 1 em R$ 1,
 * testa o ponto logo antes de cada virada e refina de 10 em 10 centavos só no trecho encontrado. */
export function minAllowedPrice(start: number, limit: number, ok: (p: number) => boolean): number {
  const at = (k: number) => round(start + k * 0.1, 2);
  if (ok(at(0))) return at(0);
  const maxK = Math.max(0, Math.ceil((limit - start) / 0.1 - 1e-9));
  for (let k = 0; k < maxK; k += 10) {
    const next = Math.min(k + 10, maxK);
    const brk = [12.5, 29, 50, 79].find((b) => at(k) < b && b <= at(next));
    if (brk !== undefined) {
      const before = Math.ceil((brk - start) / 0.1 - 1e-9) - 1;   // último ponto da grade antes da virada
      if (before > k && ok(at(before))) return at(refine(k, before));
    }
    if (ok(at(next))) return at(refine(k, next));
  }
  return at(maxK);

  function refine(failK: number, okK: number): number {
    for (let k = failK + 1; k < okK; k++) if (ok(at(k))) return k;
    return okK;
  }
}

/** UC10: escolhe o preço de maior lucro esperado respeitando a margem mínima (RN02). */
export function recommendPrice(stats: Record<string, any>, cost: number | null | undefined, minSellingPrice: number | null | undefined,
  feeFn: (price: number) => FeeQuote, minMarginPct = 15, currentPrice?: number | null): Record<string, any> {
  if (!stats.competitors_used) {
    return { recommended_price: currentPrice ?? null, strategy: "sem_dados", source: "calculado",
      warnings: ["Sem concorrentes suficientes para recomendar preço."] };
  }
  const hasCost = cost !== null && cost !== undefined;
  const median = stats.median_price, std = stats.std_dev, n = stats.competitors_used;
  const warnings: string[] = [];
  const margin = (price: number): number | null => (hasCost ? price - (cost as number) - feeTotal(feeFn(price)) : null);
  const floorOk = (price: number) => {
    if (minSellingPrice && price < minSellingPrice) return false;
    const m = margin(price);
    return m === null || m >= price * minMarginPct / 100;
  };

  const lo = Math.min(stats.q1_price, stats.lowest_price * 0.98), hi = stats.q3_price;
  const candidates = [...new Set(Array.from({ length: 61 }, (_, i) => psychological(lo + (hi - lo) * i / 60)))].sort((a, b) => a - b);
  const rows: Record<string, any>[] = [];
  for (const price of candidates) {
    if (price <= 0) continue;
    const conv = conversionScore(price, median, n, std);
    const m = margin(price);
    rows.push({ price, conversion: round(conv, 3), unit_margin: m !== null ? round(m, 2) : null,
      expected_profit: m !== null ? round(conv * m, 3) : null, allowed: floorOk(price) });
  }
  const allowed = rows.filter((r) => r.allowed);

  let minAllowed: number | null = null;
  if (hasCost) {
    minAllowed = minAllowedPrice(Math.max(cost as number, minSellingPrice || 0), (cost as number) * 10, floorOk);
  } else if (minSellingPrice) minAllowed = minSellingPrice;

  let best: number | null, strategy: string;
  if (!hasCost) {
    warnings.push("Custo do produto não cadastrado: a margem não pôde ser verificada.");
    best = psychological(median * 0.98);
    if (minSellingPrice && best < minSellingPrice) best = minSellingPrice;
    strategy = "posicao_de_mercado";
  } else if (!allowed.length) {
    best = minAllowed;
    strategy = "preco_minimo";
    warnings.push("Nenhum preço competitivo respeita a margem mínima. Revise custo ou fornecedor.");
  } else {
    best = allowed.reduce((a, b) => (b.expected_profit > a.expected_profit ? b : a)).price;
    strategy = "lucro_esperado";
  }

  let competitive = psychological(stats.lowest_free_shipping_price || stats.lowest_price);
  if (minAllowed && competitive < minAllowed) competitive = minAllowed;
  const mBest = best && hasCost ? margin(best) : null;
  const result: Record<string, any> = {
    recommended_price: best,
    strategy,
    competitive_price: competitive,
    max_margin_price: allowed.length ? Math.max(...allowed.map((r) => r.price)) : best,
    min_allowed_price: minAllowed,
    min_margin_pct: minMarginPct,
    fees_at_recommended: best ? { ...feeFn(best) } : null,
    margin_at_recommended: mBest !== null ? round(mBest, 2) : null,
    margin_pct_at_recommended: mBest !== null && best ? round(100 * mBest / best, 1) : null,
    curve: rows,
    warnings,
    source: "calculado",
  };
  if (currentPrice) {
    result.current_price = currentPrice;
    result.change_vs_current = best ? round(best - currentPrice, 2) : null;
  }
  return result;
}
