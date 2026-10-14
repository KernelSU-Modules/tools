import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ModuleManifest } from '@kernelsu-modules/schema';
import type { Logger } from '../src/actions.ts';
import type { Issue, ReleaseLike, Validator } from '../src/validator-api.ts';
import { createZip } from '../src/zip.ts';
import { gitBlobSha, WRITE_PROBE } from '../src/external.ts';

export function tempDir(prefix = 'kernelsu-mr-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function prop(fields: Record<string, string | number>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n';
}

export const PROP = { id: 'demo_mod', name: 'Demo', version: 'v1.0', versionCode: 2, author: 'me', description: 'demo' };

export function moduleZip(p: Record<string, string | number> = PROP, extra: Record<string, string> = {}): Uint8Array {
  const enc = new TextEncoder();
  return createZip([
    { name: 'module.prop', data: enc.encode(prop(p)), mode: 0o100644 },
    { name: 'customize.sh', data: enc.encode('#!/system/bin/sh\n'), mode: 0o100755 },
    ...Object.entries(extra).map(([name, c]) => ({ name, data: enc.encode(c), mode: 0o100644 })),
  ]);
}

/** Extract one stored/deflated entry by name (test-only ZIP reader). */
export function extractEntry(bytes: Uint8Array, name: string): Uint8Array | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const entry = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    if (entry === name) {
      const lnlen = dv.getUint16(off + 26, true);
      const lelen = dv.getUint16(off + 28, true);
      const data = bytes.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
      return method === 8 ? new Uint8Array(inflateRawSync(data)) : data;
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}

const globRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');

/** Fake implementation of the validator surface used by the action. */
export const fakeValidator: Validator = {
  checkModuleId: (id, policy) =>
    policy.id.reservedIds.includes(id.toLowerCase()) ? [{ code: 'id-reserved', severity: 'error', message: `"${id}" is reserved` }] : [],
  parseManifest(text) {
    let data: unknown;
    try {
      data = JSON.parse(text); // tests write JSON, which is valid YAML
    } catch (e) {
      return { ok: false, issues: [{ code: 'manifest-yaml', severity: 'error', message: String(e) }] };
    }
    const r = ModuleManifest.safeParse(data);
    return r.success
      ? { ok: true, value: r.data, issues: [] }
      : { ok: false, issues: [{ code: 'manifest-schema', severity: 'error', message: r.error.message }] };
  },
  manifestReferencedPaths: (m) => [...new Set([...(m.icon ? [m.icon] : []), m.description])],
  parseModuleProp(text) {
    const props: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) props[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const issues: Issue[] = [];
    for (const f of ['id', 'name', 'version', 'versionCode', 'author', 'description'])
      if (!props[f]) issues.push({ code: 'prop-missing-field', severity: 'error', message: `missing ${f}` });
    if (issues.length) return { ok: false, issues };
    return {
      ok: true,
      issues,
      value: { props, id: props.id!, name: props.name!, version: props.version!, versionCode: Number(props.versionCode), author: props.author!, description: props.description! },
    };
  },
  rangeReaderFromBytes: (bytes) => ({ size: bytes.length, read: async (o, l) => bytes.subarray(o, o + l) }),
  async rangeReaderFromUrl(url, opts) {
    const res = await (opts?.fetch ?? fetch)(url, { headers: opts?.headers });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return fakeValidator.rangeReaderFromBytes(bytes);
  },
  async inspectZip(reader) {
    const bytes = await reader.read(0, reader.size);
    const p = extractEntry(bytes, 'module.prop');
    if (!p) return { ok: false, issues: [{ code: 'prop-missing', severity: 'error', message: 'no module.prop' }] };
    return { ok: true, issues: [], value: { entries: 1, uncompressedTotal: p.length, moduleProp: new TextDecoder().decode(p), files: ['module.prop'] } };
  },
  /** Only the kind cross-check (the real rules are covered by the integration test). */
  checkReleaseKind({ kind, props }) {
    const oneshot = /^(1|true)$/i.test((props.oneshot ?? '').trim());
    return kind !== undefined && oneshot !== (kind === 'script') ? [{ code: 'manifest-kind-mismatch', severity: 'error', message: 'kind' }] : [];
  },
  selectAsset(release, pattern) {
    const m = release.assets.filter((a) => (pattern ? globRe(pattern).test(a.name) : a.name.endsWith('.zip')));
    if (m.length === 1) return { ok: true, value: m[0]!, issues: [] };
    return { ok: false, issues: [{ code: m.length ? 'asset-multiple' : 'asset-none', severity: 'error', message: 'select' }] };
  },
  globMatch: (pattern, name) => globRe(pattern).test(name),
};

const isProbe = (c: Call) => c.method === 'POST' && /\/git\/blobs$/.test(c.url.pathname) && (c.body as { content?: string } | undefined)?.content === WRITE_PROBE;

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body?: unknown;
}

