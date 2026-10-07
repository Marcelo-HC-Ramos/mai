"""Calculadora de custos (UC14), Full/Flex nas análises e ferramentas de anúncios (UC15-UC17)."""
from datetime import datetime, timedelta, timezone

import pytest

from mai import auth
from mai.ad_service import snapshot_all_tracked
from mai.analysis.ads import estimate_sales, market_overview, parse_item_id, quality_score
from mai.analysis.logistics import filter_by_modes, logistics_insights
from mai.cli import DEMO_EMAIL, DEMO_PASSWORD
from mai.connectors.base import CompetitorListing, FeeQuote, ItemDetails, shipping_mode
from mai.costs import CostCalculator, CostInputs, as_fee_fn, ml_fixed_fee, table_shipping

from .conftest import login

NOW = datetime(2026, 10, 6, tzinfo=timezone.utc)


# -- UC14: calculadora ---------------------------------------------------------------------------------
def test_fixed_fee_and_shipping_table():
    assert ml_fixed_fee(10) == 5.0 and ml_fixed_fee(20) == 6.25 and ml_fixed_fee(40) == 6.5
    assert ml_fixed_fee(60) == 6.75 and ml_fixed_fee(79) == 0
    assert table_shipping(250) == 19.95 and table_shipping(1500) == 23.45 and table_shipping(99_000) == 98.95


def test_calculation_by_hand():
    calc = CostCalculator({"tax_pct": 10, "packaging_cost": 2, "ads_pct": 0})
    r = calc.calculate(100, CostInputs(cost_price=40, weight_g=400, commission_pct=15), "gold_pro", "coleta")
    # 40 produto + 15 comissão + 21,45 frete (até 500 g) + 10 imposto + 2 embalagem = 88,45
    assert r["total_costs"] == 88.45 and r["profit"] == 11.55 and r["margin_pct"] == 11.6
    assert r["marketplace_payout"] == round(100 - 15 - 21.45, 2)
    assert r["roi_pct"] == 28.9 and r["markup"] == 2.5


def test_shipping_depends_on_mode_and_threshold():
    calc = CostCalculator({"flex_cost": 9, "full_storage_cost": 1.5, "own_shipping_cost": 4})
    i = CostInputs(cost_price=10, weight_g=400, commission_pct=10)
    ship = lambda price, mode: next(b["value"] for b in calc.calculate(price, i, "gold_special", mode)["breakdown"]  # noqa: E731
                                    if b["key"] == "shipping")
    assert ship(50, "coleta") == 0             # abaixo de R$ 79 o comprador paga o frete
    assert ship(100, "coleta") == 21.45
    assert ship(100, "full") == 22.95          # frete + armazenagem
    assert ship(100, "flex") == 9 and ship(100, "proprio") == 4


def test_marketplace_values_are_used_once():
    calls = []

    def fees(price, lt):
        calls.append(lt)
        return FeeQuote(commission=price * 0.12, fixed_fee=0, source="api")

    calc = CostCalculator({}, fees, lambda p, w, d, lt: 30.0)
    i = CostInputs(cost_price=50, weight_g=800)
    r = calc.report(150, i)
    shipping = next(b for b in r["breakdown"] if b["key"] == "shipping")
    assert shipping["value"] == 30.0 and shipping["source"] == "api"
    assert next(b for b in r["breakdown"] if b["key"] == "commission")["source"] == "api"
    assert sorted(set(calls)) == ["gold_pro", "gold_special"] and len(calls) == 2  # cache por tipo de anúncio
    assert len(r["scenarios"]) == 6


def test_price_for_margin_handles_free_shipping_cliff():
    calc = CostCalculator({"tax_pct": 0})
    # custo 40: abaixo de R$ 79 o frete não entra; 0,7p >= 40 + 6,75 de tarifa fixa -> R$ 66,79
    i = CostInputs(cost_price=40, weight_g=400, commission_pct=10)
    assert calc.price_for_margin(20, i, "gold_special", "coleta") == 66.79
    # custo 50: R$ 78,99 não chega a 20%; acima de R$ 79 entra o frete de R$ 21,45 -> 0,7p >= 71,45 -> R$ 102,08
    i = CostInputs(cost_price=50, weight_g=400, commission_pct=10)
    p = calc.price_for_margin(20, i, "gold_special", "coleta")
    assert p == 102.08  # não aceita R$ 102,00, que dá 19,95% e só "arredonda" para 20%
    be = calc.price_for_margin(0, i, "gold_special", "coleta")
    assert be <= p and calc.calculate(be, i, "gold_special", "coleta")["profit"] >= 0


def test_as_fee_fn_feeds_recommendation():
    calc = CostCalculator({"tax_pct": 5})
    q = as_fee_fn(calc, CostInputs(cost_price=30, weight_g=300, commission_pct=10))(100)
    assert q.commission == 10 and q.fixed_fee == round(19.95 + 5, 2) and q.source == "calculado"


