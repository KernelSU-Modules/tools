/** Pure route matching: "/repos/:repositoryId/precheck" against a pathname. */
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
  const ps = norm(pattern).split('/');
  const xs = norm(pathname).split('/');
  if (ps.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    const x = xs[i]!;
    if (p.startsWith(':')) {
      if (!x) return null;
      try {
        params[p.slice(1)] = decodeURIComponent(x);
      } catch {
        return null;
      }
    } else if (p !== x) return null;
  }
  return params;
}

/** Paths that must never be handled by the SPA router (served by the Worker / static assets). */
export function isServerPath(pathname: string): boolean {
  return /^\/(docs|auth|api|webhooks|internal)(\/|$)/.test(pathname);
}
