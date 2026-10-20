// UC07: palavras-chave mais usadas para buscar o produto.
//
// Combina duas fontes:
//   1. tendências de busca da categoria no marketplace (ordem = relevância informada pela plataforma);
//   2. termos dos títulos dos concorrentes, ponderados pelas vendas (o que vende é o que é encontrado).
// A pontuação final é relativa (0-100): o Mercado Livre não divulga volume absoluto de buscas.
// Se o vendedor importar volumes (Keyword Planner, Mercado Ads), eles entram em `monthly_volume`.
import type { CompetitorListing } from "../connectors/base";
import { ngrams, normalize, tokens } from "../lib/text";

const related = (term: string, productTokens: Set<string>) => tokens(term).some((t) => productTokens.has(t));

export function keywordInsights(productTitle: string, competitors: CompetitorListing[], trends: string[],
  sellerVolumes?: Record<string, number> | null, topN = 15): Record<string, any> {
  const productTokens = new Set(tokens(productTitle));
  const scores = new Map<string, number>();
  const sources = new Map<string, Set<string>>();
  const add = (term: string, s: number, src: string) => {
    scores.set(term, (scores.get(term) || 0) + s);
    if (!sources.has(term)) sources.set(term, new Set());
    sources.get(term)!.add(src);
  };

  // 1) tendências da categoria: os primeiros da lista valem mais
  const relatedTrends = trends.filter((t) => related(t, productTokens));
  relatedTrends.forEach((term, rank) => add(normalize(term), 60 * (1 - rank / Math.max(relatedTrends.length, 1)) + 20, "tendencias_marketplace"));

  // 2) títulos dos concorrentes ponderados por vendas
  const counts = new Map<string, number>();
  for (const c of competitors) {
    const weight = 1 + Math.log1p(c.sold_quantity);
    const words = tokens(c.title);
    const seen = new Set<string>();
    for (const n of [1, 2, 3]) {
      for (const gram of ngrams(words, n)) {
        if (!seen.has(gram)) { counts.set(gram, (counts.get(gram) || 0) + weight * (1 + 0.6 * (n - 1))); seen.add(gram); }
      }
    }
  }
  if (counts.size) {
    const top = Math.max(...counts.values());
    for (const [term, c] of counts) if (term.length >= 3) add(term, 50 * c / top, "titulos_concorrentes");
  }

  // remove termos de 1 palavra cobertos por uma expressão mais forte
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const final: [string, number][] = [];
  for (const [term, s] of ranked) {
    if (!term.includes(" ") && final.some(([t, s2]) => t.split(" ").includes(term) && s2 >= s * 0.8)) continue;
    final.push([term, s]);
    if (final.length >= topN) break;
  }

  const best = final.length ? final[0][1] : 1;
  const titleTokens = new Set(normalize(productTitle).split(" "));
  const volumes: Record<string, number> = {};
  for (const [k, v] of Object.entries(sellerVolumes || {})) volumes[normalize(k)] = v;
  const hasVolumes = Object.keys(volumes).length > 0;
  const keywords = final.map(([term, s]) => ({
    term,
    score: Math.round(100 * s / best),
    monthly_volume: volumes[term] ?? null,
    in_my_title: term.split(" ").every((w) => titleTokens.has(w)),
    sources: [...(sources.get(term) || [])].sort(),
  }));
  return {
    top_keywords: keywords,
    missing_in_title: keywords.filter((k) => !k.in_my_title && k.score >= 40).map((k) => k.term).slice(0, 5),
    category_trends: trends.slice(0, 20),
    source: hasVolumes ? "vendedor" : "calculado",
    note: "Pontuação relativa (0-100). O marketplace não divulga volume absoluto de buscas.",
  };
}