# -- Full / Flex ---------------------------------------------------------------------------------------
def _l(i, mode, sold, price=100.0):
    return CompetitorListing(item_id=f"MLB{i}", title=f"Produto {i}", price=price, sold_quantity=sold, shipping_mode=mode)


def test_shipping_mode_mapping():
    assert shipping_mode("fulfillment", []) == "full"
    assert shipping_mode("self_service", []) == "flex"
    assert shipping_mode("cross_docking", ["self_service_in"]) == "flex"
    assert shipping_mode("drop_off", []) == "coleta"
    assert shipping_mode("custom", []) == "proprio"
    assert shipping_mode(None, []) == "desconhecido"


def test_logistics_insights_and_filter():
    ls = [_l(1, "full", 500, 120), _l(2, "full", 300, 110), _l(3, "flex", 100, 95), _l(4, "coleta", 20, 90),
          _l(5, "coleta", 10, 100)]
    r = logistics_insights(ls, "coleta", top_n=3)
    assert r["leader_mode"] == "full" and r["full_share_top_pct"] == pytest.approx(66.7)
    full = next(m for m in r["by_mode"] if m["mode"] == "full")
    assert full["listings"] == 2 and full["sales_share_pct"] == pytest.approx(86.0, abs=0.1)
    assert r["full_price_premium_pct"] == pytest.approx(round(100 * (115 / 95 - 1), 1))
    assert [l.item_id for l in filter_by_modes(ls, ["flex", "full"])] == ["MLB1", "MLB2", "MLB3"]
    assert len(filter_by_modes(ls, None)) == 5 and len(filter_by_modes(ls, ["xpto"])) == 5


# -- UC15/UC16: anúncios -------------------------------------------------------------------------------
@pytest.mark.parametrize("text,expected", [
    ("MLB123456789", "MLB123456789"),
    ("mlb-123456789", "MLB123456789"),
    ("https://produto.mercadolivre.com.br/MLB-3456789012-teclado-mecanico-_JM", "MLB3456789012"),
    ("https://www.mercadolivre.com.br/teclado/p/MLB19876543?item_id=MLB1234567890", "MLB1234567890"),
])
def test_parse_item_id(text, expected):
    assert parse_item_id(text) == expected


def _details(**kw):
    base = dict(item_id="MLB1", title="Teclado Mecânico Gamer RGB Switch Blue ABNT2 Sem Fio", price=200.0,
                sold_quantity=300, date_created=NOW - timedelta(days=300), visits_30d=1000)
    return ItemDetails(**{**base, **kw})


def test_estimate_sales_average_then_tracking():
    s = estimate_sales(_details(), now=NOW)
    assert s["monthly_units"] == 30 and s["monthly_revenue"] == 6000 and s["source"] == "estimativa"
    assert s["revenue_total_estimate"] == 60000 and s["conversion_pct"] == 3.0
    hist = [{"captured_at": NOW - timedelta(days=10), "sold_quantity": 280, "price": 190},
            {"captured_at": NOW - timedelta(days=5), "sold_quantity": 290, "price": 200},
            {"captured_at": NOW, "sold_quantity": 300, "price": 200}]
    t = estimate_sales(_details(), hist, now=NOW)
    assert t["source"] == "calculado" and t["tracked_units"] == 20 and t["monthly_units"] == 60
    assert t["tracked_revenue"] == 4000


def test_quality_score_weights():
    perfect = _details(pictures=8, has_video=True, attributes_filled=30, attributes_total=30, description_length=800,
                       free_shipping=True, shipping_mode="full", listing_type="gold_pro", rating_average=4.8)
    q = quality_score(perfect, ["teclado mecanico", "rgb", "switch blue"])
    assert q["score"] == 100 and sum(c["weight"] for c in q["checks"]) == 100
    assert quality_score(_details(title="Teclado"), ["rgb"])["score"] < 20


def test_market_overview_revenue_and_concentration():
    ls = [_l(i, "full" if i < 3 else "coleta", sold, price) for i, (sold, price) in
          enumerate([(100, 50), (50, 100), (10, 100), (5, 20)])]
    m = market_overview("x", ls)
    assert m["revenue_total_estimate"] == 5000 + 5000 + 1000 + 100
    assert m["listings"] == 4 and m["units_total"] == 165
    assert m["full_share_pct"] == 75.0


# -- API -----------------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def h(client):
    return login(client, DEMO_EMAIL, DEMO_PASSWORD)


