// Usuários, empresas e sessões (multiempresa).
//
// Uma empresa (organizations) tem usuários (users) e lojas (sellers); cada loja tem uma ou mais contas de
// marketplace (marketplace_accounts). Todo dado de negócio carrega org_id e toda consulta da API filtra por ele.
// Papéis: owner (dono), admin (gerencia lojas, contas e usuários) e analyst (consulta e responde perguntas).
import { DuplicateKeyError, type Doc, type Store } from "./db";
import { fromB64, fromB64url, fromUtf8, timingSafeEqual, toB64, toB64url, utf8 } from "./lib/b64";
import { nowIso } from "./lib/time";
import type { Settings } from "./env";

export const ROLES = ["owner", "admin", "analyst"] as const;

export class AuthError extends Error {}

// sem MAI_SECRET_KEY, as sessões valem só enquanto esta instância viver (gerado na primeira chamada: a Cloudflare
// não permite números aleatórios fora de uma requisição)
let fallback = "";
const fallbackSecret = () => (fallback ||= toB64(crypto.getRandomValues(new Uint8Array(32))));

// -- Senhas (PBKDF2-SHA256) ------------------------------------------------------------------------------
async function pbkdf2(password: string, salt: Uint8Array, rounds: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, k, 256));
}

export async function hashPassword(password: string, rounds = 15000): Promise<string> {
  if (password.length < 8) throw new AuthError("A senha precisa ter pelo menos 8 caracteres");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2_sha256$${rounds}$${toB64(salt)}$${toB64(await pbkdf2(password, salt, rounds))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = (stored || "").split("$");
  if (parts.length !== 4) return false;
  const calc = await pbkdf2(password, fromB64(parts[2]), Number(parts[1]));
  return timingSafeEqual(calc, fromB64(parts[3]));
}

// -- Tokens de sessão assinados (HMAC-SHA256) ------------------------------------------------------------
async function hmac(secret: string, body: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", utf8(secret || fallbackSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, utf8(body)));
}

export async function sign(secret: string, body: string): Promise<string> {
  return toB64url(await hmac(secret, body));
}

export async function issueToken(cfg: Settings, user: { _id: string; org_id: string; role: string }): Promise<string> {
  const payload = { uid: user._id, org: user.org_id, role: user.role, exp: Math.floor(Date.now() / 1000) + cfg.sessionHours * 3600 };
  const body = toB64url(utf8(JSON.stringify(payload)));
  return `${body}.${await sign(cfg.secretKey, body)}`;
}

export async function readToken(cfg: Settings, token: string, now = Date.now()): Promise<{ uid: string; org: string; role: string; exp: number }> {
  const parts = (token || "").split(".");
  if (parts.length !== 2) throw new AuthError("Token inválido");
  let ok = false;
  try { ok = timingSafeEqual(fromB64url(parts[1]), await hmac(cfg.secretKey, parts[0])); } catch { ok = false; }
  if (!ok) throw new AuthError("Token inválido");
  const payload = JSON.parse(fromUtf8(fromB64url(parts[0])));
  if (payload.exp < now / 1000) throw new AuthError("Sessão expirada");
  return payload;
}

// -- Cadastro --------------------------------------------------------------------------------------------
export async function registerOrganization(db: Store, cfg: Settings, orgName: string, userName: string, email: string,
  password: string, document?: string | null): Promise<[Doc, Doc]> {
  email = email.trim().toLowerCase();
  if (await db.users.findOne({ email })) throw new AuthError("Já existe um usuário com este e-mail");
  if (password.length < 8) throw new AuthError("A senha precisa ter pelo menos 8 caracteres");
  const org: Record<string, any> = { name: orgName.trim(), created_at: nowIso(), settings: {} };
  if (document) org.document = document;
  let saved: Doc;
  try { saved = await db.organizations.insert(org); } catch (e) {
    if (e instanceof DuplicateKeyError) throw new AuthError("Já existe uma empresa com este documento");
    throw e;
  }
  const user = await createUser(db, cfg, saved._id, userName, email, password, "owner");
  return [saved, user];
}

export async function createUser(db: Store, cfg: Settings, orgId: string, name: string, email: string, password: string,
  role: string): Promise<Doc> {
  if (!(ROLES as readonly string[]).includes(role)) throw new AuthError(`Papel inválido: ${role}`);
  const user = { org_id: orgId, name: name.trim(), email: email.trim().toLowerCase(), role,
    password_hash: await hashPassword(password, cfg.pbkdf2Iterations), active: true, created_at: nowIso() };
  try { return await db.users.insert(user); } catch (e) {
    if (e instanceof DuplicateKeyError) throw new AuthError("Já existe um usuário com este e-mail");
    throw e;
  }
}

export async function authenticate(db: Store, email: string, password: string): Promise<Doc> {
  const user = await db.users.findOne({ email: (email || "").trim().toLowerCase(), active: true });
  if (!user || !(await verifyPassword(password || "", user.password_hash))) throw new AuthError("E-mail ou senha incorretos");
  return user;
}
