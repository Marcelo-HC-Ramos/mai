// Criptografia de tokens em repouso com AES-256-GCM (RNF02 / RN04).
import { fromB64, fromB64url, fromUtf8, toB64, toB64url, utf8 } from "./lib/b64";

const PREFIX = "enc_v1_";
const keys = new Map<string, Promise<CryptoKey>>();

export function generateKey(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32)));
}

function key(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("Defina o segredo MAI_ENCRYPTION_KEY (o npm run configurar cria)");
  if (!keys.has(secret)) {
    const raw = fromB64(secret);
    if (raw.length !== 32) throw new Error("MAI_ENCRYPTION_KEY precisa ter 32 bytes (AES-256)");
    keys.set(secret, crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  return keys.get(secret)!;
}

export async function encrypt(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), utf8(plaintext)));
  const out = new Uint8Array(12 + data.length);
  out.set(iv);
  out.set(data, 12);
  return PREFIX + toB64url(out);
}

export async function decrypt(secret: string, token: string): Promise<string> {
  if (!token.startsWith(PREFIX)) throw new Error("Token não está no formato criptografado do MAI");
  const raw = fromB64url(token.slice(PREFIX.length));
  return fromUtf8(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await key(secret), raw.slice(12)));
}
