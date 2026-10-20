// UC15-UC17: análise de anúncios no estilo das ferramentas de inteligência de vendedor (ex.: Genius Pro).
//
// - Raio-x de um anúncio: vendas e faturamento estimados (por mês e acumulado), idade, visitas e conversão,
//   Full/Flex, tipo de anúncio, nota de qualidade com checklist e palavras-chave associadas.
// - Pesquisa de mercado por termo: tamanho do mercado nos anúncios encontrados, concentração, preços, logística,
//   lojas oficiais e ranking de vendedores por faturamento estimado.
// - Monitoramento: fotos diárias de preço e vendidos de anúncios escolhidos, que transformam estimativa em cálculo.
//
// Regra de transparência (RN01/RN11): faturamento de concorrente é sempre estimativa (vendidos x preço atual);
// com monitoramento de pelo menos duas fotos, o número passa a ser "calculado" pela diferença de vendidos.
import { LISTING_TYPES, SHIPPING_MODES, type CompetitorListing, type ItemDetails } from "../connectors/base";
import { mean, median, round, sum } from "../lib/num";
import { normalize, tokens } from "../lib/text";
import { DAY, toDate } from "../lib/time";
import { keywordInsights } from "./keywords";

const ID_RE = /\b(M[A-Z]{2})-?(\d{6,})\b/i;

/** Aceita o código (MLB123...), o link do anúncio ou o link com ?item_id= / wid=. */
export function parseItemId(text: string): string {
  text = (text || "").trim();
  if (text.startsWith("http")) {
    let url: URL;
    try { url = new URL(text); } catch { return text; }
    for (const key of ["item_id", "wid"]) {
      const v = url.searchParams.get(key);
      if (v) return v.replace(/-/g, "").toUpperCase();
    }
    const m = url.pathname.match(ID_RE);
    if (m) return (m[1] + m[2]).toUpperCase();
    return url.pathname.replace(/\/+$/, "").split("/").pop()!.toUpperCase();
  }
  const m = text.match(new RegExp(`^${ID_RE.source}$`, "i"));
  return m ? (m[1] + m[2]).toUpperCase() : text;
}

export interface HistoryPoint { captured_at: string | Date; sold_quantity: number | null; price?: number | null }

/** Vendas e faturamento. `history`: fotos do monitoramento em ordem de data. */
export function estimateSales(d: ItemDetails, history?: HistoryPoint[] | null, now: Date = new Date()): Record<string, any> {
  const created = toDate(d.date_created);
  const ageDays = created ? Math.max(1, Math.floor((now.getTime() - created.getTime()) / DAY)) : null;
  const monthly = ageDays ? d.sold_quantity * 30 / ageDays : null;
  const out: Record<string, any> = {
    age_days: ageDays,
    sold_total: d.sold_quantity,
    revenue_total_estimate: round(d.sold_quantity * d.price, 2),
    monthly_units: monthly !== null ? round(monthly, 1) : null,
    monthly_revenue: monthly !== null ? round(monthly * d.price, 2) : null,
    daily_units: monthly !== null ? round(monthly / 30, 2) : null,
    method: "media_desde_a_criacao",
    source: "estimativa",
    note: "Média desde a criação do anúncio, usando o preço atual. O ritmo recente pode ser diferente.",
  };
  const pts = (history || []).filter((p) => p.sold_quantity !== null && p.sold_quantity !== undefined);
  if (pts.length >= 2) {
    const first = pts[0], last = pts[pts.length - 1];
    const days = Math.max((toDate(last.captured_at)!.getTime() - toDate(first.captured_at)!.getTime()) / DAY, 1e-9);
    if (days >= 1) {
      let units = 0, revenue = 0;
      for (let i = 1; i < pts.length; i++) {
        const delta = Math.max(0, (pts[i].sold_quantity as number) - (pts[i - 1].sold_quantity as number));
        units += delta;
        revenue += delta * (pts[i].price || d.price);
      }
      Object.assign(out, {
        tracked_days: round(days, 1), tracked_units: Math.trunc(units), tracked_revenue: round(revenue, 2),
        monthly_units: round(units * 30 / days, 1), monthly_revenue: round(revenue * 30 / days, 2),
        daily_units: round(units / days, 2), method: "monitoramento", source: "calculado",
        note: `Calculado pela variação de vendidos em ${days.toFixed(0)} dia(s) de monitoramento.`,
      });
    }
  }
  if (d.visits_30d) {
    out.visits_30d = d.visits_30d;
    if (out.monthly_units !== null) out.conversion_pct = round(100 * Math.min(out.monthly_units, d.visits_30d) / d.visits_30d, 2);
  }
  return out;
}

