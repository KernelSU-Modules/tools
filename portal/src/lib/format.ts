export const SITE_URL = 'https://modules.kernelsu.org';

/** Public detail page for a listed module. Site locales: en, zh-CN (others fall back to en). */
export function publicModuleUrl(id: string, uiLang: string): string {
  const locale = uiLang === 'zh-CN' ? 'zh-CN' : 'en';
  return `${SITE_URL}/${locale}/modules/${encodeURIComponent(id)}/`;
}

export function githubRepoUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}

export function githubUserUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string | null | undefined, lang: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

/** "3 minutes ago" style; falls back to absolute date beyond 30 days. */
export function formatRelative(iso: string | null | undefined, lang: string, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.round((t - now) / 1000);
  const abs = Math.abs(sec);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (abs < 60) return rtf.format(sec, 'second');
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day');
  return formatDate(iso, lang);
}

/** Seconds -> "m:ss" / "Ns" for rate-limit countdowns. */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
