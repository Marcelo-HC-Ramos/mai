export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MAI_SECRET_KEY?: string;
  MAI_ENCRYPTION_KEY?: string;
  ML_CLIENT_ID?: string;
  ML_CLIENT_SECRET?: string;
  ML_REDIRECT_URI?: string;
  ML_SITE_ID?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  MIN_MARGIN_PCT?: string;
  STOCK_ALERT_DAYS?: string;
  SESSION_HOURS?: string;
  PBKDF2_ITERATIONS?: string;
}

export function settings(env: Env) {
  return {
    secretKey: env.MAI_SECRET_KEY || "",
    encryptionKey: env.MAI_ENCRYPTION_KEY || "",
    mlClientId: env.ML_CLIENT_ID || "",
    mlClientSecret: env.ML_CLIENT_SECRET || "",
    mlRedirectUri: env.ML_REDIRECT_URI || "http://localhost:8787/auth/mercadolivre/callback",
    mlSiteId: env.ML_SITE_ID || "MLB",
    geminiApiKey: env.GEMINI_API_KEY || "",
    geminiModel: env.GEMINI_MODEL || "gemini-2.5-flash",
    minMarginPct: Number(env.MIN_MARGIN_PCT || 15),
    stockAlertDays: Number(env.STOCK_ALERT_DAYS || 15),
    sessionHours: Number(env.SESSION_HOURS || 12),
    pbkdf2Iterations: Number(env.PBKDF2_ITERATIONS || 15000),
  };
}

export type Settings = ReturnType<typeof settings>;
