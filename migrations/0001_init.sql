-- MAI na Cloudflare D1. Cada tabela guarda o documento completo em `data` (JSON) e repete em colunas os campos
-- usados em filtros, ordenação e unicidade. Todo dado de negócio carrega org_id (multiempresa).
CREATE TABLE organizations (id TEXT PRIMARY KEY, document TEXT, data TEXT NOT NULL);
CREATE UNIQUE INDEX organizations_document ON organizations(document) WHERE document IS NOT NULL;

CREATE TABLE users (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL, active INTEGER, data TEXT NOT NULL);
CREATE UNIQUE INDEX users_email ON users(email);
CREATE INDEX users_org ON users(org_id);

CREATE TABLE sellers (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT, data TEXT NOT NULL);
CREATE INDEX sellers_org ON sellers(org_id);

CREATE TABLE marketplace_accounts (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, seller_id TEXT, marketplace TEXT NOT NULL,
  external_id TEXT NOT NULL, status TEXT, connected_at TEXT, last_sync_at TEXT, data TEXT NOT NULL);
CREATE UNIQUE INDEX accounts_external ON marketplace_accounts(marketplace, external_id);
CREATE INDEX accounts_seller ON marketplace_accounts(org_id, seller_id);

CREATE TABLE products (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, seller_id TEXT NOT NULL, internal_sku TEXT NOT NULL,
  title TEXT, data TEXT NOT NULL);
CREATE UNIQUE INDEX products_sku ON products(seller_id, internal_sku);
CREATE INDEX products_org ON products(org_id);

CREATE TABLE market_snapshots (id TEXT PRIMARY KEY, org_id TEXT, seller_id TEXT, product_id TEXT NOT NULL,
  captured_at TEXT NOT NULL, recommended_price REAL, data TEXT NOT NULL);
CREATE INDEX snapshots_product ON market_snapshots(product_id, captured_at);

CREATE TABLE customer_questions (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, seller_id TEXT, account_id TEXT NOT NULL,
  product_id TEXT, external_question_id TEXT NOT NULL, status TEXT, topic TEXT, received_at TEXT, data TEXT NOT NULL);
CREATE UNIQUE INDEX questions_external ON customer_questions(account_id, external_question_id);
CREATE INDEX questions_seller ON customer_questions(seller_id, status, received_at);

CREATE TABLE orders (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, seller_id TEXT, account_id TEXT NOT NULL,
  external_order_id TEXT NOT NULL, created_at TEXT, status TEXT, total_amount REAL, net_amount REAL,
  marketplace_fee REAL, shipping_cost REAL, units INTEGER, buyer_device TEXT, data TEXT NOT NULL);
CREATE UNIQUE INDEX orders_external ON orders(account_id, external_order_id);
CREATE INDEX orders_seller ON orders(seller_id, created_at);

CREATE TABLE ad_tracking (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, item_id TEXT NOT NULL, active INTEGER,
  added_at TEXT, data TEXT NOT NULL);
CREATE UNIQUE INDEX tracking_item ON ad_tracking(org_id, item_id);

CREATE TABLE ad_snapshots (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, captured_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX ad_snapshots_item ON ad_snapshots(item_id, captured_at);

CREATE TABLE ad_analyses (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, item_id TEXT, analyzed_at TEXT, data TEXT NOT NULL);
CREATE INDEX ad_analyses_org ON ad_analyses(org_id, analyzed_at);

CREATE TABLE oauth_states (id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at TEXT, data TEXT NOT NULL);
CREATE UNIQUE INDEX oauth_states_state ON oauth_states(state);
