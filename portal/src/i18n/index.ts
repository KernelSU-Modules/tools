import { en, type MessageKey } from './en.ts';
import { zhCN } from './zh-CN.ts';

export type { MessageKey };
export type Lang = 'en' | 'zh-CN';
export const LANGS: readonly Lang[] = ['en', 'zh-CN'];
export const LANG_NAMES: Record<Lang, string> = { en: 'English', 'zh-CN': '简体中文' };
export const LANG_STORAGE_KEY = 'kernelsu-developer-portal-lang';

export const dictionaries: Record<Lang, Record<MessageKey, string>> = { en, 'zh-CN': zhCN };

export type Params = Record<string, string | number>;

/** Translate with {placeholder} interpolation; falls back to English, then the key. */
export function translate(lang: Lang, key: MessageKey, params?: Params): string {
  const s = dictionaries[lang][key] ?? en[key] ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Maps a BCP 47 tag to a supported UI language. */
export function matchLang(tag: string | null | undefined): Lang | null {
  if (!tag) return null;
  const t = tag.toLowerCase();
  if (t === 'en' || t.startsWith('en-')) return 'en';
  if (t === 'zh' || t.startsWith('zh-')) return 'zh-CN'; // only Simplified Chinese is provided
  return null;
}

/** Stored choice wins, then navigator.languages order, then English. */
export function detectLang(stored: string | null, navigatorLanguages: readonly string[]): Lang {
  if (stored && (LANGS as readonly string[]).includes(stored)) return stored as Lang;
  for (const l of navigatorLanguages) {
    const m = matchLang(l);
    if (m) return m;
  }
  return 'en';
}
