// Chamadas do Worker para ele mesmo (ctx.exports). Cada chamada roda numa execução separada, com seus próprios
// limites de CPU, consultas ao banco e requisições externas do plano grátis da Cloudflare.
import { sign } from "./auth";
import { timingSafeEqual, utf8 } from "./lib/b64";
import { HttpError, type Ctx } from "./http";
import type { Env, Settings } from "./env";

const HEADER = "x-mai-internal";

export async function internalSignature(cfg: Settings, path: string, body: string): Promise<string> {
  return sign(cfg.secretKey, `internal:${path}:${body}`);
}

export async function verifyInternal(cfg: Settings, req: Request, path: string, body: string): Promise<boolean> {
  const got = req.headers.get(HEADER) || "";
  if (!cfg.secretKey || !got) return false;
  return timingSafeEqual(utf8(got), utf8(await internalSignature(cfg, path, body)));
}

/** Faz a chamada interna. Sem ctx.exports (ambiente antigo), roda na mesma execução. */
export async function invoke(exec: ExecutionContext, cfg: Settings, path: string, payload: any, local: (req: Request) => Promise<Response>): Promise<Response> {
  const body = JSON.stringify(payload);
  const req = new Request(`https://mai.internal${path}`, { method: "POST", body,
    headers: { "content-type": "application/json", [HEADER]: await internalSignature(cfg, path, body) } });
  const self = (exec as any).exports?.default as Fetcher | undefined;
  return self ? self.fetch(req) : local(req);
}

let localHandler: ((req: Request, env: Env, exec: ExecutionContext) => Promise<Response>) | null = null;
export function setLocalHandler(h: typeof localHandler) { localHandler = h; }

export async function callInternal(c: Ctx, path: string, payload: any): Promise<any> {
  const resp = await invoke(c.exec, c.cfg, path, payload, (req) => localHandler!(req, c.env, c.exec));
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new HttpError(resp.status, data?.detail || "Falha na tarefa interna");
  return data;
}

/** Dispara a tarefa sem esperar o resultado (a resposta ao usuário sai na hora). */
export function dispatchInternal(c: Ctx, path: string, payload: any): void {
  c.exec.waitUntil(invoke(c.exec, c.cfg, path, payload, (req) => localHandler!(req, c.env, c.exec))
    .then(async (r) => { if (!r.ok) console.warn(`tarefa ${path} falhou: ${r.status} ${await r.text()}`); })
    .catch((e) => console.warn(`tarefa ${path} falhou:`, String(e))));
}
