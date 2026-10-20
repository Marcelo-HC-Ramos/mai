import { beforeAll, describe, expect, it } from "vitest";
import { dueJobs } from "../src/scheduler";
import { db, seedDemo } from "./helpers";

describe("agendador", () => {
  let ctx: Awaited<ReturnType<typeof seedDemo>>;
  beforeAll(async () => { ctx = await seedDemo(); });

  const at = (h: number, m: number) => { const d = new Date(); d.setUTCHours(h, m, 0, 0); return d; };

  it("antes das 06:00 não analisa; contas de demonstração não sincronizam sozinhas", async () => {
    const jobs = await dueJobs(db(), at(5, 0));
    expect(jobs).toEqual([]);
  });

  it("depois das 06:00 analisa os produtos sem análise do dia", async () => {
    // as análises do seed foram feitas agora; força que sejam de ontem
    await db().raw.prepare("UPDATE market_snapshots SET captured_at = '2000-01-01T00:00:00.000Z'").run();
    const jobs = await dueJobs(db(), at(23, 59));
    expect(jobs.filter((j) => j.path === "/internal/analyze").length).toBe(5);
  });

  it("contas reais sincronizam, as mais atrasadas primeiro", async () => {
    const acc = (await db().marketplace_accounts.findOne({ seller_id: ctx.sellerId }))!;
    await db().marketplace_accounts.insert({ ...acc, _id: undefined as any, marketplace: "MERCADO_LIVRE", external_id: "123", last_sync_at: null });
    const jobs = await dueJobs(db(), at(5, 0));
    expect(jobs).toEqual([{ path: "/internal/sync", payload: { account_id: expect.any(String), recent_only: true } }]);
  });
});
