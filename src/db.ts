// Acesso ao Cloudflare D1. Cada coleção é uma tabela com o documento em `data` (JSON) e colunas de busca.
export type Doc = Record<string, any> & { _id: string };

const COLUMNS: Record<string, string[]> = {
  organizations: ["document"],
  users: ["org_id", "email", "active"],
  sellers: ["org_id", "name"],
  marketplace_accounts: ["org_id", "seller_id", "marketplace", "external_id", "status", "connected_at", "last_sync_at"],
  products: ["org_id", "seller_id", "internal_sku", "title"],
  market_snapshots: ["org_id", "seller_id", "product_id", "captured_at", "recommended_price"],
  customer_questions: ["org_id", "seller_id", "account_id", "product_id", "external_question_id", "status", "topic", "received_at"],
  orders: ["org_id", "seller_id", "account_id", "external_order_id", "created_at", "status", "total_amount", "net_amount",
    "marketplace_fee", "shipping_cost", "units", "buyer_device"],
  ad_tracking: ["org_id", "item_id", "active", "added_at"],
  ad_snapshots: ["item_id", "captured_at"],
  ad_analyses: ["org_id", "item_id", "analyzed_at"],
  oauth_states: ["state", "created_at"],
};

export type Op = { gte?: any; gt?: any; lte?: any; lt?: any; ne?: any; in?: any[] };
export type Where = Record<string, any>;

export class DuplicateKeyError extends Error {}

export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const colValue = (v: any) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

function whereSql(where: Where, cols: string[]): [string, any[]] {
  const parts: string[] = [], args: any[] = [];
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    const col = k === "_id" ? "id" : k;
    if (col !== "id" && !cols.includes(col)) throw new Error(`coluna sem índice: ${col}`);
    if (v === null) parts.push(`${col} IS NULL`);
    else if (typeof v === "object" && !Array.isArray(v)) {
      const op = v as Op;
      for (const [o, sym] of [["gte", ">="], ["gt", ">"], ["lte", "<="], ["lt", "<"], ["ne", "!="]] as const) {
        if (op[o] !== undefined) { parts.push(`${col} ${sym} ?`); args.push(colValue(op[o])); }
      }
      if (op.in) {
        if (!op.in.length) parts.push("0");
        else { parts.push(`${col} IN (${op.in.map(() => "?").join(",")})`); args.push(...op.in.map(colValue)); }
      }
    } else { parts.push(`${col} = ?`); args.push(colValue(v)); }
  }
  return [parts.length ? " WHERE " + parts.join(" AND ") : "", args];
}

function setPath(obj: any, path: string, value: any) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] = o[k] && typeof o[k] === "object" ? o[k] : {};
  if (value === undefined) delete o[keys[keys.length - 1]];
  else o[keys[keys.length - 1]] = value;
}

export class Collection {
  readonly cols: string[];
  constructor(readonly db: D1Database, readonly name: string) {
    this.cols = COLUMNS[name];
  }

  private row(doc: Doc): any[] {
    return [doc._id, ...this.cols.map((c) => colValue(doc[c])), JSON.stringify(doc)];
  }

  async get(id: string | null | undefined): Promise<Doc | null> {
    if (!id) return null;
    const r = await this.db.prepare(`SELECT data FROM ${this.name} WHERE id = ?`).bind(id).first<{ data: string }>();
    return r ? JSON.parse(r.data) : null;
  }

  async find(where: Where = {}, opts: { order?: string; limit?: number } = {}): Promise<Doc[]> {
    const [w, args] = whereSql(where, this.cols);
    let sql = `SELECT data FROM ${this.name}${w}`;
    if (opts.order) sql += ` ORDER BY ${opts.order}`;
    if (opts.limit) sql += ` LIMIT ${Math.floor(opts.limit)}`;
    const { results } = await this.db.prepare(sql).bind(...args).all<{ data: string }>();
    return results.map((r) => JSON.parse(r.data));
  }

