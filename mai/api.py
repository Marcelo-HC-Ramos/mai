"""API REST (FastAPI) e interface web, multiempresa. Rode com: uvicorn mai.api:app --reload

Toda rota /api (exceto cadastro e login) exige `Authorization: Bearer <token>` e só enxerga dados da empresa do
usuário. Links abertos em nova aba (relatório HTML/XLSX) aceitam o token em `?token=`.
"""
from __future__ import annotations

import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from bson import ObjectId
from bson.errors import InvalidId
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from pydantic import BaseModel, Field

from . import auth, dashboard, security
from .agent import latest_snapshot
from .connectors import mercadolivre
from .db import get_db
from .report import render_html, render_xlsx
from .services import AccountError, active_accounts, connect_account, connector_for_account, disconnect_account, run_analysis
from .sync import sync_account

WEB = Path(__file__).parent / "web"


@asynccontextmanager
async def lifespan(_: FastAPI):
    """MAI_SEED_DEMO=1 cria a empresa de demonstração quando o banco está vazio; MAI_SCHEDULER=1 liga o agendador."""
    if os.environ.get("MAI_SEED_DEMO") == "1" and not get_db().organizations.count_documents({}):
        from .cli import seed_demo
        seed_demo(get_db())
    stop = None
    if os.environ.get("MAI_SCHEDULER") == "1":
        from . import scheduler
        stop = scheduler.start(get_db)
    yield
    if stop:
        stop.set()


app = FastAPI(title="MAI: Inteligência de Mercado", version="0.2.0", lifespan=lifespan)


def oid(value: str) -> ObjectId:
    try:
        return ObjectId(value)
    except (InvalidId, TypeError):
        raise HTTPException(404, "Identificador inválido")


def out(data):
    return jsonable_encoder(data, custom_encoder={ObjectId: str})


# -- Autenticação e escopo por empresa -------------------------------------------------------------------
def current_user(authorization: Optional[str] = Header(default=None), token: Optional[str] = Query(default=None)) -> dict:
    raw = token or (authorization[7:] if authorization and authorization.lower().startswith("bearer ") else None)
    if not raw:
        raise HTTPException(401, "Faça login")
    try:
        payload = auth.read_token(raw)
    except auth.AuthError as exc:
        raise HTTPException(401, str(exc))
    user = get_db().users.find_one({"_id": ObjectId(payload["uid"]), "active": True})
    if not user:
        raise HTTPException(401, "Usuário inativo")
    return user


def manager(user: dict = Depends(current_user)) -> dict:
    if user["role"] not in ("owner", "admin"):
        raise HTTPException(403, "Apenas donos e administradores podem fazer isso")
    return user


def owned(collection: str, doc_id: str, user: dict) -> dict:
    """Busca um documento garantindo que pertence à empresa do usuário (404 se não pertencer)."""
    doc = get_db()[collection].find_one({"_id": oid(doc_id), "org_id": user["org_id"]})
    if not doc:
        raise HTTPException(404, "Não encontrado")
    return doc


def public_user(u: dict) -> dict:
    return {k: u.get(k) for k in ("_id", "name", "email", "role", "active", "created_at")}


@app.get("/healthz", include_in_schema=False)
def healthz():
    get_db().command("ping")
    return {"ok": True}


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(WEB / "index.html")


class Register(BaseModel):
    org_name: str = Field(min_length=2)
    name: str = Field(min_length=2)
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str
    document: Optional[str] = None


class Login(BaseModel):
    email: str
    password: str


@app.post("/api/auth/register")
def register(body: Register):
    """Cria uma nova empresa cliente com o usuário dono e uma primeira loja."""
    db = get_db()
    try:
        org, user = auth.register_organization(db, body.org_name, body.name, body.email, body.password, body.document)
    except auth.AuthError as exc:
        raise HTTPException(400, str(exc))
    db.sellers.insert_one({"org_id": org["_id"], "name": body.org_name, "created_at": datetime.now(timezone.utc)})
    return {"token": auth.issue_token(user)}


@app.post("/api/auth/login")
def login(body: Login):
    try:
        user = auth.authenticate(get_db(), body.email, body.password)
    except auth.AuthError as exc:
        raise HTTPException(401, str(exc))
    return {"token": auth.issue_token(user)}


