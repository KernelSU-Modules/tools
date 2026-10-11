import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useRef, useState } from 'preact/hooks';
import { ApiClient, ApiError } from './api/client.ts';
import type { Me } from './api/types.ts';
import { type Lang, type MessageKey, type Params, translate } from './i18n/index.ts';

export interface AppCtx {
  api: ApiClient;
  me: Me | null;
  lang: Lang;
  setLang(l: Lang): void;
  t(key: MessageKey, params?: Params): string;
  reloadMe(): Promise<void>;
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(AppContext);
  if (!c) throw new Error('AppContext missing');
  return c;
}

export function useT() {
  return useApp().t;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload(): void;
  setData(v: T): void;
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(0, 'client', e instanceof Error ? e.message : String(e));
}

/** Runs `fn` when deps change; ignores stale responses. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    fn().then(
      (v) => {
        if (my !== seq.current) return;
        setData(v);
        setLoading(false);
      },
      (e: unknown) => {
        if (my !== seq.current) return;
        setError(toApiError(e));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}

/** Wraps an async action with pending / error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn(...args);
    } catch (e) {
      setError(toApiError(e));
      return undefined;
    } finally {
      setPending(false);
    }
  };
  return { run, pending, error, setError };
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · KernelSU Developer Portal` : 'KernelSU Developer Portal';
  }, [title]);
}

export { translate };
