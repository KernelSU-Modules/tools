// Runtime-agnostic crypto helpers (WebCrypto only): works in Node >= 22, Workers and browsers.

const enc = new TextEncoder();
/** TS 5.7+ typed-array generics: WebCrypto wants ArrayBuffer-backed views. */
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

export function base64UrlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bs(bytes)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacSha256Hex(secret: string, data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), bs(bytes)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a GitHub webhook `X-Hub-Signature-256` header ("sha256=<hex>").
 * Also used for the tgcloud -> Worker forwarder (`X-KernelSU-Signature`), same format.
 */
export async function verifySha256Signature(
  secret: string,
  body: Uint8Array | string,
  header: string | null | undefined,
): Promise<boolean> {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + (await hmacSha256Hex(secret, body));
  return timingSafeEqual(expected, header);
}

/* ---------------- RSA private key import (PKCS#1 or PKCS#8 PEM) ---------------- */

function pemBody(pem: string): { der: Uint8Array; pkcs1: boolean } {
  const pkcs1 = pem.includes('BEGIN RSA PRIVATE KEY');
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '');
  return { der: base64Decode(b64), pkcs1 };
}

function derLength(len: number): Uint8Array {
  if (len < 0x80) return Uint8Array.of(len);
  const bytes: number[] = [];
  while (len > 0) {
    bytes.unshift(len & 0xff);
    len >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Wrap a PKCS#1 RSAPrivateKey into a PKCS#8 PrivateKeyInfo (GitHub App keys are PKCS#1). */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  // AlgorithmIdentifier: rsaEncryption OID 1.2.840.113549.1.1.1 + NULL
  const algId = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  const octet = concat(Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1);
  const body = concat(version, algId, octet);
  return concat(Uint8Array.of(0x30), derLength(body.length), body);
}

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const { der, pkcs1 } = pemBody(pem.replace(/\\n/g, '\n'));
  const pkcs8 = pkcs1 ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey('pkcs8', bs(pkcs8), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

export async function signJwtRs256(key: CryptoKey, payload: Record<string, unknown>): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const input = `${header}.${body}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input));
  return `${input}.${base64UrlEncode(new Uint8Array(sig))}`;
}
