// RF05: plano de ação em linguagem direta, montado a partir dos blocos de análise.
import { brl } from "../lib/num";

type R = Record<string, any>;
const f0 = (v: number) => v.toFixed(0);

export function buildRecommendations(_product: R, comp: R, price: R, kw: R, dev: R, rev: R, logi?: R | null): R[] {
  const recs: R[] = [];
  logi = logi || {};
  if (logi.leader_mode && logi.my_mode && logi.leader_mode !== logi.my_mode) {
    if (logi.leader_mode === "full" && (logi.full_share_top_pct || 0) >= 50) {
      recs.push({ type: "LOGISTICA", priority: 1,
        message: `${f0(logi.full_share_top_pct)}% dos 10 concorrentes que mais vendem estão no Full e você está em ${logi.my_mode_label}. ` +
          "O Full dá entrega rápida e destaque na busca; simule o custo na Calculadora antes de enviar estoque." });
    } else if (logi.leader_mode === "flex") {
      recs.push({ type: "LOGISTICA", priority: 2,
        message: "Os líderes desta busca usam o Flex (entrega no mesmo dia). Se você atende a sua região, ativar o Flex pode aumentar a conversão." });
    }
  }
  if (logi.full_price_premium_pct !== null && logi.full_price_premium_pct !== undefined && logi.full_price_premium_pct >= 5) {
    recs.push({ type: "LOGISTICA", priority: 3,
      message: `Anúncios no Full cobram em média ${f0(logi.full_price_premium_pct)}% a mais que os demais: o comprador aceita pagar pela entrega rápida.` });
  }
  const current = price.current_price, best = price.recommended_price;
  if (best && current) {
    const diff = Math.round((best - current) * 100) / 100;
    if (Math.abs(diff) >= Math.max(1, current * 0.01)) {
      const verb = diff < 0 ? "Reduza" : "Aumente";
      const margin = price.margin_pct_at_recommended;
      const extra = margin !== null && margin !== undefined ? ` e mantém margem de ${margin.toFixed(1).replace(".", ",")}% após tarifas` : "";
      recs.push({ type: "PRECO", priority: 1,
        message: `${verb} o preço de ${brl(current)} para ${brl(best)}. Esse valor tem o maior lucro esperado frente à mediana do mercado (${brl(comp.median_price)})${extra}.` });
    } else {
      recs.push({ type: "PRECO", priority: 3, message: `Seu preço (${brl(current)}) já está no ponto de maior lucro esperado. Mantenha.` });
    }
  }
  for (const w of price.warnings || []) recs.push({ type: "PRECO", priority: 1, message: w });

  if ((comp.free_shipping_share_pct || 0) >= 60) {
    recs.push({ type: "FRETE", priority: 2,
      message: `${f0(comp.free_shipping_share_pct)}% dos concorrentes oferecem frete grátis. Sem frete grátis o anúncio perde comparação direta.` });
  }
  const missing: string[] = kw.missing_in_title || [];
  if (missing.length) {
    recs.push({ type: "SEO", priority: 2,
      message: "Inclua no título os termos fortes que você ainda não usa: " + missing.slice(0, 3).map((m) => `“${m}”`).join(", ") + "." });
  }
  if ((dev.mobile_share_pct || 0) >= 60) {
    const src = dev.source === "estimativa" ? " (estimativa por categoria)" : "";
    recs.push({ type: "MIDIA", priority: 2,
      message: `Cerca de ${f0(dev.mobile_share_pct)}% das buscas vêm do celular${src}. Use foto principal com fundo limpo e produto grande, ` +
        "e coloque as informações-chave no início do título e da descrição." });
  } else {
    recs.push({ type: "MIDIA", priority: 3,
      message: "Boa parte das buscas vem do computador: invista em ficha técnica completa e tabela comparativa na descrição." });
  }
  const market = (rev.groups || {}).mercado || {};
  if (market.main_reason) {
    const main = market.main_reason;
    recs.push({ type: "AVALIACOES", priority: 2,
      message: `O principal motivo de avaliação ruim nos concorrentes é “${main.label}” (${f0(main.pct_of_bad_reviews)}% das avaliações ruins). ` +
        "Deixe claro no anúncio como você evita esse problema; isso vira argumento de venda." });
  }
  const own = (rev.groups || {}).vendedor || {};
  if (own.main_reason) {
    const sample = own.small_sample ? ` (amostra pequena: ${own.bad_reviews} avaliações ruins)` : "";
    recs.push({ type: "AVALIACOES", priority: sample ? 2 : 1,
      message: `Nas suas avaliações ruins o motivo mais citado é “${own.main_reason.label}”${sample}. Corrija isso antes de investir em anúncios pagos.` });
  }
  return recs.sort((a, b) => a.priority - b.priority);
}
