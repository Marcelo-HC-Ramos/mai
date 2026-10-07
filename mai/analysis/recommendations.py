"""RF05: plano de ação em linguagem direta, montado a partir dos blocos de análise."""
from __future__ import annotations


def brl(v: float | None) -> str:
    if v is None:
        return "-"
    return "R$ " + f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def build_recommendations(product: dict, comp: dict, price: dict, kw: dict, dev: dict, rev: dict,
                          logi: dict | None = None) -> list[dict]:
    recs: list[dict] = []
    logi = logi or {}
    if logi.get("leader_mode") and logi.get("my_mode") and logi["leader_mode"] != logi["my_mode"]:
        if logi["leader_mode"] == "full" and logi.get("full_share_top_pct", 0) >= 50:
            recs.append({"type": "LOGISTICA", "priority": 1,
                         "message": f"{logi['full_share_top_pct']:.0f}% dos 10 concorrentes que mais vendem estão no "
                                    f"Full e você está em {logi['my_mode_label']}. O Full dá entrega rápida e destaque "
                                    "na busca; simule o custo na Calculadora antes de enviar estoque."})
        elif logi["leader_mode"] == "flex":
            recs.append({"type": "LOGISTICA", "priority": 2,
                         "message": "Os líderes desta busca usam o Flex (entrega no mesmo dia). Se você atende a "
                                    "sua região, ativar o Flex pode aumentar a conversão."})
    if logi.get("full_price_premium_pct") is not None and logi["full_price_premium_pct"] >= 5:
        recs.append({"type": "LOGISTICA", "priority": 3,
                     "message": f"Anúncios no Full cobram em média {logi['full_price_premium_pct']:.0f}% a mais que os "
                                "demais: o comprador aceita pagar pela entrega rápida."})
    current = price.get("current_price")
    best = price.get("recommended_price")

    if best and current:
        diff = round(best - current, 2)
        if abs(diff) >= max(1.0, current * 0.01):
            verb = "Reduza" if diff < 0 else "Aumente"
            margin = price.get("margin_pct_at_recommended")
            extra = f" e mantém margem de {margin:.1f}% após tarifas".replace(".", ",") if margin is not None else ""
            recs.append({"type": "PRECO", "priority": 1,
                         "message": f"{verb} o preço de {brl(current)} para {brl(best)}. Esse valor tem o maior lucro "
                                    f"esperado frente à mediana do mercado ({brl(comp.get('median_price'))}){extra}."})
        else:
            recs.append({"type": "PRECO", "priority": 3,
                         "message": f"Seu preço ({brl(current)}) já está no ponto de maior lucro esperado. Mantenha."})
    for w in price.get("warnings", []):
        recs.append({"type": "PRECO", "priority": 1, "message": w})

    if comp.get("free_shipping_share_pct", 0) >= 60:
        recs.append({"type": "FRETE", "priority": 2,
                     "message": f"{comp['free_shipping_share_pct']:.0f}% dos concorrentes oferecem frete grátis. "
                                "Sem frete grátis o anúncio perde comparação direta."})

    missing = kw.get("missing_in_title") or []
    if missing:
        recs.append({"type": "SEO", "priority": 2,
                     "message": "Inclua no título os termos fortes que você ainda não usa: "
                                + ", ".join(f"“{m}”" for m in missing[:3]) + "."})

    if dev.get("mobile_share_pct", 0) >= 60:
        src = " (estimativa por categoria)" if dev.get("source") == "estimativa" else ""
        recs.append({"type": "MIDIA", "priority": 2,
                     "message": f"Cerca de {dev['mobile_share_pct']:.0f}% das buscas vêm do celular{src}. Use foto "
                                "principal com fundo limpo e produto grande, e coloque as informações-chave no "
                                "início do título e da descrição."})
    else:
        recs.append({"type": "MIDIA", "priority": 3,
                     "message": "Boa parte das buscas vem do computador: invista em ficha técnica completa e tabela "
                                "comparativa na descrição."})

    market = (rev.get("groups") or {}).get("mercado") or {}
    main = market.get("main_reason")
    if main:
        recs.append({"type": "AVALIACOES", "priority": 2,
                     "message": f"O principal motivo de avaliação ruim nos concorrentes é “{main['label']}” "
                                f"({main['pct_of_bad_reviews']:.0f}% das avaliações ruins). Deixe claro no anúncio "
                                "como você evita esse problema; isso vira argumento de venda."})
    own = (rev.get("groups") or {}).get("vendedor") or {}
    mine = own.get("main_reason")
    if mine:
        sample = f" (amostra pequena: {own['bad_reviews']} avaliações ruins)" if own.get("small_sample") else ""
        recs.append({"type": "AVALIACOES", "priority": 2 if sample else 1,
                     "message": f"Nas suas avaliações ruins o motivo mais citado é “{mine['label']}”{sample}. "
                                "Corrija isso antes de investir em anúncios pagos."})
    return sorted(recs, key=lambda r: r["priority"])
