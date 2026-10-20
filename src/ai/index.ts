// IA generativa opcional. Hoje: Gemini (gratuito no Google AI Studio). Sem chave configurada, tudo funciona com as
// regras locais e o relatório informa qual método foi usado.
import type { Settings } from "../env";
import { decrypt } from "../security";
import { GeminiClient, type Llm } from "./gemini";

export type { Llm } from "./gemini";

/** Chave própria da empresa (criptografada em organizations.settings) tem prioridade sobre a chave global. */
export async function llmForOrg(cfg: Settings, org: Record<string, any> | null | undefined): Promise<Llm | null> {
  const s = org?.settings || {};
  let key: string | null = null;
  if (s.gemini_api_key) { try { key = await decrypt(cfg.encryptionKey, s.gemini_api_key); } catch { key = null; } }
  else if (cfg.geminiApiKey) key = cfg.geminiApiKey;
  if (!key || s.ai_enabled === false) return null;
  return new GeminiClient(key, s.gemini_model || cfg.geminiModel);
}
