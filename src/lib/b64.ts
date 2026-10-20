export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export const toB64url = (b: Uint8Array) => toB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64url = (s: string) => fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
export const utf8 = (s: string) => new TextEncoder().encode(s);
export const fromUtf8 = (b: ArrayBuffer | Uint8Array) => new TextDecoder().decode(b);

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}
