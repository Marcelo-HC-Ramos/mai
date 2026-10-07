"""Temas das perguntas e sugestão de resposta (UC05)."""
from __future__ import annotations

from .textutil import normalize

TOPICS = {
    "garantia": ["garantia"],
    "frete_prazo": ["prazo", "entrega", "frete", "chega", "envio", "cep"],
    "compatibilidade": ["funciona com", "compativel", "serve no", "serve para", "iphone", "android", "ps5", "pc"],
    "estoque": ["estoque", "disponivel", "ainda tem", "pronta"],
    "especificacao": ["voltagem", "110", "220", "tamanho", "medida", "cor", "material", "peso", "bivolt"],
    "nota_fiscal": ["nota fiscal", "nf"],
    "troca_devolucao": ["troca", "devolv", "devolucao"],
    "preco_desconto": ["desconto", "preco", "pix", "parcel", "menor valor"],
}

TEMPLATES = {
    "garantia": "Olá! O produto tem garantia de {warranty} contra defeitos de fabricação. Qualquer dúvida estamos à disposição.",
    "frete_prazo": "Olá! O prazo e o valor do frete aparecem no anúncio ao informar seu CEP. Enviamos em até 1 dia útil após a aprovação do pagamento.",
    "compatibilidade": "Olá! {title}. Confira a lista de compatibilidade na ficha técnica do anúncio; se o seu modelo não estiver lá, nos diga qual é que confirmamos.",
    "estoque": "Olá! Sim, temos {stock} unidade(s) disponível(is) para envio imediato.",
    "especificacao": "Olá! Todas as especificações (medidas, voltagem e material) estão na ficha técnica do anúncio. Se precisar de algum detalhe a mais, é só perguntar.",
    "nota_fiscal": "Olá! Sim, todos os pedidos são enviados com nota fiscal.",
    "troca_devolucao": "Olá! Você tem 7 dias após o recebimento para devolução, conforme o Código de Defesa do Consumidor e as regras do marketplace.",
    "preco_desconto": "Olá! O melhor preço já está aplicado no anúncio. Para compras em quantidade, adicione as unidades ao carrinho e confira as condições.",
    "outros": "Olá! Obrigado pela pergunta. {title}. Ficamos à disposição!",
}


def topic_of(text: str) -> str:
    t = f" {normalize(text)} "
    for topic, terms in TOPICS.items():
        if any(f" {term}" in t for term in terms):
            return topic
    return "outros"


def suggest_answer(question: str, product: dict | None) -> str:
    product = product or {}
    listing = (product.get("listings") or [{}])[0]
    return TEMPLATES[topic_of(question)].format(
        title=product.get("title", "Produto conforme anúncio"),
        stock=listing.get("stock_quantity", "algumas"),
        warranty=product.get("warranty", "90 dias"),
    )
