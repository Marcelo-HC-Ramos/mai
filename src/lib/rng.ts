// Gerador pseudoaleatório determinístico (dados de demonstração sempre iguais para a mesma chave).
function hash(str: string): number[] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

export const hashInt = (s: string) => hash(s)[0];

export class Rng {
  private a: number; private b: number; private c: number; private d: number;
  constructor(...parts: unknown[]) {
    [this.a, this.b, this.c, this.d] = hash(parts.map(String).join("|"));
  }
  random(): number { // sfc32
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    const t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    const r = (t + this.d) | 0;
    this.c = (this.c + r) | 0;
    return (r >>> 0) / 4294967296;
  }
  randint(lo: number, hi: number): number { return lo + Math.floor(this.random() * (hi - lo + 1)); }
  uniform(lo: number, hi: number): number { return lo + (hi - lo) * this.random(); }
  choice<T>(xs: T[]): T { return xs[Math.floor(this.random() * xs.length)]; }
  choices<T>(xs: T[], weights: number[]): T {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.random() * total;
    for (let i = 0; i < xs.length; i++) { r -= weights[i]; if (r < 0) return xs[i]; }
    return xs[xs.length - 1];
  }
  sample<T>(xs: T[], k: number): T[] {
    const pool = [...xs], out: T[] = [];
    for (let i = 0; i < k && pool.length; i++) out.push(pool.splice(Math.floor(this.random() * pool.length), 1)[0]);
    return out;
  }
  gauss(mu: number, sigma: number): number {
    const u = 1 - this.random(), v = this.random();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  paretovariate(alpha: number): number { return 1 / (1 - this.random()) ** (1 / alpha); }
}
