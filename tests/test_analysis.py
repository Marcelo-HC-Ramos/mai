from mai.analysis.devices import device_insights
from mai.analysis.keywords import keyword_insights
from mai.analysis.pricing import competitor_stats, recommend_price, remove_outliers_iqr
from mai.analysis.reviews import classify_text, review_insights
from mai.connectors.base import CompetitorListing, FeeQuote, Review


def L(price, sold=10, title="Teclado mecanico sem fio rgb", free=True):
    return CompetitorListing(item_id=f"I{price}", title=title, price=price, sold_quantity=sold, free_shipping=free)


def fee(p):
    return FeeQuote(commission=round(p * 0.16, 2), fixed_fee=0.0)


def test_iqr_removes_outliers():
    kept, dropped = remove_outliers_iqr([L(p) for p in [100, 102, 98, 101, 99, 103, 20, 500]])
    assert {d.price for d in dropped} == {20, 500}
    assert len(kept) == 6


def test_competitor_stats_and_position():
    s = competitor_stats([L(p) for p in [90, 100, 110, 120, 130]], my_price=125)
    assert s["lowest_price"] == 90 and s["median_price"] == 110 and s["highest_price"] == 130
    assert s["my_price_percentile"] == 80.0 and s["diff_to_median"] == 15


def test_recommend_price_respects_margin_floor():
    s = competitor_stats([L(p) for p in range(100, 131, 2)])
    r = recommend_price(s, cost=95, min_selling_price=None, fee_fn=fee, min_margin_pct=15)
    # preço precisa cobrir custo + 16% de comissão + 15% de margem: p >= 95 / 0.69 = 137,68
    assert r["strategy"] == "preco_minimo"
    assert r["recommended_price"] >= 137.6
    assert r["warnings"]


def test_recommend_price_profit_choice_within_market():
    s = competitor_stats([L(p) for p in range(200, 301, 5)])
    r = recommend_price(s, cost=100, min_selling_price=150, fee_fn=fee, current_price=280)
    assert r["strategy"] == "lucro_esperado"
    assert s["q1_price"] * 0.95 <= r["recommended_price"] <= s["q3_price"]
    assert str(r["recommended_price"]).endswith(".9")
    assert r["margin_pct_at_recommended"] >= 15


def test_recommend_price_without_cost_warns():
    s = competitor_stats([L(p) for p in range(200, 301, 5)])
    r = recommend_price(s, cost=None, min_selling_price=None, fee_fn=fee)
    assert r["strategy"] == "posicao_de_mercado" and r["recommended_price"] < s["median_price"]


def test_review_classification():
    assert "defeito" in classify_text("Veio com defeito, não liga")
    assert "entrega" in classify_text("A entrega atrasou demais")
    assert "divergente" in classify_text("Cor errada, diferente da foto")
    res = review_insights({"mercado": [Review("a", 1, content="Quebrou em uma semana, material frágil"),
                                       Review("a", 2, content="quebrou fácil"),
                                       Review("a", 1, content="atrasou a entrega"),
                                       Review("a", 5, content="ótimo")]})
    g = res["groups"]["mercado"]
    assert g["bad_reviews"] == 3 and g["main_reason"]["reason"] == "durabilidade" and g["small_sample"]


def test_keywords_combines_trends_and_titles():
    comps = [L(100, sold=500, title="Teclado Mecanico Gamer RGB Switch Azul"),
             L(110, sold=50, title="Teclado Mecanico Gamer Bluetooth"),
             L(120, sold=5, title="Mouse sem fio")]
    kw = keyword_insights("Teclado Mecânico RGB", comps, ["teclado gamer", "geladeira", "teclado mecanico"])
    terms = [k["term"] for k in kw["top_keywords"]]
    assert "geladeira" not in terms
    assert "teclado gamer" in terms and "teclado mecanico" in terms
    assert "teclado gamer" in kw["missing_in_title"]


def test_devices_source_priority():
    assert device_insights("MLB1051")["source"] == "estimativa"
    assert device_insights("X", seller_orders_devices={"mobile": 40, "desktop": 10})["mobile_share_pct"] == 80.0
    assert device_insights("X", platform_data={"mobile": 0.3})["predominant"] == "computador"