/** Nota de 0 a 100 do anúncio, com o que falta para melhorar (Auditor de Qualidade). */
export function qualityScore(d: ItemDetails, strongTerms: string[]): Record<string, any> {
  const titleTokens = new Set(normalize(d.title).split(" "));
  const top5 = strongTerms.slice(0, 5);
  const used = top5.filter((t) => t.split(" ").every((w) => titleTokens.has(w)));
  const fill = d.attributes_total ? d.attributes_filled / d.attributes_total : 0;
  const checks: [string, string, number, boolean, string][] = [
    ["titulo", "Título entre 40 e 60 caracteres", 10, d.title.length >= 40 && d.title.length <= 60, `Seu título tem ${d.title.length} caracteres.`],
    ["palavras", "Usa as palavras-chave mais fortes", 15, used.length >= Math.min(3, top5.length), `Usa ${used.length} das ${top5.length} principais.`],
    ["fotos", "Pelo menos 6 fotos", 15, d.pictures >= 6, `${d.pictures} foto(s).`],
    ["video", "Tem vídeo ou clipe", 5, !!d.has_video, ""],
    ["ficha", "Ficha técnica 80% preenchida", 15, fill >= 0.8, `${Math.round(100 * fill)}% preenchida.`],
    ["descricao", "Descrição com pelo menos 500 caracteres", 10, d.description_length >= 500, `${d.description_length} caracteres.`],
    ["frete", "Frete grátis", 10, !!d.free_shipping, ""],
    ["logistica", "Full ou Flex (entrega rápida)", 10, ["full", "flex"].includes(d.shipping_mode), SHIPPING_MODES[d.shipping_mode] || ""],
    ["premium", "Anúncio Premium (parcelamento sem juros)", 5, d.listing_type === "gold_pro", LISTING_TYPES[d.listing_type] || d.listing_type],
    ["avaliacao", "Nota média 4,5 ou mais", 5, (d.rating_average || 0) >= 4.5, d.rating_average ? `Nota ${d.rating_average}` : "Sem avaliações."],
  ];
  const items = checks.map(([key, label, weight, ok, detail]) => ({ key, label, weight, ok, detail }));
  return { score: sum(items.filter((i) => i.ok).map((i) => i.weight)), checks: items };
}

export function analyzeAd(d: ItemDetails, competitors: CompetitorListing[], trends: string[], suggestions: string[],
  history?: HistoryPoint[] | null, now?: Date): Record<string, any> {
  const kw = keywordInsights(d.title, competitors, trends, null, 15);
  const strong: string[] = kw.top_keywords.map((k: any) => k.term);
  const titleTokens = new Set(tokens(d.title));
  const inTitle = (t: string) => t.split(" ").every((w) => titleTokens.has(w));
  const sugg = suggestions.slice(0, 10).map((s) => ({ term: s, in_title: tokens(s).every((w) => titleTokens.has(w)) }));
  const prices = competitors.map((c) => c.price).sort((a, b) => a - b);
  return {
    item: { ...d },
    listing_type_label: LISTING_TYPES[d.listing_type] || d.listing_type,
    shipping_mode_label: SHIPPING_MODES[d.shipping_mode] || d.shipping_mode,
    sales: estimateSales(d, history, now),
    quality: qualityScore(d, strong),
    keywords: {
      associated: kw.top_keywords,
      in_title: strong.filter(inTitle),
      missing: strong.filter((t) => !inTitle(t)).slice(0, 8),
      search_suggestions: sugg,
      source: "calculado",
    },
    market_position: {
      competitors: competitors.length,
      median_price: prices.length ? round(median(prices), 2) : null,
      price_percentile: prices.length ? round(100 * prices.filter((p) => p < d.price).length / prices.length, 1) : null,
    },
  };
}

