// Conector de demonstração: um mercado sintético e determinístico, sem internet. Todos os dados são fictícios.
import { tokens } from "../lib/text";
import { Rng, hashInt } from "../lib/rng";
import { addDays, DAY, startOfDayUTC } from "../lib/time";
import { round } from "../lib/num";
import { mlFixedFee } from "../costs";
import {
  competitor, itemDetails, MarketplaceConnector, type CompetitorListing, type FeeQuote, type ItemDetails, type Order,
  type Question, type Review, type SellerListing,
} from "./base";

export interface CatalogItem {
  sku: string; ean: string; title: string; price: number; cost: number; min: number; stock: number; category: string;
  pool: string[]; trends: string[];
}

export const CATALOG: CatalogItem[] = [
  { sku: "MEC-RGB-WL", ean: "7898956789123", title: "Teclado Mecânico Sem Fio Switch Blue RGB", price: 249.90, cost: 120.00,
    min: 180.00, stock: 42, category: "MLB1714",
    pool: ["teclado mecanico", "sem fio", "bluetooth", "gamer", "rgb", "switch blue", "switch azul", "abnt2", "wireless", "60%",
      "hot swap", "redragon", "usb-c", "led"],
    trends: ["teclado mecanico", "teclado gamer", "teclado sem fio", "teclado bluetooth", "mouse gamer", "teclado mecanico sem fio",
      "headset gamer", "teclado redragon"] },
  { sku: "FONE-BT-ANC", ean: "7891234500011", title: "Fone de Ouvido Bluetooth com Cancelamento de Ruído", price: 189.90,
    cost: 85.00, min: 140.00, stock: 8, category: "MLB1676",
    pool: ["fone de ouvido", "bluetooth", "cancelamento de ruido", "anc", "sem fio", "tws", "microfone", "a prova d agua",
      "esportivo", "bateria longa"],
    trends: ["fone bluetooth", "fone de ouvido sem fio", "fone jbl", "airpods", "fone com cancelamento de ruido", "fone gamer"] },
  { sku: "SW-FIT-02", ean: "7891234500028", title: "Smartwatch Relógio Inteligente Monitor Cardíaco", price: 159.90, cost: 70.00,
    min: 120.00, stock: 0, category: "MLB135384",
    pool: ["smartwatch", "relogio inteligente", "monitor cardiaco", "a prova d agua", "notificacoes", "android ios", "pulseira",
      "oximetro", "gps"],
    trends: ["smartwatch", "relogio smartwatch", "smartwatch feminino", "relogio inteligente", "smartband"] },
  { sku: "CAD-GAM-PRO", ean: "7891234500035", title: "Cadeira Gamer Reclinável com Apoio Lombar", price: 899.90, cost: 480.00,
    min: 650.00, stock: 15, category: "MLB254183",
    pool: ["cadeira gamer", "reclinavel", "apoio lombar", "ergonomica", "escritorio", "giratoria", "almofada", "suporta 150kg",
      "couro sintetico"],
    trends: ["cadeira gamer", "cadeira escritorio", "cadeira ergonomica", "cadeira", "mesa gamer"] },
  { sku: "GAR-TERM-1L", ean: "7891234500042", title: "Garrafa Térmica Inox 1 Litro Parede Dupla", price: 79.90, cost: 28.00,
    min: 55.00, stock: 120, category: "MLB1580",
    pool: ["garrafa termica", "inox", "1 litro", "parede dupla", "agua gelada", "academia", "squeeze", "24 horas", "tampa"],
    trends: ["garrafa termica", "garrafa stanley", "copo termico", "garrafa de agua", "squeeze"] },
];

