// WebCrypto helpers: AES-GCM sealing (session cookie, secrets in the Cache API), HMAC (CSRF), random ids.
import { base64Decode, base64UrlEncode, timingSafeEqual } from '@kernelsu-modules/github';

const enc = new TextEncoder();
const dec = new TextDecoder();
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

interface Keys {
  aes: CryptoKey;
  hmac: CryptoKey;
}
// Module-level memo: importKey runs once per isolate per SESSION_KEY.
const keyMemo = new Map<string, Promise<Keys>>();

async function deriveKeys(sessionKeyB64: string): Promise<Keys> {
  const raw = base64Decode(sessionKeyB64.trim());
  if (raw.length !== 32) throw new Error('SESSION_KEY must be 32 bytes, base64-encoded');
  // Separate sub-keys per purpose: HKDF(SESSION_KEY, info) -> AES-256-GCM key, HMAC-SHA256 key.
  const base = await crypto.subtle.importKey('raw', bs(raw), 'HKDF', false, ['deriveKey']);
  const salt = enc.encode('kernelsu-developer-portal/v1');
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(enc.encode('aes-gcm')) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const hmac = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(enc.encode('hmac')) },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  );
  return { aes, hmac };
}

export function keys(sessionKeyB64: string): Promise<Keys> {
  let k = keyMemo.get(sessionKeyB64);
  if (!k) {
    k = deriveKeys(sessionKeyB64);
    k.catch(() => keyMemo.delete(sessionKeyB64));
    keyMemo.set(sessionKeyB64, k);
  }
  return k;
}

/** AES-GCM encrypt a JSON value; `aad` binds the ciphertext to its purpose (cookie name, cache key). */
export async function seal(sessionKey: string, value: unknown, aad: string): Promise<string> {
  const { aes } = await keys(sessionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(iv), additionalData: bs(enc.encode(aad)) }, aes, bs(enc.encode(JSON.stringify(value)))),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return base64UrlEncode(out);
}

export async function unseal<T>(sessionKey: string, token: string, aad: string): Promise<T | null> {
  try {
    const { aes } = await keys(sessionKey);
    const raw = base64Decode(token);
    if (raw.length < 13) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bs(raw.subarray(0, 12)), additionalData: bs(enc.encode(aad)) },
      aes,
      bs(raw.subarray(12)),
    );
    return JSON.parse(dec.decode(pt)) as T;
  } catch {
    return null;
  }
}

export async function hmacB64(sessionKey: string, data: string): Promise<string> {
  const { hmac } = await keys(sessionKey);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', hmac, bs(enc.encode(data)))));
}

export async function hmacVerify(sessionKey: string, data: string, mac: string | null | undefined): Promise<boolean> {
  if (!mac) return false;
  return timingSafeEqual(await hmacB64(sessionKey, data), mac);
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Uniform random string over [a-z0-9] (rejection sampling, no modulo bias). */
export function randomId(len = 10): string {
  let out = '';
  while (out.length < len) {
    const buf = crypto.getRandomValues(new Uint8Array(len * 2));
    for (const b of buf) {
      if (b < 252) out += ALNUM[b % 36];
      if (out.length === len) break;
    }
  }
  return out;
}

export function randomToken(bytes = 16): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}
