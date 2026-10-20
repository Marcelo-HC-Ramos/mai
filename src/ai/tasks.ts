// Tarefas do agente que usam IA generativa, cada uma com alternativa por regras quando a IA não está disponível.
import { REASONS } from "../analysis/reviews";
import type { Llm } from "./gemini";

const SYSTEM = "Você é um analista de e-commerce brasileiro que ajuda vendedores de marketplace. Responda em português " +
  "do Brasil, com frases curtas e diretas, sem inventar números que não estejam nos dados.";

/** Classifica avaliações ruins nos motivos de REASONS. Uma lista de motivos por texto, ou null. */
export async function classifyReviews(llm: Llm | null, texts: string[]): Promise<string[][] | null> {
  if (!llm || !texts.length) return null;
  texts = texts.slice(0, 80);
  const keys = [...Object.keys(REASONS), "outro"];
  const catalog = Object.entries(REASONS).map(([k, r]) => `- ${k}: ${r.label}`).join("\n") + "\n- outro: nenhum dos anteriores";
  const numbered = texts.map((t, i) => `${i}. ${t.slice(0, 400)}`).join("\n");
  const schema = { type: "ARRAY", items: { type: "OBJECT", properties: {
    i: { type: "INTEGER" }, reasons: { type: "ARRAY", items: { type: "STRING", enum: keys } } }, required: ["i", "reasons"] } };
  const out = await llm.generate("Classifique cada avaliação negativa de produto nos motivos abaixo (pode haver mais de um).\n" +
    `Motivos:\n${catalog}\n\nAvaliações:\n${numbered}`, { schema, system: SYSTEM });
  if (!Array.isArray(out)) return null;
  const result: string[][] = texts.map(() => []);
  for (const row of out) {
    const i = row?.i;
    if (Number.isInteger(i) && i >= 0 && i < texts.length) result[i] = (row.reasons || []).filter((r: string) => r in REASONS);
  }
  return result;
}

/** Resposta sugerida para pergunta de comprador, com base só na ficha do produto (UC05). */
export async function suggestAnswerAi(llm: Llm | null, question: string, product?: Record<string, any> | null): Promise<string | null> {
  if (!llm) return null;
  product = product || {};
  const listing = (product.listings || [{}])[0] || {};
  const facts = { titulo: product.title ?? null, estoque: listing.stock_quantity ?? null, preco: listing.current_price ?? null,
    garantia: product.warranty ?? null, ficha_tecnica: product.attributes ?? null, ean: product.ean ?? null };
  const text = await llm.generate(
    "Escreva a resposta do vendedor para a pergunta abaixo, em até 350 caracteres, cordial, começando com 'Olá!'. " +
    "Use apenas os dados do produto; se a informação não estiver neles, diga que vai confirmar e responder em " +
    "seguida. Não prometa prazos nem descontos.\n\n" +
    `Produto: ${JSON.stringify(facts)}\nPergunta: ${question}`, { system: SYSTEM });
  return typeof text === "string" && text ? text.slice(0, 2000) : null;
}

/** Resumo executivo e sugestão de título para o relatório (UC03). */
export async function executiveSummary(llm: Llm | null, product: Record<string, any>, comp: Record<string, any>,
  price: Record<string, any>, kw: Record<string, any>, dev: Record<string, any>, rev: Record<string, any>): Promise<Record<string, any> | null> {
  if (!llm) return null;
  const market = (rev.groups || {}).mercado || {};
  const pick = (o: Record<string, any>, ks: string[]) => Object.fromEntries(ks.map((k) => [k, o[k] ?? null]));
  const data = {
    produto: product.title,
    preco_atual: price.current_price ?? null, preco_recomendado: price.recommended_price ?? null,
    preco_minimo_permitido: price.min_allowed_price ?? null,
    mercado: pick(comp, ["lowest_price", "median_price", "highest_price", "competitors_used", "free_shipping_share_pct"]),
    palavras_chave: (kw.top_keywords || []).slice(0, 10).map((k: any) => k.term),
    faltam_no_titulo: kw.missing_in_title ?? null,
    celular_pct: dev.mobile_share_pct ?? null, fonte_celular: dev.source ?? null,
    motivos_avaliacoes_ruins: (market.reasons || []).slice(0, 4).map((r: any) => [r.label, r.pct_of_bad_reviews]),
  };
  const schema = { type: "OBJECT", properties: {
    summary: { type: "STRING" }, title_suggestion: { type: "STRING" }, selling_points: { type: "ARRAY", items: { type: "STRING" } } },
    required: ["summary", "title_suggestion", "selling_points"] };
  const out = await llm.generate(
    "Com base nos dados de mercado abaixo, escreva: (1) summary: um resumo executivo de 3 a 4 frases dizendo ao " +
    "vendedor a situação e o que fazer primeiro; (2) title_suggestion: um título de anúncio com até 60 " +
    "caracteres usando as palavras-chave mais fortes; (3) selling_points: 3 argumentos de venda que respondem " +
    "aos motivos das avaliações ruins dos concorrentes. Valores em reais no formato R$ 1.234,56.\n\n" + JSON.stringify(data),
    { schema, system: SYSTEM, temperature: 0.4 });
  if (!out || typeof out !== "object" || Array.isArray(out) || !out.summary) return null;
  out.title_suggestion = String(out.title_suggestion || "").slice(0, 60);
  out.provider = llm.provider;
  out.model = llm.model;
  return out;
}
