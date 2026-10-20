"""Agendador dentro do processo da API, para hospedagens sem Redis/worker (ex.: Render com um único serviço).

Ligado com MAI_SCHEDULER=1. Roda as mesmas tarefas do Celery Beat (horários em UTC). Cada execução reserva um
documento em `scheduler_runs` com chave única, então reinícios ou mais de uma instância não repetem a tarefa.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Callable, Optional

from pymongo.errors import DuplicateKeyError

log = logging.getLogger("mai.scheduler")


def _jobs() -> list[tuple[str, Callable[[datetime], Optional[str]], Callable[[], object]]]:
    from . import tasks

    def daily(hour: int, minute: int):
        return lambda now: now.strftime("%Y-%m-%d") if (now.hour, now.minute) >= (hour, minute) else None

    def every(minutes: int):
        return lambda now: now.strftime("%Y-%m-%dT%H:") + f"{now.minute - now.minute % minutes:02d}"

    return [
        ("monitorar-anuncios", daily(5, 30), tasks.snapshot_tracked_ads),
        ("varredura-diaria", daily(6, 0), tasks.analyze_all),
        ("sync-pedidos-perguntas", every(15), tasks.sync_recent),
    ]


def run_due(db, now: Optional[datetime] = None) -> list[str]:
    """Executa as tarefas cujo horário chegou e que ainda não rodaram nesse período. Devolve os nomes executados."""
    now = now or datetime.now(timezone.utc)
    ran = []
    for name, slot_of, fn in _jobs():
        slot = slot_of(now)
        if slot is None:
            continue
        try:
            db.scheduler_runs.insert_one({"_id": f"{name}:{slot}", "started_at": now})
        except DuplicateKeyError:
            continue
        try:
            fn()
            ran.append(name)
        except Exception:  # uma tarefa com problema não derruba o agendador
            log.exception("tarefa %s falhou", name)
    return ran


def start(get_db, interval_s: int = 30) -> threading.Event:
    stop = threading.Event()

    def loop():
        while not stop.wait(interval_s):
            try:
                run_due(get_db())
            except Exception:
                log.exception("falha no agendador")

    threading.Thread(target=loop, name="mai-scheduler", daemon=True).start()
    return stop
