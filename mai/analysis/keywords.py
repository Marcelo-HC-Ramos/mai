"""UC07: palavras-chave mais usadas para buscar o produto.

Combina duas fontes:
  1. tendências de busca da categoria no marketplace (ordem = relevância informada pela plataforma);
  2. termos dos títulos dos concorrentes, ponderados pelas vendas (o que vende é o que é encontrado).
A pontuação final é relativa (0-100): o Mercado Livre não divulga volume absoluto de buscas.
Se o vendedor importar volumes (Keyword Planner, Mercado Ads), eles entram em `monthly_volume`.
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict
from typing import Optional

from ..connectors.base import CompetitorListing
from ..textutil import ngrams, normalize, tokens


def _related(term: str, product_tokens: set[str]) -> bool:
    return bool(set(tokens(term)) & product_tokens)


def keyword_insights(product_title: str, competitors: list[CompetitorListing], trends: list[str],
                     seller_volumes: Optional[dict[str, int]] = None, top_n: int = 15) -> dict:
    product_tokens = set(tokens(product_title))
    scores: dict[str, float] = defaultdict(float)
    sources: dict[str, set[str]] = defaultdict(set)

    # 1) tendências da categoria: os primeiros da lista valem mais
    related_trends = [t for t in trends if _related(t, product_tokens)]
    for rank, term in enumerate(related_trends):
        key = normalize(term)
        scores[key] += 60 * (1 - rank / max(len(related_trends), 1)) + 20
        sources[key].add("tendencias_marketplace")

    # 2) títulos dos concorrentes ponderados por vendas
    counts: Counter = Counter()
    for c in competitors:
        weight = 1 + math.log1p(c.sold_quantity)
        words = tokens(c.title)
        seen = set()
        for n in (1, 2, 3):
            for g in ngrams(words, n):
                if g not in seen:
                    counts[g] += weight * (1 + 0.6 * (n - 1))
                    seen.add(g)
    if counts:
        top = counts.most_common(1)[0][1]
        for term, c in counts.items():
            if len(term) < 3:
                continue
            scores[term] += 50 * c / top
            sources[term].add("titulos_concorrentes")

    # remove termos de 1 palavra cobertos por uma expressão mais forte
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    final: list[tuple[str, float]] = []
    for term, s in ranked:
        if " " not in term and any(term in t.split() and s2 >= s * 0.8 for t, s2 in final):
            continue
        final.append((term, s))
        if len(final) >= top_n:
            break

    best = final[0][1] if final else 1
    title_tokens = set(normalize(product_title).split())
    seller_volumes = {normalize(k): v for k, v in (seller_volumes or {}).items()}
    keywords = [{
        "term": term,
        "score": round(100 * s / best),
        "monthly_volume": seller_volumes.get(term),
        "in_my_title": set(term.split()) <= title_tokens,
        "sources": sorted(sources[term]),
    } for term, s in final]
    return {
        "top_keywords": keywords,
        "missing_in_title": [k["term"] for k in keywords if not k["in_my_title"] and k["score"] >= 40][:5],
        "category_trends": trends[:20],
        "source": "vendedor" if seller_volumes else "calculado",
        "note": "Pontuação relativa (0-100). O marketplace não divulga volume absoluto de buscas.",
    }