/** Pesquisa de mercado por termo. `enriched`: {item_id: estimateSales(...)} dos principais anúncios. */
export function marketOverview(query: string, listings: CompetitorListing[], enriched?: Record<string, Record<string, any>> | null): Record<string, any> {
  enriched = enriched || {};
  if (!listings.length) return { query, listings: 0 };
  const rows = listings.map((l) => {
    const est = enriched![l.item_id] || {};
    return { ...l, revenue_total_estimate: round(l.sold_quantity * l.price, 2),
      monthly_units: est.monthly_units ?? null, monthly_revenue: est.monthly_revenue ?? null, age_days: est.age_days ?? null,
      shipping_mode_label: SHIPPING_MODES[l.shipping_mode] || l.shipping_mode,
      listing_type_label: LISTING_TYPES[l.listing_type] || l.listing_type };
  }).sort((a, b) => b.revenue_total_estimate - a.revenue_total_estimate);
  const totalRev = sum(rows.map((r) => r.revenue_total_estimate)) || 1;
  const top10 = sum(rows.slice(0, 10).map((r) => r.revenue_total_estimate));
  const prices = listings.map((l) => l.price);
  const sellers = new Map<string, { revenue: number; units: number; listings: number; official: boolean }>();
  for (const r of rows) {
    const key = r.seller_nickname || r.seller_id;
    const s = sellers.get(key) || { revenue: 0, units: 0, listings: 0, official: false };
    s.revenue += r.revenue_total_estimate; s.units += r.sold_quantity; s.listings += 1; s.official = s.official || r.official_store;
    sellers.set(key, s);
  }
  const sellerRank = [...sellers.entries()].map(([k, v]) => ({ seller: k, ...v, revenue: round(v.revenue, 2),
    share_pct: round(100 * v.revenue / totalRev, 1) })).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const monthlyKnown = rows.map((r) => r.monthly_revenue).filter((v): v is number => v !== null);
  const n = listings.length;
  const share = (f: (l: CompetitorListing) => boolean) => round(100 * listings.filter(f).length / n, 1);
  const concentration = round(100 * top10 / totalRev, 1);
  return {
    query,
    listings: n,
    units_total: sum(listings.map((l) => l.sold_quantity)),
    revenue_total_estimate: round(totalRev, 2),
    monthly_revenue_top_estimate: monthlyKnown.length ? round(sum(monthlyKnown), 2) : null,
    monthly_revenue_top_count: monthlyKnown.length,
    top10_concentration_pct: concentration,
    competition_level: concentration < 50 ? "alta" : concentration < 75 ? "média" : "concentrada",
    price: { min: Math.min(...prices), median: round(median(prices), 2), avg: round(mean(prices), 2), max: Math.max(...prices) },
    full_share_pct: share((l) => l.shipping_mode === "full"),
    flex_share_pct: share((l) => l.shipping_mode === "flex"),
    official_store_share_pct: share((l) => l.official_store),
    premium_share_pct: share((l) => l.listing_type === "gold_pro"),
    free_shipping_share_pct: share((l) => l.free_shipping),
    top_sellers: sellerRank,
    ads: rows,
    source: "estimativa",
    note: "Faturamento estimado por vendidos x preço atual dos anúncios encontrados na busca.",
  };
}
