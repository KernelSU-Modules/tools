import type { APIRoute } from 'astro';
import { UI_LOCALES } from '../lib/i18n.ts';
import { detailUrl, listUrl } from '../lib/data.ts';
import { siteData } from '../lib/load.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const GET: APIRoute = () => {
  const data = siteData();
  const base = data.baseUrl.replace(/\/+$/, '');
  // "/" canonicalizes to /en/ and is not listed.
  const paths: string[] = [];
  for (const ui of UI_LOCALES) {
    paths.push(listUrl(ui));
    for (const m of data.modules) paths.push(detailUrl(ui, m.detail.id));
  }
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    paths.map((p) => `  <url><loc>${esc(`${base}/${p}`)}</loc></url>\n`).join('') +
    '</urlset>\n';
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
