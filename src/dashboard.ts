// Painéis do vendedor: vendas (UC04), perguntas (UC05) e estoque (UC11).
// As somas saem de consultas SQL no D1, apoiadas pelos índices da migração (RNF03).
import type { Store } from "./db";
import { round } from "./lib/num";
import { DAY, startOfDayUTC } from "./lib/time";

export const PERIODS: Record<string, number | null> = { hoje: 0, "7d": 7, "15d": 15, "30d": 30, "90d": 90, mes: null, ano: null };
const VALID = "('paid','confirmed','delivered','shipped')";

export class PeriodError extends Error {}

export function periodRange(period: string, now = new Date()): [Date, Date] {
  const today = startOfDayUTC(now);
  if (period === "hoje") return [today, now];
  if (period === "mes") return [new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), now];
  if (period === "ano") return [new Date(Date.UTC(now.getUTCFullYear(), 0, 1)), now];
  if (!(period in PERIODS)) throw new PeriodError(`Período inválido: ${period}. Use ${Object.keys(PERIODS).join(", ")}`);
  return [new Date(today.getTime() - ((PERIODS[period] as number) - 1) * DAY), now];
}

/** Filtro base: a loja inteira ou só uma das suas contas de marketplace. */
function scope(sellerId: string, accountId?: string | null): [string, any[]] {
  return accountId ? ["seller_id = ? AND account_id = ?", [sellerId, accountId]] : ["seller_id = ?", [sellerId]];
}

const pct = (a: number, b: number) => (b ? round(100 * (a - b) / b, 1) : null);

async function totals(db: Store, sc: [string, any[]], start: Date, end: Date) {
  const r = (await db.raw.prepare(`SELECT coalesce(sum(total_amount),0) AS gross, coalesce(sum(net_amount),0) AS net,
      coalesce(sum(marketplace_fee),0) AS fees, coalesce(sum(shipping_cost),0) AS shipping, count(*) AS orders,
      coalesce(sum(units),0) AS units
    FROM orders WHERE ${sc[0]} AND created_at >= ? AND created_at <= ? AND status IN ${VALID}`)
    .bind(...sc[1], start.toISOString(), end.toISOString()).first<any>())!;
  return { gross_revenue: round(r.gross, 2), net_revenue: round(r.net, 2), marketplace_fees: round(r.fees, 2),
    shipping_costs: round(r.shipping, 2), orders: r.orders, units: r.units,
    average_ticket: r.orders ? round(r.gross / r.orders, 2) : 0 };
}

