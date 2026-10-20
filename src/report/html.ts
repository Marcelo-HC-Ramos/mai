// UC03: relatório de inteligência de mercado em HTML (imprimível em PDF).
import { SHIPPING_MODES } from "../connectors/base";
import { brl } from "../lib/num";

export const SOURCE_LABEL: Record<string, string> = { api: "Dado do marketplace", calculado: "Calculado pelo MAI", estimativa: "Estimativa",
  vendedor: "Dados do vendedor", indisponivel: "Indisponível" };

/** Escapa texto para HTML (todo valor vindo do banco ou do marketplace passa por aqui). */
export const esc = (v: any) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const src = (s: any) => esc(SOURCE_LABEL[s] ?? s);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${v.toFixed(1).replace(".", ",")}%`);
const money = (v: any) => esc(brl(v ?? null));
const each = <T>(xs: T[] | null | undefined, f: (x: T) => string) => (xs || []).map(f).join("");

/** Histograma dos preços dos concorrentes com linhas para o preço atual e o recomendado. */
export function priceHistogramSvg(prices: number[], markers: Record<string, number | null | undefined>, width = 640, height = 180): string {
  if (!prices.length) return "";
  const vals = Object.values(markers).filter((v): v is number => !!v);
  const lo = Math.min(...prices, ...vals), hi = Math.max(...prices, ...vals);
  const span = hi - lo || 1;
  const bins = 12;
  const counts = new Array(bins).fill(0);
  for (const p of prices) counts[Math.min(bins - 1, Math.trunc((p - lo) / span * bins))]++;
  const top = Math.max(...counts) || 1;
  const padL = 8, padB = 28, padT = 26;
  const plotW = width - 2 * padL, plotH = height - padB - padT;
  const bw = plotW / bins;
  const parts = [`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Distribuição de preços dos concorrentes" class="hist">`];
  counts.forEach((c, i) => {
    const h = plotH * c / top, x = padL + i * bw + 1, y = padT + plotH - h;
    const label = `${brl(lo + span * i / bins)} a ${brl(lo + span * (i + 1) / bins)}: ${c} anúncio(s)`;
    if (c) parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="3" class="bar"><title>${esc(label)}</title></rect>`);
  });
  const baseY = padT + plotH;
  parts.push(`<line x1="${padL}" x2="${width - padL}" y1="${baseY}" y2="${baseY}" class="axis"/>`);
  parts.push(`<text x="${padL}" y="${height - 8}" class="tick">${money(lo)}</text>`);
  parts.push(`<text x="${width - padL}" y="${height - 8}" class="tick" text-anchor="end">${money(hi)}</text>`);
  const styles: Record<string, string> = { "Seu preço": "m-current", Recomendado: "m-reco", Mediana: "m-median" };
  for (const [name, value] of Object.entries(markers)) {
    if (!value) continue;
    const x = padL + plotW * (value - lo) / span;
    parts.push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${padT - 6}" y2="${baseY}" class="marker ${styles[name] || ""}"><title>${esc(name)}: ${money(value)}</title></line>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

function dateBR(isoText: string): string {
  const d = new Date(isoText);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function renderHtml(s: Record<string, any>, p: Record<string, any>): string {
  const comp = s.competitor_data || {}, pricing = s.pricing || {};
  const kw = s.search_intelligence.keywords, dev = s.search_intelligence.traffic_breakdown;
  const rev = s.review_insights, recs: any[] = s.ai_recommendations || [];
  const hist = priceHistogramSvg(comp.price_distribution || [], { "Seu preço": pricing.current_price, Recomendado: pricing.recommended_price,
    Mediana: comp.median_price });
  const ai = s.ai_summary, logi = s.logistics, cb = pricing.cost_breakdown;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório de Mercado</title>
<style>
:root{color-scheme:light;--bg:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;
--axis:#c3c2b7;--border:rgba(11,11,11,.10);--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--good:#006300;--crit:#d03b3b;--warn:#fab219}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#fff;
--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--good:#0ca30c}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--grid:#2c2c2a;--axis:#383835;
--border:rgba(255,255,255,.10);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--good:#0ca30c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}
.sub{color:var(--ink2);margin:0 0 24px}.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.tile .v{font-size:22px;font-weight:600}.tile .l{color:var(--ink2);font-size:13px}
.badge{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--border);color:var(--ink2);vertical-align:middle}
.badge.est{border-color:var(--warn);}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--grid);font-size:14px}
th{color:var(--ink2);font-weight:500}.bar-cell{width:40%}.hbar{height:10px;border-radius:0 4px 4px 0;background:var(--s1)}
.hist .bar{fill:var(--s1)}.hist .axis{stroke:var(--axis)}.hist .tick{fill:var(--muted);font-size:12px}
.hist .marker{stroke-width:2;stroke-dasharray:4 3}.m-current{stroke:var(--s2)}.m-reco{stroke:var(--s3);stroke-dasharray:none!important}.m-median{stroke:var(--muted)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--ink2);margin-top:8px}.legend i{display:inline-block;width:14px;height:3px;margin-right:6px;vertical-align:middle}
.split{display:flex;height:22px;border-radius:6px;overflow:hidden;gap:2px;background:var(--surface)}.split div{height:100%}
.recs li{margin-bottom:10px}.prio{font-size:11px;font-weight:600;color:var(--ink2);margin-right:6px}
.warn{color:var(--crit)}.ex{color:var(--ink2);font-size:13px;font-style:italic}
@media print{body{background:#fff}.card{break-inside:avoid}}
</style>
</head>
<body>
<main>
<h1>Relatório de mercado: ${esc(p.title)}</h1>
<p class="sub">Análise de ${dateBR(s.captured_at)} UTC · ${esc(comp.competitors_used || 0)} concorrentes · busca por “${esc(s.query)}” · ${esc(s.marketplace)}${s.account_nickname ? ` · conta ${esc(s.account_nickname)}` : ""}</p>
${ai ? `
<section class="card">
  <h2>Resumo da análise <span class="badge">Gerado por IA (${esc(ai.model || ai.provider)})</span></h2>
  <p>${esc(ai.summary)}</p>
  ${ai.title_suggestion ? `<p><strong>Sugestão de título:</strong> ${esc(ai.title_suggestion)}</p>` : ""}
  ${ai.selling_points?.length ? `<p style="margin-bottom:4px"><strong>Argumentos de venda contra as falhas dos concorrentes:</strong></p>
  <ul>${each(ai.selling_points, (sp: string) => `<li>${esc(sp)}</li>`)}</ul>` : ""}
  <p class="ex">Texto gerado por IA a partir dos números deste relatório. Revise antes de publicar.</p>
</section>` : ""}

<section class="card">
  <h2>O que fazer agora</h2>
  <ol class="recs">
  ${each(recs, (r) => `<li><span class="prio">${esc(r.type)}</span>${esc(r.message)}</li>`)}
  </ol>
</section>

<section class="card">
  <h2>Melhor preço de venda <span class="badge">${src(pricing.source)}</span></h2>
  <div class="grid">
    <div class="tile"><div class="l">Seu preço atual</div><div class="v">${money(pricing.current_price)}</div></div>
    <div class="tile"><div class="l">Preço recomendado</div><div class="v">${money(pricing.recommended_price)}</div></div>
    <div class="tile"><div class="l">Preço competitivo</div><div class="v">${money(pricing.competitive_price)}</div></div>
    <div class="tile"><div class="l">Mínimo permitido (margem ${Math.trunc(pricing.min_margin_pct || 0)}%)</div><div class="v">${money(pricing.min_allowed_price)}</div></div>
    <div class="tile"><div class="l">Margem no recomendado</div><div class="v">${pct(pricing.margin_pct_at_recommended)}</div></div>
  </div>
  ${each(pricing.warnings, (w: string) => `<p class="warn">${esc(w)}</p>`)}
  ${cb ? `
  <table style="margin-top:12px"><thead><tr><th>Custos por unidade no preço recomendado (${esc(cb.listing_type_label)}, ${esc(cb.shipping_mode_label)})</th><th>Valor</th><th>% do preço</th></tr></thead><tbody>
  ${each(cb.breakdown, (b: any) => `<tr><td>${esc(b.label)}${b.source === "estimativa" ? ' <span class="badge est">Estimativa</span>' : ""}</td><td>${money(b.value)}</td><td>${pct(b.pct_of_price)}</td></tr>`)}
  <tr><td><strong>Lucro líquido</strong></td><td><strong>${money(cb.profit)}</strong></td><td><strong>${pct(cb.margin_pct)}</strong></td></tr>
  </tbody></table>` : ""}
  <p class="ex">O recomendado é o preço com maior lucro esperado (margem × chance relativa de conversão frente à mediana do mercado). O competitivo iguala o menor preço relevante, respeitando a margem mínima.</p>
</section>

<section class="card">
  <h2>Preços dos concorrentes <span class="badge">${src(comp.source)}</span></h2>
  <div class="grid">
    <div class="tile"><div class="l">Menor</div><div class="v">${money(comp.lowest_price)}</div></div>
    <div class="tile"><div class="l">Mediana</div><div class="v">${money(comp.median_price)}</div></div>
    <div class="tile"><div class="l">Média</div><div class="v">${money(comp.average_price)}</div></div>
    <div class="tile"><div class="l">Maior</div><div class="v">${money(comp.highest_price)}</div></div>
    <div class="tile"><div class="l">Com frete grátis</div><div class="v">${pct(comp.free_shipping_share_pct)}</div></div>
  </div>
  <div style="margin-top:16px">${hist}</div>
  <div class="legend"><span><i style="background:var(--s2)"></i>Seu preço</span><span><i style="background:var(--s3)"></i>Recomendado</span><span><i style="background:var(--muted)"></i>Mediana</span></div>
  <p class="ex">${esc(comp.outliers_removed || 0)} anúncio(s) com preço discrepante foram descartados (regra do intervalo interquartil). Confiança: ${esc(comp.confidence)}.</p>
  <table><thead><tr><th>Concorrente</th><th>Preço</th><th>Vendidos</th><th>Envio</th></tr></thead><tbody>
  ${each(comp.top_competitors, (c: any) => `<tr><td>${/^https?:\/\//.test(c.url || "") ? `<a href="${esc(c.url)}">${esc(c.title)}</a>` : esc(c.title)}</td><td>${money(c.price)}</td><td>${esc(c.sold_quantity)}</td><td>${esc(SHIPPING_MODES[c.shipping_mode] ?? "-")}${c.free_shipping ? " · grátis" : ""}</td></tr>`)}
  </tbody></table>
</section>
${logi?.by_mode?.length ? `
<section class="card">
  <h2>Full, Flex ou coleta? <span class="badge">${src(logi.source)}</span></h2>
  ${logi.filter?.length ? `<p class="warn">Preços e melhor preço comparados só com concorrentes em: ${esc(logi.filter.join(", "))}.</p>` : ""}
  <p>Entre os 10 concorrentes que mais vendem, a logística mais usada é <strong>${esc(logi.leader_mode_label)}</strong>
  (${pct(logi.full_share_top_pct)} no Full, ${pct(logi.flex_share_top_pct)} no Flex).${logi.my_mode_label ? ` Seu anúncio usa <strong>${esc(logi.my_mode_label)}</strong>.` : ""}</p>
  <table><thead><tr><th>Modalidade</th><th>Anúncios</th><th class="bar-cell">Participação nas vendas</th><th>Preço mediano</th><th>Vendidos por anúncio</th></tr></thead><tbody>
  ${each(logi.by_mode, (m: any) => `<tr><td>${esc(m.label)}</td><td>${esc(m.listings)} (${pct(m.share_pct)})</td>
  <td class="bar-cell"><div class="hbar" style="width:${Number(m.sales_share_pct)}%" title="${esc(m.sales_share_pct)}%"></div> ${pct(m.sales_share_pct)}</td>
  <td>${money(m.median_price)}</td><td>${esc(m.avg_sold)}</td></tr>`)}
  </tbody></table>
</section>` : ""}

<section class="card">
  <h2>Palavras-chave mais buscadas <span class="badge">${src(kw.source)}</span></h2>
  <table><thead><tr><th>Termo</th><th class="bar-cell">Relevância (0-100)</th><th>No seu título</th></tr></thead><tbody>
  ${each(kw.top_keywords, (k: any) => `<tr><td>${esc(k.term)}${k.monthly_volume ? ` <span class="badge">${esc(k.monthly_volume)}/mês</span>` : ""}</td>
  <td class="bar-cell"><div class="hbar" style="width:${Number(k.score)}%" title="${esc(k.score)}"></div></td><td>${k.in_my_title ? "Sim" : "Não"}</td></tr>`)}
  </tbody></table>
  <p class="ex">${esc(kw.note)}</p>
</section>

<section class="card">
  <h2>Celular ou computador? <span class="badge ${dev.source === "estimativa" ? "est" : ""}">${src(dev.source)}</span></h2>
  <p>A maior parte das buscas vem do <strong>${esc(dev.predominant)}</strong>.</p>
  <div class="split" role="img" aria-label="Celular ${esc(dev.mobile_share_pct)}%, computador ${esc(dev.desktop_share_pct)}%">
    <div style="width:${Number(dev.mobile_share_pct)}%;background:var(--s1)" title="Celular ${esc(dev.mobile_share_pct)}%"></div>
    <div style="width:${Number(dev.desktop_share_pct)}%;background:var(--s2)" title="Computador ${esc(dev.desktop_share_pct)}%"></div>
  </div>
  <div class="legend"><span><i style="background:var(--s1);height:10px"></i>Celular ${pct(dev.mobile_share_pct)}</span><span><i style="background:var(--s2);height:10px"></i>Computador ${pct(dev.desktop_share_pct)}</span></div>
  <p class="ex">Fonte: ${esc(dev.reference)}.</p>
</section>

<section class="card">
  <h2>Por que as avaliações são ruins <span class="badge">${src(rev.source)}</span> <span class="badge">${rev.method === "ia" ? "Classificado por IA" : "Classificado por palavras-chave"}</span></h2>
  ${Object.entries(rev.groups || {}).map(([owner, g]: [string, any]) => `
  <h3 style="font-size:15px;margin:12px 0 6px">${owner === "mercado" ? "Concorrentes" : "Seu anúncio"}: ${esc(g.bad_reviews)} avaliações de 1 a 3 estrelas de ${esc(g.total_reviews)} (${pct(g.bad_share_pct)}), nota média ${esc(g.average_rating || "-")}</h3>
  ${g.main_reason ? `<p>Principal motivo: <strong>${esc(g.main_reason.label)}</strong> (${pct(g.main_reason.pct_of_bad_reviews)} das avaliações ruins).</p>` : "<p>Sem avaliações ruins com texto.</p>"}
  ${g.small_sample ? '<p class="ex">Amostra pequena: trate como indício.</p>' : ""}
  <table><tbody>
  ${each(g.reasons, (r: any) => `<tr><td>${esc(r.label)}<div class="ex">${esc((r.examples || []).join(" · "))}</div></td><td class="bar-cell"><div class="hbar" style="width:${Number(r.pct_of_bad_reviews)}%"></div></td><td>${pct(r.pct_of_bad_reviews)}</td></tr>`)}
  </tbody></table>`).join("")}
</section>

<p class="ex">Legenda de fontes: “Dado do marketplace” vem da API oficial; “Calculado pelo MAI” é derivado desses dados; “Estimativa” indica dado que a plataforma não fornece.</p>
</main>
</body>
</html>`;
}
