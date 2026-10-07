"""Cliente da API Gemini (Google AI Studio), via REST e sem SDK.

A camada gratuita do Gemini tem limite de requisições por minuto; o cliente respeita `GEMINI_RPM`, tenta de novo
com backoff quando recebe 429/5xx e devolve None se não conseguir, para o MAI cair nas regras locais.
Atenção: na camada gratuita o Google pode usar o conteúdo enviado para melhorar seus produtos. Não envie dados
pessoais de compradores; o MAI manda apenas textos de avaliações públicas, perguntas sem identificação e números.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Optional

import httpx

from ..connectors.base import RateLimiter

log = logging.getLogger("mai.ai")
API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_limiters: dict[str, RateLimiter] = {}


class GeminiClient:
    provider = "gemini"

    def __init__(self, api_key: str, model: str = "gemini-2.5-flash", rpm: int = 10, timeout: float = 40):
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        # um limitador por chave: empresas com chave própria não disputam a cota da chave global
        self._limiter = _limiters.setdefault(api_key[-8:], RateLimiter(rpm / 60))

    def generate(self, prompt: str, schema: Optional[dict] = None, system: Optional[str] = None,
                 temperature: float = 0.2, max_retries: int = 3) -> Optional[Any]:
        """Retorna texto, ou o JSON já decodificado quando `schema` é informado. None em caso de falha."""
        body: dict[str, Any] = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": temperature},
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        if schema:
            body["generationConfig"].update({"responseMimeType": "application/json", "responseSchema": schema})
        for attempt in range(max_retries):
            self._limiter.wait()
            try:
                resp = httpx.post(API.format(model=self.model), json=body, timeout=self.timeout,
                                  headers={"x-goog-api-key": self.api_key})
            except httpx.TransportError as exc:
                log.warning("Gemini indisponível: %s", exc)
                time.sleep(2 ** attempt)
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                time.sleep(min(30, 2 ** (attempt + 2)))
                continue
            if resp.status_code != 200:
                log.warning("Gemini respondeu %s: %s", resp.status_code, resp.text[:300])
                return None
            try:
                text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
                return json.loads(text) if schema else text.strip()
            except (KeyError, IndexError, ValueError) as exc:
                log.warning("Resposta inesperada do Gemini: %s", exc)
                return None
        return None
