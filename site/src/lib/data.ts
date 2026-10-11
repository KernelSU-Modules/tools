// The page-data contract between tools/build (producer) and the Astro pages (consumer).
// Module content is single-language: every UI locale shows the same name / summary / README.
import type { ApiModuleDetail, ApiRelease } from '@kernelsu-modules/schema';
import { UI_LOCALES, type UiLocale } from './i18n.ts';

export const SITE_DATA_SCHEMA = 2;

export interface SiteModule {
  /** Exactly what api/v1/modules/{id}.json contains (changelog images are root-absolute "/assets/…"). */
  detail: ApiModuleDetail;
  /**
   * Sanitized README HTML (already passed through @kernelsu-modules/render's whitelist; identical to the
   * api/v1/modules/{id}/readme fragment), or null. Copied images are root-absolute "/assets/…"; images
   * without a local copy are plain links (CSP img-src 'self' data:).
   */
  readme: string | null;
}

export interface SiteData {
  schemaVersion: typeof SITE_DATA_SCHEMA;
  /** https origin, no trailing slash. */
  baseUrl: string;
  portalUrl: string;
  buildId: string;
  /** From the lock (never the wall clock), so builds are reproducible. */
  generatedAt: string;
  /** Sorted by id. */
  modules: SiteModule[];
}

export interface SearchEntry {
  id: string;
  name: string;
  summary: string;
  authors: string[];
  tags: string[];
  metamodule: boolean;
  version: string;
  updatedAt: string;
  /** GitHub stars of the bound repository; null when not recorded. */
  stars: number | null;
  /** Relative to the site root, e.g. "en/modules/foo/". */
  url: string;
}

export interface SearchIndex {
  schemaVersion: 1;
  buildId: string;
  locale: string;
  modules: SearchEntry[];
}

/** Site-root-relative page paths (directory form, as served by Pages). */
export const listUrl = (ui: UiLocale): string => `${ui}/`;
export const detailUrl = (ui: UiLocale, id: string): string => `${ui}/modules/${id}/`;
export const searchPath = (ui: UiLocale): string => `search/${ui}.json`;

export function emptySiteData(): SiteData {
  return {
    schemaVersion: SITE_DATA_SCHEMA,
    baseUrl: 'https://modules.kernelsu.org',
    portalUrl: 'https://developers.kernelsu.org',
    buildId: '0000000000000000',
    generatedAt: '1970-01-01T00:00:00Z',
    modules: [],
  };
}

export function parseSiteData(text: string): SiteData {
  const d = JSON.parse(text) as SiteData;
  if (d?.schemaVersion !== SITE_DATA_SCHEMA || !Array.isArray(d.modules)) throw new Error('site data: unsupported schemaVersion');
  return d;
}

export function buildSearchIndex(data: Pick<SiteData, 'buildId' | 'modules'>, ui: UiLocale): SearchIndex {
  const modules = data.modules
    .map(({ detail: d }) => {
      return {
        id: d.id,
        name: d.name,
        summary: d.summary,
        authors: d.authors.map((a) => a.name),
        tags: d.tags,
        metamodule: d.metamodule,
        version: d.stable.version,
        updatedAt: d.updatedAt,
        stars: d.stars ?? null,
        url: detailUrl(ui, d.id),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schemaVersion: 1, buildId: data.buildId, locale: ui, modules };
}

/** Newest first by updatedAt, then id: the static order of the module list. */
export function listOrder(mods: SiteModule[]): SiteModule[] {
  return [...mods].sort(
    (a, b) => (a.detail.updatedAt < b.detail.updatedAt ? 1 : a.detail.updatedAt > b.detail.updatedAt ? -1 : 0) || (a.detail.id < b.detail.id ? -1 : 1),
  );
}

export function stableRelease(d: ApiModuleDetail): ApiRelease | undefined {
  return d.releases.find((r) => !r.prerelease && r.versionCode === d.stable.versionCode) ?? d.releases.find((r) => !r.prerelease);
}

export { UI_LOCALES };
