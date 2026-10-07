import base64
import os

os.environ["MAI_MONGO_URI"] = "mongomock://"
os.environ["MAI_ENCRYPTION_KEY"] = base64.b64encode(b"k" * 32).decode()
os.environ["MAI_SECRET_KEY"] = "segredo-de-teste"
os.environ.pop("MAI_REDIS_URL", None)
os.environ.pop("GEMINI_API_KEY", None)

import pytest  # noqa: E402


@pytest.fixture(scope="session")
def db():
    from mai.db import get_db
    return get_db()


@pytest.fixture(scope="session")
def org_id(db):
    from mai.cli import seed_demo
    return seed_demo(db)


@pytest.fixture(scope="session")
def seller_id(db, org_id):
    return db.sellers.find_one({"org_id": org_id})["_id"]


@pytest.fixture(scope="session")
def client(org_id):
    from fastapi.testclient import TestClient
    from mai.api import app
    return TestClient(app)


def login(client, email, password):
    token = client.post("/api/auth/login", json={"email": email, "password": password}).json()["token"]
    return {"Authorization": f"Bearer {token}"}


class FakeLLM:
    """Substitui o Gemini nos testes: devolve respostas fixas no formato pedido."""
    provider, model = "fake", "fake-1"

    def __init__(self):
        self.calls = []

    def generate(self, prompt, schema=None, system=None, temperature=0.2, max_retries=3):
        self.calls.append(prompt)
        if schema and schema.get("type") == "ARRAY":  # classificação de avaliações
            n = prompt.count("\n")
            return [{"i": i, "reasons": ["entrega"]} for i in range(n)]
        if schema:
            return {"summary": "Resumo de teste.", "title_suggestion": "Título sugerido " * 10,
                    "selling_points": ["a", "b", "c"]}
        return "Olá! Resposta da IA."
