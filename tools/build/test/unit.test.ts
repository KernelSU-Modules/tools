import dns from 'node:dns';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertCspClean,
  builderFingerprint,
  checkFetchUrl,
  checkHtmlCsp,
  computeBuildId,
  fetchFollow,
  fetchRetry,
  FetchError,
  fingerprintFiles,
  guardedLookup,
  isPublicIp,
  isTransient,
  nodeHttpGet,
  PathClaims,
  renderHeaders,
  sanitizeSvg,
  sniffImage,
  type BuildIdInputs,
  type HttpGet,
} from '../src/index.ts';

const te = new TextEncoder();
const td = new TextDecoder();

describe('isPublicIp', () => {
  it.each([
    ['8.8.8.8', true], ['140.82.112.3', true], ['2606:4700::1111', true],
    ['127.0.0.1', false], ['10.1.2.3', false], ['172.16.0.1', false], ['172.31.255.255', false], ['192.168.1.1', false],
    ['169.254.169.254', false], ['100.64.0.1', false], ['0.0.0.0', false], ['198.18.0.19', false], ['224.0.0.1', false],
    ['255.255.255.255', false], ['::1', false], ['::', false], ['fe80::1', false], ['fd00::1', false], ['::ffff:127.0.0.1', false],
    ['::ffff:8.8.8.8', false], ['64:ff9b::7f00:1', false], ['2001:db8::1', false], ['ff02::1', false], ['not-an-ip', false],
    // zone ids (scoped link-local) never throw and are never public
    ['fe80::1%eth0', false], ['fe80::1%25eth0', false], ['2606:4700::1111%eth0', false], ['::1%lo', false],
  ])('%s -> %s', (ip, pub) => expect(isPublicIp(ip)).toBe(pub));
});

describe('checkFetchUrl', () => {
  it.each([
    'http://example.com/a.png', 'ftp://example.com/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://localhost/a',
    'https://foo.localhost/a', 'https://intranet/a', 'https://user:pw@example.com/a', 'https://example.com:8443/a',
    'https://169.254.169.254/latest/meta-data', 'https://0x7f000001/a', 'https://2130706433/a', 'file:///etc/passwd', 'data:image/png;base64,AA==',
  ])('refuses %s', (u) => expect(() => checkFetchUrl(u)).toThrow(FetchError));
  it('accepts public https URLs', () => {
    expect(checkFetchUrl('https://raw.githubusercontent.com/a/b/c/d.png').hostname).toBe('raw.githubusercontent.com');
  });
});

