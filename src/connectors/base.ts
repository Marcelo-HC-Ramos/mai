// Contrato comum dos conectores de marketplace. O agente e os painéis só conhecem este contrato.

// Modalidades de envio do Mercado Livre, como o vendedor fala:
//   full    = Mercado Envios Full                       logistic_type "fulfillment"
//   flex    = Mercado Envios Flex                       "self_service" ou tag "self_service_in"
//   coleta  = coleta ou agência                         "cross_docking", "drop_off", "xd_drop_off"
//   proprio = envio por conta do vendedor               "custom", "not_specified", "default"
export const SHIPPING_MODES: Record<string, string> = {
  full: "Full", flex: "Flex", coleta: "Coleta/Agência", proprio: "Envio próprio", desconhecido: "Não informado",
};

export function shippingMode(logisticType?: string | null, tags?: string[] | null): string {
  const lt = (logisticType || "").toLowerCase();
  if (lt === "fulfillment") return "full";
  if (lt === "self_service" || (tags || []).includes("self_service_in")) return "flex";
  if (["cross_docking", "drop_off", "xd_drop_off"].includes(lt)) return "coleta";
  if (["custom", "not_specified", "default"].includes(lt)) return "proprio";
  return "desconhecido";
}

// gold_special = Clássico, gold_pro = Premium
export const LISTING_TYPES: Record<string, string> = { gold_special: "Clássico", gold_pro: "Premium", free: "Grátis" };

export interface CompetitorListing {
  item_id: string;
  title: string;
  price: number;
  seller_id: string;
  seller_reputation: string;
  sold_quantity: number;
  free_shipping: boolean;
  category_id: string;
  url: string;
  position: number;
  shipping_mode: string;
  listing_type: string;
  official_store: boolean;
  seller_nickname: string;
}

export function competitor(p: Partial<CompetitorListing> & { item_id: string; title: string; price: number }): CompetitorListing {
  return { seller_id: "", seller_reputation: "", sold_quantity: 0, free_shipping: false, category_id: "", url: "",
    position: 0, shipping_mode: "desconhecido", listing_type: "", official_store: false, seller_nickname: "", ...p };
}

export interface ItemDetails {
  item_id: string;
  title: string;
  price: number;
  sold_quantity: number;
  date_created: string | null;
  category_id: string;
  url: string;
  seller_id: string;
  seller_nickname: string;
  seller_reputation: string;
  official_store: boolean;
  listing_type: string;
  shipping_mode: string;
  free_shipping: boolean;
  available_quantity: number | null;
  pictures: number;
  has_video: boolean;
  attributes_filled: number;
  attributes_total: number;
  description_length: number;
  catalog_listing: boolean;
  visits_30d: number | null;
  rating_average: number | null;
  reviews_total: number | null;
  attributes: Record<string, any>;
}

export function itemDetails(p: Partial<ItemDetails> & { item_id: string; title: string; price: number; sold_quantity: number }): ItemDetails {
  return { date_created: null, category_id: "", url: "", seller_id: "", seller_nickname: "", seller_reputation: "",
    official_store: false, listing_type: "", shipping_mode: "desconhecido", free_shipping: false, available_quantity: null,
    pictures: 0, has_video: false, attributes_filled: 0, attributes_total: 0, description_length: 0, catalog_listing: false,
    visits_30d: null, rating_average: null, reviews_total: null, attributes: {}, ...p };
}

export interface Review { item_id: string; rate: number; title?: string; content?: string; date_created?: string | null }

export interface SellerListing {
  external_item_id: string; title: string; price: number; stock_quantity: number; status: string; sku: string; ean: string;
  category_id: string; url: string; sold_quantity: number; shipping_mode: string; listing_type: string;
}

export interface Order {
  external_order_id: string; created_at: string; status: string; total_amount: number;
  items: { external_item_id: string; title: string; quantity: number; unit_price: number }[];
  marketplace_fee: number; shipping_cost: number; buyer_device?: string;
}

export interface Question {
  external_question_id: string; external_item_id: string; text: string; received_at: string; status: string;
  buyer_nickname: string; answer_text: string | null; answered_at: string | null;
}

export interface FeeQuote { commission: number; fixed_fee: number; source: string }
export const feeTotal = (f: FeeQuote) => f.commission + f.fixed_fee;

/** Base dos conectores. `name` é o identificador gravado no banco (ex.: MERCADO_LIVRE). */
export abstract class MarketplaceConnector {
  abstract readonly name: string;
  /** Teto de anúncios detalhados por chamada (o plano grátis da Cloudflare limita requisições externas). */
  readonly detailBudget: number = 10;

  abstract searchCompetitors(query: string, limit?: number): Promise<CompetitorListing[]>;
  async getReviews(_itemId: string, _limit = 50): Promise<Review[]> { return []; }
  async getSearchTrends(_categoryId: string | null): Promise<string[]> { return []; }
  async getDeviceBreakdown(_query: string, _categoryId: string | null): Promise<{ mobile: number } | null> { return null; }
  abstract getFees(price: number, categoryId: string | null, listingType: string): Promise<FeeQuote>;
  async getShippingCost(_price: number, _weightG: number, _dims: string | null, _listingType: string): Promise<number | null> { return null; }
  abstract getItemDetails(itemId: string): Promise<ItemDetails>;
  /** Vários anúncios de uma vez (só os campos básicos para estimar vendas). */
  async getItemsBasic(ids: string[]): Promise<ItemDetails[]> {
    const out: ItemDetails[] = [];
    for (const id of ids) { try { out.push(await this.getItemDetails(id)); } catch { /* um anúncio indisponível não para os outros */ } }
    return out;
  }
  async getSearchSuggestions(_query: string): Promise<string[]> { return []; }
  abstract getSellerListings(): Promise<SellerListing[]>;
  abstract getOrders(since: Date): Promise<Order[]>;
  abstract getQuestions(since?: Date | null): Promise<Question[]>;
  abstract answerQuestion(externalQuestionId: string, text: string): Promise<void>;
}
