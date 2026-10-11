/** Locale-aware developer docs links. zh-CN pages live under /docs/zh-CN/ when they exist. */
const ROUTES: Record<string, string[]> = typeof __DOCS_LOCALE_ROUTES__ !== 'undefined' ? __DOCS_LOCALE_ROUTES__ : {};

/** `page` is relative to the docs root: "/" for the index, "/checks", ... */
export function docsUrl(page: string, lang: string, hash?: string, routes: Record<string, string[]> = ROUTES): string {
  const p = page.startsWith('/') ? page : `/${page}`;
  const localized = lang !== 'en' && routes[lang]?.includes(p);
  return `/docs${localized ? `/${lang}` : ''}${p}${hash ? `#${encodeURIComponent(hash)}` : ''}`;
}

export function issueDocUrl(code: string, lang: string, routes?: Record<string, string[]>): string {
  return docsUrl('/checks', lang, code, routes);
}