describe('nodeHttpGet', () => {
  it('refuses non-public literal addresses before connecting', async () => {
    await expect(nodeHttpGet('https://127.0.0.1/x', { maxBytes: 10, timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'policy' });
    await expect(nodeHttpGet('https://[::1]/x', { maxBytes: 10, timeoutMs: 1000 })).rejects.toMatchObject({ kind: 'policy' });
  });
});

describe('guardedLookup (mocked DNS)', () => {
  afterEach(() => vi.restoreAllMocks());
  const answers: Record<string, dns.LookupAddress[]> = {
    'ok.example': [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }],
    'rebind.example': [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
    'mapped.example': [{ address: '::ffff:169.254.169.254', family: 6 }],
    'nat64.example': [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
    'scoped.example': [{ address: 'fe80::1%eth0', family: 6 }],
    'empty.example': [],
  };
  const mockDns = () =>
    vi.spyOn(dns, 'lookup').mockImplementation(((host: string, _o: unknown, cb: (e: NodeJS.ErrnoException | null, a: dns.LookupAddress[]) => void) => {
      const a = answers[host];
      if (!a) return cb(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
      cb(null, a);
    }) as unknown as typeof dns.lookup);
  const lookup = (host: string, options: dns.LookupOptions) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
      guardedLookup(host, options, (err, address, family) => resolve({ err, address, family })),
    );

  it('returns public addresses (first one, or all; family filter)', async () => {
    mockDns();
    expect(await lookup('ok.example', {})).toMatchObject({ err: null, address: '93.184.216.34', family: 4 });
    expect((await lookup('ok.example', { all: true })).address).toEqual(answers['ok.example']);
    expect(await lookup('ok.example', { family: 6 })).toMatchObject({ err: null, address: '2606:2800:220:1::1', family: 6 });
  });

  it.each(['rebind.example', 'mapped.example', 'nat64.example', 'scoped.example', 'empty.example'])('refuses %s', async (host) => {
    mockDns();
    const r = await lookup(host, { all: true });
    expect(r.err?.code).toBe('EKSUNONPUBLIC');
  });

  it('passes resolver errors through', async () => {
    mockDns();
    expect((await lookup('missing.example', {})).err?.code).toBe('ENOTFOUND');
  });
});

describe('fetchRetry', () => {
  const seq = (statuses: (number | 'net')[]): HttpGet & { calls: number } => {
    let i = 0;
    const g = (async () => {
      g.calls++;
      const s = statuses[Math.min(i++, statuses.length - 1)]!;
      if (s === 'net') throw new FetchError('ECONNRESET', 'network');
      return { status: s, headers: {}, body: new TextEncoder().encode('ok') };
    }) as unknown as HttpGet & { calls: number };
    g.calls = 0;
    return g;
  };
  const policy = { retries: 3, baseDelayMs: 100, maxDelayMs: 250 };

  it('retries 429 / 5xx / network errors with capped exponential backoff', async () => {
    const sleeps: number[] = [];
    const g = seq([503, 'net', 429, 200]);
    const r = await fetchRetry(g, 'https://a.example/x', { maxRedirects: 0, maxBytes: 10 }, policy, async (ms) => void sleeps.push(ms));
    expect(new TextDecoder().decode(r.body)).toBe('ok');
    expect(g.calls).toBe(4);
    expect(sleeps).toEqual([100, 200, 250]);
  });

  it('does not retry permanent errors and gives up after `retries`', async () => {
    const g404 = seq([404]);
    await expect(fetchRetry(g404, 'https://a.example/x', { maxRedirects: 0, maxBytes: 10 }, policy, async () => {})).rejects.toMatchObject({ status: 404 });
    expect(g404.calls).toBe(1);
    const g500 = seq([500]);
    const err = await fetchRetry(g500, 'https://a.example/x', { maxRedirects: 0, maxBytes: 10 }, policy, async () => {}).catch((e: unknown) => e);
    expect(isTransient(err)).toBe(true);
    expect(g500.calls).toBe(4);
    expect(isTransient(new FetchError('x', 'limit'))).toBe(false);
    expect(isTransient(new FetchError('x', 'policy'))).toBe(false);
  });
});

describe('PathClaims', () => {
  it('detects file/file, file/dir and dir/file collisions; shared content-addressed assets are fine', () => {
    const c = new PathClaims();
    expect(c.tryClaim([['api/v1/modules/foo.json', 'foo'], ['api/v1/modules/foo/update.json', 'foo'], ['assets/a.png', 'sha:1']])).toBeNull();
    expect(c.tryClaim([['assets/a.png', 'sha:1'], ['api/v1/modules/bar.json', 'bar']])).toBeNull();
    // id "foo.json": its directory is foo's file
    expect(c.tryClaim([['api/v1/modules/foo.json.json', 'x'], ['api/v1/modules/foo.json/update.json', 'x']])).toMatch(/api\/v1\/modules\/foo\.json is a file of foo/);
    // nothing of the failed claim was recorded
    expect(c.tryClaim([['api/v1/modules/foo.json.json', 'y']])).toBeNull();
    // a file where a directory exists
    expect(c.tryClaim([['api/v1/modules/foo', 'z']])).toMatch(/already a directory/);
    // same path, different owner / content
    expect(c.tryClaim([['assets/a.png', 'sha:2']])).toMatch(/already taken/);
    // conflicts inside one claim
    expect(new PathClaims().tryClaim([['a/b', 'm'], ['a/b/c', 'm']])).toMatch(/a\/b is a file of m/);
  });
});

describe('buildId / fingerprint', () => {
  const inputs: BuildIdInputs = {
    builder: 'f'.repeat(64),
    baseUrl: 'https://modules.kernelsu.org',
    portalUrl: 'https://developers.kernelsu.org',
    policy: { limits: { a: 1 } },
    modules: [{ id: 'a.b', repositoryId: 1, lock: { x: 1, y: [1, 2] }, result: { status: 'ok', contentCommit: 'c'.repeat(40), digest: 'd' } }],
  };
  it('is canonical (key order does not matter) and sensitive to every input', () => {
    const id = computeBuildId(inputs);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(computeBuildId({ ...inputs, modules: [{ ...inputs.modules[0]!, lock: { y: [1, 2], x: 1 } }] })).toBe(id);
    expect(computeBuildId({ ...inputs, builder: 'e'.repeat(64) })).not.toBe(id);
    expect(computeBuildId({ ...inputs, baseUrl: 'https://example.org' })).not.toBe(id);
    expect(computeBuildId({ ...inputs, modules: [{ ...inputs.modules[0]!, result: { status: 'stale' } }] })).not.toBe(id);
  });

  it('fingerprint covers builder sources and the lockfile, not tests', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'kernelsu-fp-'));
    try {
      const put = (p: string, s: string) => {
        mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
        writeFileSync(path.join(root, p), s);
      };
      put('tools/build/src/build.ts', 'a');
      put('tools/build/test/x.test.ts', 't');
      put('site/src/pages/index.astro', 'p');
      put('site/node_modules/x/index.js', 'n');
      put('packages/render/src/x.test.ts', 't');
      put('pnpm-lock.yaml', 'l');
      expect(fingerprintFiles(root)).toEqual(['pnpm-lock.yaml', 'site/src/pages/index.astro', 'tools/build/src/build.ts']);
      const a = builderFingerprint(root);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      // the real repository: includes the builder and the site, excludes tests
      const real = fingerprintFiles();
      expect(real).toContain('tools/build/src/build.ts');
      expect(real).toContain('site/src/layouts/Layout.astro');
      expect(real).toContain('packages/validator/src/id.ts');
      expect(real).toContain('pnpm-lock.yaml');
      expect(real.some((p) => p.includes('/test/') || p.includes('node_modules'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('fetchFollow', () => {
  const chain = (hops: Record<string, { status: number; location?: string; body?: string }>): HttpGet & { calls: string[] } => {
    const calls: string[] = [];
    const g = (async (url: string) => {
      calls.push(url);
      const h = hops[url];
      if (!h) return { status: 404, headers: {}, body: new Uint8Array() };
      return { status: h.status, headers: h.location ? { location: h.location } : {}, body: te.encode(h.body ?? '') };
    }) as unknown as HttpGet & { calls: string[] };
    g.calls = calls;
    return g;
  };

  it('follows up to maxRedirects and re-checks every hop', async () => {
    const g = chain({
      'https://a.example/1': { status: 301, location: '/2' },
      'https://a.example/2': { status: 302, location: 'https://b.example/3' },
      'https://b.example/3': { status: 200, body: 'ok' },
    });
    const r = await fetchFollow(g, 'https://a.example/1', { maxRedirects: 2, maxBytes: 100 });
    expect(td.decode(r.body)).toBe('ok');
    expect(r.url).toBe('https://b.example/3');
    await expect(fetchFollow(g, 'https://a.example/1', { maxRedirects: 1, maxBytes: 100 })).rejects.toThrow(/too many redirects/);
  });

  it('refuses redirects to non-https or internal targets', async () => {
    const g = chain({
      'https://a.example/1': { status: 302, location: 'http://a.example/2' },
      'https://a.example/x': { status: 302, location: 'https://169.254.169.254/latest' },
    });
    await expect(fetchFollow(g, 'https://a.example/1', { maxRedirects: 3, maxBytes: 100 })).rejects.toMatchObject({ kind: 'policy' });
    await expect(fetchFollow(g, 'https://a.example/x', { maxRedirects: 3, maxBytes: 100 })).rejects.toMatchObject({ kind: 'policy' });
    expect(g.calls).not.toContain('https://169.254.169.254/latest');
  });

  it('enforces maxBytes and status', async () => {
    const g = chain({ 'https://a.example/big': { status: 200, body: 'x'.repeat(101) } });
    await expect(fetchFollow(g, 'https://a.example/big', { maxRedirects: 0, maxBytes: 100 })).rejects.toMatchObject({ kind: 'limit' });
    await expect(fetchFollow(g, 'https://a.example/none', { maxRedirects: 0, maxBytes: 100 })).rejects.toMatchObject({ kind: 'http', status: 404 });
  });
});

describe('sniffImage', () => {
  it('detects by magic bytes, not by name', () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffImage(te.encode('GIF89a....'))).toBe('gif');
    expect(sniffImage(te.encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(sniffImage(te.encode('﻿<?xml version="1.0"?>\n<!-- c --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    expect(sniffImage(te.encode('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'))).toBeNull();
    expect(sniffImage(te.encode('<html><svg></svg></html>'))).toBeNull();
    expect(sniffImage(te.encode('GIF87'))).toBeNull();
  });
});

describe('sanitizeSvg', () => {
  const clean = (s: string) => {
    const r = sanitizeSvg(te.encode(s));
    return r ? td.decode(r) : null;
  };

  it('keeps static drawing content', () => {
    const out = clean('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><rect width="10" height="10" fill="url(#g)"/><text x="1" y="5">hi &amp; bye</text></svg>');
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain('<linearGradient id="g">');
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('hi &amp; bye');
  });

  it.each([
    '<svg onload="alert(1)"><rect/></svg>',
    '<svg><script>alert(1)</script></svg>',
    '<svg><script xlink:href="https://x.example/a.js"/></svg>',
    '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg><a xlink:href="javascript:alert(1)"><rect/></a></svg>',
    '<svg><use href="https://evil.example/x.svg#a"/></svg>',
    '<svg><use xlink:href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=#x"/></svg>',
    '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>',
    '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
    '<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>',
    '<svg><style>@import url(https://evil.example/x.css)</style></svg>',
    '<svg><rect style="background:url(javascript:alert(1))"/></svg>',
    '<svg><rect fill="url(https://evil.example/track)"/></svg>',
    '<svg><image href="https://evil.example/track.png"/></svg>',
    '<svg><handler type="application/ecmascript">alert(1)</handler></svg>',
    '<svg><![CDATA[<script>alert(1)</script>]]></svg>',
    '<svg><rect><title><![CDATA[</title><script>alert(1)</script>]]></title></rect></svg>',
  ])('neutralizes %s', (s) => {
    const out = clean(s) ?? '';
    expect(out).not.toMatch(/<script|<a\b|<set|<animate|<foreignObject|<style|<image|<handler|on[a-z]+=|javascript:|evil\.example|data:/i);
  });

  it('rejects non-svg roots and entity declarations', () => {
    expect(clean('<html><body>x</body></html>')).toBeNull();
    expect(clean('<!DOCTYPE svg [<!ENTITY lol "lol">]><svg>&lol;</svg>')).toBeNull();
  });
});

describe('renderHeaders', () => {
  it('sets CSP, immutable assets and short API caching without conflicting Cache-Control rules', () => {
    const h = renderHeaders();
    expect(h).toContain("script-src 'self'");
    expect(h).not.toContain("'unsafe-inline'; script");
    expect(h).toContain("frame-ancestors 'none'");
    const rules = h.split(/\n(?=\/)/);
    const cc = rules.filter((r) => r.includes('Cache-Control')).map((r) => r.split('\n')[0]);
    expect(cc).not.toContain('/*');
    expect(h).toContain("img-src 'self' data:;");
    expect(h).not.toMatch(/img-src[^;]*https:/);
    expect(h).toContain('/api/v1/modules/:id/changelog.md\n  Content-Type: text/markdown; charset=utf-8');
  });
});

describe('checkHtmlCsp', () => {
  it('accepts external same-origin scripts/styles and text that merely looks like markup', () => {
    const ok =
      '<!doctype html><html><head><link rel="stylesheet" href="/assets/0123456789abcdef.css"><link rel="icon" href="/favicon.ico">' +
      '<link rel="canonical" href="https://modules.kernelsu.org/"><script type="module" src="/assets/0123456789abcdef.js"></script></head>' +
      '<body><pre><code>style="x" &lt;script&gt;alert(1)&lt;/script&gt; onclick="y"</code></pre><img src="/assets/0123456789abcdef.png" srcset="/assets/0123456789abcdef.png 2x">' +
      '<img src="data:image/png;base64,AA=="><a href="https://img.example.com/a.png" class="image-link">a</a><noscript><p>Enable JavaScript</p></noscript></body></html>';
    expect(checkHtmlCsp(ok)).toEqual([]);
  });
  it.each([
    ['<script>alert(1)</script>', /inline <script> without src/],
    ['<script src="/a.js">alert(1)</script>', /inline body/],
    ['<script src="https://cdn.example.com/a.js"></script>', /third-party <script/],
    ['<script src="//cdn.example.com/a.js"></script>', /third-party <script/],
    ['<style>body{}</style>', /inline <style>/],
    ['<div style="color:red"></div>', /inline style attribute/],
    ['<img src="/a.png" onerror="x()">', /event handler onerror/],
    ['<a href=" javascript:alert(1)">x</a>', /javascript:\/vbscript: URL/],
    ['<a href="vbscript:msgbox">x</a>', /vbscript: URL/],
    ['<a href="data:text/html,<script>alert(1)</script>">x</a>', /data: URL in href/],
    ['<form action="data:text/html,x"></form>', /data: URL in action/],
    ['<svg><animate attributeName="href" values="#a; javascript:alert(1)"/></svg>', /animates to a javascript: URL/],
    ['<svg><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>', /animates to a javascript: URL/],
    ['<noscript><script src="/a.js"></script></noscript>', /<noscript> contains a <script>/],
    ['<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>', /<noscript> contains markup inside an attribute/],
    ['<link rel="preconnect" href="https://evil.example">', /third-party <link rel="preconnect"/],
    ['<link rel="dns-prefetch" href="//evil.example">', /third-party <link rel="dns-prefetch"/],
    ['<link rel="prefetch" href="https://evil.example/x">', /third-party <link rel="prefetch"/],
    ['<link rel="preload" as="image" href="https://evil.example/x.png">', /third-party <link rel="preload"/],
    ['<img src="https://evil.example/track.gif">', /third-party image/],
    ['<img src="/a.png" srcset="https://evil.example/a.png 2x">', /third-party image/],
    ['<picture><source srcset="https://evil.example/d.png"><img src="/a.png"></picture>', /third-party image <source/],
    ['<link rel="stylesheet" href="https://fonts.example.com/a.css">', /third-party <link/],
    ['<iframe src="/x"></iframe>', /<iframe> element/],
    ['<meta http-equiv="refresh" content="0;url=/x">', /refresh/],
  ])('rejects %s', (html, re) => {
    expect(checkHtmlCsp(html).join('\n')).toMatch(re);
  });
  it('assertCspClean reports file paths', () => {
    expect(() => assertCspClean([['en/index.html', '<p style="x">']])).toThrow(/en\/index\.html: <p> has an inline style attribute/);
  });
});
