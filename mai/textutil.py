"""Normalização de texto em português usada pelas análises."""
import re
import unicodedata

STOPWORDS = {
    "a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "em", "no", "na", "nos", "nas", "para", "pra",
    "com", "sem", "por", "um", "uma", "uns", "umas", "que", "se", "ao", "aos", "ou", "mais", "muito", "muita",
    "foi", "e", "eh", "ja", "nao", "sim", "kit", "novo", "nova", "original", "oferta", "promocao", "envio",
    "imediato", "pronta", "entrega", "frete", "gratis", "full", "c", "p", "x", "un", "und", "unidade",
}


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", text.lower())).strip()


def tokens(text: str, drop_stopwords: bool = True) -> list[str]:
    words = normalize(text).split()
    if drop_stopwords:
        words = [w for w in words if w not in STOPWORDS and len(w) > 1]
    return words


def ngrams(words: list[str], n: int) -> list[str]:
    return [" ".join(words[i:i + n]) for i in range(len(words) - n + 1)]
