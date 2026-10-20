// Cliente da API Gemini (Google AI Studio), via REST.
//
// Na camada gratuita há limite de requisições por minuto; o cliente tenta de novo uma vez em 429/5xx e devolve null se
// não conseguir, para o MAI cair nas regras locais. Atenção: na camada gratuita o Google pode usar o conteúdo enviado
// para melhorar seus produtos. O MAI manda apenas textos de avaliações públicas, perguntas sem identificação e números.
const API = "https://generativelanguage.googleapis.com/v1beta/models";

export interface Llm {
  provider: string;
  model: string;
  generate(prompt: string, opts?: { schema?: Record<string, any>; system?: string; temperature?: number }): Promise<any | null>;
}

export class GeminiClient implements Llm {
  readonly provider = "gemini";
  constructor(readonly apiKey: string, readonly model = "gemini-2.5-flash") {}

  /** Texto, ou o JSON já decodificado quando `schema` é informado. null em caso de falha. */
  async generate(prompt: string, opts: { schema?: Record<string, any>; system?: string; temperature?: number } = {}): Promise<any | null> {
    const body: Record<string, any> = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: opts.temperature ?? 0.2 },
    };
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    if (opts.schema) Object.assign(body.generationConfig, { responseMimeType: "application/json", responseSchema: opts.schema });
    for (let attempt = 0; attempt < 2; attempt++) {
      let resp: Response;
      try {
        resp = await fetch(`${API}/${this.model}:generateContent`, {
          method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey }, body: JSON.stringify(body) });
      } catch (e) {
        console.warn("Gemini indisponível:", String(e));
        continue;
      }
      if (resp.status === 429 || resp.status >= 500) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      if (resp.status !== 200) {
        console.warn(`Gemini respondeu ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
        return null;
      }
      try {
        const data: any = await resp.json();
        const text: string = data.candidates[0].content.parts[0].text;
        return opts.schema ? JSON.parse(text) : text.trim();
      } catch (e) {
        console.warn("Resposta inesperada do Gemini:", String(e));
        return null;
      }
    }
    return null;
  }
}