export async function salesSummary(db: Store, sellerId: string, period = "30d", now = new Date(), accountId?: string | null) {
  const sc = scope(sellerId, accountId);
  const [start, end] = periodRange(period, now);
  const span = end.getTime() - start.getTime();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const samePoint = new Date(Math.min(prevMonthStart.getTime() + (now.getTime() - monthStart.getTime()), monthStart.getTime()));
  const range = [start.toISOString(), end.toISOString()];
  const where = `${sc[0]} AND created_at >= ? AND created_at <= ?`;
  const [cur, previous, month, prevMonth, prevMonthFull, byAcc, daily, topProducts, cancelled, accounts] = await Promise.all([
    totals(db, sc, start, end),
    totals(db, sc, new Date(start.getTime() - span), start),
    totals(db, sc, monthStart, now),
    totals(db, sc, prevMonthStart, samePoint),
    totals(db, sc, prevMonthStart, monthStart),
    db.raw.prepare(`SELECT account_id, sum(total_amount) AS gross, count(*) AS orders FROM orders WHERE ${where} AND status IN ${VALID}
      GROUP BY account_id ORDER BY gross DESC`).bind(...sc[1], ...range).all<any>(),
    db.raw.prepare(`SELECT substr(created_at,1,10) AS day, sum(total_amount) AS gross, count(*) AS orders FROM orders
      WHERE ${where} AND status IN ${VALID} GROUP BY day`).bind(...sc[1], ...range).all<any>(),
    db.raw.prepare(`SELECT json_extract(i.value,'$.product_id') AS pid, json_extract(i.value,'$.title') AS title,
        sum(json_extract(i.value,'$.quantity')) AS units,
        sum(json_extract(i.value,'$.quantity') * json_extract(i.value,'$.unit_price')) AS gross
      FROM orders o, json_each(o.data,'$.items') i WHERE ${where.replace(/(seller_id|account_id|created_at)/g, "o.$1")}
        AND o.status IN ${VALID} GROUP BY pid, title ORDER BY gross DESC LIMIT 5`).bind(...sc[1], ...range).all<any>(),
    db.raw.prepare(`SELECT count(*) AS n FROM orders WHERE ${where} AND status = 'cancelled'`).bind(...sc[1], ...range).first<{ n: number }>(),
    db.marketplace_accounts.find({ seller_id: sellerId }),
  ]);
  const accById = new Map(accounts.map((a) => [a._id, a]));
  const gross = cur.gross_revenue || 1;
  const byAccount = byAcc.results.map((r) => {
    const acc: any = accById.get(r.account_id) || {};
    return { account_id: r.account_id, nickname: acc.nickname ?? "Conta removida", marketplace: acc.marketplace ?? null,
      gross_revenue: round(r.gross, 2), orders: r.orders, share_pct: round(100 * r.gross / gross, 1) };
  });
  const byMarketplace = new Map<string, any>();
  for (const a of byAccount) {
    const m = byMarketplace.get(a.marketplace) || { marketplace: a.marketplace, gross_revenue: 0, orders: 0 };
    m.gross_revenue = round(m.gross_revenue + a.gross_revenue, 2);
    m.orders += a.orders;
    byMarketplace.set(a.marketplace, m);
  }
  for (const m of byMarketplace.values()) m.share_pct = round(100 * m.gross_revenue / gross, 1);
  const days = new Map(daily.results.map((r) => [r.day, r]));
  const curve: any[] = [];
  for (let day = start; day <= end; day = new Date(day.getTime() + DAY)) {
    const key = day.toISOString().slice(0, 10);
    const r = days.get(key) || { gross: 0, orders: 0 };
    curve.push({ date: key, gross_revenue: round(r.gross, 2), orders: r.orders });
  }
  const nCancelled = cancelled!.n;
  return {
    period, start: start.toISOString(), end: end.toISOString(),
    ...cur,
    vs_previous_period_pct: { gross_revenue: pct(cur.gross_revenue, previous.gross_revenue), orders: pct(cur.orders, previous.orders) },
    current_month: { ...month, vs_same_point_last_month_pct: pct(month.gross_revenue, prevMonth.gross_revenue),
      last_month_total: prevMonthFull.gross_revenue },
    cancelled_orders: nCancelled,
    cancellation_rate_pct: nCancelled + cur.orders ? round(100 * nCancelled / (nCancelled + cur.orders), 1) : 0,
    by_account: byAccount,
    by_marketplace: [...byMarketplace.values()].sort((a, b) => b.gross_revenue - a.gross_revenue),
    daily_curve: curve,
    top_products: topProducts.results.map((r) => ({ product_id: r.pid ?? null, title: r.title, units: r.units, gross_revenue: round(r.gross, 2) })),
  };
}

