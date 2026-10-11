// Cloudflare Pages `_headers`. Note: when several rules match, Pages concatenates values of the same header,
// so Cache-Control is only ever set by one rule per path and extra CSPs only tighten. A `Content-Type` set here
// replaces the one Pages derives from the file extension (verified with `wrangler pages dev`).
import { UI_LOCALES } from '@kernelsu-modules/site';

export const SITE_CSP = [
  "default-src 'self'",
  // Only same-origin images: README/changelog images without a local copy are rendered as links.
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SHORT = 'public, max-age=60, must-revalidate';
const SEARCH = 'public, max-age=300, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';

export function renderHeaders(): string {
  const rules: [string, string[]][] = [
    [
      '/*',
      [
        `Content-Security-Policy: ${SITE_CSP}`,
        'X-Content-Type-Options: nosniff',
        'X-Frame-Options: DENY',
        'Referrer-Policy: strict-origin-when-cross-origin',
        'Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()',
        'Cross-Origin-Opener-Policy: same-origin',
      ],
    ],
    ['/', [`Cache-Control: ${SHORT}`]],
    ['/index.html', [`Cache-Control: ${SHORT}`]],
    ['/404.html', [`Cache-Control: ${SHORT}`]],
    ...UI_LOCALES.map((l): [string, string[]] => [`/${l}/*`, [`Cache-Control: ${SHORT}`]]),
    ['/api/v1/*', [`Cache-Control: ${SHORT}`, 'Access-Control-Allow-Origin: *']],
    // README fragments, changelog.md and update.json: never scriptable even if opened directly.
    ['/api/v1/modules/:id/*', ["Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'self'; sandbox"]],
    // Raw release notes (update.json "changelog"); Pages would serve .md as text/markdown anyway, pin it.
    ['/api/v1/modules/:id/changelog.md', ['Content-Type: text/markdown; charset=utf-8']],
    ['/search/*', [`Cache-Control: ${SEARCH}`]],
    // Assets are only ever subresources (CSS/JS/images); CSP on subresources is ignored by browsers,
    // so this only bites when a copied SVG is opened directly as a document.
    ['/assets/*', [`Cache-Control: ${IMMUTABLE}`, "Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"]],
    ['/build-manifest.json', [`Cache-Control: ${SHORT}`]],
  ];
  return rules.map(([p, hs]) => `${p}\n${hs.map((h) => `  ${h}`).join('\n')}\n`).join('');
}
