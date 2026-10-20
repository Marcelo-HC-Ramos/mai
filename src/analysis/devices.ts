// UC08: celular x computador.
//
// A API do Mercado Livre não informa o dispositivo de quem busca. A ordem de preferência das fontes é:
//   1. dados do próprio vendedor (pedidos com dispositivo informado ou relatório de tráfego importado);
//   2. referência de mercado por categoria (tabela abaixo, editável pelo administrador).
// O resultado sempre informa a fonte (RN01).
import { round, sum } from "../lib/num";

// Participação do celular nas visitas por macro-categoria do e-commerce brasileiro.
// Valores de referência para estimativa; atualize com o relatório de mercado mais recente que a empresa usar.
export const REFERENCE_NAME = "Referência MAI de tráfego do e-commerce brasileiro por categoria (atualizar periodicamente)";
export const CATEGORY_MOBILE_SHARE: Record<string, number> = {
  default: 0.70,
  MLB1000: 0.66,    // Eletrônicos, áudio e vídeo
  MLB1648: 0.58,    // Informática
  MLB1714: 0.60,    // Periféricos de PC (teclados, mouses)
  MLB1676: 0.72,    // Fones de ouvido
  MLB135384: 0.78,  // Smartwatches
  MLB1051: 0.80,    // Celulares e telefones
  MLB1430: 0.82,    // Calçados, roupas e bolsas
  MLB1246: 0.84,    // Beleza e cuidado pessoal
  MLB1574: 0.68,    // Casa, móveis e decoração
  MLB254183: 0.62,  // Cadeiras gamer
  MLB1580: 0.74,    // Esportes e fitness
  MLB1144: 0.55,    // Games
};

export function deviceInsights(categoryId: string | null | undefined, platformData?: { mobile: number } | null,
  sellerDevices?: Record<string, number> | null): Record<string, any> {
  let mobile: number, source: string, ref: string;
  const total = sellerDevices ? sum(Object.values(sellerDevices)) : 0;
  if (platformData) [mobile, source, ref] = [platformData.mobile, "api", "Dados da plataforma"];
  else if (sellerDevices && total >= 30) {
    mobile = (sellerDevices.mobile || 0) / total;
    [source, ref] = ["vendedor", `Dispositivo de ${total} pedidos/visitas do próprio vendedor`];
  } else {
    mobile = CATEGORY_MOBILE_SHARE[categoryId || ""] ?? CATEGORY_MOBILE_SHARE.default;
    [source, ref] = ["estimativa", REFERENCE_NAME];
  }
  const mobilePct = round(100 * mobile, 1);
  return {
    mobile_share_pct: mobilePct,
    desktop_share_pct: round(100 - mobilePct, 1),
    predominant: mobilePct >= 50 ? "celular" : "computador",
    source,
    reference: ref,
  };
}
