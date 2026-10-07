"""Dashboards do vendedor: vendas (UC04), perguntas (UC05) e estoque (UC11).

Todas as métricas saem de aggregation pipelines no MongoDB, apoiadas pelos índices de `db.py` (RNF03).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from bson import ObjectId
from pymongo.database import Database

from .config import settings

PERIODS = {"hoje": 0, "7d": 7, "15d": 15, "30d": 30, "90d": 90, "mes": None, "ano": None}
VALID_STATUSES = ["paid", "confirmed", "delivered", "shipped"]


def period_range(period: str, now: Optional[datetime] = None) -> tuple[datetime, datetime]:
    now = now or datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "hoje":
        return today, now
    if period == "mes":
        return today.replace(day=1), now
    if period == "ano":
        return today.replace(month=1, day=1), now
    if period not in PERIODS:
        raise ValueError(f"Período inválido: {period}. Use {list(PERIODS)}")
    return today - timedelta(days=PERIODS[period] - 1), now


def _scope(seller_id: ObjectId, account_id: Optional[ObjectId]) -> dict:
    """Filtro base: a loja inteira ou só uma das suas contas de marketplace."""
    return {"seller_id": seller_id, **({"account_id": account_id} if account_id else {})}


def _totals(db: Database, scope: dict, start: datetime, end: datetime) -> dict:
    rows = list(db.orders.aggregate([
        {"$match": {**scope, "created_at": {"$gte": start, "$lte": end}, "status": {"$in": VALID_STATUSES}}},
        {"$group": {"_id": None, "gross": {"$sum": "$total_amount"}, "net": {"$sum": "$net_amount"},
                    "fees": {"$sum": "$marketplace_fee"}, "shipping": {"$sum": "$shipping_cost"},
                    "orders": {"$sum": 1}, "units": {"$sum": "$units"}}},
    ]))
    r = rows[0] if rows else {"gross": 0, "net": 0, "fees": 0, "shipping": 0, "orders": 0, "units": 0}
    return {"gross_revenue": round(r["gross"], 2), "net_revenue": round(r["net"], 2),
            "marketplace_fees": round(r["fees"], 2), "shipping_costs": round(r["shipping"], 2),
            "orders": r["orders"], "units": r["units"],
            "average_ticket": round(r["gross"] / r["orders"], 2) if r["orders"] else 0.0}


def _pct(a: float, b: float) -> Optional[float]:
    return round(100 * (a - b) / b, 1) if b else None


def sales_summary(db: Database, seller_id: ObjectId, period: str = "30d", now: Optional[datetime] = None,
                  account_id: Optional[ObjectId] = None) -> dict:
    now = now or datetime.now(timezone.utc)
    scope = _scope(seller_id, account_id)
    start, end = period_range(period, now)
    totals = _totals(db, scope, start, end)
    span = end - start
    previous = _totals(db, scope, start - span, start)

    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    prev_month_start = (month_start - timedelta(days=1)).replace(day=1)
    same_point_prev_month = prev_month_start + (now - month_start)
    month = _totals(db, scope, month_start, now)
    prev_month = _totals(db, scope, prev_month_start, min(same_point_prev_month, month_start))
    prev_month_full = _totals(db, scope, prev_month_start, month_start)

    match = {**scope, "created_at": {"$gte": start, "$lte": end}, "status": {"$in": VALID_STATUSES}}
    accounts = {a["_id"]: a for a in db.marketplace_accounts.find({"seller_id": seller_id})}
    gross = totals["gross_revenue"] or 1
    by_account = []
    for r in db.orders.aggregate([
            {"$match": match},
            {"$group": {"_id": "$account_id", "gross": {"$sum": "$total_amount"}, "orders": {"$sum": 1}}},
            {"$sort": {"gross": -1}}]):
        acc = accounts.get(r["_id"], {})
        by_account.append({"account_id": str(r["_id"]), "nickname": acc.get("nickname", "Conta removida"),
                           "marketplace": acc.get("marketplace"), "gross_revenue": round(r["gross"], 2),
                           "orders": r["orders"], "share_pct": round(100 * r["gross"] / gross, 1)})
    by_marketplace: dict[str, dict] = {}
    for a in by_account:
        m = by_marketplace.setdefault(a["marketplace"], {"marketplace": a["marketplace"], "gross_revenue": 0.0, "orders": 0})
        m["gross_revenue"] = round(m["gross_revenue"] + a["gross_revenue"], 2)
        m["orders"] += a["orders"]
    for m in by_marketplace.values():
        m["share_pct"] = round(100 * m["gross_revenue"] / gross, 1)

    daily = {r["_id"]: r for r in db.orders.aggregate([
        {"$match": match},
        {"$group": {"_id": {"$dateToString": {"format": "%Y-%m-%d", "date": "$created_at"}},
                    "gross": {"$sum": "$total_amount"}, "orders": {"$sum": 1}}},
    ])}
    curve, day = [], start
    while day <= end:
        key = day.strftime("%Y-%m-%d")
        r = daily.get(key, {"gross": 0, "orders": 0})
        curve.append({"date": key, "gross_revenue": round(r["gross"], 2), "orders": r["orders"]})
        day += timedelta(days=1)

    top_products = [{"product_id": str(r["_id"]["pid"]) if r["_id"]["pid"] else None, "title": r["_id"]["title"],
                     "units": r["units"], "gross_revenue": round(r["gross"], 2)}
                    for r in db.orders.aggregate([
                        {"$match": match}, {"$unwind": "$items"},
                        {"$group": {"_id": {"pid": "$items.product_id", "title": "$items.title"},
                                    "units": {"$sum": "$items.quantity"},
                                    "gross": {"$sum": {"$multiply": ["$items.quantity", "$items.unit_price"]}}}},
                        {"$sort": {"gross": -1}}, {"$limit": 5}])]

    cancelled = db.orders.count_documents({**scope, "created_at": {"$gte": start, "$lte": end}, "status": "cancelled"})
    return {
        "period": period, "start": start.isoformat(), "end": end.isoformat(),
        **totals,
        "vs_previous_period_pct": {"gross_revenue": _pct(totals["gross_revenue"], previous["gross_revenue"]),
                                   "orders": _pct(totals["orders"], previous["orders"])},
        "current_month": {**month, "vs_same_point_last_month_pct": _pct(month["gross_revenue"], prev_month["gross_revenue"]),
                          "last_month_total": prev_month_full["gross_revenue"]},
        "cancelled_orders": cancelled,
        "cancellation_rate_pct": round(100 * cancelled / (cancelled + totals["orders"]), 1) if cancelled + totals["orders"] else 0.0,
        "by_account": by_account,
        "by_marketplace": sorted(by_marketplace.values(), key=lambda m: -m["gross_revenue"]),
        "daily_curve": curve,
        "top_products": top_products,
    }


def questions_summary(db: Database, seller_id: ObjectId, now: Optional[datetime] = None, limit: int = 20,
                      account_id: Optional[ObjectId] = None) -> dict:
    now = now or datetime.now(timezone.utc)
    scope = _scope(seller_id, account_id)
    nick = {a["_id"]: a.get("nickname") for a in db.marketplace_accounts.find({"seller_id": seller_id})}
    q = db.customer_questions
    unanswered = list(q.find({**scope, "status": "UNANSWERED"}).sort("received_at", 1).limit(limit))
    for doc in unanswered:
        received = doc["received_at"]
        if received.tzinfo is None:
            received = received.replace(tzinfo=timezone.utc)
        doc["waiting_hours"] = round((now - received).total_seconds() / 3600, 1)
    since = now - timedelta(days=30)
    answered = list(q.find({**scope, "status": "ANSWERED", "received_at": {"$gte": since},
                            "answered_at": {"$ne": None}}, {"received_at": 1, "answered_at": 1}))
    resp_minutes = [(a["answered_at"] - a["received_at"]).total_seconds() / 60 for a in answered]
    topics = [{"topic": r["_id"], "count": r["n"]} for r in q.aggregate([
        {"$match": {**scope, "received_at": {"$gte": since}}},
        {"$group": {"_id": "$topic", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}])]
    by_product = [{"product_id": str(r["_id"]) if r["_id"] else None, "count": r["n"]} for r in q.aggregate([
        {"$match": {**scope, "received_at": {"$gte": since}}},
        {"$group": {"_id": "$product_id", "n": {"$sum": 1}}}, {"$sort": {"n": -1}}, {"$limit": 5}])]
    titles = {p["_id"]: p["title"] for p in db.products.find({"seller_id": seller_id}, {"title": 1})}
    for b in by_product:
        b["title"] = titles.get(ObjectId(b["product_id"])) if b["product_id"] else None
    return {
        "unanswered_count": q.count_documents({**scope, "status": "UNANSWERED"}),
        "received_last_30d": q.count_documents({**scope, "received_at": {"$gte": since}}),
        "avg_response_minutes_30d": round(sum(resp_minutes) / len(resp_minutes)) if resp_minutes else None,
        "answered_within_1h_pct": round(100 * sum(m <= 60 for m in resp_minutes) / len(resp_minutes), 1) if resp_minutes else None,
        "top_topics": topics,
        "by_product": by_product,
        "unanswered": [{"id": str(d["_id"]), "product_id": str(d["product_id"]) if d.get("product_id") else None,
                        "product_title": titles.get(d.get("product_id")), "question": d["question_text"],
                        "topic": d.get("topic"), "buyer": d.get("buyer_nickname"), "marketplace": d["marketplace"], "account": nick.get(d.get("account_id")),
                        "suggestion_method": d.get("suggestion_method"),
                        "received_at": d["received_at"].isoformat(), "waiting_hours": d["waiting_hours"],
                        "suggested_answer": d.get("suggested_ai_answer")} for d in unanswered],
    }


def stock_summary(db: Database, seller_id: ObjectId, now: Optional[datetime] = None,
                  account_id: Optional[ObjectId] = None) -> dict:
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=30)
    velocity = {r["_id"]: r["units"] for r in db.orders.aggregate([
        {"$match": {**_scope(seller_id, account_id), "created_at": {"$gte": since}, "status": {"$in": VALID_STATUSES}}},
        {"$unwind": "$items"},
        {"$group": {"_id": "$items.product_id", "units": {"$sum": "$items.quantity"}}}])}
    rows = []
    for p in db.products.find({"seller_id": seller_id}):
        listings = [l for l in p.get("listings", []) if not account_id or l.get("account_id") == account_id]
        if not listings:
            continue
        stock = sum(int(l.get("stock_quantity") or 0) for l in listings)
        per_day = velocity.get(p["_id"], 0) / 30
        coverage = round(stock / per_day, 1) if per_day else None
        rows.append({
            "product_id": str(p["_id"]), "sku": p.get("internal_sku"), "title": p["title"], "stock": stock,
            "price": min((l.get("current_price") for l in listings if l.get("current_price")), default=None),
            "accounts": sorted({l.get("account_nickname") or l.get("marketplace") for l in listings}),
            "stock_value_at_cost": round(stock * p["cost_price"], 2) if p.get("cost_price") else None,
            "units_sold_30d": velocity.get(p["_id"], 0), "avg_daily_sales": round(per_day, 2),
            "coverage_days": coverage,
            "alert": "SEM_ESTOQUE" if stock == 0 else (
                "REPOR" if coverage is not None and coverage < settings.stock_alert_days else None),
        })
    rows.sort(key=lambda r: (r["alert"] is None, r["coverage_days"] if r["coverage_days"] is not None else 1e9))
    return {
        "total_units": sum(r["stock"] for r in rows),
        "stock_value_at_cost": round(sum(r["stock_value_at_cost"] or 0 for r in rows), 2),
        "products": len(rows),
        "out_of_stock": sum(r["alert"] == "SEM_ESTOQUE" for r in rows),
        "restock_alerts": sum(r["alert"] == "REPOR" for r in rows),
        "alert_threshold_days": settings.stock_alert_days,
        "items": rows,
    }
