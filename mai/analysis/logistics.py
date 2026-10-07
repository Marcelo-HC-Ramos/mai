"""Full x Flex x Coleta x Envio próprio dos concorrentes (parâmetro da análise de concorrência).

Responde: quantos concorrentes estão no Full ou no Flex, quanto vendem e a que preço, e se o vendedor está
competindo com a mesma logística dos líderes. Os dados vêm da API do marketplace (`shipping.logistic_type`).
"""
from __future__ import annotations

import statistics
from typing import Iterable, Optional

from ..connectors.base import SHIPPING_MODES, CompetitorListing

MODES = ("full", "flex", "coleta", "proprio", "desconhecido")


def filter_by_modes(listings: list[CompetitorListing], modes: Optional[Iterable[str]]) -> list[CompetitorListing]:
    """Parâmetro da análise: limita os concorrentes às modalidades escolhidas (ex.: só quem está no Full)."""
    wanted = {m for m in (modes or []) if m in MODES}
    return [l for l in listings if l.shipping_mode in wanted] if wanted else list(listings)


def logistics_insights(listings: list[CompetitorListing], my_mode: Optional[str] = None, top_n: int = 10) -> dict:
    total = len(listings) or 1
    total_sold = sum(l.sold_quantity for l in listings) or 1
    by_mode = []
    for mode in MODES:
        group = [l for l in listings if l.shipping_mode == mode]
        if not group:
            continue
        sold = sum(l.sold_quantity for l in group)
        by_mode.append({
            "mode": mode, "label": SHIPPING_MODES[mode], "listings": len(group),
            "share_pct": round(100 * len(group) / total, 1),
            "sales_share_pct": round(100 * sold / total_sold, 1),
            "median_price": round(statistics.median(l.price for l in group), 2),
            "avg_sold": round(sold / len(group), 1),
        })
    top = sorted(listings, key=lambda l: -l.sold_quantity)[:top_n]
    top_counts = {m: sum(1 for l in top if l.shipping_mode == m) for m in MODES}
    leader_mode = max(top_counts, key=top_counts.get) if top else None
    full = next((m for m in by_mode if m["mode"] == "full"), None)
    others = [l.price for l in listings if l.shipping_mode != "full"]
    return {
        "by_mode": sorted(by_mode, key=lambda m: -m["listings"]),
        "top_sellers_modes": {SHIPPING_MODES[m]: c for m, c in top_counts.items() if c},
        "leader_mode": leader_mode,
        "leader_mode_label": SHIPPING_MODES.get(leader_mode, "") if leader_mode else "",
        "full_share_top_pct": round(100 * top_counts["full"] / len(top), 1) if top else 0.0,
        "flex_share_top_pct": round(100 * top_counts["flex"] / len(top), 1) if top else 0.0,
        # quanto o Full cobra a mais (ou a menos) que o resto do mercado, pela mediana
        "full_price_premium_pct": round(100 * (full["median_price"] / statistics.median(others) - 1), 1)
        if full and others else None,
        "my_mode": my_mode, "my_mode_label": SHIPPING_MODES.get(my_mode or "", ""),
        "source": "api",
    }
