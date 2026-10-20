// Conector do Mercado Livre (API oficial, https://developers.mercadolivre.com.br).
//
// Endpoints usados:
//   busca de itens ........ GET  /sites/{site}/search?q=
//   avaliações ............ GET  /reviews/item/{item_id}
//   tendências de busca ... GET  /trends/{site}/{category_id}
//   tarifas ............... GET  /sites/{site}/listing_prices?price=
//   anúncios do vendedor .. GET  /users/{id}/items/search  +  GET /items?ids=
//   pedidos ............... GET  /orders/search?seller={id}
//   perguntas ............. GET  /questions/search?seller_id={id}  |  POST /answers
//   OAuth 2.0 ............. https://auth.mercadolivre.com.br/authorization  |  POST /oauth/token
//   frete grátis .......... GET  /users/{id}/shipping_options/free?dimensions=AxLxC,peso
//   raio-x do anúncio ..... GET  /items/{id}  +  /items/{id}/description  +  /users/{seller}  +  /items/visits
//   sugestões de busca .... GET  https://http2.mlstatic.com/resources/sites/{site}/autosuggest (não oficial)
//
// Full x Flex: vem de `shipping.logistic_type` ("fulfillment" = Full, "self_service" = Flex) e da tag
// "self_service_in" (anúncio com Flex ativo). Veja `shippingMode` em base.ts.
//
// O plano grátis da Cloudflare permite 50 requisições externas por chamada; o conector conta as suas e para antes.
import type { Settings } from "../env";
import {
  competitor, itemDetails, MarketplaceConnector, shippingMode, type CompetitorListing, type FeeQuote, type ItemDetails,
  type Order, type Question, type Review, type SellerListing,
} from "./base";

export const API = "https://api.mercadolibre.com";
const AUTH_URL = "https://auth.mercadolivre.com.br/authorization";

const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);

export class MarketplaceError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

export function authorizationUrl(cfg: Settings, state: string): string {
  const q = new URLSearchParams({ response_type: "code", client_id: cfg.mlClientId, redirect_uri: cfg.mlRedirectUri, state });
  return `${AUTH_URL}?${q}`;
}

/** Troca o authorization_code por tokens (UC01 passo 5). */
export async function exchangeCode(cfg: Settings, code: string): Promise<Record<string, any>> {
  const resp = await fetch(`${API}/oauth/token`, {
    method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: cfg.mlClientId, client_secret: cfg.mlClientSecret,
      code, redirect_uri: cfg.mlRedirectUri }),
  });
  if (!resp.ok) throw new MarketplaceError(`Mercado Livre recusou a autorização (${resp.status})`, resp.status);
  return resp.json(); // access_token, refresh_token, expires_in, user_id
}

export interface MlOptions {
  cfg: Settings;
  accessToken?: string | null;
  refreshToken?: string | null;
  userId?: string | null;
  siteId?: string | null;
  onTokenRefresh?: (data: Record<string, any>) => Promise<void>;
  maxRequests?: number;
}

export class MercadoLivreConnector extends MarketplaceConnector {
  readonly name = "MERCADO_LIVRE";
  readonly detailBudget = 8;
  accessToken: string | null;
  refreshToken: string | null;
  userId: string | null;
  readonly siteId: string;
  requests = 0;
  readonly maxRequests: number;

  constructor(private opts: MlOptions) {
    super();
    this.accessToken = opts.accessToken || null;
    this.refreshToken = opts.refreshToken || null;
    this.userId = opts.userId || null;
    this.siteId = opts.siteId || opts.cfg.mlSiteId;
    this.maxRequests = opts.maxRequests ?? 42;
  }

  /** Quantas requisições ainda cabem nesta chamada. */
  get remaining() { return this.maxRequests - this.requests; }