/** In-memory GitHub REST fake: releases + assets for one repo. */
export class FakeGitHub {
  calls: Call[] = [];
  releases: (ReleaseLike & { html_url: string; upload_url: string; body?: string; name?: string })[] = [];
  assetBytes = new Map<number, Uint8Array>();
  nextId = 1000;
  immutableOnPublish = true;
  failUpload = false;
  renameUploadTo: string | null = null;
  /** Apply the publish PATCH but answer with this HTTP status (simulates a lost / failed response). */
  publishResponseStatus: number | null = null;
  /** Answer GET /releases/{id} with this HTTP status. */
  releaseGetStatus: number | null = null;

  /* ---- repository metadata + Git Data (external mode) ---- */
  /** GET /repos/{repo}; null -> 404. */
  repoInfo: Record<string, unknown> | null;
  /** GET /immutable-releases: 200 answers { enabled: immutableEnabled }. */
  immutableStatus = 200;
  immutableEnabled = true;
  /** Extra headers on every JSON response (e.g. github-authentication-token-expiration). */
  responseHeaders: Record<string, string> = {};
  blobs = new Map<string, Uint8Array>();
  /** tree sha -> flat path -> entry */
  trees = new Map<string, Map<string, { sha: string; mode: string; type: 'blob' | 'commit' }>>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  /** "heads/main" / "tags/v1.0" -> commit sha */
  refs = new Map<string, string>();
  /** Before answering the next PATCH of a branch ref, move the branch (simulates a concurrent push). */
  raceNextRefUpdate = false;
  private seq = 0;

  private gitSha(kind: string, data: string): string {
    return createHash('sha1').update(`${kind}:${this.seq++}:${data}`).digest('hex');
  }

  /** Create a commit on `branch` with these files on top of its current tree. Returns the commit sha. */
  commitFiles(files: Record<string, string | Uint8Array>, branch = 'main', message = 'seed'): string {
    const parent = this.refs.get(`heads/${branch}`);
    const base = parent ? new Map(this.trees.get(this.commits.get(parent)!.tree)!) : new Map();
    for (const [path, c] of Object.entries(files)) {
      const bytes = typeof c === 'string' ? new TextEncoder().encode(c) : c;
      const sha = gitBlobSha(bytes);
      this.blobs.set(sha, bytes);
      base.set(path, { sha, mode: '100644', type: 'blob' });
    }
    const tree = this.gitSha('tree', JSON.stringify([...base]));
    this.trees.set(tree, base);
    const commit = this.gitSha('commit', tree);
    this.commits.set(commit, { tree, parents: parent ? [parent] : [], message });
    this.refs.set(`heads/${branch}`, commit);
    return commit;
  }

  /** File content at the tip of `branch` (null if absent). */
  fileAt(path: string, branch = 'main'): string | null {
    const head = this.refs.get(`heads/${branch}`);
    const e = head ? this.trees.get(this.commits.get(head)!.tree)!.get(path) : undefined;
    return e ? new TextDecoder().decode(this.blobs.get(e.sha)!) : null;
  }

