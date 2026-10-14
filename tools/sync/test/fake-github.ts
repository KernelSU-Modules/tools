// In-memory fake of the GitHub REST endpoints used by sync, exposed as a `fetch` implementation.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { crc32 } from 'node:zlib';

export const enc = new TextEncoder();
const sha1 = (s: string | Uint8Array) => createHash('sha1').update(s).digest('hex');
export const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

let keyCache: string | null = null;
export function testPrivateKey(): string {
  keyCache ??= generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  return keyCache;
}

/** Minimal ZIP writer (stored entries) for fixtures. */
export function makeZip(entries: { name: string; data: string | Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const name = enc.encode(e.name);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    parts.push(lh, name, data);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, eocd]));
}

export function moduleZip(id: string, versionCode: number, version = `v${versionCode}`, extraProp = ''): Uint8Array {
  const prop = `id=${id}\nname=Demo\nversion=${version}\nversionCode=${versionCode}\nauthor=Demo Author\ndescription=Demo module\n${extraProp}`;
  return makeZip([
    { name: 'module.prop', data: prop },
    { name: 'service.sh', data: '#!/system/bin/sh\necho hi\n' },
  ]);
}

/**
 * A one-shot script entry ZIP: module.prop (+ `propLines`, default oneshot=true) and action.sh; `extra` adds or
 * replaces root files (null removes one).
 */
export function scriptZip(id: string, versionCode: number, extra: Record<string, string | null> = {}, propLines = 'oneshot=true\n'): Uint8Array {
  const prop = `id=${id}\nname=Demo\nversion=v${versionCode}\nversionCode=${versionCode}\nauthor=Demo Author\ndescription=Demo script\n${propLines}`;
  const files: Record<string, string | null> = { 'module.prop': prop, 'action.sh': '#!/system/bin/sh\necho done\n', ...extra };
  return makeZip(Object.entries(files).flatMap(([name, data]) => (data === null ? [] : [{ name, data }])));
}

export interface FakeAsset {
  id: number;
  name: string;
  size: number;
  digest?: string | null;
  browser_download_url: string;
  state?: string;
}
export interface FakeRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  immutable?: boolean;
  published_at: string | null;
  html_url: string;
  assets: FakeAsset[];
}

export interface FakeRepo {
  id: number;
  fullName: string;
  ownerId: number;
  defaultBranch: string;
  private?: boolean;
  /** stargazers_count (default 0). */
  stars?: number;
  branches: Record<string, string>;
  /** commit sha -> path -> content */
  commits: Record<string, Record<string, string | Uint8Array>>;
  /** tag -> commit sha (annotated: dereferenced through a tag object) */
  tags: Record<string, { commit: string; annotated?: boolean }>;
  releases: FakeRelease[];
  assetBytes: Map<number, Uint8Array>;
}

export interface Req {
  method: string;
  url: string;
  auth: string | null;
  ifNoneMatch: string | null;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const notFound = () => json({ message: 'Not Found' }, 404);

export class FakeGitHub {
  requests: Req[] = [];
  installations = new Map<number, number>(); // repositoryId -> installation id
  repos = new Map<number, FakeRepo>();
  checkRuns: { id: number; repo: string; head_sha: string; external_id: string; conclusion: string; output: { title: string; summary: string }; actions: unknown[]; app: { id: number } }[] = [];
  /** asset id -> number of times the CDN served it */
  downloads = new Map<number, number>();
  /** asset ids for which the CDN returns 500 */
  failingAssets = new Set<number>();
  /** Status to return for installation-token creation (401 to simulate auth failure). */
  tokenStatus = 201;
  /** Injected failures: first matching rule answers instead of the normal route. */
  failures: { method?: string; match: RegExp; status: number; body?: unknown; headers?: Record<string, string>; times?: number }[] = [];
  private nextId = 1000;
  private blobs = new Map<string, Uint8Array>();
  private tagObjects = new Map<string, string>();

  // ---- data repo (Git Data API) ----
  dataRepo = { fullName: 'KernelSU-Modules/repo', installationId: 77, head: '', commits: new Map<string, { tree: Map<string, string>; parent: string | null; message: string }>() };
  /** Hook run before the ref PATCH; return true to reject with 422 (simulated concurrent push). */
  beforeRefUpdate: (() => boolean) | null = null;
  private dataTrees = new Map<string, Map<string, string>>();

  constructor() {
    this.seedData({});
  }

