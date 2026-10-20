// MAI no Cloudflare Workers: API, telas (pasta public/) e tarefas agendadas, com banco Cloudflare D1.
import { router } from "./api";
import { store } from "./db";
import { settings, type Env } from "./env";
import { errorResponse, HttpError, json, type Ctx } from "./http";
import { invoke, setLocalHandler, verifyInternal } from "./internal";
import { dueJobs } from "./scheduler";

async function handle(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const isApi = path.startsWith("/api/") || path.startsWith("/auth/") || path.startsWith("/webhooks/") || path.startsWith("/internal/") || path === "/healthz";
  if (!isApi) return env.ASSETS.fetch(req);
  const cfg = settings(env);
  try {
    if (path.startsWith("/internal/")) {
      const body = await req.clone().text();
      if (!(await verifyInternal(cfg, req, path, body))) return errorResponse(403, "Acesso negado");
    }
    const found = router.match(req.method, path);
    if (found === "methodNotAllowed") return errorResponse(405, "Método não permitido");
    if (!found) return errorResponse(404, "Não encontrado");
    const c: Ctx = { req, url, env, cfg, db: store(env.DB), exec, params: found.params };
    const out = await found.handler(c);
    return out instanceof Response ? out : json(out);
  } catch (e: any) {
    if (e instanceof HttpError) return errorResponse(e.status, e.detail);
    console.error(`erro em ${req.method} ${path}:`, e?.stack || String(e));
    return errorResponse(500, "Erro interno. Tente de novo em instantes.");
  }
}

setLocalHandler(handle);

export default {
  fetch: handle,

  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    const cfg = settings(env);
    const db = store(env.DB);
    const jobs = await dueJobs(db, new Date());
    if (jobs.some((j) => j.path === "/internal/analyze")) {
      // marca antes de disparar: um produto com problema tenta uma vez por dia, não a cada 15 minutos
      const ids = jobs.filter((j) => j.path === "/internal/analyze").map((j) => j.payload.product_id);
      await env.DB.prepare(`UPDATE products SET data = json_set(data, '$.auto_analysis_at', ?) WHERE id IN (${ids.map(() => "?").join(",")})`)
        .bind(new Date().toISOString(), ...ids).run();
    }
    for (const job of jobs) {
      exec.waitUntil(invoke(exec, cfg, job.path, job.payload, (req) => handle(req, env, exec))
        .then(async (r) => { if (!r.ok) console.warn(`tarefa ${job.path} falhou: ${r.status} ${await r.text()}`); })
        .catch((e) => console.warn(`tarefa ${job.path} falhou:`, String(e))));
    }
    console.log(`agendador: ${jobs.length} tarefa(s) disparada(s)`);
  },
} satisfies ExportedHandler<Env>;