const REVIEW_TEXTS: Record<number, string[]> = {
  5: ["Excelente produto, chegou antes do prazo.", "Muito bom, recomendo!", "Ótima qualidade pelo preço."],
  4: ["Bom produto, atende bem.", "Gostei, só a embalagem que podia ser melhor."],
  3: ["Produto ok, mas a bateria dura menos do que o anúncio diz.", "Razoável, a qualidade do material é fraca.",
    "Chegou com atraso de uma semana, mas funciona."],
  2: ["Parou de funcionar depois de um mês de uso.", "Veio diferente da foto, a cor não é a mesma do anúncio.",
    "Material frágil, quebrou fácil.", "A entrega atrasou muito e ninguém respondeu.",
    "Não conecta no meu celular, problema de compatibilidade com bluetooth."],
  1: ["Veio com defeito, não liga.", "Produto chegou quebrado, caixa toda amassada.", "Faltou peça, veio sem o cabo.",
    "Péssimo, estragou em duas semanas.", "Vendedor não responde, quero devolver e não consigo."],
};

const QUESTIONS = ["Tem garantia?", "Qual o prazo de entrega para São Paulo?", "Funciona com iPhone?", "Ainda tem em estoque?",
  "Qual a voltagem?", "Vem com nota fiscal?", "Qual o tamanho exato?", "Aceita troca se não servir?",
  "Faz desconto para duas unidades?", "É compatível com PS5?"];

