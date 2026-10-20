// Normalização de texto em português usada pelas análises.
export const STOPWORDS = new Set([
  "a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "em", "no", "na", "nos", "nas", "para", "pra",
  "com", "sem", "por", "um", "uma", "uns", "umas", "que", "se", "ao", "aos", "ou", "mais", "muito", "muita",
  "foi", "eh", "ja", "nao", "sim", "kit", "novo", "nova", "original", "oferta", "promocao", "envio",
  "imediato", "pronta", "entrega", "frete", "gratis", "full", "c", "p", "x", "un", "und", "unidade",
]);

export function normalize(text: string | null | undefined): string {
  const ascii = (text || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  return ascii.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

export function tokens(text: string | null | undefined, dropStopwords = true): string[] {
  const words = normalize(text).split(" ").filter(Boolean);
  return dropStopwords ? words.filter((w) => !STOPWORDS.has(w) && w.length > 1) : words;
}

export function ngrams(words: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
  return out;
}

export const isSubset = (a: Iterable<string>, b: Set<string>) => [...a].every((x) => b.has(x));