  seedData(files: Record<string, string>): string {
    const sha = sha1(`data-${this.nextId++}`);
    this.dataRepo.commits.set(sha, { tree: new Map(Object.entries(files)), parent: this.dataRepo.head || null, message: 'seed' });
    this.dataRepo.head = sha;
    return sha;
  }
  /** Simulate an unrelated commit by someone else (e.g. the Portal). */
  pushData(change: Record<string, string | null>, message = 'portal'): string {
    const tree = new Map(this.dataRepo.commits.get(this.dataRepo.head)!.tree);
    for (const [p, c] of Object.entries(change)) c === null ? tree.delete(p) : tree.set(p, c);
    const sha = sha1(`data-${this.nextId++}`);
    this.dataRepo.commits.set(sha, { tree, parent: this.dataRepo.head, message });
    this.dataRepo.head = sha;
    return sha;
  }
  dataFile(path: string): string | undefined {
    return this.dataRepo.commits.get(this.dataRepo.head)!.tree.get(path);
  }

  addRepo(r: Omit<FakeRepo, 'assetBytes' | 'releases' | 'tags'> & Partial<Pick<FakeRepo, 'releases' | 'tags'>>): FakeRepo {
    const repo: FakeRepo = { releases: [], tags: {}, assetBytes: new Map(), ...r };
    this.repos.set(repo.id, repo);
    return repo;
  }

  /** Add a published release with one ZIP asset; returns the release. */
  addRelease(
    repo: FakeRepo,
    o: { tag: string; zip: Uint8Array; commit: string; prerelease?: boolean; immutable?: boolean; digest?: string | null; assetName?: string; annotated?: boolean; publishedAt?: string; extraAssets?: FakeAsset[] },
  ): FakeRelease {
    const id = this.nextId++;
    const assetId = this.nextId++;
    const name = o.assetName ?? `${o.tag}.zip`;
    repo.tags[o.tag] = { commit: o.commit, annotated: o.annotated };
    repo.assetBytes.set(assetId, o.zip);
    const rel: FakeRelease = {
      id,
      tag_name: o.tag,
      name: `Release ${o.tag}`,
      body: `Changes in ${o.tag}`,
      draft: false,
      prerelease: o.prerelease ?? false,
      immutable: o.immutable ?? true,
      published_at: o.publishedAt ?? new Date(Date.UTC(2026, 9, 1) + id * 1000).toISOString().replace('.000', ''),
      html_url: `https://github.com/${repo.fullName}/releases/tag/${o.tag}`,
      assets: [
        {
          id: assetId,
          name,
          size: o.zip.length,
          digest: o.digest === undefined ? `sha256:${sha256(o.zip)}` : o.digest,
          browser_download_url: `https://github.com/${repo.fullName}/releases/download/${o.tag}/${name}`,
          state: 'uploaded',
        },
        ...(o.extraAssets ?? []),
      ],
    };
    repo.releases.unshift(rel); // GitHub lists newest first
    return rel;
  }

  /** Create a commit on a branch with the given files. */
  commit(repo: FakeRepo, files: Record<string, string | Uint8Array>, branch = repo.defaultBranch): string {
    const sha = sha1(`c-${this.nextId++}`);
    repo.commits[sha] = files;
    repo.branches[branch] = sha;
    return sha;
  }

  releasesListEtag(repo: FakeRepo): string {
    return `W/"${sha1(JSON.stringify(repo.releases))}"`;
  }

  private blobSha(content: Uint8Array): string {
    const s = sha1(content);
    this.blobs.set(s, content);
    return s;
  }

  private repoByFull(o: string, r: string): FakeRepo | undefined {
    return [...this.repos.values()].find((x) => x.fullName.toLowerCase() === `${o}/${r}`.toLowerCase());
  }

  /** Old full name (lowercase) -> repository id, for renamed repositories. */
  renamed = new Map<string, number>();

