"""Linha de comando do MAI.

  python -m mai.cli gen-key                 gera MAI_ENCRYPTION_KEY
  python -m mai.cli seed-demo               cria a empresa de demonstração (login demo@mai.local / demo12345)
  python -m mai.cli create-org "Empresa" "Nome" email senha   cadastra uma empresa cliente e seu usuário dono
  python -m mai.cli analyze <product_id>    executa o agente para um produto
  python -m mai.cli report <product_id> -o relatorio.html|relatorio.xlsx
  python -m mai.cli serve                   sobe a API e os dashboards em http://localhost:8000
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId


DEMO_EMAIL = "demo@mai.local"
DEMO_PASSWORD = "demo12345"


def seed_demo(db) -> ObjectId:
    """Cria a empresa de demonstração: 1 usuário dono, 1 loja com 2 contas fictícias no marketplace."""
    from . import auth
    from .connectors.demo import CATALOG
    from .services import connect_account, run_analysis
    from .sync import sync_account

    user = db.users.find_one({"email": DEMO_EMAIL})
    if user:
        org_id = user["org_id"]
    else:
        org, user = auth.register_organization(db, "Empresa Demonstração", "Usuário Demo", DEMO_EMAIL, DEMO_PASSWORD)
        org_id = org["_id"]
    seller = db.sellers.find_one({"org_id": org_id}) or {"_id": db.sellers.insert_one(
        {"org_id": org_id, "name": "Loja Demonstração", "created_at": datetime.now(timezone.utc)}).inserted_id}
    for n, nick in ((1, "Conta principal"), (2, "Conta outlet")):
        acc = connect_account(db, org_id, seller["_id"], "DEMO", f"DEMO-{org_id}-{n}", nick)
        print("Sincronizando", nick, sync_account(db, acc["_id"]))
    for c in CATALOG:
        db.products.update_one({"seller_id": seller["_id"], "internal_sku": c["sku"]},
                               {"$set": {"cost_price": c["cost"], "min_selling_price": c["min"]}})
    for p in db.products.find({"seller_id": seller["_id"]}):
        snap = run_analysis(db, p["_id"])
        print(f"  {p['title'][:50]:50}  recomendado: R$ {snap['pricing']['recommended_price']}")
    print(f"Login de demonstração: {DEMO_EMAIL} / {DEMO_PASSWORD}")
    return org_id


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="mai")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("gen-key")
    sub.add_parser("seed-demo")
    co = sub.add_parser("create-org")
    for f in ("org_name", "name", "email", "password"):
        co.add_argument(f)
    a = sub.add_parser("analyze"); a.add_argument("product_id")
    r = sub.add_parser("report"); r.add_argument("product_id"); r.add_argument("-o", "--output", required=True)
    s = sub.add_parser("serve"); s.add_argument("--port", type=int, default=8000); s.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args(argv)

    if args.cmd == "gen-key":
        from .security import generate_key
        print(generate_key())
        return
    if args.cmd == "serve":
        import uvicorn
        uvicorn.run("mai.api:app", host=args.host, port=args.port)
        return

    from .db import get_db
    db = get_db()
    if args.cmd == "seed-demo":
        print("Empresa de demonstração:", seed_demo(db))
    elif args.cmd == "create-org":
        from . import auth
        org, user = auth.register_organization(db, args.org_name, args.name, args.email, args.password)
        db.sellers.insert_one({"org_id": org["_id"], "name": args.org_name, "created_at": datetime.now(timezone.utc)})
        print("Empresa criada:", org["_id"], "| login:", user["email"])
    elif args.cmd == "analyze":
        from .services import run_analysis
        snap = run_analysis(db, args.product_id)
        print(json.dumps({"snapshot": str(snap["_id"]), "pricing": {k: snap["pricing"].get(k) for k in
              ("current_price", "recommended_price", "competitive_price", "min_allowed_price")},
              "recomendacoes": [r["message"] for r in snap["ai_recommendations"]]}, ensure_ascii=False, indent=2))
    elif args.cmd == "report":
        from .agent import latest_snapshot
        from .report import render_html, render_xlsx
        product = db.products.find_one({"_id": ObjectId(args.product_id)})
        snap = latest_snapshot(db, product["_id"])
        out = Path(args.output)
        out.write_bytes(render_xlsx(snap, product)) if out.suffix == ".xlsx" else out.write_text(render_html(snap, product), encoding="utf-8")
        print("Relatório salvo em", out)


if __name__ == "__main__":
    main()
