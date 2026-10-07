"""UC09: principal motivo das avaliações ruins (1 a 3 estrelas, RN06).

Classificador por léxico em português, transparente e sem dependências. Cada avaliação pode ter mais de um
motivo. Para trocar por um modelo de linguagem, substitua `classify_text` mantendo a mesma saída.
"""
from __future__ import annotations

from collections import Counter, defaultdict

from ..connectors.base import Review
from ..textutil import normalize

REASONS: dict[str, dict] = {
    "defeito": {"label": "Defeito / não funciona",
                "terms": ["defeito", "defeituoso", "nao liga", "nao funciona", "parou de funcionar", "veio com problema",
                          "falha", "travando", "pifou", "queimou", "nao carrega"]},
    "durabilidade": {"label": "Baixa durabilidade / material frágil",
                     "terms": ["quebrou", "fragil", "estragou", "durou pouco", "material fraco", "qualidade fraca",
                               "qualidade ruim", "baixa qualidade", "descascou", "rasgou", "plastico fino",
                               "qualidade do material"]},
    "entrega": {"label": "Atraso ou problema na entrega",
                "terms": ["atraso", "atrasou", "atrasada", "demorou", "nao chegou", "prazo", "entrega", "extraviado"]},
    "embalagem": {"label": "Embalagem ruim / chegou avariado",
                  "terms": ["embalagem", "amassad", "chegou quebrado", "caixa", "avariad", "riscado", "arranhado"]},
    "divergente": {"label": "Diferente do anúncio",
                   "terms": ["diferente da foto", "diferente do anuncio", "nao e o mesmo", "propaganda enganosa",
                             "nao corresponde", "cor errada", "cor nao e", "veio outro", "modelo errado", "diferente"]},
    "tamanho": {"label": "Tamanho / medida",
                "terms": ["tamanho", "pequeno", "grande demais", "apertado", "largo", "medida", "nao serviu"]},
    "compatibilidade": {"label": "Compatibilidade / conexão",
                        "terms": ["compativel", "compatibilidade", "nao conecta", "conexao", "pareamento", "driver",
                                  "nao reconhece"]},
    "bateria": {"label": "Bateria / carregamento",
                "terms": ["bateria", "carrega", "carregador", "autonomia", "descarrega"]},
    "pecas_faltando": {"label": "Peças ou acessórios faltando",
                       "terms": ["faltou", "faltando", "veio sem", "sem o cabo", "incompleto", "nao veio"]},
    "atendimento": {"label": "Atendimento / troca e devolução",
                    "terms": ["nao responde", "atendimento", "devolver", "devolucao", "troca", "reembolso", "suporte"]},
    "custo_beneficio": {"label": "Preço alto para o que entrega",
                        "terms": ["caro", "nao vale", "custo beneficio", "preco alto", "dinheiro jogado"]},
}


def classify_text(text: str) -> list[str]:
    t = normalize(text)
    return [key for key, r in REASONS.items() if any(term in t for term in r["terms"])]


def review_insights(reviews_by_owner: dict[str, list[Review]], classifier=None) -> dict:
    """reviews_by_owner: {'mercado': [...], 'vendedor': [...]} -> diagnóstico por grupo.

    `classifier(textos) -> lista de motivos por texto | None` permite usar IA (Gemini); se falhar, usa o léxico.
    """
    result = {"source": "api", "method": "lexico", "groups": {}}
    for owner, reviews in reviews_by_owner.items():
        bad = [r for r in reviews if 1 <= r.rate <= 3 and (r.title or r.content)]
        texts = [f"{r.title}. {r.content}".strip(". ") for r in bad]
        ai_labels = classifier(texts) if classifier and texts else None
        if ai_labels:
            result["method"] = "ia"
        counts: Counter = Counter()
        examples: dict[str, list[str]] = defaultdict(list)
        unclassified = 0
        for idx, text in enumerate(texts):
            reasons = (ai_labels[idx] if ai_labels and idx < len(ai_labels) else None) or classify_text(text)
            if not reasons:
                unclassified += 1
            for key in reasons:
                counts[key] += 1
                if len(examples[key]) < 3 and text not in examples[key]:
                    examples[key].append(text)
        ranked = [{"reason": k, "label": REASONS[k]["label"], "count": c,
                   "pct_of_bad_reviews": round(100 * c / len(bad), 1), "examples": examples[k]}
                  for k, c in counts.most_common()]
        result["groups"][owner] = {
            "total_reviews": len(reviews),
            "bad_reviews": len(bad),
            "bad_share_pct": round(100 * len(bad) / len(reviews), 1) if reviews else 0.0,
            "average_rating": round(sum(r.rate for r in reviews) / len(reviews), 2) if reviews else None,
            "main_reason": ranked[0] if ranked else None,
            "reasons": ranked,
            "unclassified": unclassified,
            "small_sample": len(bad) < 5,
        }
    return result