  count(pred: (r: Req) => boolean): number {
    return this.requests.filter(pred).length;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const h = new Headers(init?.headers);
    const req: Req = { method, url: url.href, auth: h.get('authorization'), ifNoneMatch: h.get('if-none-match') };
    this.requests.push(req);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (url.host === 'objects.githubusercontent.com') {
      const id = Number(url.pathname.split('/').pop());
      if (this.failingAssets.has(id)) return new Response('boom', { status: 500 });
      for (const repo of this.repos.values()) {
        const b = repo.assetBytes.get(id);
        if (b) {
          this.downloads.set(id, (this.downloads.get(id) ?? 0) + 1);
          return new Response(b as unknown as BodyInit, { status: 200, headers: { 'content-length': String(b.length) } });
        }
      }
      return new Response('nope', { status: 404 });
    }
    if (url.host !== 'api.github.com') return new Response('unexpected host', { status: 599 });
    const p = url.pathname;
    const f = this.failures.find((x) => (!x.method || x.method === method) && x.match.test(p) && (x.times === undefined || x.times > 0));
    if (f) {
      if (f.times !== undefined) f.times--;
      return json(f.body ?? { message: 'injected' }, f.status, f.headers);
    }
    let m: RegExpMatchArray | null;

    if ((m = p.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && method === 'POST') {
      if (this.tokenStatus !== 201) return json({ message: 'Bad credentials' }, this.tokenStatus);
      return json({ token: `tok-${m[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }
    if ((m = p.match(/^\/repositories\/(\d+)\/installation$/))) {
      if (this.tokenStatus === 401) return json({ message: 'Bad credentials' }, 401);
      const inst = this.installations.get(Number(m[1]));
      return inst ? json({ id: inst, account: { id: 1, login: 'x' } }) : notFound();
    }
    if ((m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/installation$/))) {
      if (`${m[1]}/${m[2]}` === this.dataRepo.fullName) return json({ id: this.dataRepo.installationId, account: { id: 2, login: 'KernelSU-Modules' } });
      return notFound();
    }
    const repoJson = (r: FakeRepo) =>
      json({ id: r.id, full_name: r.fullName, default_branch: r.defaultBranch, owner: { id: r.ownerId }, private: !!r.private, archived: false, stargazers_count: r.stars ?? 0 });
    if ((m = p.match(/^\/repositories\/(\d+)$/))) {
      const r = this.repos.get(Number(m[1]));
      return r ? repoJson(r) : notFound();
    }
    if ((m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
      // Renamed repositories: GitHub answers 301 to /repositories/{id}; fetch follows it.
      const r = this.repoByFull(m[1]!, m[2]!) ?? this.repos.get(this.renamed.get(`${m[1]}/${m[2]}`.toLowerCase()) ?? -1);
      return r ? repoJson(r) : notFound();
    }
    if ((m = p.match(/^\/repositories\/(\d+)\/releases$/))) {
      const r = this.repos.get(Number(m[1]));
      if (!r) return notFound();
      const etag = this.releasesListEtag(r);
      if (req.ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } });
      const per = Number(url.searchParams.get('per_page') ?? 30);
      return json(r.releases.slice(0, per), 200, { etag });
    }

    // ---- data repo Git Data API ----
    const dataBase = `/repos/${this.dataRepo.fullName}`;
    if (p.startsWith(dataBase + '/')) return this.dataRoute(method, p.slice(dataBase.length), url, body);

    if ((m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/(.*)$/))) {
      const repo = this.repoByFull(m[1]!, m[2]!);
      if (!repo) return notFound();
      const rest = m[3]!;
      let k: RegExpMatchArray | null;
      if ((k = rest.match(/^commits\/([0-9a-f]{40})\/check-runs$/))) {
        const runs = this.checkRuns.filter((c) => c.repo === repo.fullName && c.head_sha === k![1] && (!url.searchParams.get('check_name') || url.searchParams.get('check_name') === 'KernelSU Modules'));
        return json({ total_count: runs.length, check_runs: runs.map((c) => ({ id: c.id, external_id: c.external_id, conclusion: c.conclusion, status: 'completed' })) });
      }
      if ((k = rest.match(/^commits\/(.+)$/))) {
        const ref = decodeURIComponent(k[1]!);
        const sha = repo.branches[ref] ?? (repo.commits[ref] ? ref : undefined);
        if (!sha) return json({ message: 'No commit found' }, 422);
        return new Response(sha, { status: 200 });
      }
      if ((k = rest.match(/^git\/trees\/([0-9a-f]{40})$/))) {
        const files = repo.commits[k[1]!];
        if (!files) return notFound();
        const dirs = new Set<string>();
        const tree: unknown[] = [];
        for (const [path, c] of Object.entries(files)) {
          const bytes = typeof c === 'string' ? enc.encode(c) : c;
          const segs = path.split('/');
          for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
          tree.push({ path, mode: '100644', type: 'blob', sha: this.blobSha(bytes), size: bytes.length });
        }
        for (const d of dirs) tree.push({ path: d, mode: '040000', type: 'tree', sha: sha1('dir' + d) });
        return json({ sha: k[1], tree, truncated: false });
      }
      if ((k = rest.match(/^git\/blobs\/([0-9a-f]{40})$/))) {
        const b = this.blobs.get(k[1]!);
        return b ? json({ sha: k[1], content: Buffer.from(b).toString('base64'), encoding: 'base64', size: b.length }) : notFound();
      }
      if ((k = rest.match(/^git\/ref\/tags\/(.+)$/))) {
        const t = repo.tags[decodeURIComponent(k[1]!)];
        if (!t) return notFound();
        if (t.annotated) {
          const tagSha = sha1('tagobj' + t.commit);
          this.tagObjects.set(tagSha, t.commit);
          return json({ ref: `refs/tags/${k[1]}`, object: { type: 'tag', sha: tagSha } });
        }
        return json({ ref: `refs/tags/${k[1]}`, object: { type: 'commit', sha: t.commit } });
      }
      if ((k = rest.match(/^git\/tags\/([0-9a-f]{40})$/))) {
        const c = this.tagObjects.get(k[1]!);
        return c ? json({ sha: k[1], object: { type: 'commit', sha: c } }) : notFound();
      }
      if ((k = rest.match(/^releases\/assets\/(\d+)$/))) {
        if (!req.auth) return json({ message: 'Requires authentication' }, 401);
        if (h.get('accept') !== 'application/octet-stream') return json({ id: Number(k[1]) });
        return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.com/github-production-release-asset/${k[1]}?sig=x` } });
      }
      if (rest === 'check-runs' && method === 'POST') {
        const id = this.nextId++;
        this.checkRuns.push({ id, repo: repo.fullName, head_sha: body.head_sha, external_id: body.external_id, conclusion: body.conclusion, output: body.output, actions: body.actions, app: { id: 1 } });
        return json({ id }, 201);
      }
    }
    return json({ message: `fake: no route for ${method} ${p}` }, 404);
  };

