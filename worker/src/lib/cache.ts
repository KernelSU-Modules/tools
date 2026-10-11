// Two-tier cache: isolate memory (L1) + Workers Cache API (L2, per colo).
// Anything secret (installation tokens) is sealed with SESSION_KEY before it reaches the Cache API.
// Note: the Cache API is a no-op on *.pages.dev / *.workers.dev and in the cron Worker (no zone); production
// Portal traffic runs on the custom domain developers.kernelsu.org, where it works. Callers must tolerate misses.
import { seal, unseal } from './crypto.ts';

export interface KvCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSec: number): Promise<void>;
  delete(key: string): Promise<void>;
}

const CACHE_ORIGIN = 'https://kernelsu-developer-portal.internal/cache/';

/** Workers Cache API backend (caches.default). */
export class CacheApiStore implements KvCache {
  constructor(private readonly cache: Cache) {}
  private req(key: string) {
    return new Request(CACHE_ORIGIN + encodeURIComponent(key));
  }
  async get(key: string) {
    const res = await this.cache.match(this.req(key));
    return res ? res.text() : null;
  }
  async put(key: string, value: string, ttlSec: number) {
    await this.cache.put(
      this.req(key),
      new Response(value, { headers: { 'cache-control': `max-age=${Math.max(1, Math.floor(ttlSec))}`, 'content-type': 'text/plain' } }),
    );
  }
  async delete(key: string) {
    await this.cache.delete(this.req(key));
  }
}

/** In-memory backend with TTLs (tests, and the L1 tier). */
export class MemoryStore implements KvCache {
  constructor(
    readonly map = new Map<string, { v: string; exp: number }>(),
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 500,
  ) {}
  async get(key: string) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.exp <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return e.v;
  }
  async put(key: string, value: string, ttlSec: number) {
    if (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    this.map.set(key, { v: value, exp: this.now() + ttlSec * 1000 });
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

/** L1 memory in front of an optional L2. L1 TTL is capped so isolates converge quickly. */
export class TieredCache implements KvCache {
  constructor(
    private readonly l1: MemoryStore,
    private readonly l2: KvCache | null,
  ) {}
  async get(key: string) {
    const v = await this.l1.get(key);
    if (v !== null || !this.l2) return v;
    const v2 = await this.l2.get(key).catch(() => null);
    if (v2 !== null) await this.l1.put(key, v2, 30);
    return v2;
  }
  async put(key: string, value: string, ttlSec: number) {
    await this.l1.put(key, value, Math.min(ttlSec, 300));
    await this.l2?.put(key, value, ttlSec).catch(() => {});
  }
  async delete(key: string) {
    await this.l1.delete(key);
    await this.l2?.delete(key).catch(() => {});
  }
}

export async function getJson<T>(c: KvCache, key: string): Promise<T | null> {
  const s = await c.get(key);
  if (s === null) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
export function putJson(c: KvCache, key: string, value: unknown, ttlSec: number): Promise<void> {
  return c.put(key, JSON.stringify(value), ttlSec);
}
export async function getSecret<T>(c: KvCache, sessionKey: string, key: string): Promise<T | null> {
  const s = await c.get(key);
  return s === null ? null : unseal<T>(sessionKey, s, 'cache:' + key);
}
export async function putSecret(c: KvCache, sessionKey: string, key: string, value: unknown, ttlSec: number): Promise<void> {
  await c.put(key, await seal(sessionKey, value, 'cache:' + key), ttlSec);
}
