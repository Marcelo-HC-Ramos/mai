// Agente MAI: executa a varredura de mercado de um produto (UC02) e grava o snapshot.
import { classifyReviews, executiveSummary } from "./ai/tasks";
import type { Llm } from "./ai";
import { deviceInsights } from "./analysis/devices";
import { filterByModes, logisticsInsights } from "./analysis/logistics";
import { keywordInsights } from "./analysis/keywords";
import { competitorStats, recommendPrice } from "./analysis/pricing";
import { buildRecommendations } from "./analysis/recommendations";
import { reviewInsights } from "./analysis/reviews";
import type { CompetitorListing, MarketplaceConnector, Review } from "./connectors/base";
import { asFeeFn, CostCalculator, type CostInputs } from "./costs";
import type { Doc, Store } from "./db";
import type { Settings } from "./env";
import { mostCommon } from "./lib/num";

async function safe<T>(fn: () => Promise<T>, dflt: T): Promise<T> {
  try { return await fn(); } catch (e) {
    // um bloco indisponível não derruba a varredura (UC02 fluxo 4a)
    console.warn("fonte indisponível:", String(e));
    return dflt;
  }
}

export interface AgentOptions {
  ownSellerIds?: Set<string>;
  reviewItems?: number;
  account?: Doc | null;
  llm?: Llm | null;
  minMarginPct?: number | null;
}

export class MarketAgent {
  readonly ownSellerIds: Set<string>;
  readonly reviewItems: number;
  readonly account: Doc | null;
  readonly llm: Llm | null;
  readonly minMarginPct: number;

  constructor(readonly db: Store, readonly cfg: Settings, readonly connector: MarketplaceConnector, opts: AgentOptions = {}) {
    this.ownSellerIds = opts.ownSellerIds || new Set();
    this.reviewItems = opts.reviewItems ?? 5;
    this.account = opts.account || null;
    this.llm = opts.llm || null;
    this.minMarginPct = opts.minMarginPct ?? cfg.minMarginPct;
  }

