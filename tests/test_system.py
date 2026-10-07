from datetime import datetime, timezone

from mai import dashboard, security
from mai.cli import DEMO_EMAIL, DEMO_PASSWORD
from mai.report import render_html, render_xlsx

from .conftest import login


def test_encryption_roundtrip():
    tok = security.encrypt("APP_USR-123")
    assert tok.startswith("enc_v1_") and "APP_USR" not in tok
    assert security.decrypt(tok) == "APP_USR-123"


def test_agent_snapshot_has_all_five_answers(db, seller_id):
    snap = db.market_snapshots.find_one({"seller_id": seller_id})
    assert snap["competitor_data"]["competitors_used"] >= 10                       # preços dos concorrentes
    assert snap["search_intelligence"]["keywords"]["top_keywords"]                 # palavras-chave
    assert snap["search_intelligence"]["traffic_breakdown"]["source"] == "estimativa"  # celular x computador
    assert snap["review_insights"]["groups"]["mercado"]["main_reason"]             # avaliações ruins
    assert snap["pricing"]["recommended_price"]                                    # melhor preço
    assert snap["ai_recommendations"]


def test_dashboard_metrics(db, seller_id):
    s = dashboard.sales_summary(db, seller_id, "30d")
    assert s["orders"] > 0 and s["gross_revenue"] > s["net_revenue"] > 0
    assert len(s["daily_curve"]) == 30 and len(s["top_products"]) <= 5
    assert s["current_month"]["gross_revenue"] >= 0
    q = dashboard.questions_summary(db, seller_id)
    assert q["unanswered_count"] == len(q["unanswered"]) or q["unanswered_count"] > 20
    st = dashboard.stock_summary(db, seller_id)
    assert all(i["alert"] == "SEM_ESTOQUE" for i in st["items"] if i["stock"] == 0)
    assert st["out_of_stock"] == sum(i["stock"] == 0 for i in st["items"])
    alerts = [i["alert"] is not None for i in st["items"]]
    assert alerts == sorted(alerts, reverse=True)  # alertas primeiro


def test_period_ranges():
    now = datetime(2026, 10, 3, 15, tzinfo=timezone.utc)
    assert dashboard.period_range("mes", now)[0] == datetime(2026, 10, 1, tzinfo=timezone.utc)
    assert dashboard.period_range("7d", now)[0] == datetime(2026, 9, 27, tzinfo=timezone.utc)


def test_reports_render(db, seller_id):
    snap = db.market_snapshots.find_one({"seller_id": seller_id})
    product = db.products.find_one({"_id": snap["product_id"]})
    html = render_html(snap, product)
    assert "Melhor preço de venda" in html and "Estimativa" in html and "<svg" in html
    assert render_xlsx(snap, product)[:2] == b"PK"


def test_api_flow(client, seller_id):
    c, h = client, login(client, DEMO_EMAIL, DEMO_PASSWORD)
    sellers = c.get("/api/sellers", headers=h).json()
    sid = sellers[0]["_id"]
    products = c.get(f"/api/sellers/{sid}/products", headers=h).json()
    pid = products[0]["_id"]
    assert c.patch(f"/api/products/{pid}", json={"cost_price": 100}, headers=h).status_code == 200
    acc = sellers[0]["accounts"][1]["_id"]
    r = c.post(f"/api/products/{pid}/analyze", headers=h)
    assert r.status_code == 200 and r.json()["recommended_price"]
    token = h["Authorization"][7:]
    assert c.get(f"/api/products/{pid}/report.html?token={token}").status_code == 200
    assert c.get(f"/api/products/{pid}/report.html").status_code == 401
    assert c.get(f"/api/products/{pid}/report.xlsx?token={token}").headers["content-type"].startswith("application/vnd.openxml")
    d = c.get(f"/api/sellers/{sid}/dashboard?period=mes&account_id={acc}", headers=h).json()
    assert {"sales", "questions", "stock"} <= set(d)
    qid = d["questions"]["unanswered"][0]["id"]
    assert c.post(f"/api/questions/{qid}/answer", json={"text": "Sim!"}, headers=h).json()["status"] == "ANSWERED"
    assert c.post(f"/api/questions/{qid}/answer", json={"text": "de novo"}, headers=h).status_code == 409
    s = c.patch("/api/org/settings", json={"gemini_api_key": "AIza-xyz", "min_margin_pct": 20}, headers=h).json()
    assert s["has_own_gemini_key"] and "gemini_api_key" not in s and s["min_margin_pct"] == 20
    assert c.patch("/api/org/settings", json={"gemini_api_key": ""}, headers=h).json()["has_own_gemini_key"] is False
    assert c.get("/").status_code == 200