  private dataRoute(method: string, p: string, url: URL, body: any): Response {
    const d = this.dataRepo;
    let m: RegExpMatchArray | null;
    if (p === '/git/ref/heads/main' && method === 'GET') return json({ object: { sha: d.head } });
    if ((m = p.match(/^\/git\/commits\/([0-9a-f]{40})$/)) && method === 'GET') {
      const c = d.commits.get(m[1]!);
      if (!c) return notFound();
      const treeSha = sha1('tree-' + m[1]);
      this.dataTrees.set(treeSha, c.tree);
      return json({ sha: m[1], tree: { sha: treeSha } });
    }
    if ((m = p.match(/^\/git\/trees\/([0-9a-f]{40})$/)) && method === 'GET') {
      const t = this.dataTrees.get(m[1]!);
      if (!t) return notFound();
      return json({ tree: [...t.entries()].map(([path, c]) => ({ path, type: 'blob', mode: '100644', sha: this.blobSha(enc.encode(c)) })), truncated: false });
    }
    if ((m = p.match(/^\/git\/blobs\/([0-9a-f]{40})$/)) && method === 'GET') {
      const b = this.blobs.get(m[1]!);
      return b ? json({ content: Buffer.from(b).toString('base64'), encoding: 'base64' }) : notFound();
    }
    if (p === '/git/blobs' && method === 'POST') return json({ sha: this.blobSha(enc.encode(body.content)) }, 201);
    if (p === '/git/trees' && method === 'POST') {
      const base = this.dataTrees.get(body.base_tree)!;
      const t = new Map(base);
      for (const it of body.tree) it.sha === null ? t.delete(it.path) : t.set(it.path, new TextDecoder().decode(this.blobs.get(it.sha)!));
      const sha = sha1('newtree-' + this.nextId++);
      this.dataTrees.set(sha, t);
      return json({ sha }, 201);
    }
    if (p === '/git/commits' && method === 'POST') {
      const sha = sha1('newcommit-' + this.nextId++);
      d.commits.set(sha, { tree: this.dataTrees.get(body.tree)!, parent: body.parents[0], message: body.message });
      return json({ sha }, 201);
    }
    if (p === '/git/refs/heads/main' && method === 'PATCH') {
      if (this.beforeRefUpdate?.()) return json({ message: 'Update is not a fast forward' }, 422);
      const c = d.commits.get(body.sha)!;
      if (c.parent !== d.head) return json({ message: 'Update is not a fast forward' }, 422);
      d.head = body.sha;
      return json({ object: { sha: body.sha } });
    }
    return json({ message: `fake data: no route for ${method} ${p}` }, 404);
  }
}
