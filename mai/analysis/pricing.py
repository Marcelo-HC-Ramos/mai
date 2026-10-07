"""UC06 (preços dos concorrentes) e UC10 (melhor preço de venda)."""
from __future__ import annotations

import math
import statistics
from typing import Callable, Optional

from ..connectors.base import CompetitorListing, FeeQuote


def _quantile(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    pos = (len(sorted_vals) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def remove_outliers_iqr(listings: list[CompetitorListing], factor: float = 1.5):
    """RN03: remove preços fora de [Q1 - 1,5·IQR, Q3 + 1,5·IQR]. Retorna (mantidos, descartados)."""
    prices = sorted(l.price for l in listings)
    if len(prices) < 4:
        return list(listings), []
    q1, q3 = _quantile(prices, 0.25), _quantile(prices, 0.75)
    iqr = q3 - q1
    lo, hi = q1 - factor * iqr, q3 + factor * iqr
    kept = [l for l in listings if lo <= l.price <= hi]
    return kept, [l for l in listings if not (lo <= l.price <= hi)]


def competitor_stats(listings: list[CompetitorListing], my_price: Optional[float] = None) -> dict:
    kept, dropped = remove_outliers_iqr(listings)
    prices = sorted(l.price for l in kept)
    if not prices:
        return {"total_competitors_found": 0, "confidence": "baixa", "source": "api"}
    free = [l for l in kept if l.free_shipping]
    best_seller = max(kept, key=lambda l: l.sold_quantity)
    stats = {
        "total_competitors_found": len(listings),
        "competitors_used": len(kept),
        "outliers_removed": len(dropped),
        "lowest_price": prices[0],
        "q1_price": round(_quantile(prices, 0.25), 2),
        "median_price": round(_quantile(prices, 0.5), 2),
        "average_price": round(statistics.fmean(prices), 2),
        "q3_price": round(_quantile(prices, 0.75), 2),
        "highest_price": prices[-1],
        "std_dev": round(statistics.pstdev(prices), 2),
        "free_shipping_share_pct": round(100 * len(free) / len(kept), 1),
        "lowest_free_shipping_price": min((l.price for l in free), default=None),
        "best_seller": best_seller.to_dict(),
        "top_competitors": [l.to_dict() for l in sorted(kept, key=lambda l: (-l.sold_quantity, l.price))[:10]],
        "price_distribution": prices,
        "confidence": "alta" if len(kept) >= 10 else "media" if len(kept) >= 3 else "baixa",
        "source": "api",
    }
    if my_price:
        below = sum(1 for p in prices if p < my_price)
        stats["my_price"] = my_price
        stats["my_price_percentile"] = round(100 * below / len(prices), 1)
        stats["diff_to_median"] = round(my_price - stats["median_price"], 2)
        stats["diff_to_lowest"] = round(my_price - prices[0], 2)
    return stats


def _psychological(price: float) -> float:
    """Arredonda para o final ,90 mais próximo abaixo (ex.: 233,47 -> 232,90)."""
    base = math.floor(price)
    candidate = base + 0.90
    return round(candidate if candidate <= price else base - 0.10, 2)


def conversion_score(price: float, median: float, n_competitors: int, std: float) -> float:
    """Chance relativa de conversão (0-1) pela posição do preço frente à mediana.

    Curva logística: preço na mediana = 0,5. Quanto mais concorrentes e menor a dispersão, mais o comprador
    compara preços e mais íngreme a curva. É um modelo de apoio à decisão, não uma previsão de vendas.
    """
    spread = max(std, median * 0.03)
    steepness = 1.5 + min(n_competitors, 50) / 25
    return 1 / (1 + math.exp(steepness * (price - median) / spread))


def recommend_price(stats: dict, cost: Optional[float], min_selling_price: Optional[float],
                    fee_fn: Callable[[float], FeeQuote], min_margin_pct: float = 15.0,
                    current_price: Optional[float] = None) -> dict:
    """UC10: escolhe o preço de maior lucro esperado respeitando a margem mínima (RN02)."""
    if not stats.get("competitors_used"):
        return {"recommended_price": current_price, "strategy": "sem_dados", "source": "calculado",
                "warnings": ["Sem concorrentes suficientes para recomendar preço."]}

    median, std, n = stats["median_price"], stats["std_dev"], stats["competitors_used"]
    warnings: list[str] = []

    def margin(price: float) -> Optional[float]:
        if cost is None:
            return None
        fee = fee_fn(price)
        return price - cost - fee.total

    def floor_ok(price: float) -> bool:
        if min_selling_price and price < min_selling_price:
            return False
        m = margin(price)
        return m is None or m >= price * min_margin_pct / 100

    lo = min(stats["q1_price"], stats["lowest_price"] * 0.98)
    hi = stats["q3_price"]
    candidates = sorted({_psychological(lo + (hi - lo) * i / 60) for i in range(61)})
    rows = []
    for price in candidates:
        if price <= 0:
            continue
        conv = conversion_score(price, median, n, std)
        m = margin(price)
        rows.append({"price": price, "conversion": round(conv, 3),
                     "unit_margin": round(m, 2) if m is not None else None,
                     "expected_profit": round(conv * m, 3) if m is not None else None,
                     "allowed": floor_ok(price)})
    allowed = [r for r in rows if r["allowed"]]

    min_allowed = None
    if cost is not None:
        # menor preço que respeita RN02 (busca em passos de R$ 0,10)
        p = max(cost, min_selling_price or 0)
        while not floor_ok(p) and p < cost * 10:
            p = round(p + 0.10, 2)
        min_allowed = round(p, 2)
    elif min_selling_price:
        min_allowed = min_selling_price

    if cost is None:
        warnings.append("Custo do produto não cadastrado: a margem não pôde ser verificada.")
        best = _psychological(median * 0.98)
        if min_selling_price and best < min_selling_price:
            best = min_selling_price
        strategy = "posicao_de_mercado"
    elif not allowed:
        best = min_allowed
        strategy = "preco_minimo"
        warnings.append("Nenhum preço competitivo respeita a margem mínima. Revise custo ou fornecedor.")
    else:
        best = max(allowed, key=lambda r: r["expected_profit"])["price"]
        strategy = "lucro_esperado"

    competitive = _psychological(stats["lowest_free_shipping_price"] or stats["lowest_price"])
    if min_allowed and competitive < min_allowed:
        competitive = min_allowed
    result = {
        "recommended_price": best,
        "strategy": strategy,
        "competitive_price": competitive,
        "max_margin_price": max((r["price"] for r in allowed), default=best),
        "min_allowed_price": min_allowed,
        "min_margin_pct": min_margin_pct,
        "fees_at_recommended": vars(fee_fn(best)) if best else None,
        "margin_at_recommended": round(margin(best), 2) if best and cost is not None else None,
        "margin_pct_at_recommended": round(100 * margin(best) / best, 1) if best and cost is not None else None,
        "curve": rows,
        "warnings": warnings,
        "source": "calculado",
    }
    if current_price:
        result["current_price"] = current_price
        result["change_vs_current"] = round(best - current_price, 2) if best else None
    return result
