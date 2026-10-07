"""Integração com IA generativa (Gemini), sempre com alternativa local."""

import httpx

from mai.ai import gemini, llm_for_org, tasks
from mai.analysis.reviews import review_insights
from mai.connectors.base import Review

from .conftest import FakeLLM


def test_no_key_means_no_llm():
    assert llm_for_org({"settings": {}}) is None


def test_org_key_is_used(monkeypatch):
    from mai import security
    llm = llm_for_org({"settings": {"gemini_api_key": security.encrypt("AIza-teste"), "gemini_model": "gemini-x"}})
    assert llm and llm.api_key == "AIza-teste" and llm.model == "gemini-x"
    assert llm_for_org({"settings": {"gemini_api_key": security.encrypt("k"), "ai_enabled": False}}) is None


def test_gemini_client_parses_json(monkeypatch):
    sent = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        sent.update(url=url, body=json, headers=headers)
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": '{"ok": true}'}]}}]})

    monkeypatch.setattr(gemini.httpx, "post", fake_post)
    c = gemini.GeminiClient("chave-123", "gemini-2.5-flash", rpm=600)
    assert c.generate("oi", schema={"type": "OBJECT"}) == {"ok": True}
    assert "gemini-2.5-flash:generateContent" in sent["url"] and sent["headers"]["x-goog-api-key"] == "chave-123"
    assert sent["body"]["generationConfig"]["responseMimeType"] == "application/json"


def test_gemini_failure_returns_none(monkeypatch):
    monkeypatch.setattr(gemini.httpx, "post", lambda *a, **k: httpx.Response(400, json={"error": "bad"}))
    assert gemini.GeminiClient("k2", rpm=600).generate("oi") is None


def test_review_classification_with_ai_and_fallback():
    reviews = [Review("a", 1, content="Demorou muito"), Review("a", 2, content="quebrou rápido")]
    with_ai = review_insights({"mercado": reviews}, classifier=lambda texts: tasks.classify_reviews(FakeLLM(), texts))
    assert with_ai["method"] == "ia" and with_ai["groups"]["mercado"]["main_reason"]["reason"] == "entrega"
    broken = review_insights({"mercado": reviews}, classifier=lambda texts: None)
    assert broken["method"] == "lexico" and broken["groups"]["mercado"]["main_reason"]


def test_summary_and_answer():
    llm = FakeLLM()
    out = tasks.executive_summary(llm, {"title": "X"}, {}, {}, {"top_keywords": []}, {}, {"groups": {}})
    assert out["summary"] == "Resumo de teste." and len(out["title_suggestion"]) <= 60 and out["provider"] == "fake"
    assert tasks.suggest_answer(llm, "Tem garantia?", {"title": "X"}).startswith("Olá!")
    assert tasks.suggest_answer(None, "Tem garantia?", {}) is None


def test_agent_uses_ai_when_available(db, org_id, monkeypatch):
    import mai.ai as ai_mod
    from mai.services import run_analysis
    fake = FakeLLM()
    monkeypatch.setattr(ai_mod, "llm_for_org", lambda org: fake)
    product = db.products.find_one({"org_id": org_id})
    snap = run_analysis(db, product["_id"])
    assert snap["ai_summary"]["summary"] == "Resumo de teste."
    assert snap["review_insights"]["method"] == "ia"
    assert any("Classifique" in c for c in fake.calls)
    from mai.report import render_html
    assert "Resumo da análise" in render_html(snap, product)
