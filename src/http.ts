// Pequeno roteador HTTP e validação de entrada, no formato de erro que a tela espera: {"detail": "..."}.
import type { Store } from "./db";
import type { Env, Settings } from "./env";

export class HttpError extends Error {
  constructor(readonly status: number, readonly detail: string) { super(detail); }
}

export interface Ctx {
  req: Request;
  url: URL;
  env: Env;
  cfg: Settings;
  db: Store;
  exec: ExecutionContext;
  params: Record<string, string>;
}

export type Handler = (c: Ctx) => Promise<any>;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];

  on(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const re = new RegExp("^" + path.replace(/[.]/g, "\\.").replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  /** Devolve o handler e os parâmetros da rota, ou null; `methodNotAllowed` quando só o método não confere. */
  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null | "methodNotAllowed" {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return pathMatched ? "methodNotAllowed" : null;
  }
}

export function json(data: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

export const errorResponse = (status: number, detail: string) => json({ detail }, status);

// -- Validação ------------------------------------------------------------------------------------------------
export interface Field {
  type: "str" | "num" | "int" | "bool" | "dict";
  required?: boolean;
  min?: number; max?: number; gt?: number;
  minLen?: number; maxLen?: number;
  pattern?: RegExp;
  label?: string;
}
export type Schema = Record<string, Field>;

/** Valida e converte o corpo. Campos fora do esquema são ignorados; ausentes ou null ficam de fora. */
export function validate(body: any, schema: Schema): Record<string, any> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new HttpError(422, "Corpo da requisição inválido");
  const out: Record<string, any> = {};
  for (const [k, f] of Object.entries(schema)) {
    let v = body[k];
    const name = f.label || k;
    if (v === undefined || v === null) {
      if (f.required) throw new HttpError(422, `Campo obrigatório: ${name}`);
      continue;
    }
    if (f.type === "num" || f.type === "int") {
      if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) v = Number(v);
      if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(422, `${name} precisa ser um número`);
      if (f.type === "int" && !Number.isInteger(v)) throw new HttpError(422, `${name} precisa ser um número inteiro`);
      if (f.min !== undefined && v < f.min) throw new HttpError(422, `${name} precisa ser no mínimo ${f.min}`);
      if (f.max !== undefined && v > f.max) throw new HttpError(422, `${name} precisa ser no máximo ${f.max}`);
      if (f.gt !== undefined && v <= f.gt) throw new HttpError(422, `${name} precisa ser maior que ${f.gt}`);
    } else if (f.type === "str") {
      if (typeof v !== "string") throw new HttpError(422, `${name} precisa ser texto`);
      if (f.minLen !== undefined && v.length < f.minLen) throw new HttpError(422, `${name} precisa ter pelo menos ${f.minLen} caracteres`);
      if (f.maxLen !== undefined && v.length > f.maxLen) throw new HttpError(422, `${name} pode ter no máximo ${f.maxLen} caracteres`);
      if (f.pattern && !f.pattern.test(v)) throw new HttpError(422, `${name} em formato inválido`);
    } else if (f.type === "bool") {
      if (typeof v !== "boolean") throw new HttpError(422, `${name} precisa ser verdadeiro ou falso`);
    } else if (f.type === "dict") {
      if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(422, `${name} precisa ser um objeto`);
      for (const x of Object.values(v)) if (typeof x !== "number" || !Number.isInteger(x)) throw new HttpError(422, `${name}: valores precisam ser inteiros`);
    }
    out[k] = v;
  }
  return out;
}

export async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(422, "JSON inválido"); }
}
