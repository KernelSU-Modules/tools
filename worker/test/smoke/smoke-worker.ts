// Smoke/benchmark Worker for the real workerd runtime (not deployed; run with `pnpm smoke`).
// workerd freezes Date.now() between I/O events, so each measurement ends with a timer tick to observe the
// elapsed wall time of the synchronous work (≈ CPU time; includes <1 ms timer latency).
import { GitHubApp } from '@kernelsu-modules/github';
import { DEFAULT_POLICY } from '@kernelsu-modules/schema';
import { crc32, rangeReaderFromUrl, validateReleaseAsset, zipLimitsFromPolicy } from '@kernelsu-modules/validator';
import { renderMarkdown } from '@kernelsu-modules/render';
import YAML from 'yaml';
import { seal, unseal } from '../../src/lib/crypto.ts';
import { parseRecord, serializeRecord } from '../../src/domain/yaml.ts';
import { parseStatus } from '../../src/domain/data.ts';
import { syncTargetsByRepo } from '../../src/domain/state.ts';
import { csrfToken, verifyCsrf } from '../../src/lib/session.ts';

const enc = new TextEncoder();
const tick = () => new Promise((r) => setTimeout(r, 0));
async function measure<T>(fn: () => Promise<T> | T, runs = 5): Promise<{ ms: number[]; value: T }> {
  const ms: number[] = [];
  let value!: T;
  for (let i = 0; i < runs; i++) {
    await tick();
    const t0 = Date.now();
    value = await fn();
    await tick();
    ms.push(Date.now() - t0);
  }
  return { ms, value };
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function makeDeflateZip(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const comp = await deflateRaw(data);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(8, 8, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, comp.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameB.length, true);
    parts.push(new Uint8Array(lh.buffer), nameB, comp);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(10, 8, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, comp.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + comp.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const n = Object.keys(files).length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, n, true);
  eocd.setUint16(10, n, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((k, p) => k + p.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

function rangeFetch(bytes: Uint8Array): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range')!;
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range)!;
    const start = Number(a);
    const end = Math.min(Number(b), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1) as BodyInit, {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` },
    });
  }) as typeof fetch;
}

async function pkcs1Pem(): Promise<string> {
  const kp = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer);
  let bin = '';
  for (const x of der) bin += String.fromCharCode(x);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;
}

const record = (i: number) =>
  serializeRecord({
    id: `mod.n${i}`,
    status: 'listed',
    source: { host: 'github', repositoryId: 1000 + i, ownerId: 5000 + i, fullName: `owner${i}/repo${i}`, manifestPath: 'module.yaml' },
    review: {
      submissionId: 'abcdefghij',
      kind: 'submit',
      submittedBy: 1,
      submittedAt: '2026-10-10T00:00:00Z',
      decision: 'approved',
      decidedBy: 2,
      decidedVia: 'telegram',
      decidedAt: '2026-10-10T01:00:00Z',
      reason: null,
      telegram: { chatId: -100123, messageId: 42 },
    },
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-10T00:00:00Z',
  });

export default {
  async fetch(): Promise<Response> {
    const out: Record<string, unknown> = { runtime: navigator.userAgent };

    // 1. precheck ZIP path: inspectZip + module.prop via HTTP Range, deflate-raw entries.
    const files: Record<string, Uint8Array> = {
      'module.prop': enc.encode('id=demo.toolbox\nname=Demo\nversion=v1.2.3\nversionCode=123\nauthor=me\ndescription=smoke\n'),
      'system/bin/tool': crypto.getRandomValues(new Uint8Array(60000)),
    };
    for (let i = 0; i < 2000; i++) files[`system/etc/file${i}.txt`] = enc.encode(`file ${i}\n`.repeat(20));
    const zip = await makeDeflateZip(files);
    const zipRun = await measure(async () => {
      const reader = await rangeReaderFromUrl('https://github.com/a/b/releases/download/v1/x.zip', { size: zip.length, fetch: rangeFetch(zip) });
      const r = await validateReleaseAsset({ reader, expectedId: 'demo.toolbox', limits: zipLimitsFromPolicy(DEFAULT_POLICY) });
      return { ok: r.ok, versionCode: r.value?.versionCode, entries: r.value?.entries, issues: r.issues.map((i) => i.code), requests: reader.requests };
    });
    out.precheckZip = { zipBytes: zip.length, entries: 2002, ms: zipRun.ms, result: zipRun.value };

    // 2. RS256 App JWT (import key + sign) — first call per isolate, then memoized.
    const pem = await pkcs1Pem();
    out.jwtColdMs = (await measure(() => new GitHubApp({ appId: 1, privateKey: pem }).jwt())).ms;
    const app = new GitHubApp({ appId: 1, privateKey: pem });
    await app.jwt();
    out.jwtWarmMs = (await measure(() => app.jwt())).ms;

    // 3. YAML+zod parse of N records (cold snapshot build), and JSON.parse of the cached snapshot.
    for (const n of [50, 300]) {
      const texts = Array.from({ length: n }, (_, i) => record(i));
      const parsed = await measure(() => texts.map(parseRecord), 3);
      const json = JSON.stringify({ records: Object.fromEntries(parsed.value.map((r) => [r.id, r])) });
      out[`yamlParse${n}Ms`] = parsed.ms;
      out[`snapshotJsonParse${n}`] = { bytes: json.length, ms: (await measure(() => JSON.parse(json), 3)).ms };
      // webhook routing index (repoId -> module), once per snapshot
      out[`webhookIndex${n}Ms`] = (await measure(() => syncTargetsByRepo(parsed.value).size, 3)).ms;
      // status.json (written by the sync; read instead of the lock): fetch+parse once per change, then cached JSON
      const status = JSON.stringify({
        schemaVersion: 1,
        modules: Object.fromEntries(
          Array.from({ length: n }, (_, i) => [
            `mod.n${i}`,
            {
              repositoryId: 1000 + i,
              fullName: `owner${i}/repo${i}`,
              health: 'ok',
              installation: 'present',
              lastSuccessAt: '2026-10-10T00:00:00Z',
              message: null,
              contentCommit: 'a'.repeat(40),
              stable: { tag: 'v1.2.3', version: 'v1.2.3', versionCode: 123, publishedAt: '2026-10-01T00:00:00Z' },
              maxVersionCode: 123,
              request: null,
            },
          ]),
        ),
      }, null, 2);
      out[`statusParse${n}`] = { bytes: status.length, ms: (await measure(() => Object.keys(parseStatus(status).modules).length, 3)).ms };
    }

    // 4. Markdown render (~32 KB README) — now done client-side by the SPA (/api/preview returns raw Markdown);
    //    measured here only as a reference for the browser/site build.
    const md = Array.from({ length: 200 }, (_, i) => `## Section ${i}\n\nSome *text* with a [link](docs/x.md) and ![img](a.png) <b>html</b> :+1:\n\n- a\n- b\n`).join('\n');
    out.renderReferenceNotInWorker = { mdBytes: md.length, ms: (await measure(() => renderMarkdown(md, { fullName: 'a/b', commit: '0'.repeat(40), docPath: 'README.md' }).html.length, 3)).ms };

    // 5. Session cookie seal/unseal.
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const sess = { v: 1, sid: 'x', uid: 1, login: 'alice', avatar: 'https://a/1', at: 'ghu_' + 'x'.repeat(36), atExp: Date.now() + 1e7, rt: 'ghr_' + 'y'.repeat(76) };
    out.sessionMs = (await measure(async () => unseal(key, await seal(key, sess, 'c'), 'c'))).ms;
    const env = { SESSION_KEY: key } as never;
    const sd = { ...sess, exp: Date.now() + 1e9 } as never;
    const tok = await csrfToken(env, sd);
    out.csrfVerifyMs = (await measure(() => verifyCsrf(env, sd, tok))).ms;
    out.yamlVersion = typeof YAML.parse;
    return Response.json(out);
  },
};
