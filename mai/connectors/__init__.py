"""Registro de conectores. Para adicionar uma plataforma, crie a classe e registre aqui."""
from .base import MarketplaceConnector
from .demo import DemoConnector
from .mercadolivre import MercadoLivreConnector

REGISTRY: dict[str, type[MarketplaceConnector]] = {
    "demo": DemoConnector,
    "DEMO": DemoConnector,
    "mercadolivre": MercadoLivreConnector,
    "MERCADO_LIVRE": MercadoLivreConnector,
}


def get_connector(name: str, **kwargs) -> MarketplaceConnector:
    try:
        return REGISTRY[name](**kwargs)
    except KeyError:
        raise ValueError(f"Conector desconhecido: {name}. Disponíveis: {sorted(set(REGISTRY))}")
