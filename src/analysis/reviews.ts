// UC09: principal motivo das avaliações ruins (1 a 3 estrelas, RN06).
//
// Classificador por léxico em português, transparente e sem dependências. Cada avaliação pode ter mais de um motivo.
// A IA (Gemini), quando ligada, classifica antes; se falhar, vale o léxico.
import type { Review } from "../connectors/base";
import { normalize } from "../lib/text";
import { round, sum } from "../lib/num";

export const REASONS: Record<string, { label: string; terms: string[] }> = {
  defeito: { label: "Defeito / não funciona",
    terms: ["defeito", "defeituoso", "nao liga", "nao funciona", "parou de funcionar", "veio com problema", "falha", "travando",
      "pifou", "queimou", "nao carrega"] },
  durabilidade: { label: "Baixa durabilidade / material frágil",
    terms: ["quebrou", "fragil", "estragou", "durou pouco", "material fraco", "qualidade fraca", "qualidade ruim", "baixa qualidade",
      "descascou", "rasgou", "plastico fino", "qualidade do material"] },
  entrega: { label: "Atraso ou problema na entrega",
    terms: ["atraso", "atrasou", "atrasada", "demorou", "nao chegou", "prazo", "entrega", "extraviado"] },
  embalagem: { label: "Embalagem ruim / chegou avariado",
    terms: ["embalagem", "amassad", "chegou quebrado", "caixa", "avariad", "riscado", "arranhado"] },
  divergente: { label: "Diferente do anúncio",
    terms: ["diferente da foto", "diferente do anuncio", "nao e o mesmo", "propaganda enganosa", "nao corresponde", "cor errada",
      "cor nao e", "veio outro", "modelo errado", "diferente"] },
  tamanho: { label: "Tamanho / medida", terms: ["tamanho", "pequeno", "grande demais", "apertado", "largo", "medida", "nao serviu"] },
  compatibilidade: { label: "Compatibilidade / conexão",
    terms: ["compativel", "compatibilidade", "nao conecta", "conexao", "pareamento", "driver", "nao reconhece"] },
  bateria: { label: "Bateria / carregamento", terms: ["bateria", "carrega", "carregador", "autonomia", "descarrega"] },
  pecas_faltando: { label: "Peças ou acessórios faltando",
    terms: ["faltou", "faltando", "veio sem", "sem o cabo", "incompleto", "nao veio"] },
  atendimento: { label: "Atendimento / troca e devolução",
    terms: ["nao responde", "atendimento", "devolver", "devolucao", "troca", "reembolso", "suporte"] },
  custo_beneficio: { label: "Preço alto para o que entrega", terms: ["caro", "nao vale", "custo beneficio", "preco alto", "dinheiro jogado"] },
};

export function classifyText(text: string): string[] {
  const t = normalize(text);
  return Object.entries(REASONS).filter(([, r]) => r.terms.some((term) => t.includes(term))).map(([k]) => k);
}

export type Classifier = (texts: string[]) => Promise<(string[] | null)[] | null>;

const stripDots = (s: string) => s.replace(/^[. ]+|[. ]+$/g, "");

/** reviewsByOwner: {mercado: [...], vendedor: [...]} -> diagnóstico por grupo. */
export async function reviewInsights(reviewsByOwner: Record<string, Review[]>, classifier?: Classifier | null): Promise<Record<string, any>> {
  const result: Record<string, any> = { source: "api", method: "lexico", groups: {} };
  for (const [owner, reviews] of Object.entries(reviewsByOwner)) {
    const bad = reviews.filter((r) => r.rate >= 1 && r.rate <= 3 && (r.title || r.content));
    const texts = bad.map((r) => stripDots(`${r.title || ""}. ${r.content || ""}`));
    let aiLabels: (string[] | null)[] | null = null;
    if (classifier && texts.length) { try { aiLabels = await classifier(texts); } catch { aiLabels = null; } }
    if (aiLabels) result.method = "ia";
    const counts = new Map<string, number>();
    const examples = new Map<string, string[]>();
    let unclassified = 0;
    texts.forEach((text, idx) => {
      const ai = aiLabels && idx < aiLabels.length ? aiLabels[idx] : null;
      const reasons = ai && ai.length ? ai : classifyText(text);
      if (!reasons.length) unclassified++;
      for (const key of reasons) {
        counts.set(key, (counts.get(key) || 0) + 1);
        const ex = examples.get(key) || [];
        if (ex.length < 3 && !ex.includes(text)) ex.push(text);
        examples.set(key, ex);
      }
    });
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, c]) => ({
      reason: k, label: REASONS[k].label, count: c, pct_of_bad_reviews: round(100 * c / bad.length, 1), examples: examples.get(k) || [] }));
    result.groups[owner] = {
      total_reviews: reviews.length,
      bad_reviews: bad.length,
      bad_share_pct: reviews.length ? round(100 * bad.length / reviews.length, 1) : 0,
      average_rating: reviews.length ? round(sum(reviews.map((r) => r.rate)) / reviews.length, 2) : null,
      main_reason: ranked[0] || null,
      reasons: ranked,
      unclassified,
      small_sample: bad.length < 5,
    };
  }
  return result;
}
