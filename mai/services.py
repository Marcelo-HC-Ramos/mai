"""Funções de alto nível usadas pela API, pelos workers e pela linha de comando.

Contas de marketplace ficam em `marketplace_accounts` (uma loja pode ter várias, inclusive duas contas do mesmo
marketplace). Os tokens são gravados criptografados com AES-256-GCM (RN04).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from bson import ObjectId
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError

from . import security
from .agent import MarketAgent
from .connectors import get_connector
from .connectors.base import MarketplaceConnector


class AccountError(Exception):
    pass


def connect_account(db: Database, org_id: ObjectId, seller_id: ObjectId, marketplace: str, external_id: str,
                    nickname: str, access_token: str | None = None, refresh_token: str | None = None,
                    expires_in: int | None = None) -> dict:
    """Liga uma conta de marketplace a uma loja (UC01). Reconectar a mesma conta só renova os tokens."""
    existing = db.marketplace_accounts.find_one({"marketplace": marketplace, "external_id": str(external_id)})
    if existing and existing["org_id"] != org_id:
        raise AccountError("Esta conta de marketplace já está conectada a outra empresa.")
    doc = {"org_id": org_id, "seller_id": seller_id, "marketplace": marketplace, "external_id": str(external_id),
           "nickname": nickname, "status": "ACTIVE", "updated_at": datetime.now(timezone.utc)}
    if access_token:
        doc["access_token"] = security.encrypt(access_token)
    if refresh_token:
        doc["refresh_token"] = security.encrypt(refresh_token)
    if expires_in:
        doc["token_expires_at"] = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    try:
        db.marketplace_accounts.update_one({"marketplace": marketplace, "external_id": str(external_id)},
                                           {"$set": doc, "$setOnInsert": {"connected_at": datetime.now(timezone.utc)}},
                                           upsert=True)
    except DuplicateKeyError:
        raise AccountError("Esta conta de marketplace já está conectada.")
    return db.marketplace_accounts.find_one({"marketplace": marketplace, "external_id": str(external_id)})


def disconnect_account(db: Database, account_id: ObjectId) -> None:
    """Revoga a integração (RF01): apaga os tokens e marca a conta como REVOKED. O histórico continua."""
    db.marketplace_accounts.update_one({"_id": account_id}, {
        "$set": {"status": "REVOKED", "revoked_at": datetime.now(timezone.utc)},
        "$unset": {"access_token": "", "refresh_token": ""}})


def connector_for_account(db: Database, account: dict) -> MarketplaceConnector:
    if account.get("status") != "ACTIVE":
        raise AccountError(f"A conta {account.get('nickname')} está desconectada.")
    if account["marketplace"] == "DEMO":
        return get_connector("DEMO", account_key=account["external_id"])

    def save_tokens(data: dict) -> None:
        db.marketplace_accounts.update_one({"_id": account["_id"]}, {"$set": {
            "access_token": security.encrypt(data["access_token"]),
            "refresh_token": security.encrypt(data.get("refresh_token", "")),
            "token_expires_at": datetime.now(timezone.utc) + timedelta(seconds=data.get("expires_in", 21600))}})

    return get_connector(account["marketplace"], access_token=security.decrypt(account["access_token"]),
                         refresh_token=security.decrypt(account["refresh_token"]) if account.get("refresh_token") else None,
                         user_id=account["external_id"], on_token_refresh=save_tokens)


def active_accounts(db: Database, **filters) -> list[dict]:
    return list(db.marketplace_accounts.find({**filters, "status": "ACTIVE"}).sort("connected_at", 1))


def run_analysis(db: Database, product_id: str | ObjectId, account_id: Optional[ObjectId] = None,
                 shipping_modes: Optional[list[str]] = None) -> dict:
    """Roda o agente para um produto, usando a conta do anúncio escolhido (ou a primeira conta ativa do produto)."""
    from .ai import llm_for_org

    product = db.products.find_one({"_id": ObjectId(product_id)})
    if not product:
        raise ValueError("Produto não encontrado")
    account_ids = [l.get("account_id") for l in product.get("listings", []) if l.get("account_id")]
    if account_id:
        account_ids = [account_id]
    accounts = [a for a in (db.marketplace_accounts.find_one({"_id": i}) for i in account_ids) if a and a["status"] == "ACTIVE"]
    if not accounts:
        raise AccountError("Nenhuma conta ativa ligada a este produto.")
    account = accounts[0]
    org = db.organizations.find_one({"_id": product["org_id"]}) or {}
    own_ids = {a["external_id"] for a in db.marketplace_accounts.find({"org_id": product["org_id"]})}
    agent = MarketAgent(db, connector_for_account(db, account), own_seller_ids=own_ids, account=account,
                        llm=llm_for_org(org), min_margin_pct=(org.get("settings") or {}).get("min_margin_pct"))
    return agent.analyze_product(product["_id"], shipping_modes=shipping_modes)
