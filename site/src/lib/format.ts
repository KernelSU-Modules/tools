// Locale-independent formatting: output must not depend on the build machine's clock, TZ or ICU.

export function date(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * Only https URLs and root-relative site paths may become href/src values. Module data is
 * schema-validated (HttpsUrl) before it gets here; this is a second line of defence.
 */
export function safeHref(url: string): string {
  const ok = /^https:\/\/[^\s"'<>]+$/i.test(url) || /^\/(?!\/)[^\s"'<>\\]*$/.test(url) || /^#[^\s"'<>]*$/.test(url);
  if (!ok) throw new Error(`refusing unsafe URL in template: ${url}`);
  return url;
}

/**
 * Like safeHref but also accepts plain http:// URLs: module homepage / support links (module.yaml tolerates
 * http with a validator warning). Rendered with rel="nofollow noopener noreferrer" like every external link.
 */
export function safeWebHref(url: string): string {
  if (/^http:\/\/[^\s"'<>]+$/i.test(url)) return url;
  return safeHref(url);
}

/** Link text for an external URL: without the scheme. */
export const displayUrl = (url: string): string => url.replace(/^https?:\/\//i, '');

/** Compact count like GitHub: 999, 1k, 1.2k, 12.3k, 1.5M (deterministic, no ICU). */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  const [div, unit] = n < 999_950 ? [1000, 'k'] : [1_000_000, 'M'];
  return `${(n / div).toFixed(1).replace(/\.0$/, '')}${unit}`;
}

export const shortSha = (sha: string): string => sha.slice(0, 12);
