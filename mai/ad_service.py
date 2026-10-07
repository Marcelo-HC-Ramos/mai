"""Serviços da análise de anúncios (UC15), pesquisa de mercado (UC16) e monitoramento (UC17).

As consultas ao marketplace usam uma conta conectada da empresa (dados públicos de anúncios). As fotos de
monitoramento (`ad_snapshots`) são dados públicos e ficam compartilhadas por anúncio; a lista de anúncios
monitorados (`ad_tracking`) é de cada empresa.
"""
from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Optional

from bson import ObjectId
from pymongo.database import Database

from .analysis.ads import analyze_ad, estimate_sales, market_overview, parse_item_id
from .analysis.logistics import filter_by_modes, logistics_insights
from .connectors.base import MarketplaceConnector
from .services import AccountError, active_accounts, connector_for_account

log = logging.getLogger("mai.ads")


def connector_for_org(db: Database, org_id: ObjectId, account_id: Optional[ObjectId] = None) -> tuple[MarketplaceConnector, dict]:
    accounts = active_accounts(db, org_id=org_id, **({"_id": account_id} if account_id else {}))
    if not accounts:
        raise AccountError("Conecte uma conta de marketplace para pesquisar anúncios.")
    return connector_for_account(db, accounts[0]), accounts[0]


def _safe(fn, default):
    try:
        return fn()
    except Exception as exc:
        log.warning("fonte indisponível: %s", exc)
        return default


def history(db: Database, item_id: str, days: int = 90) -> list[dict]:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    return list(db.ad_snapshots.find({"item_id": item_id, "captured_at": {"$gte": since}},
                                     {"_id": 0}).sort("captured_at", 1))


def take_snapshot(db: Database, conn: MarketplaceConnector, item_id: str):
    d = conn.get_item_details(item_id)
    db.ad_snapshots.insert_one({"item_id": d.item_id, "captured_at": datetime.now(timezone.utc), "price": d.price,
                                "sold_quantity": d.sold_quantity, "available_quantity": d.available_quantity,
                                "visits_30d": d.visits_30d, "shipping_mode": d.shipping_mode})
    return d


def analyze_ad_for_org(db: Database, org_id: ObjectId, item: str, account_id: Optional[ObjectId] = None) -> dict:
    conn, account = connector_for_org(db, org_id, account_id)
    item_id = parse_item_id(item)
    d = conn.get_item_details(item_id)
    competitors = _safe(lambda: conn.search_competitors(d.title, limit=50), [])
    competitors = [c for c in competitors if c.item_id != d.item_id]
    category = d.category_id or (Counter(c.category_id for c in competitors).most_common(1)[0][0] if competitors else None)
    trends = _safe(lambda: conn.get_search_trends(category), [])
    # o termo mais buscado da categoria descreve o produto melhor que as primeiras palavras do título
    seed = trends[0] if trends else " ".join(d.title.split()[:3])
    suggestions = _safe(lambda: conn.get_search_suggestions(seed), [])
    result = analyze_ad(d, competitors, trends, suggestions, history(db, d.item_id))
    result["logistics"] = logistics_insights(competitors, d.shipping_mode)
    result["tracked"] = bool(db.ad_tracking.find_one({"org_id": org_id, "item_id": d.item_id, "active": True}))
    result["analyzed_at"] = datetime.now(timezone.utc)
    result["account_nickname"] = account.get("nickname")
    db.ad_analyses.insert_one({"org_id": org_id, "item_id": d.item_id, "title": d.title,
                               "analyzed_at": result["analyzed_at"], "result": result})
    return result


def market_research(db: Database, org_id: ObjectId, query: str, account_id: Optional[ObjectId] = None,
                    modes: Optional[list[str]] = None, enrich_top: int = 10) -> dict:
    conn, _ = connector_for_org(db, org_id, account_id)
    listings = filter_by_modes(conn.search_competitors(query, limit=50), modes)
    top = sorted(listings, key=lambda l: -(l.sold_quantity * l.price))[:enrich_top]
    enriched = {}
    for l in top:  # vendas por mês exigem a data de criação: busca os detalhes só dos principais
        d = _safe(lambda l=l: conn.get_item_details(l.item_id), None)
        if d:
            enriched[l.item_id] = estimate_sales(d, history(db, l.item_id))
    out = market_overview(query, listings, enriched)
    out["logistics"] = logistics_insights(listings)
    out["filter_modes"] = modes or []
    return out


def track(db: Database, org_id: ObjectId, item: str, account_id: Optional[ObjectId] = None) -> dict:
    conn, _ = connector_for_org(db, org_id, account_id)
    d = take_snapshot(db, conn, parse_item_id(item))
    db.ad_tracking.update_one({"org_id": org_id, "item_id": d.item_id},
                              {"$set": {"title": d.title, "url": d.url, "active": True, "seller": d.seller_nickname},
                               "$setOnInsert": {"added_at": datetime.now(timezone.utc)}}, upsert=True)
    return {"item_id": d.item_id, "title": d.title}


def untrack(db: Database, org_id: ObjectId, item_id: str) -> None:
    db.ad_tracking.update_one({"org_id": org_id, "item_id": item_id}, {"$set": {"active": False}})


def tracked_list(db: Database, org_id: ObjectId) -> list[dict]:
    rows = []
    now = datetime.now(timezone.utc)
    for t in db.ad_tracking.find({"org_id": org_id, "active": True}).sort("added_at", -1):
        h = history(db, t["item_id"], days=30)
        last = h[-1] if h else {}

        def sales_since(days: int) -> Optional[int]:
            cut = now - timedelta(days=days)
            window = [p for p in h if (p["captured_at"] if p["captured_at"].tzinfo else p["captured_at"].replace(tzinfo=timezone.utc)) >= cut]
            if len(window) < 2:
                return None
            return max(0, window[-1]["sold_quantity"] - window[0]["sold_quantity"])

        s7, s30 = sales_since(7), sales_since(30)
        first_price = h[0]["price"] if h else None
        rows.append({
            "item_id": t["item_id"], "title": t.get("title"), "url": t.get("url"), "seller": t.get("seller"),
            "price": last.get("price"), "price_change_30d": round(last["price"] - first_price, 2) if h else None,
            "sold_total": last.get("sold_quantity"), "shipping_mode": last.get("shipping_mode"),
            "sales_7d": s7, "sales_30d": s30,
            "revenue_30d": round(s30 * last["price"], 2) if s30 is not None and last.get("price") else None,
            "snapshots": len(h), "last_capture": last.get("captured_at"),
        })
    return rows


def snapshot_all_tracked(db: Database) -> int:
    """Tarefa diária: uma foto por anúncio monitorado, usando uma conta ativa de cada empresa que o monitora."""
    done: set[str] = set()
    for t in db.ad_tracking.find({"active": True}):
        if t["item_id"] in done:
            continue
        try:
            conn, _ = connector_for_org(db, t["org_id"])
            take_snapshot(db, conn, t["item_id"])
            done.add(t["item_id"])
        except Exception as exc:
            log.warning("monitoramento de %s falhou: %s", t["item_id"], exc)
    return len(done)