  private async request(method: string, url: string, body?: any, auth = true): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.requests >= this.maxRequests) throw new MarketplaceError("Limite de consultas ao Mercado Livre nesta etapa");
      this.requests++;
      const headers: Record<string, string> = { accept: "application/json" };
      if (auth && this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      let resp: Response;
      try {
        resp = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      } catch (e) {
        if (attempt === 2) throw e;
        continue;
      }
      if (resp.status === 401 && attempt === 0 && auth && await this.refreshAccessToken()) continue;
      if ((resp.status === 429 || resp.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      if (!resp.ok) throw new MarketplaceError(`Mercado Livre respondeu ${resp.status} em ${new URL(url).pathname}`, resp.status);
      const text = await resp.text();
      return text ? JSON.parse(text) : null;
    }
    throw new MarketplaceError(`${this.name}: limite de tentativas excedido em ${url}`);
  }

  private get(path: string, params: Record<string, any> = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
    const qs = q.toString();
    return this.request("GET", `${API}${path}${qs ? "?" + qs : ""}`);
  }

  async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) return false;
    this.requests++;
    const resp = await fetch(`${API}/oauth/token`, {
      method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.opts.cfg.mlClientId,
        client_secret: this.opts.cfg.mlClientSecret, refresh_token: this.refreshToken }),
    });
    if (resp.status !== 200) return false;
    const data: any = await resp.json();
    this.accessToken = data.access_token;
    this.refreshToken = data.refresh_token || this.refreshToken;
    if (this.opts.onTokenRefresh) await this.opts.onTokenRefresh(data);
    return true;
  }

  private async me(): Promise<string> {
    if (!this.userId) this.userId = String((await this.get("/users/me")).id);
    return this.userId;
  }

  // -- Inteligência de mercado -------------------------------------------------------------------------
  async searchCompetitors(query: string, limit = 50): Promise<CompetitorListing[]> {
    const out: CompetitorListing[] = [];
    let offset = 0;
    while (out.length < limit) {
      const page = await this.get(`/sites/${this.siteId}/search`, { q: query, limit: Math.min(50, limit - out.length), offset });
      const results: any[] = page?.results || [];
      if (!results.length) break;
      for (const r of results) {
        const shipping = r.shipping || {}, seller = r.seller || {};
        out.push(competitor({
          item_id: r.id, title: r.title || "", price: Number(r.price || 0), seller_id: String(seller.id ?? ""),
          seller_reputation: seller.seller_reputation?.power_seller_status || "", sold_quantity: Number(r.sold_quantity || 0),
          free_shipping: !!shipping.free_shipping, category_id: r.category_id || "", url: r.permalink || "",
          position: out.length + 1, shipping_mode: shippingMode(shipping.logistic_type, shipping.tags),
          listing_type: r.listing_type_id || "", official_store: !!r.official_store_id, seller_nickname: seller.nickname || "",
        }));
      }
      offset += results.length;
    }
    return out;
  }

  async getReviews(itemId: string, limit = 50): Promise<Review[]> {
    const out: Review[] = [];
    let offset = 0;
    while (out.length < limit) {
      const page = await this.get(`/reviews/item/${itemId}`, { limit: Math.min(50, limit - out.length), offset });
      const reviews: any[] = page?.reviews || [];
      if (!reviews.length) break;
      out.push(...reviews.map((r) => ({ item_id: itemId, rate: Number(r.rate || 0), title: r.title || "", content: r.content || "",
        date_created: iso(r.date_created) })));
      offset += reviews.length;
    }
    return out;
  }

  async getSearchTrends(categoryId: string | null): Promise<string[]> {
    const path = categoryId ? `/trends/${this.siteId}/${categoryId}` : `/trends/${this.siteId}`;
    return ((await this.get(path)) || []).map((t: any) => t.keyword);
  }

  async getFees(price: number, categoryId: string | null, listingType = "gold_special"): Promise<FeeQuote> {
    let data = await this.get(`/sites/${this.siteId}/listing_prices`, { price, listing_type_id: listingType, category_id: categoryId || undefined });
    if (Array.isArray(data)) data = data[0];
    const fixed = Number(data?.sale_fee_details?.fixed_fee || 0);
    return { commission: Number(data?.sale_fee_amount || 0) - fixed, fixed_fee: fixed, source: "api" };
  }

  async getShippingCost(price: number, weightG: number, dims: string | null, listingType = "gold_special"): Promise<number | null> {
    const data = await this.get(`/users/${await this.me()}/shipping_options/free`, {
      dimensions: `${dims || "20x15x10"},${Math.trunc(weightG)}`, item_price: price, listing_type_id: listingType,
      mode: "me2", condition: "new", verbose: "true" });
    const cost = data?.coverage?.all_country?.list_cost;
    return cost !== undefined && cost !== null ? Number(cost) : null;
  }

  private static basic(it: any, extra: Partial<ItemDetails> = {}): ItemDetails {
    const shipping = it.shipping || {};
    const attrs: any[] = it.attributes || [];
    const filled = attrs.filter((a) => ![null, undefined, "", "-1"].includes(a.value_name));
    return itemDetails({
      item_id: it.id, title: it.title || "", price: Number(it.price || 0), sold_quantity: Number(it.sold_quantity || 0),
      date_created: iso(it.date_created), category_id: it.category_id || "", url: it.permalink || "",
      seller_id: String(it.seller_id ?? ""), official_store: !!it.official_store_id, listing_type: it.listing_type_id || "",
      shipping_mode: shippingMode(shipping.logistic_type, shipping.tags), free_shipping: !!shipping.free_shipping,
      available_quantity: it.available_quantity ?? null, pictures: (it.pictures || []).length, has_video: !!it.video_id,
      attributes_filled: filled.length, attributes_total: attrs.length, catalog_listing: !!it.catalog_listing,
      attributes: Object.fromEntries(filled.map((a) => [a.name, a.value_name])), ...extra,
    });
  }

  async getItemDetails(itemId: string): Promise<ItemDetails> {
    const it = await this.get(`/items/${itemId}`, { include_attributes: "all" });
    const safe = async <T>(fn: () => Promise<T>, dflt: T): Promise<T> => { try { return await fn(); } catch { return dflt; } };
    const today = new Date(), from = new Date(today.getTime() - 30 * 86_400_000);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const [seller, desc, visits, rv] = await Promise.all([
      safe(() => this.get(`/users/${it.seller_id}`), {} as any),
      safe(() => this.get(`/items/${itemId}/description`), {} as any),
      safe(() => this.get("/items/visits", { ids: itemId, date_from: day(from), date_to: day(today) }), null as any),
      safe(() => this.get(`/reviews/item/${itemId}`, { limit: 1 }), {} as any),
    ]);
    const v = Array.isArray(visits) ? visits[0] : visits;
    return MercadoLivreConnector.basic(it, {
      seller_nickname: seller?.nickname || "", seller_reputation: seller?.seller_reputation?.power_seller_status || "",
      description_length: (desc?.plain_text || "").length,
      visits_30d: v ? Number(v.total_visits || 0) : null,
      rating_average: rv?.rating_average ?? null, reviews_total: rv?.paging?.total ?? null,
    });
  }

  /** Até 20 anúncios por requisição (GET /items?ids=), só os campos básicos. */
  async getItemsBasic(ids: string[]): Promise<ItemDetails[]> {
    const out: ItemDetails[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const entries: any[] = (await this.get("/items", { ids: ids.slice(i, i + 20).join(",") })) || [];
      for (const e of entries) if (e?.code === 200 && e.body) out.push(MercadoLivreConnector.basic(e.body));
    }
    return out;
  }

  async getSearchSuggestions(query: string): Promise<string[]> {
    const q = new URLSearchParams({ q: query, limit: "10", api_version: "2" });
    const data = await this.request("GET", `https://http2.mlstatic.com/resources/sites/${this.siteId}/autosuggest?${q}`, undefined, false);
    return (data?.suggested_queries || []).map((s: any) => s.q);
  }

  // -- Operação do vendedor ----------------------------------------------------------------------------
  async getSellerListings(maxItems = 600): Promise<SellerListing[]> {
    const ids: string[] = [];
    let offset = 0;
    const me = await this.me();
    while (ids.length < maxItems) {
      const page = await this.get(`/users/${me}/items/search`, { limit: 100, offset });
      ids.push(...(page?.results || []));
      offset += 100;
      if (offset >= (page?.paging?.total || 0)) break;
    }
    const out: SellerListing[] = [];
    for (let i = 0; i < ids.length && this.remaining > 4; i += 20) {
      for (const entry of (await this.get("/items", { ids: ids.slice(i, i + 20).join(",") })) || []) {
        const b = entry?.body;
        if (!b?.id) continue;
        const attrs: Record<string, any> = Object.fromEntries((b.attributes || []).map((a: any) => [a.id, a.value_name]));
        out.push({
          external_item_id: b.id, title: b.title || "", price: Number(b.price || 0), stock_quantity: Number(b.available_quantity || 0),
          status: b.status || "", sku: attrs.SELLER_SKU || b.seller_custom_field || b.id, ean: attrs.GTIN || "",
          category_id: b.category_id || "", url: b.permalink || "", sold_quantity: Number(b.sold_quantity || 0),
          shipping_mode: shippingMode(b.shipping?.logistic_type, b.shipping?.tags), listing_type: b.listing_type_id || "",
        });
      }
    }
    return out;
  }

  async getOrders(since: Date, maxPages = 10): Promise<Order[]> {
    const out: Order[] = [];
    let offset = 0;
    const me = await this.me();
    for (let page = 0; page < maxPages; page++) {
      const data = await this.get("/orders/search", { seller: me, sort: "date_desc", offset, limit: 50,
        "order.date_created.from": since.toISOString().slice(0, 19) + ".000-00:00" });
      for (const o of data?.results || []) {
        const lines: any[] = o.order_items || [];
        out.push({
          external_order_id: String(o.id), created_at: iso(o.date_created)!, status: o.status || "",
          total_amount: Number(o.total_amount || 0),
          items: lines.map((it) => ({ external_item_id: it.item.id, title: it.item.title || "", quantity: Number(it.quantity ?? 1),
            unit_price: Number(it.unit_price || 0) })),
          marketplace_fee: lines.reduce((s, it) => s + Number(it.sale_fee || 0) * Number(it.quantity ?? 1), 0),
          shipping_cost: 0,
        });
      }
      offset += 50;
      if (offset >= (data?.paging?.total || 0) || this.remaining < 4) break;
    }
    return out;
  }

  async getQuestions(since?: Date | null, maxPages = 6): Promise<Question[]> {
    const out: Question[] = [];
    let offset = 0;
    const me = await this.me();
    for (let page = 0; page < maxPages; page++) {
      const data = await this.get("/questions/search", { seller_id: me, api_version: 4, offset, limit: 50,
        sort_fields: "date_created", sort_types: "DESC" });
      for (const q of data?.questions || []) {
        const received = iso(q.date_created)!;
        if (since && new Date(received) < since) return out;
        const answer = q.answer || {};
        out.push({
          external_question_id: String(q.id), external_item_id: q.item_id, text: q.text || "", received_at: received,
          status: q.status === "ANSWERED" ? "ANSWERED" : "UNANSWERED", buyer_nickname: String(q.from?.id ?? ""),
          answer_text: answer.text ?? null, answered_at: iso(answer.date_created),
        });
      }
      offset += 50;
      if (offset >= (data?.total || 0) || this.remaining < 4) break;
    }
    return out;
  }

  async answerQuestion(externalQuestionId: string, text: string): Promise<void> {
    await this.request("POST", `${API}/answers`, { question_id: Number(externalQuestionId), text });
  }
}
