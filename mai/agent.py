"""Agente MAI: executa a varredura de mercado de um produto (UC02) e grava o snapshot."""
from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from pymongo.database import Database

from .ai.tasks import classify_reviews, executive_summary
from .analysis.devices import device_insights
from .analysis.logistics import filter_by_modes, logistics_insights
from .costs import CostCalculator, CostInputs, as_fee_fn
from .analysis.keywords import keyword_insights
from .analysis.pricing import competitor_stats, recommend_price
from .analysis.recommendations import build_recommendations
from .analysis.reviews import review_insights
from .config import settings
from .connectors.base import MarketplaceConnector

log = logging.getLogger("mai.agent")


class MarketAgent:
    def __init__(self, db: Database, connector: MarketplaceConnector, own_seller_ids: Optional[set[str]] = None,
                 review_items: int = 5, account: Optional[dict] = None, llm=None,
                 min_margin_pct: Optional[float] = None):
        self.db = db
        self.connector = connector
        self.own_seller_ids = own_seller_ids or set()
        self.review_items = review_items
        self.account = account  # conta de marketplace usada na varredura
        self.llm = llm          # cliente de IA generativa (Gemini) ou None
        self.min_margin_pct = min_margin_pct if min_margin_pct is not None else settings.min_margin_pct

    def analyze_product(self, product_id: ObjectId | str, shipping_modes: Optional[list[str]] = None) -> dict:
        """`shipping_modes` limita a concorrência a modalidades de envio (ex.: ["full"] para comparar só com o Full)."""
        product = self.db.products.find_one({"_id": ObjectId(product_id)})
        if not product:
            raise ValueError(f"Produto {product_id} não encontrado")
        listings = product.get("listings") or [{}]
        account_id = (self.account or {}).get("_id")
        listing = next((l for l in listings if account_id and l.get("account_id") == account_id),
                       next((l for l in listings if l.get("marketplace") == self.connector.name), listings[0]))
        my_item = listing.get("external_item_id")
        current_price = listing.get("current_price")
        started = datetime.now(timezone.utc)

        # 1. Coleta de concorrentes (EAN primeiro, título como alternativa: UC02 fluxo 3a)
        query = product.get("ean") or product["title"]
        competitors = self._competitors(query)
        if len(competitors) < 3 and query != product["title"]:
            query = product["title"]
            competitors = self._competitors(query)
        category = product.get("category_id") or listing.get("category_id") or (
            Counter(c.category_id for c in competitors).most_common(1)[0][0] if competitors else None)

        # 2. Full x Flex: retrato de todo o mercado e, se pedido, filtro das modalidades a comparar
        logi = logistics_insights(competitors, listing.get("shipping_mode"))
        logi["filter"] = [m for m in (shipping_modes or [])]
        all_competitors = competitors
        competitors = filter_by_modes(competitors, shipping_modes)

        # 3. UC06 preços dos concorrentes
        comp = competitor_stats(competitors, current_price)

        # 4. UC10 melhor preço, com o custo completo da loja (calculadora UC14)
        seller = self.db.sellers.find_one({"_id": product.get("seller_id")}) or {}
        profile = {**(seller.get("cost_profile") or {}),
                   **({"listing_type": listing["listing_type"]} if listing.get("listing_type") else {}),
                   **({"shipping_mode": listing["shipping_mode"]} if listing.get("shipping_mode") in ("full", "flex", "coleta", "proprio") else {})}
        calc = CostCalculator(profile, lambda p, lt: self.connector.get_fees(p, category, lt),
                              lambda p, w, d, lt: self.connector.get_shipping_cost(p, w, d, lt))
        inputs = CostInputs(cost_price=product.get("cost_price") or 0, weight_g=product.get("weight_g"),
                            dimensions_cm=product.get("dimensions_cm"), packaging_cost=product.get("packaging_cost"))
        price = recommend_price(comp, product.get("cost_price"), product.get("min_selling_price"),
                                as_fee_fn(calc, inputs), self.min_margin_pct, current_price)
        if product.get("cost_price") and price.get("recommended_price"):
            price["cost_breakdown"] = calc.calculate(price["recommended_price"], inputs)

        # 4. UC07 palavras-chave
        trends = self._safe(lambda: self.connector.get_search_trends(category), [])
        kw = keyword_insights(product["title"], all_competitors, trends, product.get("keyword_volumes"))

        # 5. UC08 celular x computador
        platform_dev = self._safe(lambda: self.connector.get_device_breakdown(query, category), None)
        dev = device_insights(category, platform_dev, self._seller_devices(product))

        # 6. UC09 avaliações ruins (concorrentes mais vendidos + anúncio do vendedor)
        top = sorted(all_competitors, key=lambda c: -c.sold_quantity)[: self.review_items]
        market_reviews = [r for c in top for r in self._safe(lambda c=c: self.connector.get_reviews(c.item_id), [])]
        groups = {"mercado": market_reviews}
        if my_item:
            groups["vendedor"] = self._safe(lambda: self.connector.get_reviews(my_item), [])
        classifier = (lambda texts: classify_reviews(self.llm, texts)) if self.llm else None
        rev = review_insights(groups, classifier=classifier)

        recs = build_recommendations(product, comp, price, kw, dev, rev, logi)
        summary = self._safe(lambda: executive_summary(self.llm, product, comp, price, kw, dev, rev), None)
        snapshot = {
            "product_id": product["_id"],
            "org_id": product.get("org_id"),
            "seller_id": product.get("seller_id"),
            "account_id": account_id,
            "account_nickname": (self.account or {}).get("nickname"),
            "marketplace": self.connector.name,
            "ean": product.get("ean"),
            "query": query,
            "category_id": category,
            "captured_at": started,
            "duration_ms": int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
            "status": "OK",
            "competitor_data": comp,
            "logistics": logi,
            "pricing": price,
            "search_intelligence": {"keywords": kw, "traffic_breakdown": dev},
            "review_insights": rev,
            "ai_recommendations": recs,
            "ai_summary": summary,
        }
        snapshot["_id"] = self.db.market_snapshots.insert_one(snapshot).inserted_id
        log.info("snapshot %s gravado para produto %s (%d concorrentes)", snapshot["_id"], product["_id"], len(competitors))
        return snapshot

    def _competitors(self, query: str):
        found = self.connector.search_competitors(query, limit=50)
        return [c for c in found if c.seller_id not in self.own_seller_ids]

    def _seller_devices(self, product: dict) -> Optional[dict[str, int]]:
        if product.get("traffic_devices"):  # relatório de tráfego importado pelo vendedor
            return product["traffic_devices"]
        rows = self.db.orders.aggregate([
            {"$match": {"seller_id": product.get("seller_id"), "buyer_device": {"$in": ["mobile", "desktop"]}}},
            {"$group": {"_id": "$buyer_device", "n": {"$sum": 1}}},
        ])
        counts = {r["_id"]: r["n"] for r in rows}
        return counts or None

    @staticmethod
    def _safe(fn, default):
        try:
            return fn()
        except Exception as exc:  # um bloco indisponível não derruba a varredura (UC02 fluxo 4a)
            log.warning("fonte indisponível: %s", exc)
            return default


def latest_snapshot(db: Database, product_id: ObjectId | str) -> Optional[dict]:
    return db.market_snapshots.find_one({"product_id": ObjectId(product_id)}, sort=[("captured_at", -1)])
