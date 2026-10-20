// UC03: relatório de inteligência de mercado em planilha Excel (XLSX), montada à mão e compactada com fflate.
import { strToU8, zipSync } from "fflate";
import { SHIPPING_MODES } from "../connectors/base";

type Cell = string | number | boolean | null | undefined;
interface Sheet { title: string; header: string[]; rows: Cell[][] }

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
  // caracteres de controle não são aceitos no XML da planilha
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

function colName(i: number): string {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

function cell(v: Cell, ref: string, bold = false): string {
  const st = bold ? ' s="1"' : "";
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
  return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
}

function sheetXml(s: Sheet): string {
  const all: Cell[][] = [s.header, ...s.rows];
  const ncols = Math.max(...all.map((r) => r.length));
  const widths = Array.from({ length: ncols }, (_, c) => Math.min(70, Math.max(12, ...all.map((r) => String(r[c] ?? "").length))));
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const rows = all.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(v, `${colName(ci)}${ri + 1}`, ri === 0)).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<cols>${cols}</cols><sheetData>${rows}</sheetData></worksheet>`;
}

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}" xmlns:r="${rel}"><sheets>` +
      sheets.map((s, i) => `<sheet name="${xml(s.title.replace(/[\\/?*[\]:]/g, " ").slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      `</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${rel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="${rel}/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${ns}">` +
      `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
      `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
      `</styleSheet>`),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s)); });
  return zipSync(files, { level: 1 });
}

function dateBR(isoText: string): string {
  const d = new Date(isoText);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function renderXlsx(s: Record<string, any>, product: Record<string, any>): Uint8Array {
  const comp = s.competitor_data || {}, pricing = s.pricing || {};
  const kw = s.search_intelligence.keywords, dev = s.search_intelligence.traffic_breakdown;
  const sheets: Sheet[] = [];
  const add = (title: string, header: string[], rows: Cell[][]) => sheets.push({ title, header, rows });
  add("Resumo", ["Indicador", "Valor", "Fonte"], [
    ["Produto", product.title, ""],
    ["Data da análise", dateBR(s.captured_at), ""],
    ["Seu preço", pricing.current_price, "api"],
    ["Preço recomendado", pricing.recommended_price, "calculado"],
    ["Preço competitivo", pricing.competitive_price, "calculado"],
    ["Preço mínimo permitido", pricing.min_allowed_price, "calculado"],
    ["Margem no recomendado (%)", pricing.margin_pct_at_recommended, "calculado"],
    ["Concorrentes analisados", comp.competitors_used, "api"],
    ["Menor preço", comp.lowest_price, "api"],
    ["Mediana", comp.median_price, "calculado"],
    ["Média", comp.average_price, "calculado"],
    ["Maior preço", comp.highest_price, "api"],
    ["Buscas pelo celular (%)", dev.mobile_share_pct, dev.source],
    ["Buscas pelo computador (%)", dev.desktop_share_pct, dev.source],
  ]);
  add("Concorrentes", ["Anúncio", "Título", "Preço", "Vendidos", "Envio", "Frete grátis", "Reputação", "Link"],
    (comp.top_competitors || []).map((c: any) => [c.item_id, c.title, c.price, c.sold_quantity, SHIPPING_MODES[c.shipping_mode] ?? "-",
      c.free_shipping ? "Sim" : "Não", c.seller_reputation, c.url]));
  const logi = s.logistics || {};
  if (logi.by_mode?.length) {
    add("Full x Flex", ["Modalidade", "Anúncios", "% dos anúncios", "% das vendas", "Preço mediano", "Vendidos por anúncio"],
      logi.by_mode.map((m: any) => [m.label, m.listings, m.share_pct, m.sales_share_pct, m.median_price, m.avg_sold]));
  }
  const cb = pricing.cost_breakdown;
  if (cb?.breakdown?.length) {
    add("Custos", ["Item", "Valor (R$)", "% do preço", "Fonte"],
      [...cb.breakdown.map((b: any) => [b.label, b.value, b.pct_of_price, b.source]), ["Lucro líquido", cb.profit, cb.margin_pct, ""]]);
  }
  add("Palavras-chave", ["Termo", "Pontuação (0-100)", "Volume mensal", "Já no seu título", "Fontes"],
    (kw.top_keywords || []).map((k: any) => [k.term, k.score, k.monthly_volume, k.in_my_title ? "Sim" : "Não", (k.sources || []).join(", ")]));
  const rows: Cell[][] = [];
  for (const [owner, g] of Object.entries<any>(s.review_insights?.groups || {})) {
    for (const r of g.reasons || []) rows.push([owner, r.label, r.count, r.pct_of_bad_reviews, (r.examples || []).join(" | ")]);
  }
  add("Avaliações ruins", ["Grupo", "Motivo", "Ocorrências", "% das ruins", "Exemplos"], rows);
  let plan: Cell[][] = (s.ai_recommendations || []).map((r: any) => [r.priority, r.type, r.message]);
  const ai = s.ai_summary;
  if (ai) {
    plan = [[0, "RESUMO (IA)", ai.summary], [0, "TÍTULO (IA)", ai.title_suggestion],
      ...(ai.selling_points || []).map((sp: string) => [0, "ARGUMENTO (IA)", sp]), ...plan];
  }
  add("Plano de ação", ["Prioridade", "Tipo", "Recomendação"], plan);
  add("Curva de preço", ["Preço", "Conversão relativa", "Margem unitária", "Lucro esperado", "Permitido"],
    (pricing.curve || []).map((r: any) => [r.price, r.conversion, r.unit_margin, r.expected_profit, r.allowed ? "Sim" : "Não"]));
  return buildXlsx(sheets);
}
