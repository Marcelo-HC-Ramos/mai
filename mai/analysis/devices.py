"""UC08: celular x computador.

A API do Mercado Livre não informa o dispositivo de quem busca. A ordem de preferência das fontes é:
  1. dados do próprio vendedor (pedidos com dispositivo informado ou relatório de tráfego importado);
  2. referência de mercado por categoria (tabela abaixo, editável pelo administrador).
O resultado sempre informa a fonte (RN01).
"""
from __future__ import annotations

from typing import Optional

# Participação do celular nas visitas por macro-categoria do e-commerce brasileiro.
# Valores de referência para estimativa; atualize com o relatório de mercado mais recente que a empresa usar.
REFERENCE_NAME = "Referência MAI de tráfego do e-commerce brasileiro por categoria (atualizar periodicamente)"
CATEGORY_MOBILE_SHARE = {
    "default": 0.70,
    "MLB1000": 0.66,    # Eletrônicos, áudio e vídeo
    "MLB1648": 0.58,    # Informática
    "MLB1714": 0.60,    # Periféricos de PC (teclados, mouses)
    "MLB1676": 0.72,    # Fones de ouvido
    "MLB135384": 0.78,  # Smartwatches
    "MLB1051": 0.80,    # Celulares e telefones
    "MLB1430": 0.82,    # Calçados, roupas e bolsas
    "MLB1246": 0.84,    # Beleza e cuidado pessoal
    "MLB1574": 0.68,    # Casa, móveis e decoração
    "MLB254183": 0.62,  # Cadeiras gamer
    "MLB1580": 0.74,    # Esportes e fitness
    "MLB1144": 0.55,    # Games
}


def device_insights(category_id: Optional[str], platform_data: Optional[dict] = None,
                    seller_orders_devices: Optional[dict[str, int]] = None) -> dict:
    if platform_data:
        mobile, source, ref = platform_data["mobile"], "api", "Dados da plataforma"
    elif seller_orders_devices and sum(seller_orders_devices.values()) >= 30:
        total = sum(seller_orders_devices.values())
        mobile = seller_orders_devices.get("mobile", 0) / total
        source, ref = "vendedor", f"Dispositivo de {total} pedidos/visitas do próprio vendedor"
    else:
        mobile = CATEGORY_MOBILE_SHARE.get(category_id or "", CATEGORY_MOBILE_SHARE["default"])
        source, ref = "estimativa", REFERENCE_NAME
    mobile_pct = round(100 * mobile, 1)
    return {
        "mobile_share_pct": mobile_pct,
        "desktop_share_pct": round(100 - mobile_pct, 1),
        "predominant": "celular" if mobile_pct >= 50 else "computador",
        "source": source,
        "reference": ref,
    }
