"""Conector de demonstração: gera um mercado sintético e determinístico, sem internet.

Serve para testar o sistema ponta a ponta e para apresentar os dashboards antes de conectar uma conta real.
Todos os dados que ele produz são fictícios.
"""
from __future__ import annotations

import hashlib
import random
from datetime import datetime, timedelta, timezone

from ..textutil import tokens
from .base import (CompetitorListing, FeeQuote, ItemDetails, MarketplaceConnector, Order, Question, Review,
                   SellerListing)

CATALOG = [
    {"sku": "MEC-RGB-WL", "ean": "7898956789123", "title": "Teclado Mecânico Sem Fio Switch Blue RGB",
     "price": 249.90, "cost": 120.00, "min": 180.00, "stock": 42, "category": "MLB1714",
     "pool": ["teclado mecanico", "sem fio", "bluetooth", "gamer", "rgb", "switch blue", "switch azul", "abnt2",
              "wireless", "60%", "hot swap", "redragon", "usb-c", "led"],
     "trends": ["teclado mecanico", "teclado gamer", "teclado sem fio", "teclado bluetooth", "mouse gamer",
                "teclado mecanico sem fio", "headset gamer", "teclado redragon"]},
    {"sku": "FONE-BT-ANC", "ean": "7891234500011", "title": "Fone de Ouvido Bluetooth com Cancelamento de Ruído",
     "price": 189.90, "cost": 85.00, "min": 140.00, "stock": 8, "category": "MLB1676",
     "pool": ["fone de ouvido", "bluetooth", "cancelamento de ruido", "anc", "sem fio", "tws", "microfone",
              "a prova d agua", "esportivo", "bateria longa"],
     "trends": ["fone bluetooth", "fone de ouvido sem fio", "fone jbl", "airpods", "fone com cancelamento de ruido",
                "fone gamer"]},
    {"sku": "SW-FIT-02", "ean": "7891234500028", "title": "Smartwatch Relógio Inteligente Monitor Cardíaco",
     "price": 159.90, "cost": 70.00, "min": 120.00, "stock": 0, "category": "MLB135384",
     "pool": ["smartwatch", "relogio inteligente", "monitor cardiaco", "a prova d agua", "notificacoes",
              "android ios", "pulseira", "oximetro", "gps"],
     "trends": ["smartwatch", "relogio smartwatch", "smartwatch feminino", "relogio inteligente", "smartband"]},
    {"sku": "CAD-GAM-PRO", "ean": "7891234500035", "title": "Cadeira Gamer Reclinável com Apoio Lombar",
     "price": 899.90, "cost": 480.00, "min": 650.00, "stock": 15, "category": "MLB254183",
     "pool": ["cadeira gamer", "reclinavel", "apoio lombar", "ergonomica", "escritorio", "giratoria",
              "almofada", "suporta 150kg", "couro sintetico"],
     "trends": ["cadeira gamer", "cadeira escritorio", "cadeira ergonomica", "cadeira", "mesa gamer"]},
    {"sku": "GAR-TERM-1L", "ean": "7891234500042", "title": "Garrafa Térmica Inox 1 Litro Parede Dupla",
     "price": 79.90, "cost": 28.00, "min": 55.00, "stock": 120, "category": "MLB1580",
     "pool": ["garrafa termica", "inox", "1 litro", "parede dupla", "agua gelada", "academia", "squeeze",
              "24 horas", "tampa"],
     "trends": ["garrafa termica", "garrafa stanley", "copo termico", "garrafa de agua", "squeeze"]},
]

REVIEW_TEXTS = {
    5: ["Excelente produto, chegou antes do prazo.", "Muito bom, recomendo!", "Ótima qualidade pelo preço."],
    4: ["Bom produto, atende bem.", "Gostei, só a embalagem que podia ser melhor."],
    3: ["Produto ok, mas a bateria dura menos do que o anúncio diz.", "Razoável, a qualidade do material é fraca.",
        "Chegou com atraso de uma semana, mas funciona."],
    2: ["Parou de funcionar depois de um mês de uso.", "Veio diferente da foto, a cor não é a mesma do anúncio.",
        "Material frágil, quebrou fácil.", "A entrega atrasou muito e ninguém respondeu.",
        "Não conecta no meu celular, problema de compatibilidade com bluetooth."],
    1: ["Veio com defeito, não liga.", "Produto chegou quebrado, caixa toda amassada.",
        "Faltou peça, veio sem o cabo.", "Péssimo, estragou em duas semanas.",
        "Vendedor não responde, quero devolver e não consigo."],
}

QUESTIONS = ["Tem garantia?", "Qual o prazo de entrega para São Paulo?", "Funciona com iPhone?",
             "Ainda tem em estoque?", "Qual a voltagem?", "Vem com nota fiscal?", "Qual o tamanho exato?",
             "Aceita troca se não servir?", "Faz desconto para duas unidades?", "É compatível com PS5?"]


def _rng(*parts) -> random.Random:
    return random.Random(int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:12], 16))


