// Real-browser check that the sandboxed preview frame is styled under the production CSP.
//
// A srcdoc iframe inherits the Portal's CSP (`style-src 'self'` from public/_headers) and `sandbox=""` gives it an
// opaque origin. This test proves that /preview.css (linked by buildPreviewDoc) still applies there, and — as a
// control showing the CSP really is enforced inside the frame — that an inline <style> is blocked.
// Needs a headless Chromium: $CHROME_BIN, google-chrome/chromium in PATH, or Playwright's chromium-headless-shell
// cache. Skipped when none is available.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPreviewDoc } from '../src/lib/preview.ts';

const PUBLIC = join(__dirname, '../public');

function findChrome(): string | null {
  const candidates = [process.env.CHROME_BIN];
  for (const dir of (process.env.PATH ?? '').split(':'))
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) candidates.push(join(dir, n));
  const pw = join(homedir(), '.cache/ms-playwright');
  if (existsSync(pw))
    for (const d of readdirSync(pw).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse())
      for (const sub of readdirSync(join(pw, d))) candidates.push(join(pw, d, sub, 'chrome-headless-shell'));
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}

/** RGB of one pixel of an 8-bit RGB/RGBA PNG (non-interlaced). */
function pixel(png: Buffer, x: number, y: number): [number, number, number] {
  let o = 8;
  let w = 0;
  let h = 0;
  let bpp = 3;
  const idat: Buffer[] = [];
  while (o < png.length) {
    const len = png.readUInt32BE(o);
    const type = png.toString('latin1', o + 4, o + 8);
    const d = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0);
      h = d.readUInt32BE(4);
      bpp = d[9] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let r = 0; r <= y; r++) {
    const f = raw[r * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[r * stride + i - bpp]! : 0;
      const b = r ? out[(r - 1) * stride + i]! : 0;
      const c = r && i >= bpp ? out[(r - 1) * stride + i - bpp]! : 0;
      let v = raw[r * (stride + 1) + 1 + i]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[r * stride + i] = v & 255;
    }
  }
  const i = y * stride + x * bpp;
  return [out[i]!, out[i + 1]!, out[i + 2]!];
}

const chrome = findChrome();
const csp = /^\s*Content-Security-Policy:\s*(.+)$/m.exec(readFileSync(join(PUBLIC, '_headers'), 'utf8'))![1]!;

describe.skipIf(!chrome)('preview frame styling under the Portal CSP (headless Chromium)', () => {
  let server: Server;
  let origin = '';
  const docs: Record<string, string> = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const headers = { 'content-security-policy': csp };
      if (u.pathname === '/preview.css') {
        res.writeHead(200, { ...headers, 'content-type': 'text/css' });
        return res.end(readFileSync(join(PUBLIC, 'preview.css')));
      }
      if (u.pathname === '/frame.js') {
        // Same construction as components/SandboxFrame.tsx: sandbox="" set before srcdoc.
        const doc = docs[u.searchParams.get('mode') ?? ''] ?? '';
        res.writeHead(200, { ...headers, 'content-type': 'text/javascript' });
        return res.end(
          `const f=document.createElement('iframe');f.setAttribute('sandbox','');f.width='780';f.height='560';f.srcdoc=${JSON.stringify(doc)};document.body.replaceChildren(f);`,
        );
      }
      res.writeHead(200, { ...headers, 'content-type': 'text/html' });
      res.end(`<!doctype html><meta charset="utf-8"><body><script src="/frame.js?mode=${encodeURIComponent(u.searchParams.get('mode') ?? '')}"></script>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = '<h1>Hello</h1><p>text</p>';
    docs.link = buildPreviewDoc(body, { origin, lang: 'en', dark: true });
    // Control: the same document with the stylesheet inlined must be blocked by the inherited CSP.
    docs.inline = docs.link.replace(/<link rel="stylesheet"[^>]*>/, '<style>html{background:#0d1117}</style>');
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const shoot = (mode: string) =>
    new Promise<Buffer>((resolve, reject) => {
      const out = join(mkdtempSync(join(tmpdir(), 'kernelsu-csp-')), 'shot.png');
      execFile(
        chrome!,
        ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--window-size=800,600', '--virtual-time-budget=3000', `--screenshot=${out}`, `${origin}/?mode=${mode}`],
        { timeout: 45_000 },
        (err) => (err && !existsSync(out) ? reject(err) : resolve(readFileSync(out))),
      );
    });

  it('applies /preview.css inside the sandboxed srcdoc frame (dark theme background)', async () => {
    expect(docs.link).toContain(`href="${origin}/preview.css"`);
    expect(pixel(await shoot('link'), 400, 400)).toEqual([13, 17, 23]); // html.dark background #0d1117
  }, 60_000);

  it('control: inline styles are blocked in the frame (the CSP is inherited and enforced)', async () => {
    expect(pixel(await shoot('inline'), 400, 400)).toEqual([255, 255, 255]);
  }, 60_000);
});