export async function questionsSummary(db: Store, sellerId: string, now = new Date(), limit = 20, accountId?: string | null) {
  const sc = scope(sellerId, accountId);
  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  const [accounts, unanswered, answered, topics, byProduct, unansweredCount, received, products] = await Promise.all([
    db.marketplace_accounts.find({ seller_id: sellerId }),
    db.customer_questions.find({ seller_id: sellerId, account_id: accountId || undefined, status: "UNANSWERED" }, { order: "received_at", limit }),
    db.raw.prepare(`SELECT received_at AS r, json_extract(data,'$.answered_at') AS a FROM customer_questions
      WHERE ${sc[0]} AND status = 'ANSWERED' AND received_at >= ? AND json_extract(data,'$.answered_at') IS NOT NULL`)
      .bind(...sc[1], since).all<{ r: string; a: string }>(),
    db.raw.prepare(`SELECT topic, count(*) AS n FROM customer_questions WHERE ${sc[0]} AND received_at >= ? GROUP BY topic ORDER BY n DESC`)
      .bind(...sc[1], since).all<{ topic: string; n: number }>(),
    db.raw.prepare(`SELECT product_id, count(*) AS n FROM customer_questions WHERE ${sc[0]} AND received_at >= ?
      GROUP BY product_id ORDER BY n DESC LIMIT 5`).bind(...sc[1], since).all<{ product_id: string | null; n: number }>(),
    db.customer_questions.count({ seller_id: sellerId, account_id: accountId || undefined, status: "UNANSWERED" }),
    db.customer_questions.count({ seller_id: sellerId, account_id: accountId || undefined, received_at: { gte: since } }),
    db.raw.prepare("SELECT id, title FROM products WHERE seller_id = ?").bind(sellerId).all<{ id: string; title: string }>(),
  ]);
  const nick = new Map(accounts.map((a) => [a._id, a.nickname]));
  const titles = new Map(products.results.map((p) => [p.id, p.title]));
  const minutes = answered.results.map((x) => (new Date(x.a).getTime() - new Date(x.r).getTime()) / 60_000);
  return {
    unanswered_count: unansweredCount,
    received_last_30d: received,
    avg_response_minutes_30d: minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null,
    answered_within_1h_pct: minutes.length ? round(100 * minutes.filter((m) => m <= 60).length / minutes.length, 1) : null,
    top_topics: topics.results.map((r) => ({ topic: r.topic, count: r.n })),
    by_product: byProduct.results.map((r) => ({ product_id: r.product_id, count: r.n, title: r.product_id ? titles.get(r.product_id) ?? null : null })),
    unanswered: unanswered.map((d) => ({
      id: d._id, product_id: d.product_id ?? null, product_title: titles.get(d.product_id) ?? null, question: d.question_text,
      topic: d.topic ?? null, buyer: d.buyer_nickname ?? null, marketplace: d.marketplace, account: nick.get(d.account_id) ?? null,
      suggestion_method: d.suggestion_method ?? null, received_at: d.received_at,
      waiting_hours: round((now.getTime() - new Date(d.received_at).getTime()) / 3_600_000, 1),
      suggested_answer: d.suggested_ai_answer ?? null,
    })),
  };
}

export async function stockSummary(db: Store, sellerId: string, alertDays: number, now = new Date(), accountId?: string | null) {
  const sc = scope(sellerId, accountId);
  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  const [vel, products] = await Promise.all([
    db.raw.prepare(`SELECT json_extract(i.value,'$.product_id') AS pid, sum(json_extract(i.value,'$.quantity')) AS units
      FROM orders o, json_each(o.data,'$.items') i WHERE ${sc[0].replace(/(seller_id|account_id)/g, "o.$1")} AND o.created_at >= ?
        AND o.status IN ${VALID} GROUP BY pid`).bind(...sc[1], since).all<{ pid: string; units: number }>(),
    db.products.find({ seller_id: sellerId }),
  ]);
  const velocity = new Map(vel.results.map((r) => [r.pid, r.units]));
  const rows: any[] = [];
  for (const p of products) {
    const listings = (p.listings || []).filter((l: any) => !accountId || l.account_id === accountId);
    if (!listings.length) continue;
    const stock = listings.reduce((s: number, l: any) => s + Math.trunc(Number(l.stock_quantity || 0)), 0);
    const sold = velocity.get(p._id) || 0;
    const perDay = sold / 30;
    const coverage = perDay ? round(stock / perDay, 1) : null;
    const prices = listings.map((l: any) => l.current_price).filter(Boolean);
    rows.push({
      product_id: p._id, sku: p.internal_sku ?? null, title: p.title, stock,
      price: prices.length ? Math.min(...prices) : null,
      accounts: [...new Set(listings.map((l: any) => l.account_nickname || l.marketplace))].sort(),
      stock_value_at_cost: p.cost_price ? round(stock * p.cost_price, 2) : null,
      units_sold_30d: sold, avg_daily_sales: round(perDay, 2), coverage_days: coverage,
      alert: stock === 0 ? "SEM_ESTOQUE" : coverage !== null && coverage < alertDays ? "REPOR" : null,
    });
  }
  rows.sort((a, b) => Number(a.alert === null) - Number(b.alert === null) || (a.coverage_days ?? 1e9) - (b.coverage_days ?? 1e9));
  return {
    total_units: rows.reduce((s, r) => s + r.stock, 0),
    stock_value_at_cost: round(rows.reduce((s, r) => s + (r.stock_value_at_cost || 0), 0), 2),
    products: rows.length,
    out_of_stock: rows.filter((r) => r.alert === "SEM_ESTOQUE").length,
    restock_alerts: rows.filter((r) => r.alert === "REPOR").length,
    alert_threshold_days: alertDays,
    items: rows,
  };
}
