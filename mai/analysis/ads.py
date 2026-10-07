"""UC15-UC17: análise de anúncios no estilo das ferramentas de inteligência de vendedor (ex.: Genius Pro).

- Raio-x de um anúncio: vendas e faturamento estimados (por mês e acumulado), idade, visitas e conversão,
  Full/Flex, tipo de anúncio, nota de qualidade com checklist e palavras-chave associadas.
- Pesquisa de mercado por termo: tamanho do mercado nos anúncios encontrados, concentração, preços, logística,
  lojas oficiais e ranking de vendedores por faturamento estimado.
- Monitoramento: fotos diárias de preço e vendidos de anúncios escolhidos, que transformam estimativa em cálculo.

Regra de transparência (RN01/RN11): faturamento de concorrente é sempre estimativa (vendidos x preço atual);
quando há monitoramento com pelo menos duas fotos, o número passa a ser "calculado" pela diferença de vendidos.
"""
from __future__ import annotations

import re
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import parse_qs, urlparse

from ..connectors.base import LISTING_TYPES, SHIPPING_MODES, CompetitorListing, ItemDetails
from ..textutil import normalize, tokens
from .keywords import keyword_insights

_ID = re.compile(r"\b(M[A-Z]{2})-?(\d{6,})\b", re.I)


def parse_item_id(text: str) -> str:
    """Aceita o código (MLB123...), o link do anúncio ou o link com ?item_id= / wid=."""
    text = (text or "").strip()
    if text.startswith("http"):
        q = parse_qs(urlparse(text).query)
        for key in ("item_id", "wid"):
            if q.get(key):
                return q[key][0].replace("-", "").upper()
        path = urlparse(text).path
        m = _ID.search(path)
        if m:
            return (m.group(1) + m.group(2)).upper()
        return path.rstrip("/").split("/")[-1].upper()
    m = _ID.fullmatch(text)
    return (m.group(1) + m.group(2)).upper() if m else text


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def estimate_sales(d: ItemDetails, history: Optional[list[dict]] = None, now: Optional[datetime] = None) -> dict:
    """Vendas e faturamento. `history`: fotos do monitoramento [{captured_at, sold_quantity, price}] em ordem."""
    now = now or datetime.now(timezone.utc)
    created = _aware(d.date_created)
    age_days = max(1, (now - created).days) if created else None
    monthly_units = d.sold_quantity * 30 / age_days if age_days else None
    out = {
        "age_days": age_days,
        "sold_total": d.sold_quantity,
        "revenue_total_estimate": round(d.sold_quantity * d.price, 2),
        "monthly_units": round(monthly_units, 1) if monthly_units is not None else None,
        "monthly_revenue": round(monthly_units * d.price, 2) if monthly_units is not None else None,
        "daily_units": round(monthly_units / 30, 2) if monthly_units is not None else None,
        "method": "media_desde_a_criacao",
        "source": "estimativa",
        "note": "Média desde a criação do anúncio, usando o preço atual. O ritmo recente pode ser diferente.",
    }
    pts = [p for p in (history or []) if p.get("sold_quantity") is not None]
    if len(pts) >= 2:
        first, last = pts[0], pts[-1]
        days = max((_aware(last["captured_at"]) - _aware(first["captured_at"])).total_seconds() / 86400, 1e-9)
        if days >= 1:
            units = revenue = 0.0
            for a, b in zip(pts, pts[1:]):
                delta = max(0, b["sold_quantity"] - a["sold_quantity"])
                units += delta
                revenue += delta * (b.get("price") or d.price)
            out.update({
                "tracked_days": round(days, 1), "tracked_units": int(units), "tracked_revenue": round(revenue, 2),
                "monthly_units": round(units * 30 / days, 1), "monthly_revenue": round(revenue * 30 / days, 2),
                "daily_units": round(units / days, 2), "method": "monitoramento", "source": "calculado",
                "note": f"Calculado pela variação de vendidos em {days:.0f} dia(s) de monitoramento.",
            })
    if d.visits_30d:
        out["visits_30d"] = d.visits_30d
        if out["monthly_units"] is not None:
            out["conversion_pct"] = round(100 * min(out["monthly_units"], d.visits_30d) / d.visits_30d, 2)
    return out


def quality_score(d: ItemDetails, strong_terms: list[str]) -> dict:
    """Nota de 0 a 100 do anúncio, com o que falta para melhorar (Auditor de Qualidade do documento)."""
    title_n = normalize(d.title)
    title_tokens = set(title_n.split())
    used = [t for t in strong_terms[:5] if set(t.split()) <= title_tokens]
    fill = d.attributes_filled / d.attributes_total if d.attributes_total else 0
    checks = [
        ("titulo", "Título entre 40 e 60 caracteres", 10, 40 <= len(d.title) <= 60, f"Seu título tem {len(d.title)} caracteres."),
        ("palavras", "Usa as palavras-chave mais fortes", 15, len(used) >= min(3, len(strong_terms[:5])),
         f"Usa {len(used)} das {len(strong_terms[:5])} principais."),
        ("fotos", "Pelo menos 6 fotos", 15, d.pictures >= 6, f"{d.pictures} foto(s)."),
        ("video", "Tem vídeo ou clipe", 5, d.has_video, ""),
        ("ficha", "Ficha técnica 80% preenchida", 15, fill >= 0.8, f"{round(100 * fill)}% preenchida."),
        ("descricao", "Descrição com pelo menos 500 caracteres", 10, d.description_length >= 500,
         f"{d.description_length} caracteres."),
        ("frete", "Frete grátis", 10, d.free_shipping, ""),
        ("logistica", "Full ou Flex (entrega rápida)", 10, d.shipping_mode in ("full", "flex"),
         SHIPPING_MODES.get(d.shipping_mode, "")),
        ("premium", "Anúncio Premium (parcelamento sem juros)", 5, d.listing_type == "gold_pro",
         LISTING_TYPES.get(d.listing_type, d.listing_type)),
        ("avaliacao", "Nota média 4,5 ou mais", 5, (d.rating_average or 0) >= 4.5,
         f"Nota {d.rating_average}" if d.rating_average else "Sem avaliações."),
    ]
    items = [{"key": k, "label": l, "weight": w, "ok": bool(ok), "detail": det} for k, l, w, ok, det in checks]
    return {"score": sum(i["weight"] for i in items if i["ok"]), "checks": items}


