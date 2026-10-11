import type { AccessibleAnchorHTMLAttributes, ComponentChildren, TargetedMouseEvent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { isServerPath } from './lib/route.ts';

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const url = new URL(to, location.href);
  if (url.origin !== location.origin || isServerPath(url.pathname)) {
    location.assign(url.href);
    return;
  }
  if (opts.replace) history.replaceState(null, '', url.pathname + url.search + url.hash);
  else history.pushState(null, '', url.pathname + url.search + url.hash);
  emit();
  if (!url.hash) window.scrollTo(0, 0);
}

if (typeof window !== 'undefined') window.addEventListener('popstate', emit);

export interface Loc {
  path: string;
  query: URLSearchParams;
}

export function useLocation(): Loc {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}

type AnchorProps = AccessibleAnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ComponentChildren };

/** In-app link: client-side navigation for SPA paths, normal navigation otherwise. */
export function Link({ href, onClick, ...rest }: AnchorProps) {
  const handle = (e: TargetedMouseEvent<HTMLAnchorElement>) => {
    if (onClick) (onClick as (e: TargetedMouseEvent<HTMLAnchorElement>) => void)(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (rest.target && rest.target !== '_self') return;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || isServerPath(url.pathname)) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
