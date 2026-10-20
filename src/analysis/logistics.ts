// Full x Flex x Coleta x Envio próprio dos concorrentes (parâmetro da análise de concorrência).
//
// Responde: quantos concorrentes estão no Full ou no Flex, quanto vendem e a que preço, e se o vendedor está
// competindo com a mesma logística dos líderes. Os dados vêm da API do marketplace (`shipping.logistic_type`).
import { SHIPPING_MODES, type CompetitorListing } from "../connectors/base";
import { median, round, sum } from "../lib/num";

export const MODES = ["full", "flex", "coleta", "proprio", "desconhecido"];

/** Parâmetro da análise: limita os concorrentes às modalidades escolhidas (ex.: só quem está no Full). */
export function filterByModes(listings: CompetitorListing[], modes?: string[] | null): CompetitorListing[] {
  const wanted = new Set((modes || []).filter((m) => MODES.includes(m)));
  return wanted.size ? listings.filter((l) => wanted.has(l.shipping_mode)) : [...listings];
}

export function logisticsInsights(listings: CompetitorListing[], myMode?: string | null, topN = 10): Record<string, any> {
  const total = listings.length || 1;
  const totalSold = sum(listings.map((l) => l.sold_quantity)) || 1;
  const byMode: Record<string, any>[] = [];
  for (const mode of MODES) {
    const group = listings.filter((l) => l.shipping_mode === mode);
    if (!group.length) continue;
    const sold = sum(group.map((l) => l.sold_quantity));
    byMode.push({
      mode, label: SHIPPING_MODES[mode], listings: group.length,
      share_pct: round(100 * group.length / total, 1),
      sales_share_pct: round(100 * sold / totalSold, 1),
      median_price: round(median(group.map((l) => l.price)), 2),
      avg_sold: round(sold / group.length, 1),
    });
  }
  const top = [...listings].sort((a, b) => b.sold_quantity - a.sold_quantity).slice(0, topN);
  const topCounts: Record<string, number> = {};
  for (const m of MODES) topCounts[m] = top.filter((l) => l.shipping_mode === m).length;
  let leader: string | null = null;
  if (top.length) for (const m of MODES) if (leader === null || topCounts[m] > topCounts[leader]) leader = m;
  const full = byMode.find((m) => m.mode === "full");
  const others = listings.filter((l) => l.shipping_mode !== "full").map((l) => l.price);
  const topSellersModes: Record<string, number> = {};
  for (const m of MODES) if (topCounts[m]) topSellersModes[SHIPPING_MODES[m]] = topCounts[m];
  return {
    by_mode: byMode.sort((a, b) => b.listings - a.listings),
    top_sellers_modes: topSellersModes,
    leader_mode: leader,
    leader_mode_label: leader ? SHIPPING_MODES[leader] || "" : "",
    full_share_top_pct: top.length ? round(100 * topCounts.full / top.length, 1) : 0,
    flex_share_top_pct: top.length ? round(100 * topCounts.flex / top.length, 1) : 0,
    // quanto o Full cobra a mais (ou a menos) que o resto do mercado, pela mediana
    full_price_premium_pct: full && others.length ? round(100 * (full.median_price / median(others) - 1), 1) : null,
    my_mode: myMode ?? null, my_mode_label: SHIPPING_MODES[myMode || ""] || "",
    source: "api",
  };
}
