"""Conector do Mercado Livre (API oficial, https://developers.mercadolivre.com.br).

Endpoints usados:
  busca de itens ........ GET  /sites/{site}/search?q=
  avaliações ............ GET  /reviews/item/{item_id}
  tendências de busca ... GET  /trends/{site}/{category_id}
  tarifas ............... GET  /sites/{site}/listing_prices?price=
  anúncios do vendedor .. GET  /users/{id}/items/search  +  GET /items?ids=
  pedidos ............... GET  /orders/search?seller={id}
  perguntas ............. GET  /questions/search?seller_id={id}  |  POST /answers
  OAuth 2.0 ............. https://auth.mercadolivre.com.br/authorization  |  POST /oauth/token
  frete grátis .......... GET  /users/{id}/shipping_options/free?dimensions=AxLxC,peso
  raio-x do anúncio ..... GET  /items/{id}  +  /items/{id}/description  +  /users/{seller}  +  /items/visits
  sugestões de busca .... GET  https://http2.mlstatic.com/resources/sites/{site}/autosuggest (não oficial)

Full x Flex: vem de `shipping.logistic_type` ("fulfillment" = Full, "self_service" = Flex) e da tag
"self_service_in" (anúncio com Flex ativo). Veja `base.shipping_mode`.

A API não informa o dispositivo (celular x computador) de quem busca; `get_device_breakdown` devolve None e o
agente usa a estimativa por categoria (UC08).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Callable, Optional
from urllib.parse import urlencode

import httpx

from ..config import settings
from .base import (CompetitorListing, FeeQuote, ItemDetails, MarketplaceConnector, Order, Question, Review,
                   SellerListing, shipping_mode)

API = "https://api.mercadolibre.com"
AUTH_URL = "https://auth.mercadolivre.com.br/authorization"


def _dt(value: str | None) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def authorization_url(state: str) -> str:
    query = {"response_type": "code", "client_id": settings.ml_client_id,
             "redirect_uri": settings.ml_redirect_uri, "state": state}
    return f"{AUTH_URL}?{urlencode(query)}"


def exchange_code(code: str) -> dict:
    """Troca o authorization_code por tokens (UC01 passo 5)."""
    resp = httpx.post(f"{API}/oauth/token", data={
        "grant_type": "authorization_code", "client_id": settings.ml_client_id,
        "client_secret": settings.ml_client_secret, "code": code, "redirect_uri": settings.ml_redirect_uri,
    }, headers={"accept": "application/json"}, timeout=20)
    resp.raise_for_status()
    return resp.json()  # access_token, refresh_token, expires_in, user_id


class MercadoLivreConnector(MarketplaceConnector):
    name = "MERCADO_LIVRE"
    requests_per_second = 8.0

    def __init__(self, access_token: str | None = None, refresh_token: str | None = None,
                 user_id: str | None = None, site_id: str | None = None,
                 on_token_refresh: Callable[[dict], None] | None = None):
        super().__init__(access_token)
        self.refresh_token = refresh_token
        self.user_id = user_id
        self.site_id = site_id or settings.ml_site_id
        self.on_token_refresh = on_token_refresh

    def _get(self, path: str, **params):
        return self._request("GET", f"{API}{path}", params=params)

    def refresh_access_token(self) -> bool:
        if not self.refresh_token:
            return False
        resp = httpx.post(f"{API}/oauth/token", data={
            "grant_type": "refresh_token", "client_id": settings.ml_client_id,
            "client_secret": settings.ml_client_secret, "refresh_token": self.refresh_token,
        }, timeout=20)
        if resp.status_code != 200:
            return False
        data = resp.json()
        self.access_token, self.refresh_token = data["access_token"], data.get("refresh_token", self.refresh_token)
        if self.on_token_refresh:
            self.on_token_refresh(data)
        return True

    def _me(self) -> str:
        if not self.user_id:
            self.user_id = str(self._get("/users/me")["id"])
        return self.user_id

    # -- Inteligência de mercado -------------------------------------------------------------------------
    def search_competitors(self, query: str, limit: int = 50) -> list[CompetitorListing]:
        out: list[CompetitorListing] = []
        offset = 0
        while len(out) < limit:
            page = self._get(f"/sites/{self.site_id}/search", q=query, limit=min(50, limit - len(out)), offset=offset)
            results = page.get("results", [])
            if not results:
                break
            for r in results:
                shipping = r.get("shipping") or {}
                out.append(CompetitorListing(
                    item_id=r["id"], title=r.get("title", ""), price=float(r.get("price") or 0),
                    seller_id=str((r.get("seller") or {}).get("id", "")),
                    seller_reputation=((r.get("seller") or {}).get("seller_reputation") or {}).get("power_seller_status") or "",
                    sold_quantity=int(r.get("sold_quantity") or 0),
                    free_shipping=bool(shipping.get("free_shipping")),
                    category_id=r.get("category_id", ""), url=r.get("permalink", ""),
                    position=len(out) + 1,
                    shipping_mode=shipping_mode(shipping.get("logistic_type"), shipping.get("tags")),
                    listing_type=r.get("listing_type_id", ""), official_store=bool(r.get("official_store_id")),
                    seller_nickname=(r.get("seller") or {}).get("nickname", ""),
                ))
            offset += len(results)
        return out

    def get_reviews(self, item_id: str, limit: int = 50) -> list[Review]:
        out: list[Review] = []
        offset = 0
        while len(out) < limit:
            page = self._get(f"/reviews/item/{item_id}", limit=min(50, limit - len(out)), offset=offset)
            reviews = page.get("reviews", [])
            if not reviews:
                break
            out += [Review(item_id=item_id, rate=int(r.get("rate", 0)), title=r.get("title") or "",
                           content=r.get("content") or "", date_created=_dt(r.get("date_created"))) for r in reviews]
            offset += len(reviews)
        return out

    def get_search_trends(self, category_id: str | None) -> list[str]:
        path = f"/trends/{self.site_id}/{category_id}" if category_id else f"/trends/{self.site_id}"
        return [t["keyword"] for t in self._get(path) or []]

    def get_fees(self, price: float, category_id: str | None = None, listing_type: str = "gold_special") -> FeeQuote:
        params = {"price": price, "listing_type_id": listing_type}
        if category_id:
            params["category_id"] = category_id
        data = self._get(f"/sites/{self.site_id}/listing_prices", **params)
        data = data[0] if isinstance(data, list) else data
        details = data.get("sale_fee_details") or {}
        fixed = float(details.get("fixed_fee") or 0)
        return FeeQuote(commission=float(data.get("sale_fee_amount", 0)) - fixed, fixed_fee=fixed)

    def get_shipping_cost(self, price: float, weight_g: int, dimensions_cm: str | None = None,
                          listing_type: str = "gold_special") -> Optional[float]:
        dims = f"{dimensions_cm or '20x15x10'},{int(weight_g)}"
        data = self._get(f"/users/{self._me()}/shipping_options/free", dimensions=dims, item_price=price,
                         listing_type_id=listing_type, mode="me2", condition="new", verbose="true")
        cost = ((data.get("coverage") or {}).get("all_country") or {}).get("list_cost")
        return float(cost) if cost is not None else None

    def get_item_details(self, item_id: str) -> ItemDetails:
        it = self._get(f"/items/{item_id}", include_attributes="all")
        shipping = it.get("shipping") or {}
        attrs = it.get("attributes") or []
        filled = [a for a in attrs if a.get("value_name") not in (None, "", "-1")]
        seller = {}
        try:
            seller = self._get(f"/users/{it['seller_id']}")
        except Exception:
            pass
        desc_len = 0
        try:
            desc_len = len((self._get(f"/items/{item_id}/description") or {}).get("plain_text") or "")
        except Exception:
            pass
        visits = None
        try:
            today = datetime.now(timezone.utc).date()
            v = self._get("/items/visits", ids=item_id, date_from=str(today - timedelta(days=30)), date_to=str(today))
            visits = int((v[0] if isinstance(v, list) else v).get("total_visits", 0)) if v else None
        except Exception:
            pass
        rating = total = None
        try:
            rv = self._get(f"/reviews/item/{item_id}", limit=1)
            rating, total = rv.get("rating_average"), (rv.get("paging") or {}).get("total")
        except Exception:
            pass
        return ItemDetails(
            item_id=it["id"], title=it.get("title", ""), price=float(it.get("price") or 0),
            sold_quantity=int(it.get("sold_quantity") or 0), date_created=_dt(it.get("date_created")),
            category_id=it.get("category_id", ""), url=it.get("permalink", ""), seller_id=str(it.get("seller_id", "")),
            seller_nickname=seller.get("nickname", ""),
            seller_reputation=((seller.get("seller_reputation") or {}).get("power_seller_status") or ""),
            official_store=bool(it.get("official_store_id")), listing_type=it.get("listing_type_id", ""),
            shipping_mode=shipping_mode(shipping.get("logistic_type"), shipping.get("tags")),
            free_shipping=bool(shipping.get("free_shipping")), available_quantity=it.get("available_quantity"),
            pictures=len(it.get("pictures") or []), has_video=bool(it.get("video_id")),
            attributes_filled=len(filled), attributes_total=len(attrs), description_length=desc_len,
            catalog_listing=bool(it.get("catalog_listing")), visits_30d=visits, rating_average=rating,
            reviews_total=total, attributes={a.get("name"): a.get("value_name") for a in filled},
        )

    def get_search_suggestions(self, query: str) -> list[str]:
        resp = httpx.get(f"https://http2.mlstatic.com/resources/sites/{self.site_id}/autosuggest",
                         params={"q": query, "limit": 10, "api_version": 2}, timeout=10)
        resp.raise_for_status()
        return [s["q"] for s in resp.json().get("suggested_queries", [])]

    # -- Operação do vendedor ----------------------------------------------------------------------------
    def get_seller_listings(self) -> list[SellerListing]:
        ids: list[str] = []
        offset = 0
        while True:
            page = self._get(f"/users/{self._me()}/items/search", limit=50, offset=offset)
            ids += page.get("results", [])
            offset += 50
            if offset >= page.get("paging", {}).get("total", 0):
                break
        out: list[SellerListing] = []
        for i in range(0, len(ids), 20):
            for entry in self._get("/items", ids=",".join(ids[i:i + 20])):
                b = entry.get("body") or {}
                attrs = {a.get("id"): a.get("value_name") for a in b.get("attributes", [])}
                out.append(SellerListing(
                    external_item_id=b["id"], title=b.get("title", ""), price=float(b.get("price") or 0),
                    stock_quantity=int(b.get("available_quantity") or 0), status=b.get("status", ""),
                    sku=attrs.get("SELLER_SKU") or b.get("seller_custom_field") or b["id"],
                    ean=attrs.get("GTIN") or "", category_id=b.get("category_id", ""),
                    url=b.get("permalink", ""), sold_quantity=int(b.get("sold_quantity") or 0),
                    shipping_mode=shipping_mode((b.get("shipping") or {}).get("logistic_type"),
                                                (b.get("shipping") or {}).get("tags")),
                    listing_type=b.get("listing_type_id", ""),
                ))
        return out

    def get_orders(self, since: datetime) -> list[Order]:
        out: list[Order] = []
        offset = 0
        while True:
            page = self._get("/orders/search", seller=self._me(), sort="date_desc", offset=offset, limit=50,
                             **{"order.date_created.from": since.strftime("%Y-%m-%dT%H:%M:%S.000-00:00")})
            for o in page.get("results", []):
                items = [{"external_item_id": it["item"]["id"], "title": it["item"].get("title", ""),
                          "quantity": int(it.get("quantity", 1)), "unit_price": float(it.get("unit_price", 0))}
                         for it in o.get("order_items", [])]
                fee = sum(float(it.get("sale_fee") or 0) * int(it.get("quantity", 1)) for it in o.get("order_items", []))
                out.append(Order(external_order_id=str(o["id"]), created_at=_dt(o["date_created"]),
                                 status=o.get("status", ""), total_amount=float(o.get("total_amount", 0)),
                                 items=items, marketplace_fee=fee))
            offset += 50
            if offset >= page.get("paging", {}).get("total", 0):
                break
        return out

    def get_questions(self, since: datetime | None = None) -> list[Question]:
        out: list[Question] = []
        offset = 0
        while True:
            page = self._get("/questions/search", seller_id=self._me(), api_version=4, offset=offset, limit=50,
                             sort_fields="date_created", sort_types="DESC")
            for q in page.get("questions", []):
                received = _dt(q["date_created"])
                if since and received < since:
                    return out
                answer = q.get("answer") or {}
                out.append(Question(
                    external_question_id=str(q["id"]), external_item_id=q["item_id"], text=q.get("text", ""),
                    received_at=received, status="ANSWERED" if q.get("status") == "ANSWERED" else "UNANSWERED",
                    buyer_nickname=str((q.get("from") or {}).get("id", "")),
                    answer_text=answer.get("text"), answered_at=_dt(answer.get("date_created")),
                ))
            offset += 50
            if offset >= page.get("total", 0):
                break
        return out

    def answer_question(self, external_question_id: str, text: str) -> None:
        self._request("POST", f"{API}/answers", json={"question_id": int(external_question_id), "text": text})
