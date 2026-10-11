#!/usr/bin/env node
// Post-build guard: the production bundle must not contain the mock API, inline scripts or
// third-party script/style origins, and the developer docs must exist.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = new URL('../dist/', import.meta.url).pathname;
const errors = [];
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) walk(f);
    else files.push(f);
  }
};
walk(dist);

const FORBIDDEN = ['__KSU_PORTAL_MOCK_FIXTURES__', 'kernelsu-mock-persona', 'mock-csrf-token'];
let js = 0, jsGz = 0, css = 0, cssGz = 0;
for (const f of files) {
  const rel = f.slice(dist.length);
  if (!/\.(js|css|html)$/.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  for (const s of FORBIDDEN) if (text.includes(s)) errors.push(`${rel}: contains mock marker "${s}"`);
  if (/\beval\(|new Function\(/.test(text)) errors.push(`${rel}: eval/new Function`);
  if (rel.endsWith('.html')) {
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(text)) errors.push(`${rel}: inline <script>`);
    if (/<(script|link)[^>]+(src|href)="(https?:)?\/\//i.test(text)) errors.push(`${rel}: third-party script/style origin`);
    if (/\son[a-z]+="/i.test(text)) errors.push(`${rel}: inline event handler`);
  }
  if (rel.startsWith('assets/') && f.endsWith('.js')) { js += text.length; jsGz += gzipSync(text).length; }
  if (rel.startsWith('assets/') && f.endsWith('.css')) { css += text.length; cssGz += gzipSync(text).length; }
}
const headers = existsSync(join(dist, '_headers')) ? readFileSync(join(dist, '_headers'), 'utf8') : '';
if (!/^\s*Strict-Transport-Security:\s*max-age=\d{8,}/m.test(headers)) errors.push('_headers: missing Strict-Transport-Security');
const csp = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(headers)?.[1] ?? '';
if (!/script-src 'self'/.test(csp) || /unsafe-(inline|eval)/.test(csp)) errors.push(`_headers: unexpected CSP "${csp}"`);
for (const need of ['_headers', 'index.html', 'docs/index.html', 'docs/checks.html', 'docs/docs.css', 'preview.css']) {
  if (!existsSync(join(dist, need))) errors.push(`missing ${need}`);
}
if (existsSync(join(dist, 'docs/checks.html')) && !/<h3 id="[a-z0-9-]+"/.test(readFileSync(join(dist, 'docs/checks.html'), 'utf8'))) {
  errors.push('docs/checks.html has no <h3 id> issue-code anchors');
}
const kb = (n) => (n / 1024).toFixed(1) + ' KiB';
console.log(`portal bundle: JS ${kb(js)} (gzip ${kb(jsGz)}), CSS ${kb(css)} (gzip ${kb(cssGz)}); ${files.filter((f) => f.includes('/docs/') && f.endsWith('.html')).length} docs pages`);
if (errors.length) {
  console.error('check-dist failed:\n  ' + errors.join('\n  '));
  process.exit(1);
}