@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    org = get_db().organizations.find_one({"_id": user["org_id"]})
    return out({"user": public_user(user), "organization": {"_id": org["_id"], "name": org["name"]}})


# -- Usuários e configurações da empresa -----------------------------------------------------------------
class NewUser(BaseModel):
    name: str
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str
    role: str = "analyst"


class UserUpdate(BaseModel):
    role: Optional[str] = None
    active: Optional[bool] = None


@app.get("/api/users")
def list_users(user: dict = Depends(manager)):
    return out([public_user(u) for u in get_db().users.find({"org_id": user["org_id"]}).sort("name", 1)])


@app.post("/api/users")
def add_user(body: NewUser, user: dict = Depends(manager)):
    if body.role == "owner" and user["role"] != "owner":
        raise HTTPException(403, "Só o dono pode criar outro dono")
    try:
        new = auth.create_user(get_db(), user["org_id"], body.name, body.email, body.password, body.role)
    except auth.AuthError as exc:
        raise HTTPException(400, str(exc))
    return out(public_user(new))


@app.patch("/api/users/{user_id}")
def update_user(user_id: str, body: UserUpdate, user: dict = Depends(manager)):
    target = owned("users", user_id, user)
    changes = body.model_dump(exclude_none=True)
    if target["_id"] == user["_id"]:
        raise HTTPException(400, "Você não pode alterar o próprio acesso")
    if (target["role"] == "owner" or changes.get("role") == "owner") and user["role"] != "owner":
        raise HTTPException(403, "Só o dono pode alterar outro dono")
    if changes.get("role") and changes["role"] not in auth.ROLES:
        raise HTTPException(400, "Papel inválido")
    get_db().users.update_one({"_id": target["_id"]}, {"$set": changes})
    return {"updated": list(changes)}


class OrgSettings(BaseModel):
    min_margin_pct: Optional[float] = Field(default=None, ge=0, le=90)
    gemini_api_key: Optional[str] = None  # "" remove a chave própria
    gemini_model: Optional[str] = None
    ai_enabled: Optional[bool] = None


def _settings_view(org: dict) -> dict:
    from .config import settings

    cfg = dict(org.get("settings") or {})
    cfg["has_own_gemini_key"] = bool(cfg.pop("gemini_api_key", None))
    cfg.setdefault("min_margin_pct", settings.min_margin_pct)
    cfg["ai_available"] = cfg.get("ai_enabled") is not False and (cfg["has_own_gemini_key"] or bool(settings.gemini_api_key))
    return cfg


@app.get("/api/org/settings")
def get_settings(user: dict = Depends(current_user)):
    return _settings_view(get_db().organizations.find_one({"_id": user["org_id"]}))


@app.patch("/api/org/settings")
def update_settings(body: OrgSettings, user: dict = Depends(manager)):
    db = get_db()
    sets, unsets = {}, {}
    for k, v in body.model_dump(exclude_none=True).items():
        if k == "gemini_api_key":
            if v.strip():
                sets["settings.gemini_api_key"] = security.encrypt(v.strip())
            else:
                unsets["settings.gemini_api_key"] = ""
        else:
            sets[f"settings.{k}"] = v
    update = {**({"$set": sets} if sets else {}), **({"$unset": unsets} if unsets else {})}
    if update:
        db.organizations.update_one({"_id": user["org_id"]}, update)
    return _settings_view(db.organizations.find_one({"_id": user["org_id"]}))


# -- Lojas e contas de marketplace (UC01) ----------------------------------------------------------------
class NewSeller(BaseModel):
    name: str = Field(min_length=2)
    document: Optional[str] = None


@app.get("/api/sellers")
def list_sellers(user: dict = Depends(current_user)):
    db = get_db()
    rows = []
    for s in db.sellers.find({"org_id": user["org_id"]}).sort("name", 1):
        accs = db.marketplace_accounts.find({"seller_id": s["_id"]}).sort("connected_at", 1)
        rows.append({"_id": s["_id"], "name": s["name"],
                     "accounts": [{k: a.get(k) for k in ("_id", "marketplace", "nickname", "external_id", "status",
                                                         "connected_at", "last_sync_at")} for a in accs]})
    return out(rows)


