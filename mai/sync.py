"""Sincronização de anúncios, estoque, pedidos e perguntas de uma conta de marketplace (UC01 passo 6).

Uma loja pode ter várias contas. Anúncios de contas diferentes com o mesmo SKU viram um único produto com várias
entradas em `listings`, cada uma marcada com `account_id`.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from pymongo import UpdateOne
from pymongo.database import Database

from .connectors.base import MarketplaceConnector
from .questions import suggest_answer, topic_of


def sync_listings(db: Database, account: dict, conn: MarketplaceConnector) -> int:
    n = 0
    for l in conn.get_seller_listings():
        listing = {"account_id": account["_id"], "marketplace": account["marketplace"],
                   "account_nickname": account.get("nickname"), "external_item_id": l.external_item_id,
                   "url": l.url, "current_price": l.price, "stock_quantity": l.stock_quantity, "status": l.status,
                   "category_id": l.category_id, "sold_quantity": l.sold_quantity,
                   "shipping_mode": l.shipping_mode, "listing_type": l.listing_type}
        key = {"seller_id": account["seller_id"], "internal_sku": l.sku}
        existing = db.products.find_one(key)
        if existing:
            others = [x for x in existing.get("listings", [])
                      if not (x.get("account_id") == account["_id"] and x.get("external_item_id") == l.external_item_id)]
            db.products.update_one(key, {"$set": {"listings": others + [listing],
                                                  "category_id": existing.get("category_id") or l.category_id}})
        else:
            db.products.insert_one({**key, "org_id": account["org_id"], "ean": l.ean or None, "title": l.title,
                                    "category_id": l.category_id, "cost_price": None, "min_selling_price": None,
                                    "listings": [listing], "created_at": datetime.now(timezone.utc)})
        n += 1
    db.marketplace_accounts.update_one({"_id": account["_id"]}, {"$set": {"last_sync_at": datetime.now(timezone.utc)}})
    return n


def _item_index(db: Database, account: dict) -> dict[str, dict]:
    return {l["external_item_id"]: p for p in db.products.find({"seller_id": account["seller_id"]})
            for l in p.get("listings", []) if l.get("account_id") == account["_id"]}


def sync_orders(db: Database, account: dict, conn: MarketplaceConnector, days: int = 90) -> int:
    index = _item_index(db, account)
    ops = []
    for o in conn.get_orders(datetime.now(timezone.utc) - timedelta(days=days)):
        items = [{**it, "product_id": index.get(it["external_item_id"], {}).get("_id"),
                  "unit_cost": index.get(it["external_item_id"], {}).get("cost_price")} for it in o.items]
        doc = {"org_id": account["org_id"], "seller_id": account["seller_id"], "account_id": account["_id"],
               "marketplace": account["marketplace"], "external_order_id": o.external_order_id,
               "created_at": o.created_at, "status": o.status, "total_amount": o.total_amount,
               "marketplace_fee": o.marketplace_fee, "shipping_cost": o.shipping_cost,
               "net_amount": round(o.total_amount - o.marketplace_fee - o.shipping_cost, 2),
               "units": sum(i["quantity"] for i in items), "items": items}
        if o.buyer_device:
            doc["buyer_device"] = o.buyer_device
        ops.append(UpdateOne({"account_id": account["_id"], "external_order_id": o.external_order_id},
                             {"$set": doc}, upsert=True))
    if ops:
        try:
            db.orders.bulk_write(ops, ordered=False)
        except TypeError:  # mongomock (testes) não suporta bulk_write com pymongo 4.9+
            for op in ops:
                db.orders.update_one(op._filter, op._doc, upsert=True)
    return len(ops)


def sync_questions(db: Database, account: dict, conn: MarketplaceConnector, llm=None, max_ai: int = 20) -> int:
    """Importa perguntas. Pendentes novas recebem resposta sugerida pela IA (até `max_ai` por rodada) ou por modelo."""
    from .ai.tasks import suggest_answer as ai_answer

    index = _item_index(db, account)
    n = ai_used = 0
    for q in conn.get_questions():
        product = index.get(q.external_item_id)
        key = {"account_id": account["_id"], "external_question_id": q.external_question_id}
        is_new = db.customer_questions.count_documents(key, limit=1) == 0
        doc = {"org_id": account["org_id"], "seller_id": account["seller_id"], "account_id": account["_id"],
               "product_id": product["_id"] if product else None, "marketplace": account["marketplace"],
               "external_question_id": q.external_question_id, "external_item_id": q.external_item_id,
               "buyer_nickname": q.buyer_nickname, "question_text": q.text, "topic": topic_of(q.text),
               "received_at": q.received_at, "status": q.status, "answer_text": q.answer_text,
               "answered_at": q.answered_at}
        if is_new:
            suggestion: Optional[str] = None
            if llm and q.status == "UNANSWERED" and ai_used < max_ai:
                suggestion = ai_answer(llm, q.text, product)
                ai_used += 1
            doc["suggested_ai_answer"] = suggestion or suggest_answer(q.text, product)
            doc["suggestion_method"] = "ia" if suggestion else "modelo"
        db.customer_questions.update_one(key, {"$set": doc}, upsert=True)
        n += 1
    return n


def full_sync(db: Database, account: dict, conn: MarketplaceConnector, llm=None) -> dict:
    return {"account": account.get("nickname"), "listings": sync_listings(db, account, conn),
            "orders": sync_orders(db, account, conn), "questions": sync_questions(db, account, conn, llm)}


def sync_account(db: Database, account_id, recent_only: bool = False) -> dict:
    """Sincroniza uma conta pelo id, resolvendo conector e IA da empresa."""
    from .ai import llm_for_org
    from .services import connector_for_account

    account = db.marketplace_accounts.find_one({"_id": account_id})
    conn = connector_for_account(db, account)
    llm = llm_for_org(db.organizations.find_one({"_id": account["org_id"]}))
    if recent_only:
        return {"orders": sync_orders(db, account, conn, days=2), "questions": sync_questions(db, account, conn, llm)}
    return full_sync(db, account, conn, llm)
