"""UC14: calculadora de custos e lucro por anúncio, no estilo das extensões de vendedor (ex.: Zinx).

Para cada preço de venda calcula, por unidade: comissão do marketplace (por tipo de anúncio), tarifa fixa, frete
pago pelo vendedor (conforme a modalidade: coleta/agência, Full, Flex ou envio próprio), impostos, Mercado Ads,
embalagem, custos extras e custo do produto. Devolve lucro, margem, ROI, markup, preço de equilíbrio e o preço que
atinge a margem desejada.

Os parâmetros ficam no perfil de custos da loja (`sellers.cost_profile`) e podem ser trocados em cada simulação.
Cálculo 100% local depois de uma consulta ao marketplace (comissão e frete), para simular centenas de preços.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from .connectors.base import FeeQuote, LISTING_TYPES, SHIPPING_MODES

DEFAULT_PROFILE: dict = {
    "listing_type": "gold_pro",        # gold_special = Clássico, gold_pro = Premium
    "shipping_mode": "coleta",         # coleta | full | flex | proprio
    "tax_pct": 6.0,                    # imposto sobre a venda (ex.: Simples Nacional)
    "ads_pct": 0.0,                    # Mercado Ads como % do faturamento (TACOS)
    "installment_pct": 0.0,            # custo de parcelamento sem juros oferecido ao comprador
    "other_cost_pct": 0.0,             # outros custos em % da venda (antecipação, gateway...)
    "packaging_cost": 0.0,             # embalagem e etiqueta por unidade (R$)
    "other_cost_fixed": 0.0,           # outros custos fixos por unidade (mão de obra, insumos) (R$)
    "flex_cost": 12.0,                 # custo médio da sua entrega Flex por pedido (R$)
    "full_storage_cost": 0.0,          # armazenagem/serviço do Full por unidade (R$)
    "own_shipping_cost": 0.0,          # custo do envio próprio por pedido, quando você paga (R$)
    "shipping_discount_pct": 0.0,      # desconto de frete da sua reputação sobre a tabela (%)
    "free_shipping_threshold": 79.0,   # a partir deste preço o frete grátis é obrigatório no Mercado Livre
    "target_margin_pct": 20.0,         # margem líquida desejada
}

# Tabela de referência do frete grátis pago pelo vendedor no Mercado Livre, por peso (kg -> R$), já com o desconto
# típico de reputação verde. Valores aproximados para estimativa: a loja pode substituir em `shipping_table` e,
# com conta conectada, o MAI consulta o valor real na API (/users/{id}/shipping_options/free).
SHIPPING_TABLE = [(0.3, 19.95), (0.5, 21.45), (1, 22.45), (2, 23.45), (3, 24.95), (4, 26.95), (5, 28.45),
                  (9, 44.45), (13, 68.45), (17, 73.95), (23, 84.95), (30, 98.95)]


def ml_fixed_fee(price: float) -> float:
    """Tarifa fixa por unidade do Mercado Livre para itens abaixo de R$ 79."""
    if price >= 79:
        return 0.0
    if price < 12.5:
        return round(price * 0.5, 2)
    if price < 29:
        return 6.25
    if price < 50:
        return 6.50
    return 6.75


def table_shipping(weight_g: Optional[int], table: Optional[list] = None) -> float:
    kg = (weight_g or 500) / 1000
    for limit, cost in (table or SHIPPING_TABLE):
        if kg <= limit:
            return cost
    return (table or SHIPPING_TABLE)[-1][1]


@dataclass
class CostInputs:
    cost_price: float
    weight_g: Optional[int] = None
    dimensions_cm: Optional[str] = None
    commission_pct: Optional[float] = None      # se None, vem do marketplace
    shipping_cost: Optional[float] = None       # se None, calcula pela modalidade
    packaging_cost: Optional[float] = None      # se None, usa o perfil da loja


class CostCalculator:
    """Calculadora para um produto em uma loja. `fees_fn(preço, tipo)` e `shipping_fn(preço, peso, dim, tipo)`
    vêm do conector da conta; sem conta, usa a referência local."""

    def __init__(self, profile: Optional[dict] = None,
                 fees_fn: Optional[Callable[[float, str], FeeQuote]] = None,
                 shipping_fn: Optional[Callable[[float, Optional[int], Optional[str], str], Optional[float]]] = None):
        self.profile = {**DEFAULT_PROFILE, **{k: v for k, v in (profile or {}).items() if v is not None}}
        self.fees_fn = fees_fn
        self.shipping_fn = shipping_fn
        self._commission_cache: dict[str, tuple[float, str]] = {}
        self._shipping_cache: dict[tuple, tuple[float, str]] = {}

    # -- parâmetros vindos do marketplace (consultados uma vez) --------------------------------------------
    def commission_pct(self, listing_type: str, ref_price: float, inputs: CostInputs) -> tuple[float, str]:
        if inputs.commission_pct is not None:
            return inputs.commission_pct, "informado"
        if listing_type not in self._commission_cache:
            pct, src = (11.5 if listing_type == "gold_special" else 16.5), "estimativa"
            if self.fees_fn:
                try:
                    q = self.fees_fn(max(ref_price, 100.0), listing_type)
                    pct, src = round(100 * q.commission / max(ref_price, 100.0), 2), q.source
                except Exception:
                    pass
            self._commission_cache[listing_type] = (pct, src)
        return self._commission_cache[listing_type]

    def free_shipping_cost(self, ref_price: float, inputs: CostInputs, listing_type: str) -> tuple[float, str]:
        key = (inputs.weight_g, inputs.dimensions_cm, listing_type)
        if key not in self._shipping_cache:
            cost, src = table_shipping(inputs.weight_g, self.profile.get("shipping_table")), "estimativa"
            if self.shipping_fn:
                try:
                    api = self.shipping_fn(max(ref_price, self.profile["free_shipping_threshold"]),
                                           inputs.weight_g or 500, inputs.dimensions_cm, listing_type)
                    if api is not None:
                        cost, src = api, "api"
                except Exception:
                    pass
            if src == "estimativa":
                cost = cost * (1 - self.profile["shipping_discount_pct"] / 100)
            self._shipping_cache[key] = (round(cost, 2), src)
        return self._shipping_cache[key]

    def shipping_for(self, price: float, mode: str, inputs: CostInputs, listing_type: str) -> tuple[float, str, str]:
        """(custo, fonte, explicação) do frete pago pelo vendedor por unidade."""
        p = self.profile
        if inputs.shipping_cost is not None:
            return inputs.shipping_cost, "informado", "Frete informado na simulação"
        if mode == "proprio":
            return p["own_shipping_cost"], "perfil", "Envio próprio (custo do perfil da loja)"
        if mode == "flex":
            return p["flex_cost"], "perfil", "Entrega Flex feita por você (custo médio do perfil)"
        if price < p["free_shipping_threshold"]:
            return 0.0, "regra", f"Abaixo de R$ {p['free_shipping_threshold']:.0f} o comprador paga o frete"
        cost, src = self.free_shipping_cost(price, inputs, listing_type)
        if mode == "full":
            return round(cost + p["full_storage_cost"], 2), src, "Frete grátis Full + armazenagem"
        return cost, src, "Frete grátis Mercado Envios (coleta/agência)"

    # -- cálculo --------------------------------------------------------------------------------------------
    def calculate(self, price: float, inputs: CostInputs, listing_type: Optional[str] = None,
                  mode: Optional[str] = None) -> dict:
        p = self.profile
        lt = listing_type or p["listing_type"]
        mode = mode or p["shipping_mode"]
        pct, pct_src = self.commission_pct(lt, price, inputs)
        ship, ship_src, ship_note = self.shipping_for(price, mode, inputs, lt)
        packaging = inputs.packaging_cost if inputs.packaging_cost is not None else p["packaging_cost"]
        items = [
            ("product", "Custo do produto", inputs.cost_price, "informado"),
            ("commission", f"Comissão {LISTING_TYPES.get(lt, lt)} ({pct:.1f}%)".replace(".", ","), price * pct / 100, pct_src),
            ("fixed_fee", "Tarifa fixa do marketplace", ml_fixed_fee(price), "regra"),
            ("shipping", ship_note, ship, ship_src),
            ("tax", f"Impostos ({p['tax_pct']:g}%)".replace(".", ","), price * p["tax_pct"] / 100, "perfil"),
            ("ads", f"Mercado Ads ({p['ads_pct']:g}%)".replace(".", ","), price * p["ads_pct"] / 100, "perfil"),
            ("installments", f"Parcelamento ({p['installment_pct']:g}%)".replace(".", ","), price * p["installment_pct"] / 100, "perfil"),
            ("other_pct", f"Outros ({p['other_cost_pct']:g}%)".replace(".", ","), price * p["other_cost_pct"] / 100, "perfil"),
            ("packaging", "Embalagem", packaging, "perfil"),
            ("other_fixed", "Outros custos por unidade", p["other_cost_fixed"], "perfil"),
        ]
        breakdown = [{"key": k, "label": l, "value": round(v, 2), "pct_of_price": round(100 * v / price, 1) if price else 0,
                      "source": s} for k, l, v, s in items if v or k in ("product", "commission", "shipping")]
        total = round(sum(b["value"] for b in breakdown), 2)
        profit = round(price - total, 2)
        received = round(price - sum(b["value"] for b in breakdown if b["key"] in ("commission", "fixed_fee", "shipping")), 2)
        return {
            "price": round(price, 2), "listing_type": lt, "listing_type_label": LISTING_TYPES.get(lt, lt),
            "shipping_mode": mode, "shipping_mode_label": SHIPPING_MODES.get(mode, mode),
            "breakdown": breakdown, "total_costs": total,
            "marketplace_payout": received,   # o que o marketplace repassa (preço - comissão - tarifa - frete)
            "profit": profit,
            "margin_pct": round(100 * profit / price, 1) if price else 0.0,
            "roi_pct": round(100 * profit / inputs.cost_price, 1) if inputs.cost_price else None,
            "markup": round(price / inputs.cost_price, 2) if inputs.cost_price else None,
        }

    def price_for_margin(self, target_pct: float, inputs: CostInputs, listing_type: Optional[str] = None,
                         mode: Optional[str] = None) -> Optional[float]:
        """Menor preço (centavos) que atinge a margem alvo; None se nenhum até 20x o custo.

        A margem não é monotônica: no limite do frete grátis (R$ 79) o custo de frete entra e o lucro cai. Por isso
        varre em passos de R$ 1, testa o centavo antes do limite e refina em centavos o intervalo encontrado.
        """
        def ok(price: float) -> bool:  # compara o lucro sem arredondar a margem (19,95% não conta como 20%)
            return self.calculate(price, inputs, listing_type, mode)["profit"] >= price * target_pct / 100 - 1e-9

        threshold = self.profile["free_shipping_threshold"]
        limit = inputs.cost_price * 20 + 50
        prev, price = None, max(0.5, round(inputs.cost_price, 2))
        while price <= limit:
            if prev is not None and prev < threshold <= price and ok(round(threshold - 0.01, 2)):
                price = round(threshold - 0.01, 2)
            if ok(price):
                lo = prev if prev is not None else price
                cents = int(round((price - lo) * 100))
                for c in range(cents + 1):
                    candidate = round(lo + c / 100, 2)
                    if ok(candidate):
                        return candidate
                return price
            prev, price = price, round(price + 1.0, 2)
        return None

    def report(self, price: float, inputs: CostInputs, target_pct: Optional[float] = None) -> dict:
        """Resultado completo para a tela: cálculo no preço, equilíbrio, preço alvo e cenários comparados."""
        target = self.profile["target_margin_pct"] if target_pct is None else target_pct
        main = self.calculate(price, inputs)
        scenarios = []
        for lt in ("gold_special", "gold_pro"):
            for mode in ("coleta", "full", "flex"):
                r = self.calculate(price, inputs, lt, mode)
                scenarios.append({k: r[k] for k in ("listing_type", "listing_type_label", "shipping_mode",
                                                    "shipping_mode_label", "total_costs", "profit", "margin_pct")})
        return {
            **main,
            "break_even_price": self.price_for_margin(0.0, inputs),
            "target_margin_pct": target,
            "price_for_target": self.price_for_margin(target, inputs),
            "scenarios": scenarios,
            "profile": self.profile,
        }


def as_fee_fn(calc: CostCalculator, inputs: CostInputs) -> Callable[[float], FeeQuote]:
    """Adapta a calculadora ao `recommend_price`: custos variáveis completos (sem o custo do produto)."""
    def fn(price: float) -> FeeQuote:
        r = calc.calculate(price, inputs)
        commission = sum(b["value"] for b in r["breakdown"] if b["key"] in ("commission",))
        others = sum(b["value"] for b in r["breakdown"] if b["key"] not in ("commission", "product"))
        return FeeQuote(commission=round(commission, 2), fixed_fee=round(others, 2), source="calculado")
    return fn

