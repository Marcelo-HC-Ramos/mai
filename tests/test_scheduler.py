"""Agendador embutido (MAI_SCHEDULER=1) e verificação de saúde usada pela hospedagem."""
from datetime import datetime, timezone

from mai import scheduler


def test_healthz(client):
    assert client.get("/healthz").json() == {"ok": True}


def test_run_due_runs_each_slot_once(db, monkeypatch):
    calls = []
    monkeypatch.setattr(scheduler, "_jobs", lambda: [
        ("diaria", lambda now: now.strftime("%Y-%m-%d") if now.hour >= 6 else None, lambda: calls.append("diaria")),
        ("quinze", lambda now: f"{now:%H}:{now.minute - now.minute % 15:02d}", lambda: calls.append("quinze")),
        ("quebrada", lambda now: "x", lambda: 1 / 0),
    ])
    db.scheduler_runs.delete_many({})
    t = lambda h, m: datetime(2026, 10, 20, h, m, tzinfo=timezone.utc)  # noqa: E731
    assert scheduler.run_due(db, t(5, 59)) == ["quinze"]          # antes das 6h a diária espera; a falha não para as outras
    assert scheduler.run_due(db, t(6, 0)) == ["diaria", "quinze"]
    assert scheduler.run_due(db, t(6, 14)) == []                  # mesmo dia e mesmo bloco de 15 min: não repete
    assert scheduler.run_due(db, t(6, 15)) == ["quinze"]
    assert calls == ["quinze", "diaria", "quinze", "quinze"]


def test_real_jobs_are_wired(db):
    names = [n for n, _, _ in scheduler._jobs()]
    assert names == ["monitorar-anuncios", "varredura-diaria", "sync-pedidos-perguntas"]
    db.scheduler_runs.delete_many({})
    ran = scheduler.run_due(db, datetime(2026, 10, 20, 7, 0, tzinfo=timezone.utc))
    assert set(ran) == set(names)