@app.post("/api/sellers")
def add_seller(body: NewSeller, user: dict = Depends(manager)):
    doc = {"org_id": user["org_id"], "name": body.name, "document": body.document, "created_at": datetime.now(timezone.utc)}
    doc["_id"] = get_db().sellers.insert_one(doc).inserted_id
    return out(doc)


class DemoAccount(BaseModel):
    nickname: str = "Conta de demonstração"


@app.post("/api/sellers/{seller_id}/accounts/demo")
def connect_demo(seller_id: str, body: DemoAccount, user: dict = Depends(manager)):
    """Conecta uma conta fictícia (dados sintéticos) para testar o sistema sem marketplace real."""
    db = get_db()
    seller = owned("sellers", seller_id, user)
    n = db.marketplace_accounts.count_documents({"org_id": user["org_id"], "marketplace": "DEMO"}) + 1
    account = connect_account(db, user["org_id"], seller["_id"], "DEMO", f"DEMO-{user['org_id']}-{n}", body.nickname)
    return out({"account": account, "sync": sync_account(db, account["_id"])})


@app.post("/api/sellers/{seller_id}/accounts/mercadolivre/connect")
def connect_mercadolivre(seller_id: str, user: dict = Depends(manager)):
    """Devolve a URL de autorização do Mercado Livre. Pode ser chamada várias vezes para ligar várias contas."""
    seller = owned("sellers", seller_id, user)
    state = secrets.token_urlsafe(24)
    get_db().oauth_states.insert_one({"state": state, "org_id": user["org_id"], "seller_id": seller["_id"],
                                      "user_id": user["_id"], "created_at": datetime.now(timezone.utc)})
    return {"url": mercadolivre.authorization_url(state)}


@app.delete("/api/accounts/{account_id}")
def revoke_account(account_id: str, user: dict = Depends(manager)):
    acc = owned("marketplace_accounts", account_id, user)
    disconnect_account(get_db(), acc["_id"])
    return {"status": "REVOKED"}


@app.post("/api/accounts/{account_id}/sync")
def sync_one(account_id: str, user: dict = Depends(current_user)):
    acc = owned("marketplace_accounts", account_id, user)
    try:
        return sync_account(get_db(), acc["_id"])
    except AccountError as exc:
        raise HTTPException(409, str(exc))


@app.post("/api/sellers/{seller_id}/sync")
def sync_seller(seller_id: str, user: dict = Depends(current_user)):
    seller = owned("sellers", seller_id, user)
    return [sync_account(get_db(), a["_id"]) for a in active_accounts(get_db(), seller_id=seller["_id"])]


@app.get("/auth/mercadolivre/callback")
def ml_callback(background: BackgroundTasks, code: Optional[str] = None, state: Optional[str] = None,
                error: Optional[str] = None):
    db = get_db()
    st = db.oauth_states.find_one_and_delete({"state": state}) if state else None
    if error or not code or not st:
        return RedirectResponse("/?integracao=cancelada")
    tokens = mercadolivre.exchange_code(code)
    try:
        me_ml = mercadolivre.MercadoLivreConnector(access_token=tokens["access_token"])._get("/users/me")
        nickname = me_ml.get("nickname") or str(tokens["user_id"])
    except Exception:
        nickname = str(tokens["user_id"])
    try:
        account = connect_account(db, st["org_id"], st["seller_id"], "MERCADO_LIVRE", str(tokens["user_id"]), nickname,
                                  tokens["access_token"], tokens.get("refresh_token"), tokens.get("expires_in"))
    except AccountError:
        return RedirectResponse("/?integracao=conta-em-uso")
    background.add_task(sync_account, db, account["_id"])
    return RedirectResponse("/?integracao=ok")


@app.post("/webhooks/mercadolivre")
async def ml_webhook(request: Request, background: BackgroundTasks):
    """Notificações do Mercado Livre (orders_v2, questions, items). Responde 200 rápido e processa depois."""
    payload = await request.json()
    db = get_db()
    account = db.marketplace_accounts.find_one({"marketplace": "MERCADO_LIVRE", "status": "ACTIVE",
                                                "external_id": str(payload.get("user_id"))})
    if account:
        background.add_task(sync_account, db, account["_id"], payload.get("topic") == "questions")
    return {"ok": True}