  async findOne(where: Where, order?: string): Promise<Doc | null> {
    return (await this.find(where, { order, limit: 1 }))[0] || null;
  }

  async count(where: Where = {}): Promise<number> {
    const [w, args] = whereSql(where, this.cols);
    return (await this.db.prepare(`SELECT count(*) AS n FROM ${this.name}${w}`).bind(...args).first<{ n: number }>())!.n;
  }

  async insert<T extends Record<string, any>>(doc: T): Promise<T & Doc> {
    const full = { ...doc, _id: doc._id || newId() } as T & Doc;
    const names = ["id", ...this.cols, "data"];
    try {
      await this.db.prepare(`INSERT INTO ${this.name} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
        .bind(...this.row(full)).run();
    } catch (e: any) {
      if (/UNIQUE/i.test(String(e?.message))) throw new DuplicateKeyError(String(e.message));
      throw e;
    }
    return full;
  }

  async replace(doc: Doc): Promise<Doc> {
    const sets = [...this.cols.map((c) => `${c} = ?`), "data = ?"].join(", ");
    try {
      await this.db.prepare(`UPDATE ${this.name} SET ${sets} WHERE id = ?`).bind(...this.row(doc).slice(1), doc._id).run();
    } catch (e: any) {
      if (/UNIQUE/i.test(String(e?.message))) throw new DuplicateKeyError(String(e.message));
      throw e;
    }
    return doc;
  }

  /** Muda campos (aceita "a.b" para campos internos; valor undefined remove o campo). */
  async update(id: string, changes: Record<string, any>): Promise<Doc | null> {
    const doc = await this.get(id);
    if (!doc) return null;
    for (const [k, v] of Object.entries(changes)) setPath(doc, k, v);
    return this.replace(doc);
  }

  async deleteWhere(where: Where): Promise<void> {
    const [w, args] = whereSql(where, this.cols);
    await this.db.prepare(`DELETE FROM ${this.name}${w}`).bind(...args).run();
  }

  /** Grava muitos documentos numa única consulta. Quem já existe (pela chave única) tem os campos mesclados e mantém
   * o próprio id; quem é novo ganha um id novo (o `_id` dos documentos enviados é ignorado). */
  async bulkUpsert(docs: Record<string, any>[], conflict: string[]): Promise<void> {
    if (!docs.length) return;
    const names = ["id", ...this.cols, "data"];
    const select = names.map((c) => `json_extract(value, '$.${c}')`).join(", ");
    const updates = [...this.cols.filter((c) => !conflict.includes(c)).map((c) => `${c} = excluded.${c}`),
      `data = json_set(json_patch(${this.name}.data, excluded.data), '$._id', ${this.name}.id)`].join(", ");
    const payload = docs.map((d) => {
      const full = { ...d, _id: newId() };
      // `data` vai como objeto: json_extract devolve o texto JSON dele (evita serializar duas vezes)
      const o: Record<string, any> = { id: full._id, data: full };
      for (const c of this.cols) o[c] = colValue(full[c]);
      return o;
    });
    await this.db.prepare(`INSERT INTO ${this.name} (${names.join(",")}) SELECT ${select} FROM json_each(?) WHERE true
      ON CONFLICT(${conflict.join(",")}) DO UPDATE SET ${updates}`).bind(JSON.stringify(payload)).run();
  }
}

export type Store = ReturnType<typeof store>;

export function store(db: D1Database) {
  const c = (name: string) => new Collection(db, name);
  return {
    raw: db,
    organizations: c("organizations"),
    users: c("users"),
    sellers: c("sellers"),
    marketplace_accounts: c("marketplace_accounts"),
    products: c("products"),
    market_snapshots: c("market_snapshots"),
    customer_questions: c("customer_questions"),
    orders: c("orders"),
    ad_tracking: c("ad_tracking"),
    ad_snapshots: c("ad_snapshots"),
    ad_analyses: c("ad_analyses"),
    oauth_states: c("oauth_states"),
  };
}
