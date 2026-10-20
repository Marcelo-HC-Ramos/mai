// Tarefas agendadas (Cron Trigger da Cloudflare, a cada 15 minutos; horários em UTC).
//
//   sincronização ........ pedidos e perguntas recentes das contas reais, as mais atrasadas primeiro
//   monitorar anúncios ... a partir das 05:30, uma foto por dia de cada anúncio monitorado
//   varredura diária ..... a partir das 06:00, uma análise por dia de cada produto com conta ativa
//
// Cada rodada só escolhe o que está pendente e manda cada tarefa para uma execução separada do Worker, em lotes
// pequenos: o que não couber numa rodada fica para a próxima, 15 minutos depois.
import type { Store } from "./db";
import { dueTrackedItems } from "./ad_service";

export interface Job { path: string; payload: Record<string, any> }

export const LIMITS = { sync: 20, snapshotCalls: 8, snapshotBatch: 20, analyses: 10 };

const at = (now: Date, h: number, m: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));

export async function dueJobs(db: Store, now = new Date()): Promise<Job[]> {
  const jobs: Job[] = [];

  // contas de demonstração não mudam sozinhas: só as reais sincronizam no agendador
  const { results: accounts } = await db.raw.prepare(`SELECT id FROM marketplace_accounts WHERE status = 'ACTIVE' AND marketplace != 'DEMO'
    ORDER BY last_sync_at IS NOT NULL, last_sync_at LIMIT ?`).bind(LIMITS.sync).all<{ id: string }>();
  for (const a of accounts) jobs.push({ path: "/internal/sync", payload: { account_id: a.id, recent_only: true } });

  const snapFrom = at(now, 5, 30);
  if (now >= snapFrom) {
    const items = await dueTrackedItems(db, snapFrom.toISOString(), LIMITS.snapshotCalls * LIMITS.snapshotBatch);
    const byOrg = new Map<string, string[]>();
    for (const it of items) byOrg.set(it.org_id, [...(byOrg.get(it.org_id) || []), it.item_id]);
    for (const [orgId, ids] of byOrg) {
      for (let i = 0; i < ids.length && jobs.length < 60; i += LIMITS.snapshotBatch) {
        jobs.push({ path: "/internal/snapshots", payload: { org_id: orgId, item_ids: ids.slice(i, i + LIMITS.snapshotBatch) } });
      }
    }
  }

  const analyzeFrom = at(now, 6, 0);
  if (now >= analyzeFrom) {
    const since = analyzeFrom.toISOString();
    const { results: products } = await db.raw.prepare(`SELECT p.id FROM products p
      WHERE EXISTS (SELECT 1 FROM json_each(p.data, '$.listings') l
                    JOIN marketplace_accounts a ON a.id = json_extract(l.value, '$.account_id') AND a.status = 'ACTIVE')
        AND coalesce(json_extract(p.data, '$.auto_analysis_at'), '') < ?
        AND NOT EXISTS (SELECT 1 FROM market_snapshots s WHERE s.product_id = p.id AND s.captured_at >= ?)
      LIMIT ?`).bind(since, since, LIMITS.analyses).all<{ id: string }>();
    for (const p of products) jobs.push({ path: "/internal/analyze", payload: { product_id: p.id } });
  }
  return jobs;
}