def _match(query: str) -> dict:
    q = set(tokens(query))
    return max(CATALOG, key=lambda p: (len(q & set(tokens(p["title"]))), p["ean"] in query))


class DemoConnector(MarketplaceConnector):
    """`account_key` identifica a conta fictícia: cada chave gera um catálogo, preços, pedidos e perguntas próprios,
    para simular uma loja com mais de uma conta no marketplace."""

    name = "DEMO"

    def __init__(self, access_token: str | None = None, now: datetime | None = None, account_key: str = "DEMO-1", **_):
        super().__init__(access_token)
        self.now = now or datetime.now(timezone.utc)
        self.seller_id = account_key
        rng = _rng("catalog", account_key)
        if account_key.endswith("-1"):  # primeira conta: catálogo completo
            self.catalog = [dict(p) for p in CATALOG]
        else:  # contas extras vendem parte do catálogo, com preço e estoque diferentes
            self.catalog = [dict(p) for p in rng.sample(CATALOG, k=3)]
            for p in self.catalog:
                p["price"] = float(f"{int(p['price'] * rng.uniform(0.93, 1.05))}.90")
                p["stock"] = rng.randint(0, 60)

    def _item_id(self, p: dict) -> str:
        return f"MLB-{self.seller_id}-{p['sku']}"

    def search_competitors(self, query: str, limit: int = 50) -> list[CompetitorListing]:
        p = _match(query)
        rng = _rng("market", p["sku"])
        out = []
        for i in range(min(limit, 32)):
            words = rng.sample(p["pool"], k=min(4, len(p["pool"])))
            price = round(rng.gauss(p["price"] * 1.04, p["price"] * 0.12), 2)
            if i in (7, 21):  # anúncios discrepantes (kits, peças, erros de cadastro)
                price = round(p["price"] * (0.25 if i == 7 else 2.6), 2)
            sold = int(rng.paretovariate(1.2) * 20)
            # quem vende mais tende a estar no Full (como no mercado real)
            mode = rng.choices(["full", "flex", "coleta", "proprio"],
                               weights=[60, 15, 20, 5] if sold > 60 else [25, 20, 45, 10])[0]
            seller_n = rng.randint(1, 9999)
            out.append(CompetitorListing(
                item_id=f"MLB{9000000 + i}{p['sku'][:3]}", title=f"{words[0].title()} " + " ".join(words[1:]),
                price=max(price, 1.0), seller_id=f"S{seller_n}", seller_nickname=f"LOJA_{seller_n}",
                seller_reputation=rng.choice(["platinum", "gold", "silver", ""]),
                sold_quantity=sold, free_shipping=price >= 79 or rng.random() < 0.3,
                category_id=p["category"], url=f"https://produto.mercadolivre.com.br/demo-{i}", position=i + 1,
                shipping_mode=mode, listing_type=rng.choice(["gold_pro", "gold_pro", "gold_special"]),
                official_store=rng.random() < 0.12,
            ))
        return out

    def get_item_details(self, item_id: str) -> ItemDetails:
        """Raio-x fictício e determinístico. Aceita ids da busca de demonstração, da própria loja ou qualquer outro."""
        listing = None
        for p in CATALOG:
            if item_id.endswith(p["sku"][:3]) or item_id.endswith(p["sku"]):
                found = [c for c in self.search_competitors(p["title"]) if c.item_id == item_id]
                listing = found[0] if found else None
                if listing is None and item_id.endswith(p["sku"]):  # anúncio da própria loja
                    listing = CompetitorListing(item_id=item_id, title=p["title"], price=p["price"],
                                                sold_quantity=180, category_id=p["category"], shipping_mode="coleta",
                                                listing_type="gold_pro", seller_nickname="SUA_LOJA",
                                                free_shipping=p["price"] >= 79)
                break
        rng = _rng("details", item_id)
        if listing is None:
            p = CATALOG[int(hashlib.sha256(item_id.encode()).hexdigest(), 16) % len(CATALOG)]
            listing = self.search_competitors(p["title"])[rng.randint(0, 20)]
            listing.item_id = item_id
        age_days = rng.randint(45, 900)
        monthly = max(1, listing.sold_quantity * 30 / age_days)
        total_attrs = 35
        return ItemDetails(
            item_id=listing.item_id, title=listing.title, price=listing.price, sold_quantity=listing.sold_quantity,
            date_created=self.now - timedelta(days=age_days), category_id=listing.category_id, url=listing.url,
            seller_id=listing.seller_id, seller_nickname=listing.seller_nickname or "LOJA_DEMO",
            seller_reputation=listing.seller_reputation, official_store=listing.official_store,
            listing_type=listing.listing_type or "gold_pro", shipping_mode=listing.shipping_mode,
            free_shipping=listing.free_shipping, available_quantity=rng.randint(0, 400),
            pictures=rng.randint(2, 12), has_video=rng.random() < 0.35,
            attributes_filled=rng.randint(12, total_attrs), attributes_total=total_attrs,
            description_length=rng.choice([0, 180, 650, 1400, 2600]), catalog_listing=rng.random() < 0.3,
            visits_30d=int(monthly / rng.uniform(0.015, 0.06)), rating_average=round(rng.uniform(3.6, 4.9), 1),
            reviews_total=int(listing.sold_quantity * rng.uniform(0.1, 0.3)),
            attributes={"Marca": rng.choice(["Genérica", "Redragon", "JBL", "Xiaomi"]), "Modelo": f"X{rng.randint(10, 99)}"},
        )

    def get_search_suggestions(self, query: str) -> list[str]:
        p = _match(query)
        base = " ".join(tokens(p["title"])[:2])
        extra = [t for t in p["pool"] if not set(tokens(t)) <= set(base.split())][:7]
        return [base] + [f"{base} {t}" for t in extra] + p["trends"][:2]

    def get_shipping_cost(self, price: float, weight_g: int, dimensions_cm: str | None = None,
                          listing_type: str = "gold_special"):
        return None  # a demonstração usa a tabela de referência da calculadora

    def get_reviews(self, item_id: str, limit: int = 50) -> list[Review]:
        rng = _rng("reviews", item_id)
        out = []
        for _ in range(min(limit, rng.randint(15, 40))):
            rate = rng.choices([5, 4, 3, 2, 1], weights=[55, 18, 10, 9, 8])[0]
            out.append(Review(item_id=item_id, rate=rate, content=rng.choice(REVIEW_TEXTS[rate]),
                              date_created=self.now - timedelta(days=rng.randint(1, 180))))
        return out

    def get_search_trends(self, category_id: str | None) -> list[str]:
        p = next((c for c in CATALOG if c["category"] == category_id), None)
        return p["trends"] if p else []

    def get_fees(self, price: float, category_id: str | None = None, listing_type: str = "gold_special") -> FeeQuote:
        # Aproximação das tarifas do Mercado Livre: Clássico ~11,5%, Premium ~16,5%, mais tarifa fixa abaixo de R$ 79.
        from ..costs import ml_fixed_fee
        pct = 0.165 if listing_type == "gold_pro" else 0.115
        return FeeQuote(commission=round(price * pct, 2), fixed_fee=ml_fixed_fee(price), source="estimativa")

    def get_seller_listings(self) -> list[SellerListing]:
        return [SellerListing(external_item_id=self._item_id(p), title=p["title"], price=p["price"],
                              stock_quantity=p["stock"], sku=p["sku"], ean=p["ean"], category_id=p["category"],
                              url=f"https://produto.mercadolivre.com.br/demo-{p['sku']}",
                              shipping_mode="coleta" if self.seller_id.endswith("-1") else "full",
                              listing_type="gold_pro" if self.seller_id.endswith("-1") else "gold_special")
                for p in self.catalog]

    def get_orders(self, since: datetime) -> list[Order]:
        rng = _rng("orders", self.seller_id)
        out = []
        day = self.now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=120)
        n = 0
        while day <= self.now:
            scale = 1.0 if self.seller_id.endswith("-1") else 0.4
            for _ in range(int((rng.randint(2, 9) + (3 if day.weekday() in (0, 1) else 0)) * scale)):
                p = rng.choice(self.catalog) if len(self.catalog) < 5 else rng.choices(self.catalog, weights=[30, 25, 20, 5, 20])[0]
                qty = rng.choices([1, 2, 3], weights=[85, 12, 3])[0]
                total = round(p["price"] * qty, 2)
                created = day + timedelta(minutes=rng.randint(0, 1439))
                if created > self.now or created < since:
                    continue
                n += 1
                out.append(Order(
                    external_order_id=f"{self.seller_id}-{n:06d}", created_at=created,
                    status=rng.choices(["paid", "cancelled"], weights=[95, 5])[0], total_amount=total,
                    items=[{"external_item_id": self._item_id(p), "title": p["title"], "quantity": qty,
                            "unit_price": p["price"]}],
                    marketplace_fee=round(total * 0.165, 2), shipping_cost=round(rng.uniform(0, 25), 2) if total >= 79 else 0,
                ))
            day += timedelta(days=1)
        return out

    def get_questions(self, since: datetime | None = None) -> list[Question]:
        rng = _rng("questions", self.seller_id)
        out = []
        for i in range(40 if self.seller_id.endswith("-1") else 12):
            p = rng.choice(self.catalog)
            received = self.now - timedelta(hours=rng.randint(1, 24 * 45))
            answered = rng.random() < 0.8 and received < self.now - timedelta(hours=3)
            out.append(Question(
                external_question_id=f"{self.seller_id}-Q{i:04d}", external_item_id=self._item_id(p),
                text=rng.choice(QUESTIONS), received_at=received, buyer_nickname=f"comprador{rng.randint(1, 999)}",
                status="ANSWERED" if answered else "UNANSWERED",
                answer_text="Olá! Sim, temos. Obrigado pelo contato." if answered else None,
                answered_at=received + timedelta(minutes=rng.randint(5, 600)) if answered else None,
            ))
        return [q for q in out if not since or q.received_at >= since]

    def answer_question(self, external_question_id: str, text: str) -> None:
        return None
