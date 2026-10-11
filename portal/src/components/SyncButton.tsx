import { useEffect, useState } from 'preact/hooks';
import { useAction, useApp } from '../context.tsx';
import { formatWait } from '../lib/format.ts';
import { blockSync, syncBlockedUntil } from '../lib/ratelimit.ts';
import { RefreshCw } from './icons.tsx';

const store = typeof sessionStorage !== 'undefined' ? sessionStorage : null;

export function SyncButton({ id, onDone }: { id: string; onDone?: () => void }) {
  const { api, t } = useApp();
  const [until, setUntil] = useState<number | null>(() => (store ? syncBlockedUntil(store, id) : null));
  const [now, setNow] = useState(Date.now());
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const action = useAction(() => api.syncModule(id));

  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) {
        setUntil(null);
        clearInterval(timer);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);

  const onClick = async () => {
    setMsg(null);
    const r = await action.run();
    if (r !== undefined) {
      if (store) setUntil(blockSync(store, id, null));
      setMsg({ tone: 'good', text: t('sync.dispatched') });
      onDone?.();
    }
  };
  // Map errors after the action settles.
  useEffect(() => {
    const e = action.error;
    if (!e) return;
    if (e.status === 429) {
      const u = store ? blockSync(store, id, e.retryAfter) : Date.now() + (e.retryAfter ?? 600) * 1000;
      setUntil(u);
      setMsg({ tone: 'bad', text: t('sync.rateLimited') });
    } else {
      setMsg({ tone: 'bad', text: `${t('sync.failed')}: ${e.message}` });
    }
  }, [action.error]);

  const blocked = until != null && until > now;
  return (
    <span class="sync">
      <button type="button" class="btn sm" onClick={onClick} disabled={blocked || action.pending} aria-busy={action.pending}>
        <RefreshCw size={14} />
        {action.pending ? t('sync.running') : blocked ? t('sync.waitButton', { time: formatWait((until - now) / 1000) }) : t('sync.button')}
      </button>
      <span class={`sync-msg ${msg?.tone ?? ''}`} role="status" aria-live="polite">
        {msg?.text}
      </span>
    </span>
  );
}