  private gitData(method: string, path: string, url: URL, body: any, json: (s: number, d: unknown) => Response): Response | null {
    const base = `/repos/${this.repo}`;
    if (method === 'GET' && path === base) return this.repoInfo ? json(200, this.repoInfo) : json(404, { message: 'Not Found' });
    if (method === 'GET' && path === `${base}/immutable-releases`)
      return this.immutableStatus === 200 ? json(200, { enabled: this.immutableEnabled, enforced_by_owner: false }) : json(this.immutableStatus, { message: 'x' });
    if (!path.startsWith(`${base}/git/`)) return null;
    const rest = path.slice(`${base}/git/`.length);
    let m: RegExpMatchArray | null;
    if (method === 'GET' && (m = rest.match(/^ref\/(heads|tags)\/(.+)$/))) {
      const name = `${m[1]}/${m[2]!.split('/').map(decodeURIComponent).join('/')}`;
      const sha = this.refs.get(name);
      if (!sha && m[1] === 'heads' && this.refs.size === 0) return json(409, { message: 'Git Repository is empty.' });
      return sha ? json(200, { ref: `refs/${name}`, object: { type: 'commit', sha } }) : json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (m = rest.match(/^commits\/([0-9a-f]+)$/))) {
      const c = this.commits.get(m[1]!);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }) : json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && (m = rest.match(/^trees\/([0-9a-f]+)$/))) {
      const t = this.trees.get(m[1]!);
      if (!t) return json(404, { message: 'Not Found' });
      const entries: { path: string; mode: string; type: string; sha: string }[] = [];
      const dirs = new Set<string>();
      for (const [p, e] of t) {
        const segs = p.split('/');
        for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
        entries.push({ path: p, mode: e.mode, type: e.type, sha: e.sha });
      }
      for (const d of dirs) entries.push({ path: d, mode: '040000', type: 'tree', sha: createHash('sha1').update(d).digest('hex') });
      return json(200, { sha: m[1], tree: entries, truncated: false });
    }
    if (method === 'POST' && rest === 'blobs') {
      if (body.content === WRITE_PROBE && this.probeStatus) return json(this.probeStatus, { message: 'Resource not accessible by personal access token' });
      const bytes = new Uint8Array(Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8'));
      const sha = gitBlobSha(bytes);
      this.blobs.set(sha, bytes);
      return json(201, { sha });
    }
    if (method === 'POST' && rest === 'trees') {
      const t = new Map(body.base_tree ? this.trees.get(body.base_tree)! : []);
      for (const it of body.tree as { path: string; mode: string; type: 'blob'; sha: string }[]) {
        if (!this.blobs.has(it.sha)) return json(422, { message: 'tree.sha not found' });
        t.set(it.path, { sha: it.sha, mode: it.mode, type: it.type });
      }
      const sha = this.gitSha('tree', JSON.stringify([...t]));
      this.trees.set(sha, t);
      return json(201, { sha });
    }
    if (method === 'POST' && rest === 'commits') {
      const sha = this.gitSha('commit', body.tree);
      this.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return json(201, { sha });
    }
    if (method === 'PATCH' && (m = rest.match(/^refs\/heads\/(.+)$/))) {
      const name = `heads/${decodeURIComponent(m[1]!)}`;
      if (this.raceNextRefUpdate) {
        this.raceNextRefUpdate = false;
        this.commitFiles({ 'CONCURRENT.md': 'someone else' }, name.slice('heads/'.length), 'concurrent');
      }
      const cur = this.refs.get(name);
      const c = this.commits.get(body.sha);
      if (!c) return json(422, { message: 'Object does not exist' });
      if (!body.force && cur && !c.parents.includes(cur)) return json(422, { message: 'Update is not a fast forward' });
      this.refs.set(name, body.sha);
      return json(200, { ref: `refs/${name}`, object: { type: 'commit', sha: body.sha } });
    }
    if (method === 'POST' && rest === 'refs') {
      const name = String(body.ref).replace(/^refs\//, '');
      if (this.refs.has(name)) return json(422, { message: 'Reference already exists' });
      if (!this.commits.has(body.sha)) return json(422, { message: 'Object does not exist' });
      this.refs.set(name, body.sha);
      return json(201, { ref: body.ref, object: { type: 'commit', sha: body.sha } });
    }
    return null;
  }

  constructor(
    readonly repo = 'demo/mod',
    readonly uploadBase = 'https://uploads.github.com',
  ) {
    this.repoInfo = {
      full_name: repo,
      private: false,
      visibility: 'public',
      archived: false,
      default_branch: 'main',
      permissions: { admin: true, push: true, pull: true },
    };
  }

  addRelease(r: { tag: string; prerelease?: boolean; draft?: boolean; immutable?: boolean; publishedAt?: string; assets?: Record<string, Uint8Array> }) {
    const id = this.nextId++;
    const assets = Object.entries(r.assets ?? {}).map(([name, bytes]) => {
      const aid = this.nextId++;
      this.assetBytes.set(aid, bytes);
      return { id: aid, name, size: bytes.length, digest: null, state: 'uploaded', browser_download_url: `https://github.com/${this.repo}/releases/download/${r.tag}/${name}` };
    });
    this.releases.push({
      id,
      tag_name: r.tag,
      draft: r.draft ?? false,
      prerelease: r.prerelease ?? false,
      immutable: r.immutable ?? true,
      published_at: r.draft ? null : (r.publishedAt ?? '2026-01-01T00:00:00Z'),
      assets,
      html_url: `https://github.com/${this.repo}/releases/tag/${r.tag}`,
      upload_url: `${this.uploadBase}/repos/${this.repo}/releases/${id}/assets{?name,label}`,
    });
    return id;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body;
    if (typeof body === 'string') body = JSON.parse(body);
    this.calls.push({ method, url, headers, body });
    const json = (status: number, data: unknown) =>
      new Response(data === null ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...this.responseHeaders } });
    const base = `/repos/${this.repo}`;
    const path = url.pathname;
    const git = this.gitData(method, path, url, body, json);
    if (git) return git;
    const up = method === 'POST' ? path.match(new RegExp(`^${base}/releases/(\\d+)/assets$`)) : null;
    if (up) {
      const id = Number(up[1]);
      const rel = this.releases.find((r) => r.id === id);
      if (!rel || this.failUpload) return json(500, { message: 'boom' });
      const bytes = body as Uint8Array;
      const aid = this.nextId++;
      this.assetBytes.set(aid, bytes);
      const { createHash } = await import('node:crypto');
      const asset = {
        id: aid,
        name: this.renameUploadTo ?? url.searchParams.get('name')!,
        size: bytes.length,
        state: 'uploaded',
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        browser_download_url: `https://github.com/${this.repo}/releases/download/${rel.tag_name}/${url.searchParams.get('name')}`,
      };
      rel.assets.push(asset);
      return json(201, asset);
    }
    if (method === 'GET' && path.startsWith(`${base}/releases/tags/`)) {
      const tag = decodeURIComponent(path.slice(`${base}/releases/tags/`.length));
      const r = this.releases.find((x) => x.tag_name === tag && !x.draft);
      return r ? json(200, r) : json(404, { message: 'Not Found' });
    }
    if (method === 'GET' && path === `${base}/releases`) {
      const sorted = [...this.releases].sort((a, b) => b.id - a.id);
      return json(200, sorted);
    }
    const am = path.match(new RegExp(`^${base}/releases/assets/(\\d+)$`));
    if (method === 'GET' && am) {
      const bytes = this.assetBytes.get(Number(am[1]));
      if (!bytes) return json(404, { message: 'Not Found' });
      const range = headers.get('range');
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d+)/)!;
        const s = Number(m[1]);
        const e = Math.min(Number(m[2]), bytes.length - 1);
        return new Response(bytes.slice(s, e + 1), { status: 206, headers: { 'content-range': `bytes ${s}-${e}/${bytes.length}` } });
      }
      return new Response(bytes.slice(), { status: 200, headers: { 'content-length': String(bytes.length) } });
    }
    if (method === 'POST' && path === `${base}/releases`) {
      const b = body as { tag_name: string; prerelease: boolean; draft: boolean; body: string; name: string };
      const id = this.addRelease({ tag: b.tag_name, prerelease: b.prerelease, draft: true, immutable: false });
      const r = this.releases.find((x) => x.id === id)!;
      r.body = b.body;
      r.name = b.name;
      return json(201, r);
    }
    const rm = path.match(new RegExp(`^${base}/releases/(\\d+)$`));
    if (rm) {
      const idx = this.releases.findIndex((x) => x.id === Number(rm[1]));
      if (idx < 0) return json(404, { message: 'Not Found' });
      const r = this.releases[idx]!;
      if (method === 'GET') return this.releaseGetStatus ? json(this.releaseGetStatus, { message: 'boom' }) : json(200, r);
      if (method === 'DELETE') {
        this.releases.splice(idx, 1);
        return json(204, null);
      }
      if (method === 'PATCH') {
        if ((body as { draft?: boolean }).draft === false) {
          r.draft = false;
          r.published_at = '2026-10-10T00:00:00Z';
          r.immutable = this.immutableOnPublish;
        }
        if (this.publishResponseStatus) return json(this.publishResponseStatus, { message: 'boom' });
        return json(200, r);
      }
    }
    return json(404, { message: `unhandled ${method} ${url}` });
  };

  /** Answer the write-probe blob with this HTTP status (null = accept). */
  probeStatus: number | null = null;

  /** Visible writes (the write-probe blob is excluded: it is never referenced by anything). */
  writes(): string[] {
    return this.calls
      .filter((c) => c.method !== 'GET' && c.method !== 'HEAD' && !isProbe(c)).map((c) => `${c.method} ${/\/assets$/.test(c.url.pathname) && c.method === 'POST' ? 'upload' : c.url.pathname}`);
  }
}

export function memoryLogger() {
  const lines: string[] = [];
  const log: Logger = {
    info: (m) => lines.push(m),
    warning: (m, p) => lines.push(`WARN[${p?.title ?? ''}] ${m}`),
    error: (m, p) => lines.push(`ERR[${p?.title ?? ''}] ${m}`),
    notice: (m) => lines.push(`NOTICE ${m}`),
    group: async (_t, fn) => fn(),
  };
  return { log, lines };
}

/** Workspace with module.yaml (JSON form), README and icon. */
export function workspace(manifest: Record<string, unknown> | null, files: Record<string, string> = {}): string {
  const dir = tempDir();
  if (manifest) writeFileSync(join(dir, 'module.yaml'), JSON.stringify(manifest, null, 2));
  for (const [p, c] of Object.entries({ 'README.md': '# Demo\n', ...files })) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

export const MANIFEST = {
  schemaVersion: 1,
  id: 'demo_mod',
  name: 'Demo',
  summary: 'Demo module',
  description: 'README.md',
};

export function readOutputs(file: string): Record<string, string> {
  const text = readFileSync(file, 'utf8');
  const out: Record<string, string> = {};
  const re = /^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
  for (const m of text.matchAll(re)) out[m[1]!] = m[3]!;
  return out;
}
