// Números, estatística e formatação em reais.
export function round(x: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round((x + Math.sign(x) * Number.EPSILON * Math.abs(x)) * f) / f;
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]) => sum(xs) / xs.length;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function pstdev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function brl(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  const [i, d] = Math.abs(v).toFixed(2).split(".");
  return (v < 0 ? "-" : "") + "R$ " + i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + d;
}

export const pctBR = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${v.toFixed(1).replace(".", ",")}%`);

// Formata como o %g do Python para porcentagens do perfil (6 -> "6", 6.5 -> "6.5").
export const g = (v: number) => String(Number(v.toPrecision(6)));

export function counter<T>(items: T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const it of items) m.set(it, (m.get(it) || 0) + 1);
  return m;
}

export function mostCommon<T>(items: T[]): T | undefined {
  let best: T | undefined, n = -1;
  for (const [k, v] of counter(items)) if (v > n) { best = k; n = v; }
  return best;
}
