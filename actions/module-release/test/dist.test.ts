// Runs the committed bundle (dist/index.js) as the Actions runner would, against a local fake GitHub.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeGitHub, MANIFEST, PROP, moduleZip, readOutputs, workspace } from './helpers.ts';

const dist = fileURLToPath(new URL('../dist/index.js', import.meta.url));
let server: Server | undefined;
afterEach(() => server?.close());

async function serve(repo = 'demo/mod'): Promise<{ gh: FakeGitHub; base: string }> {
  let gh!: FakeGitHub;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const isJson = (req.headers['content-type'] ?? '').includes('json');
    const r = await gh.fetch(`${base}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: raw.length ? (isJson ? raw.toString('utf8') : new Uint8Array(raw)) : undefined,
    });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  gh = new FakeGitHub(repo, base);
  return { gh, base };
}

function runDist(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [dist], { env: { PATH: process.env.PATH ?? '', ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => ok({ code: code ?? -1, out }));
  });
}

describe.skipIf(!existsSync(dist))('dist/index.js', () => {
  it('publishes end-to-end through real fetch', async () => {
    const { gh, base } = await serve();
    gh.addRelease({ tag: 'v0.9', assets: { 'demo_mod-1-v0.9.zip': moduleZip({ ...PROP, versionCode: 1 }) } });
    const ws = workspace(MANIFEST);
    writeFileSync(join(ws, 'module.zip'), moduleZip());
    const env = {
      GITHUB_WORKSPACE: ws,
      GITHUB_REPOSITORY: 'demo/mod',
      GITHUB_REF: 'refs/tags/v1.0',
      GITHUB_API_URL: base,
      GITHUB_OUTPUT: join(ws, 'out'),
      INPUT_TOKEN: 't',
      INPUT_ZIP: 'module.zip',
      'INPUT_REQUIRE-IMMUTABLE': 'true',
    };
    const { code, out } = await runDist(env);
    expect(code, out).toBe(0);
    expect(gh.writes().map((w) => w.split(' ')[0])).toEqual(['POST', 'POST', 'PATCH']);
    expect(gh.calls.some((c) => c.headers.get('range'))).toBe(true);
    expect(readOutputs(env.GITHUB_OUTPUT)['asset-name']).toBe('demo_mod-2-v1.0.zip');
  });

  it('exits non-zero and publishes nothing on precheck errors', async () => {
    const { gh, base } = await serve();
    const ws = workspace({ ...MANIFEST, id: 'other' });
    writeFileSync(join(ws, 'module.zip'), moduleZip());
    const { code, out } = await runDist({
      GITHUB_WORKSPACE: ws,
      GITHUB_REPOSITORY: 'demo/mod',
      GITHUB_REF: 'refs/tags/v1.0',
      GITHUB_API_URL: base,
      INPUT_TOKEN: 't',
      INPUT_ZIP: 'module.zip',
    });
    expect(code).toBe(1);
    expect(out).toMatch(/::error title=prop-id-mismatch::/);
    expect(gh.writes()).toEqual([]);
  });

  it('publishes to a distribution repository with a metadata commit (external mode)', async () => {
    const { gh, base } = await serve('dist/mod');
    const seed = gh.commitFiles({ 'README.md': 'old' });
    const ws = workspace({ ...MANIFEST, icon: 'icon.png' }, { 'README.md': '# Demo\n\n![s](shot.png)\n', 'icon.png': 'ICON', 'shot.png': 'SHOT' });
    writeFileSync(join(ws, 'module.zip'), moduleZip());
    const env = {
      GITHUB_WORKSPACE: ws,
      GITHUB_REPOSITORY: 'demo/private',
      GITHUB_REF: 'refs/tags/v1.0',
      GITHUB_API_URL: base,
      GITHUB_OUTPUT: join(ws, 'out'),
      INPUT_TOKEN: 'pat',
      'INPUT_WORKFLOW-TOKEN': 'ghs_x',
      INPUT_REPOSITORY: 'dist/mod',
      INPUT_ZIP: 'module.zip',
    };
    const { code, out } = await runDist(env);
    expect(code, out).toBe(0);
    const head = gh.refs.get('heads/main')!;
    expect(head).not.toBe(seed);
    expect(gh.refs.get('tags/v1.0')).toBe(head);
    expect(gh.fileAt('shot.png')).toBe('SHOT');
    expect(readOutputs(env.GITHUB_OUTPUT)).toMatchObject({ repository: 'dist/mod', 'metadata-commit': head });
  });
});
