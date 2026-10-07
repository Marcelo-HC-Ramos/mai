"""Contrato comum dos conectores de marketplace.

Cada plataforma (Mercado Livre, Shopee, Amazon...) implementa `MarketplaceConnector` e devolve os dados já
normalizados nas dataclasses abaixo. O agente e os dashboards só conhecem este contrato.
"""
from __future__ import annotations

import random
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Optional

import httpx


# Modalidades de envio do Mercado Livre, como o vendedor fala:
#   full    = Mercado Envios Full (estoque no centro de distribuição do ML)      logistic_type "fulfillment"
#   flex    = Mercado Envios Flex (o vendedor entrega no mesmo dia)              logistic_type "self_service"
#                                                                                 ou tag "self_service_in"
#   coleta  = Mercado Envios coleta ou agência                                   "cross_docking", "drop_off",
#                                                                                 "xd_drop_off"
#   proprio = envio por conta do vendedor (Mercado Envios 1 / a combinar)        "custom", "not_specified", "default"
SHIPPING_MODES = {"full": "Full", "flex": "Flex", "coleta": "Coleta/Agência", "proprio": "Envio próprio",
                  "desconhecido": "Não informado"}


def shipping_mode(logistic_type: str | None, tags: list[str] | None = None) -> str:
    lt = (logistic_type or "").lower()
    if lt == "fulfillment":
        return "full"
    if lt == "self_service" or "self_service_in" in (tags or []):
        return "flex"
    if lt in ("cross_docking", "drop_off", "xd_drop_off"):
        return "coleta"
    if lt in ("custom", "not_specified", "default"):
        return "proprio"
    return "desconhecido"


# Tipos de anúncio do Mercado Livre: gold_special = Clássico, gold_pro = Premium.
LISTING_TYPES = {"gold_special": "Clássico", "gold_pro": "Premium", "free": "Grátis"}


@dataclass
class CompetitorListing:
    item_id: str
    title: str
    price: float
    seller_id: str = ""
    seller_reputation: str = ""
    sold_quantity: int = 0
    free_shipping: bool = False
    category_id: str = ""
    url: str = ""
    position: int = 0  # posição no resultado de busca (1 = primeiro)
    shipping_mode: str = "desconhecido"  # full | flex | coleta | proprio | desconhecido
    listing_type: str = ""               # gold_special (Clássico) | gold_pro (Premium)
    official_store: bool = False
    seller_nickname: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ItemDetails:
    """Dados de um anúncio para a análise no estilo "raio-x" (UC15)."""
    item_id: str
    title: str
    price: float
    sold_quantity: int
    date_created: Optional[datetime]
    category_id: str = ""
    url: str = ""
    seller_id: str = ""
    seller_nickname: str = ""
    seller_reputation: str = ""
    official_store: bool = False
    listing_type: str = ""
    shipping_mode: str = "desconhecido"
    free_shipping: bool = False
    available_quantity: Optional[int] = None
    pictures: int = 0
    has_video: bool = False
    attributes_filled: int = 0
    attributes_total: int = 0
    description_length: int = 0
    catalog_listing: bool = False
    visits_30d: Optional[int] = None
    rating_average: Optional[float] = None
    reviews_total: Optional[int] = None
    attributes: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Review:
    item_id: str
    rate: int
    title: str = ""
    content: str = ""
    date_created: Optional[datetime] = None


@dataclass
class SellerListing:
    external_item_id: str
    title: str
    price: float
    stock_quantity: int
    status: str = "active"
    sku: str = ""
    ean: str = ""
    category_id: str = ""
    url: str = ""
    sold_quantity: int = 0
    shipping_mode: str = "desconhecido"
    listing_type: str = ""


@dataclass
class Order:
    external_order_id: str
    created_at: datetime
    status: str
    total_amount: float
    items: list[dict] = field(default_factory=list)  # {external_item_id, title, quantity, unit_price}
    marketplace_fee: float = 0.0
    shipping_cost: float = 0.0
    buyer_device: str = ""  # quando a plataforma informa