  /** `shippingModes` limita a concorrência a modalidades de envio (ex.: ["full"] para comparar só com o Full). */
  async analyzeProduct(product: Doc, shippingModes?: string[] | null): Promise<Record<string, any>> {
    const listings: any[] = product.listings?.length ? product.listings : [{}];
    const accountId = this.account?._id;
    const listing = listings.find((l) => accountId && l.account_id === accountId)
      || listings.find((l) => l.marketplace === this.connector.name) || listings[0];
    const myItem: string | undefined = listing.external_item_id;
    const currentPrice: number | undefined = listing.current_price;
    const started = new Date();

    // 1. Coleta de concorrentes (EAN primeiro, título como alternativa: UC02 fluxo 3a)
    let query: string = product.ean || product.title;
    let competitors = await this.competitors(query);
    if (competitors.length < 3 && query !== product.title) {
      query = product.title;
      competitors = await this.competitors(query);
    }
    const category = product.category_id || listing.category_id || mostCommon(competitors.map((c) => c.category_id)) || null;

    // 2. Full x Flex: retrato de todo o mercado e, se pedido, filtro das modalidades a comparar
    const logi = logisticsInsights(competitors, listing.shipping_mode);
    logi.filter = [...(shippingModes || [])];
    const allCompetitors = competitors;
    competitors = filterByModes(competitors, shippingModes);

    // 3. UC06 preços dos concorrentes
    const comp = competitorStats(competitors, currentPrice);

    // 4. UC10 melhor preço, com o custo completo da loja (calculadora UC14)
    const seller = (await this.db.sellers.get(product.seller_id)) || ({} as any);
    const profile = { ...(seller.cost_profile || {}),
      ...(listing.listing_type ? { listing_type: listing.listing_type } : {}),
      ...(["full", "flex", "coleta", "proprio"].includes(listing.shipping_mode) ? { shipping_mode: listing.shipping_mode } : {}) };
    const calc = new CostCalculator(profile, (p, lt) => this.connector.getFees(p, category, lt),
      (p, w, d, lt) => this.connector.getShippingCost(p, w, d, lt));
    const inputs: CostInputs = { cost_price: product.cost_price || 0, weight_g: product.weight_g, dimensions_cm: product.dimensions_cm,
      packaging_cost: product.packaging_cost };
    await calc.prepare(inputs, comp.median_price || currentPrice || 100, [calc.profile.listing_type]);
    const price = recommendPrice(comp, product.cost_price, product.min_selling_price, asFeeFn(calc, inputs), this.minMarginPct, currentPrice);
    if (product.cost_price && price.recommended_price) price.cost_breakdown = calc.calculate(price.recommended_price, inputs);

    // 5. UC07 palavras-chave e UC08 celular x computador (em paralelo com as avaliações)
    const top = [...allCompetitors].sort((a, b) => b.sold_quantity - a.sold_quantity).slice(0, this.reviewItems);
    const [trends, platformDev, sellerDev, marketReviews, ownReviews] = await Promise.all([
      safe(() => this.connector.getSearchTrends(category), [] as string[]),
      safe(() => this.connector.getDeviceBreakdown(query, category), null),
      this.sellerDevices(product),
      Promise.all(top.map((c) => safe(() => this.connector.getReviews(c.item_id), [] as Review[]))).then((x) => x.flat()),
      myItem ? safe(() => this.connector.getReviews(myItem), [] as Review[]) : Promise.resolve(null),
    ]);
    const kw = keywordInsights(product.title, allCompetitors, trends, product.keyword_volumes);
    const dev = deviceInsights(category, platformDev, sellerDev);

    // 6. UC09 avaliações ruins (concorrentes mais vendidos + anúncio do vendedor)
    const groups: Record<string, Review[]> = { mercado: marketReviews };
    if (ownReviews) groups.vendedor = ownReviews;
    const rev = await reviewInsights(groups, this.llm ? (texts) => classifyReviews(this.llm, texts) : null);

    const recs = buildRecommendations(product, comp, price, kw, dev, rev, logi);
    const summary = await safe(() => executiveSummary(this.llm, product, comp, price, kw, dev, rev), null);
    const snapshot = {
      product_id: product._id,
      org_id: product.org_id,
      seller_id: product.seller_id,
      account_id: accountId ?? null,
      account_nickname: this.account?.nickname ?? null,
      marketplace: this.connector.name,
      ean: product.ean ?? null,
      query,
      category_id: category,
      captured_at: started.toISOString(),
      duration_ms: Date.now() - started.getTime(),
      status: "OK",
      competitor_data: comp,
      logistics: logi,
      pricing: price,
      recommended_price: price.recommended_price ?? null,
      search_intelligence: { keywords: kw, traffic_breakdown: dev },
      review_insights: rev,
      ai_recommendations: recs,
      ai_summary: summary,
    };
    return this.db.market_snapshots.insert(snapshot);
  }

  private async competitors(query: string): Promise<CompetitorListing[]> {
    const found = await this.connector.searchCompetitors(query, 50);
    return found.filter((c) => !this.ownSellerIds.has(c.seller_id));
  }

  private async sellerDevices(product: Doc): Promise<Record<string, number> | null> {
    if (product.traffic_devices) return product.traffic_devices; // relatório de tráfego importado pelo vendedor
    const { results } = await this.db.raw.prepare(
      "SELECT buyer_device AS d, count(*) AS n FROM orders WHERE seller_id = ? AND buyer_device IN ('mobile','desktop') GROUP BY buyer_device",
    ).bind(product.seller_id).all<{ d: string; n: number }>();
    return results.length ? Object.fromEntries(results.map((r) => [r.d, r.n])) : null;
  }
}

export function latestSnapshot(db: Store, productId: string): Promise<Doc | null> {
  return db.market_snapshots.findOne({ product_id: productId }, "captured_at DESC");
}
