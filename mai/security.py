"""Criptografia de tokens em repouso com AES-256-GCM (RNF02 / RN04)."""
import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import settings

PREFIX = "enc_v1_"


def generate_key() -> str:
    return base64.b64encode(AESGCM.generate_key(bit_length=256)).decode()


def _key() -> bytes:
    if not settings.encryption_key:
        raise RuntimeError("Defina MAI_ENCRYPTION_KEY (gere com: python -m mai.cli gen-key)")
    key = base64.b64decode(settings.encryption_key)
    if len(key) != 32:
        raise RuntimeError("MAI_ENCRYPTION_KEY precisa ter 32 bytes (AES-256)")
    return key


def encrypt(plaintext: str) -> str:
    nonce = os.urandom(12)
    data = AESGCM(_key()).encrypt(nonce, plaintext.encode(), None)
    return PREFIX + base64.urlsafe_b64encode(nonce + data).decode()


def decrypt(token: str) -> str:
    if not token.startswith(PREFIX):
        raise ValueError("Token não está no formato criptografado do MAI")
    raw = base64.urlsafe_b64decode(token[len(PREFIX):])
    return AESGCM(_key()).decrypt(raw[:12], raw[12:], None).decode()