@dataclass
class Question:
    external_question_id: str
    external_item_id: str
    text: str
    received_at: datetime
    status: str = "UNANSWERED"
    buyer_nickname: str = ""
    answer_text: Optional[str] = None
    answered_at: Optional[datetime] = None


@dataclass
class FeeQuote:
    commission: float
    fixed_fee: float
    source: str = "api"

    @property
    def total(self) -> float:
        return self.commission + self.fixed_fee


class RateLimiter:
    """Limitador de taxa simples (token bucket) compartilhado por instância de conector."""

    def __init__(self, per_second: float):
        self.interval = 1.0 / per_second
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            if now < self._next:
                time.sleep(self._next - now)
            self._next = max(now, self._next) + self.interval


class MarketplaceConnector:
    """Base dos conectores. `name` é o identificador gravado no MongoDB (ex.: MERCADO_LIVRE)."""

    name = "BASE"
    max_retries = 5
    requests_per_second = 5.0

    def __init__(self, access_token: str | None = None):
        self.access_token = access_token
        self._limiter = RateLimiter(self.requests_per_second)
        self._http = httpx.Client(timeout=20)

    # -- HTTP resiliente (RNF01) -------------------------------------------------------------------------
    def _request(self, method: str, url: str, **kw: Any) -> Any:
        headers = kw.pop("headers", {})
        if self.access_token:
            headers.setdefault("Authorization", f"Bearer {self.access_token}")
        for attempt in range(self.max_retries):
            self._limiter.wait()
            try:
                resp = self._http.request(method, url, headers=headers, **kw)
            except httpx.TransportError:
                if attempt == self.max_retries - 1:
                    raise
                time.sleep(self._backoff(attempt))
                continue
            if resp.status_code == 401 and attempt == 0 and self.refresh_access_token():
                headers["Authorization"] = f"Bearer {self.access_token}"
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                retry_after = resp.headers.get("Retry-After")
                time.sleep(float(retry_after) if retry_after and retry_after.isdigit() else self._backoff(attempt))
                continue
            resp.raise_for_status()
            return resp.json() if resp.content else None
        raise RuntimeError(f"{self.name}: limite de tentativas excedido em {url}")

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(30.0, (2 ** attempt) + random.random())

    def refresh_access_token(self) -> bool:
        return False

    # -- Inteligência de mercado -------------------------------------------------------------------------
    def search_competitors(self, query: str, limit: int = 50) -> list[CompetitorListing]:
        raise NotImplementedError

    def get_reviews(self, item_id: str, limit: int = 50) -> list[Review]:
        return []

    def get_search_trends(self, category_id: str | None) -> list[str]:
        """Termos em alta na categoria, em ordem de relevância. Lista vazia se a plataforma não oferecer."""
        return []

    def get_device_breakdown(self, query: str, category_id: str | None) -> Optional[dict]:
        """{'mobile': 0.0-1.0, 'desktop': 0.0-1.0} quando a plataforma informa; None caso contrário."""
        return None

    def get_fees(self, price: float, category_id: str | None = None, listing_type: str = "gold_special") -> FeeQuote:
        raise NotImplementedError

    def get_shipping_cost(self, price: float, weight_g: int, dimensions_cm: str | None = None,
                          listing_type: str = "gold_special") -> Optional[float]:
        """Custo do frete grátis pago pelo vendedor por unidade enviada. None se a plataforma não informar."""
        return None

    def get_item_details(self, item_id: str) -> ItemDetails:
        raise NotImplementedError

    def get_search_suggestions(self, query: str) -> list[str]:
        """Sugestões de busca (autocompletar) para o termo. Lista vazia se a plataforma não oferecer."""
        return []

    # -- Operação do vendedor ----------------------------------------------------------------------------
    def get_seller_listings(self) -> list[SellerListing]:
        raise NotImplementedError

    def get_orders(self, since: datetime) -> list[Order]:
        raise NotImplementedError

    def get_questions(self, since: datetime | None = None) -> list[Question]:
        raise NotImplementedError

    def answer_question(self, external_question_id: str, text: str) -> None:
        raise NotImplementedError
