// Registro de conectores. Para adicionar uma plataforma, crie a classe e registre aqui.
import type { MarketplaceConnector } from "./base";
import { DemoConnector } from "./demo";
import { MercadoLivreConnector, type MlOptions } from "./mercadolivre";

export function getConnector(name: string, opts: Record<string, any> = {}): MarketplaceConnector {
  if (name === "DEMO" || name === "demo") return new DemoConnector(opts);
  if (name === "MERCADO_LIVRE" || name === "mercadolivre") return new MercadoLivreConnector(opts as MlOptions);
  throw new Error(`Conector desconhecido: ${name}. Disponíveis: DEMO, MERCADO_LIVRE`);
}
