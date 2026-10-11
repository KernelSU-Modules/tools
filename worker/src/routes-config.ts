// Path prefixes handled by the Pages Functions entry (advanced-mode `_worker.js`). Everything else is a
// static asset of `portal/dist` served by Pages directly (free and unmetered; SPA fallback via index.html).
// scripts/build-pages.ts writes `_routes.json` from this list so static requests never invoke Functions.
export const DYNAMIC_PREFIXES = ['/api/', '/auth/', '/webhooks/', '/internal/'] as const;

export interface PagesRoutes {
  version: 1;
  description: string;
  include: string[];
  exclude: string[];
}

export function pagesRoutes(): PagesRoutes {
  return {
    version: 1,
    description: 'kernelsu-developer-portal: only API/auth/webhook paths invoke the Functions worker; everything else is static.',
    include: DYNAMIC_PREFIXES.map((p) => `${p}*`),
    exclude: [],
  };
}
