"""Multiempresa, autenticação, papéis e várias contas por loja."""
import time

import pytest

from mai import auth, dashboard
from mai.cli import DEMO_EMAIL, DEMO_PASSWORD

from .conftest import login


def test_password_and_token():
    h = auth.hash_password("segredo123")
    assert auth.verify_password("segredo123", h) and not auth.verify_password("errada123", h)
    with pytest.raises(auth.AuthError):
        auth.hash_password("curta")
    tok = auth.issue_token({"_id": "u1", "org_id": "o1", "role": "owner"})
    assert auth.read_token(tok)["uid"] == "u1"
    body, sig = tok.split(".")
    with pytest.raises(auth.AuthError):
        auth.read_token(body + "x." + sig)


def test_expired_token(monkeypatch):
    tok = auth.issue_token({"_id": "u1", "org_id": "o1", "role": "owner"})
    monkeypatch.setattr(time, "time", lambda: 10 ** 11)
    with pytest.raises(auth.AuthError):
        auth.read_token(tok)


def test_requires_login(client):
    assert client.get("/api/sellers").status_code == 401
    assert client.post("/api/auth/login", json={"email": DEMO_EMAIL, "password": "errada123"}).status_code == 401


def test_companies_are_isolated(client, db, org_id):
    a = login(client, DEMO_EMAIL, DEMO_PASSWORD)
    r = client.post("/api/auth/register", json={"org_name": "Outra Empresa", "name": "Bia", "email": "bia@outra.com",
                                                "password": "senha-forte-1"})
    assert r.status_code == 200
    b = {"Authorization": f"Bearer {r.json()['token']}"}
    assert client.post("/api/auth/register", json={"org_name": "Xx", "name": "Yy", "email": "bia@outra.com",
                                                   "password": "senha-forte-1"}).status_code == 400

    a_sellers = client.get("/api/sellers", headers=a).json()
    b_sellers = client.get("/api/sellers", headers=b).json()
    assert {s["_id"] for s in a_sellers}.isdisjoint({s["_id"] for s in b_sellers})
    a_sid = a_sellers[0]["_id"]
    product = client.get(f"/api/sellers/{a_sid}/products", headers=a).json()[0]

    # a empresa B não enxerga nada da A
    assert client.get(f"/api/sellers/{a_sid}/products", headers=b).status_code == 404
    assert client.get(f"/api/sellers/{a_sid}/dashboard", headers=b).status_code == 404
    assert client.get(f"/api/products/{product['_id']}/report", headers=b).status_code == 404
    assert client.patch(f"/api/products/{product['_id']}", json={"cost_price": 1}, headers=b).status_code == 404
    acc = a_sellers[0]["accounts"][0]["_id"]
    assert client.delete(f"/api/accounts/{acc}", headers=b).status_code == 404
    q = db.customer_questions.find_one({"org_id": org_id, "status": "UNANSWERED"})
    assert client.post(f"/api/questions/{q['_id']}/answer", json={"text": "x"}, headers=b).status_code == 404

    # B começa do zero e conecta a própria conta de demonstração
    b_sid = b_sellers[0]["_id"]
    r = client.post(f"/api/sellers/{b_sid}/accounts/demo", json={"nickname": "Conta da Bia"}, headers=b)
    assert r.status_code == 200 and r.json()["sync"]["listings"] == 5
    assert len(client.get(f"/api/sellers/{b_sid}/products", headers=b).json()) == 5
    assert len(client.get(f"/api/sellers/{a_sid}/products", headers=a).json()) == 5


def test_roles(client):
    a = login(client, DEMO_EMAIL, DEMO_PASSWORD)
    r = client.post("/api/users", json={"name": "Ana", "email": "ana@demo.com", "password": "senha-ana-1",
                                        "role": "analyst"}, headers=a)
    assert r.status_code == 200
    ana = login(client, "ana@demo.com", "senha-ana-1")
    assert client.get("/api/me", headers=ana).json()["user"]["role"] == "analyst"
    sid = client.get("/api/sellers", headers=ana).json()[0]["_id"]
    assert client.get(f"/api/sellers/{sid}/dashboard", headers=ana).status_code == 200
    assert client.post("/api/users", json={"name": "Z", "email": "z@demo.com", "password": "senha-z-12"},
                       headers=ana).status_code == 403
    assert client.post(f"/api/sellers/{sid}/accounts/demo", json={}, headers=ana).status_code == 403
    # desativar usuário corta o acesso
    uid = r.json()["_id"]
    assert client.patch(f"/api/users/{uid}", json={"active": False}, headers=a).status_code == 200
    assert client.get("/api/me", headers=ana).status_code == 401


def test_multiple_accounts_per_seller(db, seller_id):
    accounts = list(db.marketplace_accounts.find({"seller_id": seller_id}))
    assert len(accounts) == 2
    total = dashboard.sales_summary(db, seller_id, "30d")
    assert len(total["by_account"]) == 2
    one = dashboard.sales_summary(db, seller_id, "30d", account_id=accounts[1]["_id"])
    assert 0 < one["gross_revenue"] < total["gross_revenue"]
    assert sum(a["gross_revenue"] for a in total["by_account"]) == pytest.approx(total["gross_revenue"], abs=0.05)
    shared = db.products.find_one({"seller_id": seller_id, "listings.1": {"$exists": True}})
    assert shared and {l["account_id"] for l in shared["listings"]} == {a["_id"] for a in accounts}
    stock_one = dashboard.stock_summary(db, seller_id, account_id=accounts[1]["_id"])
    assert stock_one["products"] == 3


def test_same_account_cannot_join_two_companies(db, org_id, seller_id):
    from mai.services import AccountError, connect_account
    acc = db.marketplace_accounts.find_one({"seller_id": seller_id})
    other = db.organizations.insert_one({"name": "Intrusa"}).inserted_id
    with pytest.raises(AccountError):
        connect_account(db, other, seller_id, acc["marketplace"], acc["external_id"], "x")


def test_revoke_account(client, db):
    a = login(client, DEMO_EMAIL, DEMO_PASSWORD)
    sid = client.get("/api/sellers", headers=a).json()[0]["_id"]
    r = client.post(f"/api/sellers/{sid}/accounts/demo", json={"nickname": "Temporária"}, headers=a).json()
    acc_id = r["account"]["_id"]
    assert client.delete(f"/api/accounts/{acc_id}", headers=a).json()["status"] == "REVOKED"
    assert client.post(f"/api/accounts/{acc_id}/sync", headers=a).status_code == 409
