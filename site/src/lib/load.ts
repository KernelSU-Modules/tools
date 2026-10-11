// Server-side (build-time) access to the page data written by tools/build. Never imported by
// client scripts. The file path comes from $KSU_SITE_DATA (set by buildSite(), or by hand for
// `astro dev`); without it the site renders an empty catalog.
import { readFileSync } from 'node:fs';
import { emptySiteData, parseSiteData, type SiteData } from './data.ts';

export const SITE_DATA_ENV = 'KSU_SITE_DATA';

let memo: { file: string; data: SiteData } | null = null;

export function siteData(): SiteData {
  const file = process.env[SITE_DATA_ENV];
  if (!file) return emptySiteData();
  if (memo?.file !== file) memo = { file, data: parseSiteData(readFileSync(file, 'utf8')) };
  return memo.data;
}
