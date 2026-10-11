// Public (non-Astro) surface of @kernelsu-modules/site, used by tools/build.
export { UI_LOCALES, DEFAULT_UI_LOCALE, MESSAGES, type UiLocale, type Messages } from './i18n.ts';
export {
  SITE_DATA_SCHEMA,
  buildSearchIndex,
  detailUrl,
  listUrl,
  searchPath,
  stableRelease,
  type SearchEntry,
  type SearchIndex,
  type SiteData,
  type SiteModule,
} from './data.ts';
export { SITE_DATA_ENV } from './load.ts';
