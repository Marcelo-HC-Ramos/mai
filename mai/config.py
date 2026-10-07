"""Configuração lida de variáveis de ambiente (veja .env.example)."""
import os
from dataclasses import dataclass, field


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


@dataclass
class Settings:
    mongo_uri: str = field(default_factory=lambda: _env("MAI_MONGO_URI", "mongodb://localhost:27017"))
    mongo_db: str = field(default_factory=lambda: _env("MAI_MONGO_DB", "mai"))
    redis_url: str = field(default_factory=lambda: _env("MAI_REDIS_URL", ""))
    # Chave AES-256 em base64 (32 bytes). Gere com: python -m mai.cli gen-key
    encryption_key: str = field(default_factory=lambda: _env("MAI_ENCRYPTION_KEY", ""))
    # Conector padrão: "mercadolivre" (API real) ou "demo" (dados sintéticos, sem internet)
    default_connector: str = field(default_factory=lambda: _env("MAI_CONNECTOR", "demo"))
    ml_client_id: str = field(default_factory=lambda: _env("ML_CLIENT_ID"))
    ml_client_secret: str = field(default_factory=lambda: _env("ML_CLIENT_SECRET"))
    ml_redirect_uri: str = field(default_factory=lambda: _env("ML_REDIRECT_URI", "http://localhost:8000/auth/mercadolivre/callback"))
    ml_site_id: str = field(default_factory=lambda: _env("ML_SITE_ID", "MLB"))
    # Assinatura dos tokens de login. Sem valor, é gerada a cada início (sessões caem ao reiniciar).
    secret_key: str = field(default_factory=lambda: _env("MAI_SECRET_KEY"))
    session_hours: int = field(default_factory=lambda: int(_env("MAI_SESSION_HOURS", "12")))
    # IA generativa (Gemini, camada gratuita do Google AI Studio). Sem chave, o MAI usa as regras locais.
    gemini_api_key: str = field(default_factory=lambda: _env("GEMINI_API_KEY"))
    gemini_model: str = field(default_factory=lambda: _env("GEMINI_MODEL", "gemini-2.5-flash"))
    gemini_rpm: int = field(default_factory=lambda: int(_env("GEMINI_RPM", "10")))
    # Regras de preço (RN02)
    min_margin_pct: float = field(default_factory=lambda: float(_env("MAI_MIN_MARGIN_PCT", "15")))
    stock_alert_days: int = field(default_factory=lambda: int(_env("MAI_STOCK_ALERT_DAYS", "15")))


settings = Settings()
