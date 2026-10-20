import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { CATALOG } from "../src/connectors/demo";
import { store } from "../src/db";
import { settings, type Env } from "../src/env";
import type { Llm } from "../src/ai";

export const E = env as unknown as Env;
export const db = () => store(E.DB);
export const cfg = () => settings(E);

export const DEMO_EMAIL = "demo@mai.local";
export const DEMO_PASSWORD = "demo12345";

export async function call(method: string, path: string, opts: { body?: any; token?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const resp = await SELF.fetch(`https://mai.ramosys.com.br${path}`, {
    method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, redirect: "manual" });
  const type = resp.headers.get("content-type") || "";
  let data: any = null;
  if (type.includes("json") || type.startsWith("text/")) {
    const text = await resp.text();
    try { data = JSON.parse(text); } catch { data = text; }
  } else data = new Uint8Array(await resp.arrayBuffer());
  return { status: resp.status, data, headers: resp.headers };
}

export async function login(email: string, password: string): Promise<string> {
  const r = await call("POST", "/api/auth/login", { body: { email, password } });
  if (r.status !== 200) throw new Error(`login falhou: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

/** Empresa de demonstração: 1 dono, 1 loja com 2 contas fictícias, custos do catálogo e uma análise por produto. */
export async function seedDemo(): Promise<{ token: string; orgId: string; sellerId: string }> {
  const reg = await call("POST", "/api/auth/register", { body: { org_name: "Empresa Demonstração", name: "Usuário Demo",
    email: DEMO_EMAIL, password: DEMO_PASSWORD } });
  if (reg.status !== 200) throw new Error(JSON.stringify(reg.data));
  const token = reg.data.token;
  const sellers = (await call("GET", "/api/sellers", { token })).data;
  const sellerId = sellers[0]._id;
  for (const nickname of ["Conta principal", "Conta outlet"]) {
    const r = await call("POST", `/api/sellers/${sellerId}/accounts/demo`, { body: { nickname }, token });
    if (r.status !== 200) throw new Error(JSON.stringify(r.data));
  }
  const products = (await call("GET", `/api/sellers/${sellerId}/products`, { token })).data;
  for (const p of products) {
    const c = CATALOG.find((x) => x.sku === p.internal_sku)!;
    await call("PATCH", `/api/products/${p._id}`, { body: { cost_price: c.cost, min_selling_price: c.min }, token });
    const r = await call("POST", `/api/products/${p._id}/analyze`, { token });
    if (r.status !== 200) throw new Error(JSON.stringify(r.data));
  }
  const me = (await call("GET", "/api/me", { token })).data;
  return { token, orgId: me.organization._id, sellerId };
}

/** Substitui o Gemini nos testes: devolve respostas fixas no formato pedido. */
export class FakeLLM implements Llm {
  provider = "fake";
  model = "fake-1";
  calls: string[] = [];
  async generate(prompt: string, opts: { schema?: Record<string, any> } = {}) {
    this.calls.push(prompt);
    if (opts.schema?.type === "ARRAY") {
      const n = (prompt.match(/\n/g) || []).length;
      return Array.from({ length: n }, (_, i) => ({ i, reasons: ["entrega"] }));
    }
    if (opts.schema) return { summary: "Resumo de teste.", title_suggestion: "Título sugerido ".repeat(10), selling_points: ["a", "b", "c"] };
    return "Olá! Resposta da IA.";
  }
}
