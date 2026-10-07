"""Acesso ao MongoDB e criação dos índices (seção 3.5 da especificação, RNF03)."""
from functools import lru_cache

from pymongo import ASCENDING, DESCENDING
from pymongo.database import Database

from .config import settings


@lru_cache(maxsize=1)
def get_db() -> Database:
    """Retorna o banco. MAI_MONGO_URI=mongomock:// usa um MongoDB em memória (testes e demonstração)."""
    if settings.mongo_uri.startswith("mongomock://"):
        import mongomock

        client = mongomock.MongoClient()
    else:
        from pymongo import MongoClient

        client = MongoClient(settings.mongo_uri, tz_aware=True)
    db = client[settings.mongo_db]
    ensure_indexes(db)
    return db


def ensure_indexes(db: Database) -> None:
    # Multiempresa: todo documento de negócio carrega org_id e as consultas sempre filtram por ele.
    db.organizations.create_index([("document", ASCENDING)], unique=True, sparse=True)
    db.users.create_index([("email", ASCENDING)], unique=True)
    db.users.create_index([("org_id", ASCENDING)])
    db.sellers.create_index([("org_id", ASCENDING)])
    # Uma conta de marketplace só pode estar ligada a uma empresa por vez.
    db.marketplace_accounts.create_index([("marketplace", ASCENDING), ("external_id", ASCENDING)], unique=True)
    db.marketplace_accounts.create_index([("org_id", ASCENDING), ("seller_id", ASCENDING)])
    db.products.create_index([("seller_id", ASCENDING), ("internal_sku", ASCENDING)], unique=True)
    db.products.create_index([("org_id", ASCENDING), ("ean", ASCENDING)])
    db.products.create_index([("listings.account_id", ASCENDING), ("listings.external_item_id", ASCENDING)])
    db.market_snapshots.create_index([("product_id", ASCENDING), ("captured_at", DESCENDING)])
    db.customer_questions.create_index([("seller_id", ASCENDING), ("status", ASCENDING), ("received_at", ASCENDING)])
    db.customer_questions.create_index([("account_id", ASCENDING), ("external_question_id", ASCENDING)], unique=True)
    db.orders.create_index([("seller_id", ASCENDING), ("created_at", DESCENDING)])
    db.orders.create_index([("account_id", ASCENDING), ("external_order_id", ASCENDING)], unique=True)
    db.ad_tracking.create_index([("org_id", ASCENDING), ("item_id", ASCENDING)], unique=True)
    db.ad_snapshots.create_index([("item_id", ASCENDING), ("captured_at", ASCENDING)])
    db.ad_analyses.create_index([("org_id", ASCENDING), ("analyzed_at", DESCENDING)])
    db.oauth_states.create_index([("created_at", ASCENDING)], expireAfterSeconds=900)
