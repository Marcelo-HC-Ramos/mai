"""Workers Celery (RNF04). Rode com: celery -A mai.tasks worker -B --loglevel=info

Sem MAI_REDIS_URL as tarefas rodam no próprio processo (modo simples). As tarefas percorrem todas as empresas e
todas as contas ativas, cada uma com suas próprias credenciais e sua chave de IA.
"""
from __future__ import annotations

import logging

from bson import ObjectId
from celery import Celery
from celery.schedules import crontab

from .config import settings
from .db import get_db
from .services import active_accounts, run_analysis
from .sync import sync_account

log = logging.getLogger("mai.tasks")
app = Celery("mai", broker=settings.redis_url or "memory://", backend=settings.redis_url or None)
app.conf.task_always_eager = not settings.redis_url
app.conf.beat_schedule = {
    "varredura-diaria": {"task": "mai.tasks.analyze_all", "schedule": crontab(hour=6, minute=0)},
    "sync-pedidos-perguntas": {"task": "mai.tasks.sync_recent", "schedule": crontab(minute="*/15")},
    "monitorar-anuncios": {"task": "mai.tasks.snapshot_tracked_ads", "schedule": crontab(hour=5, minute=30)},
}


@app.task
def snapshot_tracked_ads() -> int:
    from .ad_service import snapshot_all_tracked
    return snapshot_all_tracked(get_db())


@app.task(bind=True, max_retries=3, default_retry_delay=60)
def analyze_product(self, product_id: str) -> str:
    try:
        return str(run_analysis(get_db(), product_id)["_id"])
    except Exception as exc:
        raise self.retry(exc=exc)


@app.task
def analyze_all() -> int:
    """Uma varredura por produto que tenha ao menos um anúncio em conta ativa."""
    db = get_db()
    active = {a["_id"] for a in active_accounts(db)}
    ids = [str(p["_id"]) for p in db.products.find({}, {"listings.account_id": 1})
           if any(l.get("account_id") in active for l in p.get("listings", []))]
    for pid in ids:
        analyze_product.delay(pid)
    return len(ids)


@app.task
def sync_account_task(account_id: str, recent_only: bool = False) -> dict:
    return sync_account(get_db(), ObjectId(account_id), recent_only)


@app.task
def sync_recent() -> int:
    n = 0
    for account in active_accounts(get_db()):
        try:
            sync_account_task.delay(str(account["_id"]), True)
            n += 1
        except Exception as exc:  # uma conta com problema não para as outras
            log.warning("falha ao sincronizar %s: %s", account.get("nickname"), exc)
    return n
