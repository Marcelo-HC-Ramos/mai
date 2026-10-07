"""Tarefas do agente que usam IA generativa, cada uma com alternativa por regras quando a IA não está disponível."""
from __future__ import annotations

import json
from typing import Optional

from ..analysis.reviews import REASONS

SYSTEM = ("Você é um analista de e-commerce brasileiro que ajuda vendedores de marketplace. Responda em português "
          "do Brasil, com frases curtas e diretas, sem inventar números que não estejam nos dados.")


def classify_reviews(llm, texts: list[str]) -> Optional[list[list[str]]]:
    """Classifica avaliações ruins nos motivos de REASONS. Retorna uma lista de motivos por texto, ou None."""
    if not llm or not texts:
        return None
    texts = texts[:80]
    keys = list(REASONS) + ["outro"]
    catalog = "\n".join(f"- {k}: {REASONS[k]['label']}" for k in REASONS) + "\n- outro: nenhum dos anteriores"
    numbered = "\n".join(f"{i}. {t[:400]}" for i, t in enumerate(texts))
    schema = {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "i": {"type": "INTEGER"}, "reasons": {"type": "ARRAY", "items": {"type": "STRING", "enum": keys}}},
        "required": ["i", "reasons"]}}
    out = llm.generate(f"Classifique cada avaliação negativa de produto nos motivos abaixo (pode haver mais de um).\n"
                       f"Motivos:\n{catalog}\n\nAvaliações:\n{numbered}", schema=schema, system=SYSTEM)
    if not isinstance(out, list):
        return None
    result: list[list[str]] = [[] for _ in texts]
    for row in out:
        i = row.get("i")
        if isinstance(i, int) and 0 <= i < len(texts):
            result[i] = [r for r in row.get("reasons", []) if r in REASONS]
    return result


def suggest_answer(llm, question: str, product: Optional[dict]) -> Optional[str]:
    """Resposta sugerida para pergunta de comprador, com base só na ficha do produto (UC05)."""
    if not llm:
        return None
    product = product or {}
    listing = (product.get("listings") or [{}])[0]
    facts = {"titulo": product.get("title"), "estoque": listing.get("stock_quantity"),
             "preco": listing.get("current_price"), "garantia": product.get("warranty"),
             "ficha_tecnica": product.get("attributes"), "ean": product.get("ean")}
    text = llm.generate(
        "Escreva a resposta do vendedor para a pergunta abaixo, em até 350 caracteres, cordial, começando com 'Olá!'. "
        "Use apenas os dados do produto; se a informação não estiver neles, diga que vai confirmar e responder em "
        "seguida. Não prometa prazos nem descontos.\n\n"
        f"Produto: {json.dumps(facts, ensure_ascii=False, default=str)}\nPergunta: {question}", system=SYSTEM)
    return text[:2000] if isinstance(text, str) and text else None


def executive_summary(llm, product: dict, comp: dict, price: dict, kw: dict, dev: dict, rev: dict) -> Optional[dict]:
    """Resumo executivo e sugestão de título para o relatório (UC03)."""
    if not llm:
        return None
    market = (rev.get("groups") or {}).get("mercado") or {}
    data = {
        "produto": product.get("title"),
        "preco_atual": price.get("current_price"), "preco_recomendado": price.get("recommended_price"),
        "preco_minimo_permitido": price.get("min_allowed_price"),
        "mercado": {k: comp.get(k) for k in ("lowest_price", "median_price", "highest_price", "competitors_used",
                                             "free_shipping_share_pct")},
        "palavras_chave": [k["term"] for k in kw.get("top_keywords", [])[:10]],
        "faltam_no_titulo": kw.get("missing_in_title"),
        "celular_pct": dev.get("mobile_share_pct"), "fonte_celular": dev.get("source"),
        "motivos_avaliacoes_ruins": [(r["label"], r["pct_of_bad_reviews"]) for r in market.get("reasons", [])[:4]],
    }
    schema = {"type": "OBJECT", "properties": {
        "summary": {"type": "STRING"}, "title_suggestion": {"type": "STRING"},
        "selling_points": {"type": "ARRAY", "items": {"type": "STRING"}}},
        "required": ["summary", "title_suggestion", "selling_points"]}
    out = llm.generate(
        "Com base nos dados de mercado abaixo, escreva: (1) summary: um resumo executivo de 3 a 4 frases dizendo ao "
        "vendedor a situação e o que fazer primeiro; (2) title_suggestion: um título de anúncio com até 60 "
        "caracteres usando as palavras-chave mais fortes; (3) selling_points: 3 argumentos de venda que respondem "
        "aos motivos das avaliações ruins dos concorrentes. Valores em reais no formato R$ 1.234,56.\n\n"
        + json.dumps(data, ensure_ascii=False, default=str), schema=schema, system=SYSTEM, temperature=0.4)
    if not isinstance(out, dict) or not out.get("summary"):
        return None
    out["title_suggestion"] = (out.get("title_suggestion") or "")[:60]
    out["provider"] = getattr(llm, "provider", "llm")
    out["model"] = getattr(llm, "model", "")
    return out