def analyze_ad(d: ItemDetails, competitors: list[CompetitorListing], trends: list[str], suggestions: list[str],
               history: Optional[list[dict]] = None, now: Optional[datetime] = None) -> dict:
    kw = keyword_insights(d.title, competitors, trends, top_n=15)
    strong = [k["term"] for k in kw["top_keywords"]]
    title_tokens = set(tokens(d.title))
    sugg = [{"term": s, "in_title": set(tokens(s)) <= title_tokens} for s in suggestions[:10]]
    prices = sorted(c.price for c in competitors) if competitors else []
    position = None
    if prices:
        position = round(100 * sum(1 for p in prices if p < d.price) / len(prices), 1)
    return {
        "item": d.to_dict(),
        "listing_type_label": LISTING_TYPES.get(d.listing_type, d.listing_type),
        "shipping_mode_label": SHIPPING_MODES.get(d.shipping_mode, d.shipping_mode),
        "sales": estimate_sales(d, history, now),
        "quality": quality_score(d, strong),
        "keywords": {
            "associated": kw["top_keywords"],
            "in_title": [t for t in strong if set(t.split()) <= title_tokens],
            "missing": [t for t in strong if not set(t.split()) <= title_tokens][:8],
            "search_suggestions": sugg,
            "source": "calculado",
        },
        "market_position": {
            "competitors": len(competitors),
            "median_price": round(statistics.median(prices), 2) if prices else None,
            "price_percentile": position,
        },
    }


def market_overview(query: str, listings: list[CompetitorListing], enriched: Optional[dict[str, dict]] = None) -> dict:
    """Pesquisa de mercado por termo. `enriched`: {item_id: estimate_sales(...)} dos principais anúncios."""
    enriched = enriched or {}
    if not listings:
        return {"query": query, "listings": 0}
    rows = []
    for l in listings:
        est = enriched.get(l.item_id) or {}
        rows.append({**l.to_dict(), "revenue_total_estimate": round(l.sold_quantity * l.price, 2),
                     "monthly_units": est.get("monthly_units"), "monthly_revenue": est.get("monthly_revenue"),
                     "age_days": est.get("age_days"),
                     "shipping_mode_label": SHIPPING_MODES.get(l.shipping_mode, l.shipping_mode),
                     "listing_type_label": LISTING_TYPES.get(l.listing_type, l.listing_type)})
    rows.sort(key=lambda r: -r["revenue_total_estimate"])
    total_rev = sum(r["revenue_total_estimate"] for r in rows) or 1
    top10 = sum(r["revenue_total_estimate"] for r in rows[:10])
    prices = [l.price for l in listings]
    sellers = defaultdict(lambda: {"revenue": 0.0, "units": 0, "listings": 0, "official": False})
    for r in rows:
        s = sellers[r["seller_nickname"] or r["seller_id"]]
        s["revenue"] += r["revenue_total_estimate"]
        s["units"] += r["sold_quantity"]
        s["listings"] += 1
        s["official"] = s["official"] or r["official_store"]
    seller_rank = sorted(({"seller": k, **v, "revenue": round(v["revenue"], 2),
                           "share_pct": round(100 * v["revenue"] / total_rev, 1)} for k, v in sellers.items()),
                         key=lambda x: -x["revenue"])[:10]
    monthly_known = [r["monthly_revenue"] for r in rows if r["monthly_revenue"] is not None]
    n = len(listings)
    concentration = round(100 * top10 / total_rev, 1)
    return {
        "query": query,
        "listings": n,
        "units_total": sum(l.sold_quantity for l in listings),
        "revenue_total_estimate": round(total_rev, 2),
        "monthly_revenue_top_estimate": round(sum(monthly_known), 2) if monthly_known else None,
        "monthly_revenue_top_count": len(monthly_known),
        "top10_concentration_pct": concentration,
        "competition_level": "alta" if concentration < 50 else "média" if concentration < 75 else "concentrada",
        "price": {"min": min(prices), "median": round(statistics.median(prices), 2),
                  "avg": round(statistics.fmean(prices), 2), "max": max(prices)},
        "full_share_pct": round(100 * sum(l.shipping_mode == "full" for l in listings) / n, 1),
        "flex_share_pct": round(100 * sum(l.shipping_mode == "flex" for l in listings) / n, 1),
        "official_store_share_pct": round(100 * sum(l.official_store for l in listings) / n, 1),
        "premium_share_pct": round(100 * sum(l.listing_type == "gold_pro" for l in listings) / n, 1),
        "free_shipping_share_pct": round(100 * sum(l.free_shipping for l in listings) / n, 1),
        "top_sellers": seller_rank,
        "ads": rows,
        "source": "estimativa",
        "note": "Faturamento estimado por vendidos x preço atual dos anúncios encontrados na busca.",
    }