# -- Produtos, agente e relatório (UC02, UC03) -----------------------------------------------------------
@app.get("/api/sellers/{seller_id}/products")
def list_products(seller_id: str, user: dict = Depends(current_user)):
    db = get_db()
    seller = owned("sellers", seller_id, user)
    rows = []
    for p in db.products.find({"seller_id": seller["_id"], "org_id": user["org_id"]}).sort("title", 1):
        snap = latest_snapshot(db, p["_id"])
        rows.append({**p, "last_analysis": snap["captured_at"] if snap else None,
                     "recommended_price": snap["pricing"].get("recommended_price") if snap else None})
    return out(rows)


class ProductUpdate(BaseModel):
    cost_price: Optional[float] = Field(default=None, ge=0)
    min_selling_price: Optional[float] = Field(default=None, ge=0)
    ean: Optional[str] = None
    warranty: Optional[str] = None
    keyword_volumes: Optional[dict[str, int]] = None
    traffic_devices: Optional[dict[str, int]] = None
    weight_g: Optional[int] = Field(default=None, ge=0)
    dimensions_cm: Optional[str] = Field(default=None, pattern=r"^\d+x\d+x\d+$")
    packaging_cost: Optional[float] = Field(default=None, ge=0)


@app.patch("/api/products/{product_id}")
def update_product(product_id: str, body: ProductUpdate, user: dict = Depends(current_user)):
    product = owned("products", product_id, user)
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(400, "Nada para atualizar")
    get_db().products.update_one({"_id": product["_id"]}, {"$set": changes})
    return {"updated": list(changes)}


@app.post("/api/products/{product_id}/analyze")
def analyze(product_id: str, account_id: Optional[str] = None, modes: Optional[str] = None,
            user: dict = Depends(current_user)):
    """`modes` (ex.: "full" ou "full,flex") limita os concorrentes comparados à modalidade de envio."""
    product = owned("products", product_id, user)
    acc = owned("marketplace_accounts", account_id, user)["_id"] if account_id else None
    try:
        snap = run_analysis(get_db(), product["_id"], acc, _modes(modes))
    except (ValueError, AccountError) as exc:
        raise HTTPException(409, str(exc))
    return out({"snapshot_id": snap["_id"], "captured_at": snap["captured_at"],
                "recommended_price": snap["pricing"].get("recommended_price"),
                "ai_summary": snap.get("ai_summary"), "recommendations": snap["ai_recommendations"]})


def _snapshot_and_product(product_id: str, user: dict):
    product = owned("products", product_id, user)
    snap = latest_snapshot(get_db(), product["_id"])
    if not snap:
        raise HTTPException(404, "Ainda não há análise para este produto. Execute a análise primeiro.")
    return snap, product


@app.get("/api/products/{product_id}/report")
def report_json(product_id: str, user: dict = Depends(current_user)):
    return out(_snapshot_and_product(product_id, user)[0])


@app.get("/api/products/{product_id}/report.html", response_class=HTMLResponse)
def report_html(product_id: str, user: dict = Depends(current_user)):
    snap, product = _snapshot_and_product(product_id, user)
    return HTMLResponse(render_html(snap, product))