function match(query: string): CatalogItem {
  const q = new Set(tokens(query));
  let best = CATALOG[0], score = [-1, 0];
  for (const p of CATALOG) {
    const s = [tokens(p.title).filter((t) => q.has(t)).length, query.includes(p.ean) ? 1 : 0];
    if (s[0] > score[0] || (s[0] === score[0] && s[1] > score[1])) { best = p; score = s; }
  }
  return best;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** `accountKey` identifica a conta fictícia: cada chave gera catálogo, preços, pedidos e perguntas próprios. */
export class DemoConnector extends MarketplaceConnector {
  readonly name = "DEMO";
  readonly detailBudget = 10;
  readonly now: Date;
  readonly sellerId: string;
  readonly catalog: CatalogItem[];

  constructor(opts: { accountKey?: string; now?: Date } = {}) {
    super();
    this.now = opts.now || new Date();
    this.sellerId = opts.accountKey || "DEMO-1";
    const rng = new Rng("catalog", this.sellerId);
    if (this.sellerId.endsWith("-1")) this.catalog = CATALOG.map((p) => ({ ...p }));
    else {
      this.catalog = rng.sample(CATALOG, 3).map((p) => ({ ...p }));
      for (const p of this.catalog) {
        p.price = Math.floor(p.price * rng.uniform(0.93, 1.05)) + 0.9;
        p.stock = rng.randint(0, 60);
      }
    }
  }

  private itemId(p: CatalogItem) { return `MLB-${this.sellerId}-${p.sku}`; }
  private get first() { return this.sellerId.endsWith("-1"); }

  async searchCompetitors(query: string, limit = 50): Promise<CompetitorListing[]> {
    return this.market(match(query), limit);
  }

  private market(p: CatalogItem, limit = 50): CompetitorListing[] {
    const rng = new Rng("market", p.sku);
    const out: CompetitorListing[] = [];
    for (let i = 0; i < Math.min(limit, 32); i++) {
      const words = rng.sample(p.pool, Math.min(4, p.pool.length));
      let price = round(rng.gauss(p.price * 1.04, p.price * 0.12), 2);
      if (i === 7 || i === 21) price = round(p.price * (i === 7 ? 0.25 : 2.6), 2); // kits, peças, erros de cadastro
      const sold = Math.floor(rng.paretovariate(1.2) * 20);
      // quem vende mais tende a estar no Full (como no mercado real)
      const mode = rng.choices(["full", "flex", "coleta", "proprio"], sold > 60 ? [60, 15, 20, 5] : [25, 20, 45, 10]);
      const sellerN = rng.randint(1, 9999);
      const reputation = rng.choice(["platinum", "gold", "silver", ""]);
      const freeRoll = rng.random();
      const lt = rng.choice(["gold_pro", "gold_pro", "gold_special"]);
      const official = rng.random() < 0.12;
      out.push(competitor({
        item_id: `MLB${9000000 + i}${p.sku.slice(0, 3)}`, title: `${titleCase(words[0])} ` + words.slice(1).join(" "),
        price: Math.max(price, 1.0), seller_id: `S${sellerN}`, seller_nickname: `LOJA_${sellerN}`, seller_reputation: reputation,
        sold_quantity: sold, free_shipping: price >= 79 || freeRoll < 0.3, category_id: p.category,
        url: `https://produto.mercadolivre.com.br/demo-${i}`, position: i + 1, shipping_mode: mode, listing_type: lt,
        official_store: official,
      }));
    }
    return out;
  }

  async getItemDetails(itemId: string): Promise<ItemDetails> {
    let listing: CompetitorListing | null = null;
    for (const p of CATALOG) {
      if (itemId.endsWith(p.sku.slice(0, 3)) || itemId.endsWith(p.sku)) {
        listing = this.market(p).find((c) => c.item_id === itemId) || null;
        if (!listing && itemId.endsWith(p.sku)) { // anúncio da própria loja
          listing = competitor({ item_id: itemId, title: p.title, price: p.price, sold_quantity: 180, category_id: p.category,
            shipping_mode: "coleta", listing_type: "gold_pro", seller_nickname: "SUA_LOJA", free_shipping: p.price >= 79 });
        }
        break;
      }
    }
    const rng = new Rng("details", itemId);
    if (!listing) {
      const p = CATALOG[hashInt(itemId) % CATALOG.length];
      listing = { ...this.market(p)[rng.randint(0, 20)], item_id: itemId };
    }
    const ageDays = rng.randint(45, 900);
    const monthly = Math.max(1, (listing.sold_quantity * 30) / ageDays);
    const totalAttrs = 35;
    return itemDetails({
      item_id: listing.item_id, title: listing.title, price: listing.price, sold_quantity: listing.sold_quantity,
      date_created: new Date(this.now.getTime() - ageDays * DAY).toISOString(), category_id: listing.category_id, url: listing.url,
      seller_id: listing.seller_id, seller_nickname: listing.seller_nickname || "LOJA_DEMO", seller_reputation: listing.seller_reputation,
      official_store: listing.official_store, listing_type: listing.listing_type || "gold_pro", shipping_mode: listing.shipping_mode,
      free_shipping: listing.free_shipping, available_quantity: rng.randint(0, 400), pictures: rng.randint(2, 12),
      has_video: rng.random() < 0.35, attributes_filled: rng.randint(12, totalAttrs), attributes_total: totalAttrs,
      description_length: rng.choice([0, 180, 650, 1400, 2600]), catalog_listing: rng.random() < 0.3,
      visits_30d: Math.floor(monthly / rng.uniform(0.015, 0.06)), rating_average: round(rng.uniform(3.6, 4.9), 1),
      reviews_total: Math.floor(listing.sold_quantity * rng.uniform(0.1, 0.3)),
      attributes: { Marca: rng.choice(["Genérica", "Redragon", "JBL", "Xiaomi"]), Modelo: `X${rng.randint(10, 99)}` },
    });
  }

  async getSearchSuggestions(query: string): Promise<string[]> {
    const p = match(query);
    const base = tokens(p.title).slice(0, 2).join(" ");
    const baseSet = new Set(base.split(" "));
    const extra = p.pool.filter((t) => !tokens(t).every((w) => baseSet.has(w))).slice(0, 7);
    return [base, ...extra.map((t) => `${base} ${t}`), ...p.trends.slice(0, 2)];
  }

  async getReviews(itemId: string, limit = 50): Promise<Review[]> {
    const rng = new Rng("reviews", itemId);
    const out: Review[] = [];
    const n = Math.min(limit, rng.randint(15, 40));
    for (let i = 0; i < n; i++) {
      const rate = rng.choices([5, 4, 3, 2, 1], [55, 18, 10, 9, 8]);
      out.push({ item_id: itemId, rate, content: rng.choice(REVIEW_TEXTS[rate]),
        date_created: new Date(this.now.getTime() - rng.randint(1, 180) * DAY).toISOString() });
    }
    return out;
  }

  async getSearchTrends(categoryId: string | null): Promise<string[]> {
    return CATALOG.find((c) => c.category === categoryId)?.trends || [];
  }

  async getFees(price: number, _categoryId: string | null, listingType = "gold_special"): Promise<FeeQuote> {
    // Aproximação das tarifas do Mercado Livre: Clássico ~11,5%, Premium ~16,5%, mais tarifa fixa abaixo de R$ 79.
    const pct = listingType === "gold_pro" ? 0.165 : 0.115;
    return { commission: round(price * pct, 2), fixed_fee: mlFixedFee(price), source: "estimativa" };
  }

  async getSellerListings(): Promise<SellerListing[]> {
    return this.catalog.map((p) => ({
      external_item_id: this.itemId(p), title: p.title, price: p.price, stock_quantity: p.stock, status: "active", sku: p.sku,
      ean: p.ean, category_id: p.category, url: `https://produto.mercadolivre.com.br/demo-${p.sku}`, sold_quantity: 0,
      shipping_mode: this.first ? "coleta" : "full", listing_type: this.first ? "gold_pro" : "gold_special",
    }));
  }

  async getOrders(since: Date): Promise<Order[]> {
    const rng = new Rng("orders", this.sellerId);
    const out: Order[] = [];
    let day = addDays(startOfDayUTC(this.now), -120);
    let n = 0;
    const scale = this.first ? 1.0 : 0.4;
    while (day <= this.now) {
      const count = Math.floor((rng.randint(2, 9) + ([1, 2].includes(day.getUTCDay()) ? 3 : 0)) * scale);
      for (let k = 0; k < count; k++) {
        const p = this.catalog.length < 5 ? rng.choice(this.catalog) : rng.choices(this.catalog, [30, 25, 20, 5, 20]);
        const qty = rng.choices([1, 2, 3], [85, 12, 3]);
        const total = round(p.price * qty, 2);
        const created = new Date(day.getTime() + rng.randint(0, 1439) * 60_000);
        const status = rng.choices(["paid", "cancelled"], [95, 5]);
        const ship = round(rng.uniform(0, 25), 2);
        if (created > this.now || created < since) continue;
        n++;
        out.push({
          external_order_id: `${this.sellerId}-${String(n).padStart(6, "0")}`, created_at: created.toISOString(), status,
          total_amount: total, items: [{ external_item_id: this.itemId(p), title: p.title, quantity: qty, unit_price: p.price }],
          marketplace_fee: round(total * 0.165, 2), shipping_cost: total >= 79 ? ship : 0,
        });
      }
      day = addDays(day, 1);
    }
    return out;
  }

  async getQuestions(since?: Date | null): Promise<Question[]> {
    const rng = new Rng("questions", this.sellerId);
    const out: Question[] = [];
    for (let i = 0; i < (this.first ? 40 : 12); i++) {
      const p = rng.choice(this.catalog);
      const received = new Date(this.now.getTime() - rng.randint(1, 24 * 45) * 3_600_000);
      const answered = rng.random() < 0.8 && received.getTime() < this.now.getTime() - 3 * 3_600_000;
      const text = rng.choice(QUESTIONS);
      const buyer = rng.randint(1, 999);
      const delay = rng.randint(5, 600);
      out.push({
        external_question_id: `${this.sellerId}-Q${String(i).padStart(4, "0")}`, external_item_id: this.itemId(p), text,
        received_at: received.toISOString(), buyer_nickname: `comprador${buyer}`, status: answered ? "ANSWERED" : "UNANSWERED",
        answer_text: answered ? "Olá! Sim, temos. Obrigado pelo contato." : null,
        answered_at: answered ? new Date(received.getTime() + delay * 60_000).toISOString() : null,
      });
    }
    return out.filter((q) => !since || new Date(q.received_at) >= since);
  }

  async answerQuestion(): Promise<void> {}
}
