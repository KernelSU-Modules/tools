import type { APIRoute } from 'astro';
import { siteData } from '../lib/load.ts';

export const GET: APIRoute = () => {
  const base = siteData().baseUrl.replace(/\/+$/, '');
  return new Response(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
