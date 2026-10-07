"""Usuários, empresas e sessões (multiempresa).

Modelo: uma empresa (`organizations`) tem usuários (`users`) e lojas (`sellers`); cada loja tem uma ou mais contas
de marketplace (`marketplace_accounts`). Todo dado de negócio carrega `org_id` e toda consulta da API filtra por ele.

Papéis: owner (dono da empresa), admin (gerencia lojas, contas e usuários) e analyst (consulta e responde perguntas).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError

from .config import settings

ROLES = ("owner", "admin", "analyst")
_SECRET = (settings.secret_key or secrets.token_urlsafe(32)).encode()


class AuthError(Exception):
    pass


# -- Senhas (PBKDF2-SHA256) -------------------------------------------------------------------------------
def hash_password(password: str) -> str:
    if len(password) < 8:
        raise AuthError("A senha precisa ter pelo menos 8 caracteres")
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 200_000)
    return f"pbkdf2_sha256$200000${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, rounds, salt, digest = stored.split("$")
    except ValueError:
        return False
    calc = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt), int(rounds))
    return hmac.compare_digest(calc, base64.b64decode(digest))


# -- Tokens de sessão assinados (HMAC-SHA256) -------------------------------------------------------------
def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def issue_token(user: dict) -> str:
    payload = {"uid": str(user["_id"]), "org": str(user["org_id"]), "role": user["role"],
               "exp": int(time.time()) + settings.session_hours * 3600}
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    return f"{body}.{_b64(hmac.new(_SECRET, body.encode(), hashlib.sha256).digest())}"


def read_token(token: str) -> dict:
    try:
        body, sig = token.split(".")
    except ValueError:
        raise AuthError("Token inválido")
    if not hmac.compare_digest(_unb64(sig), hmac.new(_SECRET, body.encode(), hashlib.sha256).digest()):
        raise AuthError("Token inválido")
    payload = json.loads(_unb64(body))
    if payload["exp"] < time.time():
        raise AuthError("Sessão expirada")
    return payload


# -- Cadastro ---------------------------------------------------------------------------------------------
def register_organization(db: Database, org_name: str, user_name: str, email: str, password: str,
                          document: Optional[str] = None) -> tuple[dict, dict]:
    """Cria a empresa e o usuário dono. Retorna (organização, usuário)."""
    email = email.strip().lower()
    if db.users.find_one({"email": email}):
        raise AuthError("Já existe um usuário com este e-mail")
    now = datetime.now(timezone.utc)
    org = {"name": org_name.strip(), "created_at": now, "settings": {}}
    if document:
        org["document"] = document
    try:
        org["_id"] = db.organizations.insert_one(org).inserted_id
    except DuplicateKeyError:
        raise AuthError("Já existe uma empresa com este documento")
    user = create_user(db, org["_id"], user_name, email, password, "owner")
    return org, user


def create_user(db: Database, org_id: ObjectId, name: str, email: str, password: str, role: str) -> dict:
    if role not in ROLES:
        raise AuthError(f"Papel inválido: {role}")
    user = {"org_id": org_id, "name": name.strip(), "email": email.strip().lower(), "role": role,
            "password_hash": hash_password(password), "active": True, "created_at": datetime.now(timezone.utc)}
    try:
        user["_id"] = db.users.insert_one(user).inserted_id
    except DuplicateKeyError:
        raise AuthError("Já existe um usuário com este e-mail")
    return user


def authenticate(db: Database, email: str, password: str) -> dict:
    user = db.users.find_one({"email": email.strip().lower(), "active": True})
    if not user or not verify_password(password, user["password_hash"]):
        raise AuthError("E-mail ou senha incorretos")
    return user
