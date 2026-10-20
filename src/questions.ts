// Temas das perguntas e sugestão de resposta (UC05).
import { normalize } from "./lib/text";

export const TOPICS: Record<string, string[]> = {
  garantia: ["garantia"],
  frete_prazo: ["prazo", "entrega", "frete", "chega", "envio", "cep"],
  compatibilidade: ["funciona com", "compativel", "serve no", "serve para", "iphone", "android", "ps5", "pc"],
  estoque: ["estoque", "disponivel", "ainda tem", "pronta"],
  especificacao: ["voltagem", "110", "220", "tamanho", "medida", "cor", "material", "peso", "bivolt"],
  nota_fiscal: ["nota fiscal", "nf"],
  troca_devolucao: ["troca", "devolv", "devolucao"],
  preco_desconto: ["desconto", "preco", "pix", "parcel", "menor valor"],
};

const TEMPLATES: Record<string, string> = {
  garantia: "Olá! O produto tem garantia de {warranty} contra defeitos de fabricação. Qualquer dúvida estamos à disposição.",
  frete_prazo: "Olá! O prazo e o valor do frete aparecem no anúncio ao informar seu CEP. Enviamos em até 1 dia útil após a aprovação do pagamento.",
  compatibilidade: "Olá! {title}. Confira a lista de compatibilidade na ficha técnica do anúncio; se o seu modelo não estiver lá, nos diga qual é que confirmamos.",
  estoque: "Olá! Sim, temos {stock} unidade(s) disponível(is) para envio imediato.",
  especificacao: "Olá! Todas as especificações (medidas, voltagem e material) estão na ficha técnica do anúncio. Se precisar de algum detalhe a mais, é só perguntar.",
  nota_fiscal: "Olá! Sim, todos os pedidos são enviados com nota fiscal.",
  troca_devolucao: "Olá! Você tem 7 dias após o recebimento para devolução, conforme o Código de Defesa do Consumidor e as regras do marketplace.",
  preco_desconto: "Olá! O melhor preço já está aplicado no anúncio. Para compras em quantidade, adicione as unidades ao carrinho e confira as condições.",
  outros: "Olá! Obrigado pela pergunta. {title}. Ficamos à disposição!",
};

export function topicOf(text: string): string {
  const t = ` ${normalize(text)} `;
  for (const [topic, terms] of Object.entries(TOPICS)) if (terms.some((term) => t.includes(` ${term}`))) return topic;
  return "outros";
}

export function suggestAnswer(question: string, product?: Record<string, any> | null): string {
  product = product || {};
  const listing = (product.listings || [{}])[0] || {};
  const values: Record<string, any> = {
    title: product.title ?? "Produto conforme anúncio",
    stock: listing.stock_quantity ?? "algumas",
    warranty: product.warranty ?? "90 dias",
  };
  return TEMPLATES[topicOf(question)].replace(/\{(\w+)\}/g, (_, k) => String(values[k]));
}