def test_api_calculator_and_profile(client, h, db, org_id, seller_id):
    sid = str(seller_id)
    product = client.get(f"/api/sellers/{sid}/products", headers=h).json()[0]
    r = client.post("/api/calculator", headers=h, json={"seller_id": sid, "product_id": product["_id"],
                                                       "price": 199.9, "cost_price": 80, "tax_pct": 8})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["profile"]["tax_pct"] == 8 and len(body["scenarios"]) == 6
    assert body["break_even_price"] < body["price_for_target"]
    # simulação não altera o perfil salvo
    assert client.get(f"/api/sellers/{sid}/cost-profile", headers=h).json()["tax_pct"] == 6
    saved = client.put(f"/api/sellers/{sid}/cost-profile", headers=h, json={"tax_pct": 4.5, "flex_cost": 10}).json()
    assert saved["tax_pct"] == 4.5 and saved["flex_cost"] == 10
    assert client.post("/api/calculator", headers=h, json={"seller_id": sid, "price": 50, "cost_price": 20,
                                                          "dimensions_cm": "grande"}).status_code == 422
    auth.create_user(db, org_id, "Rui", "rui@demo.com", "senha-rui-1", "analyst")
    rui = login(client, "rui@demo.com", "senha-rui-1")
    assert client.put(f"/api/sellers/{sid}/cost-profile", headers=rui, json={"tax_pct": 1}).status_code == 403
    assert client.post("/api/calculator", headers=rui, json={"seller_id": sid, "price": 50, "cost_price": 20}).status_code == 200


def test_api_analyze_with_mode_filter(client, h, seller_id):
    product = client.get(f"/api/sellers/{seller_id}/products", headers=h).json()[0]
    assert client.post(f"/api/products/{product['_id']}/analyze?modes=full", headers=h).status_code == 200
    snap = client.get(f"/api/products/{product['_id']}/report", headers=h).json()
    snap = snap.get("snapshot", snap)
    assert snap["logistics"]["filter"] == ["full"]
    top = snap["competitor_data"]["top_competitors"]
    assert top and all(c["shipping_mode"] == "full" for c in top)
    # a visão de logística continua mostrando o mercado inteiro, não só o filtro
    assert sum(m["listings"] for m in snap["logistics"]["by_mode"]) > snap["competitor_data"]["total_competitors_found"]
    assert "cost_breakdown" in snap["pricing"]
    html = client.get(f"/api/products/{product['_id']}/report.html", headers=h).text
    assert "Full, Flex ou coleta?" in html


def test_api_ads_research_and_tracking(client, h, db, org_id):
    r = client.post("/api/ads/analyze", headers=h, json={"item": "https://produto.mercadolivre.com.br/MLB-9000003-x"})
    assert r.status_code == 200, r.text
    ad = r.json()
    assert ad["item"]["item_id"] == "MLB9000003" and 0 <= ad["quality"]["score"] <= 100
    assert ad["sales"]["source"] == "estimativa" and ad["keywords"]["associated"]
    assert client.get("/api/ads/recent", headers=h).json()[0]["item_id"] == "MLB9000003"

    m = client.get("/api/market/research?q=teclado mecanico", headers=h).json()
    assert m["listings"] > 10 and m["revenue_total_estimate"] > 0 and m["top_sellers"]
    full = client.get("/api/market/research?q=teclado mecanico&modes=full", headers=h).json()
    assert 0 < full["listings"] < m["listings"] and all(a["shipping_mode"] == "full" for a in full["ads"])

    assert client.post("/api/ads/tracked", headers=h, json={"item": "MLB9000003"}).status_code == 200
    rows = client.get("/api/ads/tracked", headers=h).json()
    assert rows[0]["item_id"] == "MLB9000003" and rows[0]["snapshots"] == 1 and rows[0]["sales_7d"] is None
    # uma segunda foto, 2 dias depois, com 6 vendas a mais: vendas passam a ser calculadas
    first = db.ad_snapshots.find_one({"item_id": "MLB9000003"})
    db.ad_snapshots.update_one({"_id": first["_id"]}, {"$set": {"captured_at": datetime.now(timezone.utc) - timedelta(days=2),
                                                              "sold_quantity": first["sold_quantity"] - 6}})
    assert snapshot_all_tracked(db) == 1
    row = client.get("/api/ads/tracked", headers=h).json()[0]
    assert row["sales_7d"] == 6 and row["revenue_30d"] == round(6 * row["price"], 2)
    again = client.post("/api/ads/analyze", headers=h, json={"item": "MLB9000003"}).json()
    assert again["tracked"] and again["sales"]["source"] == "calculado"
    client.delete("/api/ads/tracked/MLB9000003", headers=h)
    assert client.get("/api/ads/tracked", headers=h).json() == []


def test_ads_are_isolated_between_companies(client, h, db):
    client.post("/api/ads/tracked", headers=h, json={"item": "MLB9000004"})
    org, _ = auth.register_organization(db, "Concorrente SA", "Lia", "lia@conc.com", "senha-lia-1")
    lia = login(client, "lia@conc.com", "senha-lia-1")
    assert client.get("/api/ads/tracked", headers=lia).json() == []
    assert client.get("/api/ads/recent", headers=lia).json() == []
    # empresa sem conta conectada usa os dados de demonstração só se a configuração permitir; nunca a conta de outra
    r = client.get("/api/market/research?q=teclado", headers=lia)
    assert r.status_code in (200, 409)
