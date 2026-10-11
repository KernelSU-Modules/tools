/** Client-side memory of server rate limits (sessionStorage), so the button stays disabled across navigation. */
const PREFIX = 'kernelsu-developer-portal-sync-until:';
export const SYNC_DEFAULT_WAIT = 600; // 1 / 10 min / module (Worker rate limit)

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export function syncBlockedUntil(store: KV, id: string, now = Date.now()): number | null {
  const v = Number(store.getItem(PREFIX + id));
  if (!v || v <= now) {
    if (v) store.removeItem(PREFIX + id);
    return null;
  }
  return v;
}

export function blockSync(store: KV, id: string, seconds: number | null, now = Date.now()): number {
  const until = now + (seconds ?? SYNC_DEFAULT_WAIT) * 1000;
  store.setItem(PREFIX + id, String(until));
  return until;
}