@app.get("/api/products/{product_id}/report.xlsx")
def report_xlsx(product_id: str, user: dict = Depends(current_user)):
    snap, product = _snapshot_and_product(product_id, user)
    name = f"relatorio-mercado-{product.get('internal_sku', product_id)}.xlsx"
    return Response(render_xlsx(snap, product), headers={"Content-Disposition": f'attachment; filename="{name}"'},
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.get("/api/products/{product_id}/history")
def price_history(product_id: str, days: int = 90, user: dict = Depends(current_user)):
    product = owned("products", product_id, user)
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = get_db().market_snapshots.find({"product_id": product["_id"], "captured_at": {"$gte": since}}).sort("captured_at", 1)
    return out([{"captured_at": r["captured_at"], "account": r.get("account_nickname"),
                 "median": r["competitor_data"].get("median_price"), "lowest": r["competitor_data"].get("lowest_price"),
                 "recommended": r["pricing"].get("recommended_price"), "current": r["pricing"].get("current_price")}
                for r in rows])


# -- Dashboards (UC04, UC05, UC11) -----------------------------------------------------------------------
@app.get("/api/sellers/{seller_id}/dashboard")
def seller_dashboard(seller_id: str, period: str = Query("30d", enum=list(dashboard.PERIODS)),
                     account_id: Optional[str] = None, user: dict = Depends(current_user)):
    db = get_db()
    seller = owned("sellers", seller_id, user)
    acc = owned("marketplace_accounts", account_id, user)["_id"] if account_id else None
    sid = seller["_id"]
    try:
        sales = dashboard.sales_summary(db, sid, period, account_id=acc)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return out({"sales": sales, "questions": dashboard.questions_summary(db, sid, account_id=acc),
                "stock": dashboard.stock_summary(db, sid, account_id=acc)})


class Answer(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


@app.post("/api/questions/{question_id}/answer")
def answer_question(question_id: str, body: Answer, user: dict = Depends(current_user)):
    db = get_db()
    q = owned("customer_questions", question_id, user)
    if q["status"] == "ANSWERED":
        raise HTTPException(409, "Pergunta já respondida")
    try:
        account = db.marketplace_accounts.find_one({"_id": q["account_id"]})
        connector_for_account(db, account).answer_question(q["external_question_id"], body.text)
    except Exception as exc:  # UC05 exceção 4e
        raise HTTPException(502, f"O marketplace recusou a resposta: {exc}")
    db.customer_questions.update_one({"_id": q["_id"]}, {"$set": {
        "status": "ANSWERED", "answer_text": body.text, "answered_at": datetime.now(timezone.utc),
        "answered_by": user["_id"]}})
    return {"status": "ANSWERED"}


def _modes(value: Optional[str]) -> Optional[list[str]]:
    from .analysis.logistics import MODES
    picked = [m.strip() for m in (value or "").split(",") if m.strip() in MODES]
    return picked or None


# -- Calculadora de custos (UC14) ------------------------------------------------------------------------
class CostProfile(BaseModel):
    listing_type: Optional[str] = Field(default=None, pattern="^(gold_special|gold_pro)$")
    shipping_mode: Optional[str] = Field(default=None, pattern="^(coleta|full|flex|proprio)$")
    tax_pct: Optional[float] = Field(default=None, ge=0, le=60)
    ads_pct: Optional[float] = Field(default=None, ge=0, le=100)
    installment_pct: Optional[float] = Field(default=None, ge=0, le=30)
    other_cost_pct: Optional[float] = Field(default=None, ge=0, le=60)
    packaging_cost: Optional[float] = Field(default=None, ge=0)
    other_cost_fixed: Optional[float] = Field(default=None, ge=0)
    flex_cost: Optional[float] = Field(default=None, ge=0)
    full_storage_cost: Optional[float] = Field(default=None, ge=0)
    own_shipping_cost: Optional[float] = Field(default=None, ge=0)
    shipping_discount_pct: Optional[float] = Field(default=None, ge=0, le=100)
    target_margin_pct: Optional[float] = Field(default=None, ge=-50, le=90)


@app.get("/api/sellers/{seller_id}/cost-profile")
def get_cost_profile(seller_id: str, user: dict = Depends(current_user)):
    from .costs import DEFAULT_PROFILE
    seller = owned("sellers", seller_id, user)
    return {**DEFAULT_PROFILE, **(seller.get("cost_profile") or {})}


@app.put("/api/sellers/{seller_id}/cost-profile")
def save_cost_profile(seller_id: str, body: CostProfile, user: dict = Depends(manager)):
    seller = owned("sellers", seller_id, user)
    changes = {f"cost_profile.{k}": v for k, v in body.model_dump(exclude_none=True).items()}
    if changes:
        get_db().sellers.update_one({"_id": seller["_id"]}, {"$set": changes})
    return get_cost_profile(seller_id, user)


class CalculatorInput(CostProfile):
    seller_id: str
    price: float = Field(gt=0)
    cost_price: float = Field(ge=0)
    product_id: Optional[str] = None
    account_id: Optional[str] = None
    weight_g: Optional[int] = Field(default=None, ge=0)
    dimensions_cm: Optional[str] = Field(default=None, pattern=r"^\d+x\d+x\d+$")
    commission_pct: Optional[float] = Field(default=None, ge=0, le=50)
    shipping_cost: Optional[float] = Field(default=None, ge=0)


@app.post("/api/calculator")
def calculator(body: CalculatorInput, user: dict = Depends(current_user)):
    """Simula custos e lucro de um preço. Campos do perfil enviados aqui valem só para esta simulação."""
    from .costs import CostCalculator, CostInputs
    db = get_db()
    seller = owned("sellers", body.seller_id, user)
    product = owned("products", body.product_id, user) if body.product_id else {}
    overrides = {k: v for k, v in body.model_dump(exclude_none=True).items() if k in CostProfile.model_fields}
    profile = {**(seller.get("cost_profile") or {}), **overrides}
    fees_fn = shipping_fn = None
    accounts = active_accounts(db, seller_id=seller["_id"],
                               **({"_id": owned("marketplace_accounts", body.account_id, user)["_id"]} if body.account_id else {}))
    if accounts:
        conn = connector_for_account(db, accounts[0])
        category = product.get("category_id")
        fees_fn = lambda p, lt: conn.get_fees(p, category, lt)  # noqa: E731
        shipping_fn = lambda p, w, d, lt: conn.get_shipping_cost(p, w, d, lt)  # noqa: E731
    calc = CostCalculator(profile, fees_fn, shipping_fn)
    inputs = CostInputs(cost_price=body.cost_price, weight_g=body.weight_g or product.get("weight_g"),
                        dimensions_cm=body.dimensions_cm or product.get("dimensions_cm"),
                        commission_pct=body.commission_pct, shipping_cost=body.shipping_cost,
                        packaging_cost=body.packaging_cost if body.packaging_cost is not None else product.get("packaging_cost"))
    return calc.report(body.price, inputs, body.target_margin_pct)


# -- Análise de anúncios, pesquisa de mercado e monitoramento (UC15-UC17) --------------------------------
class AdInput(BaseModel):
    item: str = Field(min_length=3, description="Código MLB... ou link do anúncio")
    account_id: Optional[str] = None


def _acc(account_id: Optional[str], user: dict) -> Optional[ObjectId]:
    return owned("marketplace_accounts", account_id, user)["_id"] if account_id else None


@app.post("/api/ads/analyze")
def ads_analyze(body: AdInput, user: dict = Depends(current_user)):
    from .ad_service import analyze_ad_for_org
    try:
        return out(analyze_ad_for_org(get_db(), user["org_id"], body.item, _acc(body.account_id, user)))
    except AccountError as exc:
        raise HTTPException(409, str(exc))
    except Exception as exc:
        raise HTTPException(404, f"Não foi possível ler o anúncio: {exc}")


@app.get("/api/ads/recent")
def ads_recent(user: dict = Depends(current_user)):
    rows = get_db().ad_analyses.find({"org_id": user["org_id"]}, {"result": 0}).sort("analyzed_at", -1).limit(20)
    return out(list(rows))


@app.get("/api/market/research")
def research(q: str = Query(min_length=2), account_id: Optional[str] = None, modes: Optional[str] = None,
             user: dict = Depends(current_user)):
    from .ad_service import market_research
    try:
        return out(market_research(get_db(), user["org_id"], q, _acc(account_id, user), _modes(modes)))
    except AccountError as exc:
        raise HTTPException(409, str(exc))


@app.get("/api/ads/tracked")
def ads_tracked(user: dict = Depends(current_user)):
    from .ad_service import tracked_list
    return out(tracked_list(get_db(), user["org_id"]))


@app.post("/api/ads/tracked")
def ads_track(body: AdInput, user: dict = Depends(current_user)):
    from .ad_service import track
    try:
        return track(get_db(), user["org_id"], body.item, _acc(body.account_id, user))
    except AccountError as exc:
        raise HTTPException(409, str(exc))


@app.delete("/api/ads/tracked/{item_id}")
def ads_untrack(item_id: str, user: dict = Depends(current_user)):
    from .ad_service import untrack
    untrack(get_db(), user["org_id"], item_id)
    return {"tracked": False}
