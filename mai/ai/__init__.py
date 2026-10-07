"""IA generativa opcional. Hoje: Gemini (gratuito no Google AI Studio). Sem chave configurada, tudo funciona com as
regras locais e o relatório informa qual método foi usado.

Para usar outro provedor, implemente um cliente com o método `generate(prompt, schema=None, system=None)`.
"""
from __future__ import annotations

from typing import Optional

from .. import security
from ..config import settings
from .gemini import GeminiClient


def llm_for_org(org: Optional[dict]):
    """Chave própria da empresa (criptografada em organizations.settings) tem prioridade sobre a chave global."""
    cfg = (org or {}).get("settings") or {}
    key = None
    if cfg.get("gemini_api_key"):
        key = security.decrypt(cfg["gemini_api_key"])
    elif settings.gemini_api_key:
        key = settings.gemini_api_key
    if not key or cfg.get("ai_enabled") is False:
        return None
    return GeminiClient(key, cfg.get("gemini_model") or settings.gemini_model, settings.gemini_rpm)
