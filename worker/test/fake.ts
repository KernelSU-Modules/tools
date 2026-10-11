// In-memory fake of the GitHub REST/GraphQL/Git Data API, GitHub OAuth, Telegram Bot API and the Cloudflare
// Pages API, exposed as a `fetch` implementation. The git model is real enough for commitWithRetry
// (refs/commits/trees/blobs with non-fast-forward rejection).
import { sha256Hex } from '@kernelsu-modules/github';
import { crc32 } from '@kernelsu-modules/validator';
import YAML from 'yaml';

export const MODULES_APP_ID = '1001';
export const BOT_APP_ID = '2002';
export const DATA_REPO = 'KernelSU-Modules/repo';
export const TOOLS_REPO = 'KernelSU-Modules/tools';

export interface FakeUser {
  id: number;
  login: string;
  created_at: string;
  name?: string | null;
  type?: 'User' | 'Organization' | 'Bot';
}
export interface FakeRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  published_at: string;
  html_url: string;
  assets: { id: number; name: string; size: number; digest: string | null; browser_download_url: string; state: string }[];
}
export interface FakeRepo {
  id: number;
  full_name: string;
  owner: { id: number; login: string };
  private: boolean;
  default_branch: string;
  admins: number[];
  members: number[];
  files: Record<string, string>;
  headSha: string;
  latestRelease: FakeRelease | null;
}
export interface PagesDeployment {
  id: string;
  environment: 'production' | 'preview';
  created_on: string;
}
interface Installation {
  id: number;
  app: 'modules' | 'bot';
  account: { id: number; login: string };
  repoIds: number[];
}

type Json = Record<string, any>;
const enc = new TextEncoder();
const b64 = (s: string) => {
  let bin = '';
  for (const b of enc.encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Minimal stored (method 0) ZIP with the given files. */
export function makeZip(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameB = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(8, 0, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameB.length, true);
    parts.push(new Uint8Array(lh.buffer), nameB, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, Object.keys(files).length, true);
  eocd.setUint16(10, Object.keys(files).length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

export class FakeWorld {
  now = Date.parse('2026-10-10T00:00:00Z');
  users = new Map<number, FakeUser>();
  repos = new Map<number, FakeRepo>();
  installations = new Map<number, Installation>();
  assets = new Map<string, Uint8Array>();
  oauthCodes = new Map<string, number>();
  // git (data repo)
  blobs = new Map<string, string>();
  trees = new Map<string, Record<string, string>>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  ref = '';
  // side effects
  dispatches: Json[] = [];
  telegram: { method: string; body: Json }[] = [];
  private tgMsg = 100;
  /** Pages project `kernelsu-modules-repo` (the site). Other projects live in `pages`. */
  deployments: PagesDeployment[] = [];
  canonical: string | null = null;
  pages = new Map<string, { deployments: PagesDeployment[]; canonical: string | null }>();
  deleted: string[] = [];
  workflowRuns: Json[] = [];
  requests: string[] = [];
  private tokenSeq = 0;
  private instTokens = new Map<string, number>();
  /** Scope requested for each minted installation token (`null` = unscoped). */
  tokenScopes = new Map<string, { app: 'modules' | 'bot'; repositories?: string[]; permissions?: Record<string, string> }>();
  /** Revoked user tokens (DELETE /applications/{client_id}/token). */
  revoked: string[] = [];
  failDispatch = false;
  /** Refresh-token grants fail (as if the single-use refresh token had already been redeemed). */
  refreshFails = false;
  failTelegram = false;
  /** When set to N, ref updates are held until N of them are pending (forces a real optimistic-concurrency race). */
  patchBarrier = 0;
  private patchWaiters: (() => void)[] = [];
  patchConflicts = 0;

  constructor() {
    this.installations.set(1, { id: 1, app: 'bot', account: { id: 340597895, login: 'KernelSU-Modules' }, repoIds: [] });
  }

  /* ---------------- setup helpers ---------------- */
  addUser(id: number, login: string, created_at = '2015-01-01T00:00:00Z'): FakeUser {
    const u = { id, login, created_at };
    this.users.set(id, u);
    return u;
  }
  userJson(u: FakeUser) {
    return {
      id: u.id,
      login: u.login,
      name: u.name ?? null,
      type: u.type ?? 'User',
      avatar_url: `https://avatars.githubusercontent.com/u/${u.id}?v=4`,
      created_at: u.created_at,
    };
  }
  userToken(u: FakeUser) {
    return `ghu_${u.id}`;
  }
  addRepo(r: Partial<FakeRepo> & { id: number; full_name: string; owner: { id: number; login: string } }): FakeRepo {
    const repo: FakeRepo = {
      private: false,
      default_branch: 'main',
      admins: [r.owner.id],
      members: [],
      files: {},
      headSha: 'a'.repeat(40),
      latestRelease: null,
      ...r,
    };
    this.repos.set(repo.id, repo);
    return repo;
  }
  install(id: number, account: { id: number; login: string }, repoIds: number[]) {
    this.installations.set(id, { id, app: 'modules', account, repoIds });
  }
  /** Give a repo a module.yaml + an immutable release whose ZIP contains module.prop. */
  publishModule(repo: FakeRepo, id: string, opts: { versionCode?: number; immutable?: boolean; propId?: string } = {}) {
    repo.files['module.yaml'] = YAML.stringify({
      schemaVersion: 1,
      id,
      name: id,
      summary: 'A test module',
      description: 'README.md',
    });
    repo.files['README.md'] = `# ${id}\n\nHello <script>alert(1)</script> **world** ![img](docs/a.png)\n`;
    const vc = opts.versionCode ?? 100;
    const zip = makeZip({
      'module.prop': `id=${opts.propId ?? id}\nname=${id}\nversion=v1.0.0\nversionCode=${vc}\nauthor=me\ndescription=test\n`,
      'service.sh': '#!/system/bin/sh\n',
    });
    const name = `${id}-${vc}.zip`;
    const url = `https://github.com/${repo.full_name}/releases/download/v1.0.0/${name}`;
    this.assets.set(url, zip);
    repo.latestRelease = {
      id: repo.id * 10,
      tag_name: 'v1.0.0',
      draft: false,
      prerelease: false,
      immutable: opts.immutable ?? true,
      published_at: '2026-10-01T00:00:00Z',
      html_url: `https://github.com/${repo.full_name}/releases/tag/v1.0.0`,
      assets: [{ id: repo.id * 100, name, size: zip.length, digest: null, browser_download_url: url, state: 'uploaded' }],
    };
  }

  async seedData(files: Record<string, string>) {
    const tree: Record<string, string> = {};
    for (const [p, c] of Object.entries(files)) tree[p] = await this.putBlob(c);
    const treeSha = await this.putTree(tree);
    const commit = await this.putCommit(treeSha, [], 'init');
    this.ref = commit;
  }
  /** Direct (out-of-band) commit to the data repo, e.g. to simulate another writer. */
  async writeData(files: Record<string, string | null>) {
    const base = this.commits.get(this.ref)!;
    const tree = { ...this.trees.get(base.tree)! };
    for (const [p, c] of Object.entries(files)) {
      if (c === null) delete tree[p];
      else tree[p] = await this.putBlob(c);
    }
    this.ref = await this.putCommit(await this.putTree(tree), [this.ref], 'external');
  }
  readData(path: string): string | null {
    const t = this.trees.get(this.commits.get(this.ref)!.tree)!;
    return t[path] ? this.blobs.get(t[path])! : null;
  }
  record(id: string): any {
    const t = this.readData(`modules/${id}.yaml`);
    return t ? YAML.parse(t) : null;
  }
  commitMessages(): string[] {
    const out: string[] = [];
    let c: string | undefined = this.ref;
    while (c) {
      const co: { parents: string[]; message: string } = this.commits.get(c)!;
      out.push(co.message);
      c = co.parents[0];
    }
    return out;
  }

  private async putBlob(content: string) {
    const sha = (await sha256Hex('blob:' + content)).slice(0, 40);
    this.blobs.set(sha, content);
    return sha;
  }
  private async putTree(files: Record<string, string>) {
    const sha = (await sha256Hex('tree:' + JSON.stringify(Object.entries(files).sort()))).slice(0, 40);
    this.trees.set(sha, files);
    return sha;
  }
  private async putCommit(tree: string, parents: string[], message: string) {
    const sha = (await sha256Hex(`commit:${tree}:${parents.join(',')}:${message}:${Math.random()}`)).slice(0, 40);
    this.commits.set(sha, { tree, parents, message });
    return sha;
  }

  /* ---------------- auth model ---------------- */
  private auth(req: Request): { kind: 'jwt'; app: 'modules' | 'bot' } | { kind: 'inst'; inst: Installation } | { kind: 'user'; user: FakeUser } | null {
    const h = req.headers.get('authorization');
    if (!h?.startsWith('Bearer ')) return null;
    const t = h.slice(7);
    if (t.startsWith('eyJ')) {
      const payload = JSON.parse(atob(t.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
      return { kind: 'jwt', app: String(payload.iss) === MODULES_APP_ID ? 'modules' : 'bot' };
    }
    if (this.instTokens.has(t)) return { kind: 'inst', inst: this.installations.get(this.instTokens.get(t)!)! };
    const m = /^ghu_(\d+)$/.exec(t);
    if (m && this.users.has(Number(m[1]))) return { kind: 'user', user: this.users.get(Number(m[1]))! };
    return null;
  }
  private userCanSee(u: FakeUser, r: FakeRepo) {
    const installed = [...this.installations.values()].some((i) => i.app === 'modules' && i.repoIds.includes(r.id));
    return installed && (r.admins.includes(u.id) || r.members.includes(u.id) || !r.private);
  }
  private repoJson(r: FakeRepo, u?: FakeUser) {
    return {
      id: r.id,
      full_name: r.full_name,
      private: r.private,
      default_branch: r.default_branch,
      owner: r.owner,
      html_url: `https://github.com/${r.full_name}`,
      ...(u ? { permissions: { admin: r.admins.includes(u.id), push: r.admins.includes(u.id), pull: true } } : {}),
    };
  }
  private byName(full: string) {
    return [...this.repos.values()].find((r) => r.full_name.toLowerCase() === full.toLowerCase());
  }

  /** Bot installation tokens must be scoped to `repo` with `perm` (>= `level`). */
  private botScopeOk(req: Request, repo: string, perm: string, level: 'read' | 'write') {
    const t = req.headers.get('authorization')?.slice(7) ?? '';
    const sc = this.tokenScopes.get(t);
    if (!sc || !sc.repositories?.includes(repo)) return false;
    const have = sc.permissions?.[perm];
    return level === 'read' ? have === 'read' || have === 'write' : have === 'write';
  }

  /* ---------------- fetch ---------------- */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as any, init);
    const url = new URL(req.url);
    this.requests.push(`${req.method} ${url.host}${url.pathname}`);
    if (url.host === 'api.github.com') return this.github(req, url);
    if (url.host === 'github.com' && url.pathname === '/login/oauth/access_token') return this.oauth(req);
    if (url.host === 'github.com' && url.pathname.includes('/releases/download/')) return this.download(req, url);
    if (url.host === 'api.telegram.org') return this.tg(req, url);
    if (url.host === 'api.cloudflare.com') return this.cf(req, url);
    return json(404, { message: 'unknown host' });
  };

  private async oauth(req: Request) {
    const body = (await req.json()) as Json;
    if (body.grant_type === 'refresh_token') {
      const m = /^ghr_(\d+)$/.exec(body.refresh_token);
      if (!m || this.refreshFails) return json(200, { error: 'bad_refresh_token' });
      return json(200, { access_token: `ghu_${m[1]}`, expires_in: 28800, refresh_token: `ghr_${m[1]}`, refresh_token_expires_in: 15897600 });
    }
    const uid = this.oauthCodes.get(body.code);
    if (!uid || body.client_secret !== 'client-secret') return json(200, { error: 'bad_verification_code' });
    this.oauthCodes.delete(body.code);
    return json(200, { access_token: `ghu_${uid}`, expires_in: 28800, refresh_token: `ghr_${uid}`, refresh_token_expires_in: 15897600 });
  }

  private download(req: Request, url: URL) {
    const bytes = this.assets.get(url.toString());
    if (!bytes) return new Response('nf', { status: 404 });
    const range = req.headers.get('range');
    const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) return new Response(bytes as BodyInit, { status: 200, headers: { 'content-length': String(bytes.length) } });
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1) as BodyInit, {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(end - start + 1) },
    });
  }

  private async tg(req: Request, url: URL) {
    const method = url.pathname.split('/').pop()!;
    const body = (await req.json()) as Json;
    this.telegram.push({ method, body });
    if (this.failTelegram) return json(502, { ok: false, description: 'Bad Gateway' });
    if (method === 'sendMessage') return json(200, { ok: true, result: { message_id: ++this.tgMsg, chat: { id: body.chat_id } } });
    return json(200, { ok: true, result: true });
  }

  private async cf(req: Request, url: URL) {
    const m = /^\/client\/v4\/accounts\/[^/]+\/pages\/projects\/([^/]+)(\/deployments(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (!m) return json(404, { success: false });
    const name = decodeURIComponent(m[1]!);
    const proj = name === 'kernelsu-modules-repo' ? this : this.pages.get(name);
    if (!proj) return json(404, { success: false, errors: [{ message: 'project not found' }] });
    if (!m[2]) return json(200, { success: true, result: { canonical_deployment: proj.canonical ? { id: proj.canonical } : null } });
    if (m[3] && req.method === 'DELETE') {
      if (m[3] === proj.canonical) return json(400, { success: false, errors: [{ message: 'cannot delete canonical' }] });
      this.deleted.push(name === 'kernelsu-modules-repo' ? m[3] : `${name}/${m[3]}`);
      proj.deployments = proj.deployments.filter((d) => d.id !== m[3]);
      return json(200, { success: true, result: null });
    }
    const page = Number(url.searchParams.get('page') ?? 1);
    const per = Number(url.searchParams.get('per_page') ?? 25);
    const sorted = [...proj.deployments].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
    return json(200, {
      success: true,
      result: sorted.slice((page - 1) * per, page * per),
      result_info: { page, per_page: per, total_pages: Math.max(1, Math.ceil(sorted.length / per)) },
    });
  }

  private async github(req: Request, url: URL): Promise<Response> {
    const a = this.auth(req);
    const p = url.pathname;
    const method = req.method;
    let m: RegExpExecArray | null;

    // ---- App (JWT) ----
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && method === 'POST') {
      if (a?.kind !== 'jwt') return json(401, { message: 'jwt required' });
      const inst = this.installations.get(Number(m[1]));
      if (!inst || inst.app !== a.app) return json(404, { message: 'no installation' });
      const token = `ghs_${inst.id}_${++this.tokenSeq}`;
      this.instTokens.set(token, inst.id);
      const text = await req.text();
      const body = text ? (JSON.parse(text) as Json) : null;
      this.tokenScopes.set(token, { app: inst.app, repositories: body?.repositories, permissions: body?.permissions });
      return json(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if ((m = /^\/repositories\/(\d+)\/installation$/.exec(p))) {
      if (a?.kind !== 'jwt') return json(401, { message: 'jwt required' });
      const inst = [...this.installations.values()].find((i) => i.app === a.app && i.repoIds.includes(Number(m![1])));
      return inst ? json(200, { id: inst.id, account: inst.account }) : json(404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(p))) {
      if (a?.kind !== 'jwt') return json(401, { message: 'jwt required' });
      const full = `${m[1]}/${m[2]}`;
      if (a.app === 'bot' && (full === DATA_REPO || full === TOOLS_REPO)) return json(200, { id: 1, account: this.installations.get(1)!.account });
      const r = this.byName(full);
      const inst = r && [...this.installations.values()].find((i) => i.app === a.app && i.repoIds.includes(r.id));
      return inst ? json(200, { id: inst.id, account: inst.account }) : json(404, { message: 'Not Found' });
    }

    // ---- data repo (Bot installation token only) ----
    const dataBase = `/repos/${DATA_REPO}`;
    if (p.startsWith(dataBase + '/') || (p === '/graphql' && method === 'POST')) {
      if (a?.kind !== 'inst' || a.inst.app !== 'bot') return json(403, { message: 'bot token required' });
      const write = method !== 'GET' && p !== '/graphql';
      if (!this.botScopeOk(req, 'repo', 'contents', write ? 'write' : 'read'))
        return json(403, { message: 'Resource not accessible by integration (token scope)' });
      return this.dataRepo(req, url, p.slice(dataBase.length));
    }

    // ---- tools repo: actions ----
    if ((m = /^\/repos\/KernelSU-Modules\/tools\/actions\/workflows\/([^/]+)\/(dispatches|runs)$/.exec(p))) {
      if (a?.kind !== 'inst' || a.inst.app !== 'bot') return json(403, { message: 'bot token required' });
      if (!this.botScopeOk(req, 'tools', 'actions', m[2] === 'runs' ? 'read' : 'write'))
        return json(403, { message: 'Resource not accessible by integration (token scope)' });
      if (m[2] === 'runs') {
        const st = url.searchParams.get('status');
        const runs = this.workflowRuns.filter((r) => !st || r.conclusion === st || r.status === st);
        const per = Number(url.searchParams.get('per_page') ?? 30);
        return json(200, { total_count: runs.length, workflow_runs: runs.slice(0, per) });
      }
      if (this.failDispatch) return json(500, { message: 'boom' });
      this.dispatches.push({ workflow: decodeURIComponent(m[1]!), ...((await req.json()) as Json) });
      return new Response(null, { status: 204 });
    }

    // ---- OAuth app token revocation (Basic client_id:client_secret) ----
    if ((m = /^\/applications\/([^/]+)\/token$/.exec(p)) && method === 'DELETE') {
      if (req.headers.get('authorization') !== `Basic ${btoa(`${decodeURIComponent(m[1]!)}:client-secret`)}`) return json(401, { message: 'Bad credentials' });
      const b = (await req.json()) as Json;
      this.revoked.push(b.access_token);
      return new Response(null, { status: 204 });
    }

    // ---- user endpoints ----
    if (p === '/user') {
      if (a?.kind !== 'user') return json(401, { message: 'Bad credentials' });
      return json(200, { id: a.user.id, login: a.user.login, avatar_url: `https://avatars.example/${a.user.id}`, created_at: a.user.created_at });
    }
    if ((m = /^\/user\/(\d+)$/.exec(p))) {
      const u = this.users.get(Number(m[1]));
      return u ? json(200, this.userJson(u)) : json(404, { message: 'Not Found' });
    }
    if ((m = /^\/users\/([^/]+)$/.exec(p))) {
      const login = decodeURIComponent(m[1]!).toLowerCase();
      const u = [...this.users.values()].find((x) => x.login.toLowerCase() === login);
      return u ? json(200, this.userJson(u)) : json(404, { message: 'Not Found' });
    }
    if (p === '/user/installations') {
      if (a?.kind !== 'user') return json(401, { message: 'Bad credentials' });
      const list = [...this.installations.values()].filter(
        (i) => i.app === 'modules' && i.repoIds.some((rid) => this.repos.get(rid) && this.userCanSee(a.user, this.repos.get(rid)!)),
      );
      return json(200, { total_count: list.length, installations: list.map((i) => ({ id: i.id, account: i.account })) });
    }
    if ((m = /^\/user\/installations\/(\d+)\/repositories$/.exec(p))) {
      if (a?.kind !== 'user') return json(401, { message: 'Bad credentials' });
      const inst = this.installations.get(Number(m[1]));
      const repos = (inst?.repoIds ?? []).map((id) => this.repos.get(id)!).filter((r) => r && this.userCanSee(a.user, r));
      return json(200, { total_count: repos.length, repositories: repos.map((r) => this.repoJson(r, a.user)) });
    }
    if ((m = /^\/repositories\/(\d+)$/.exec(p))) {
      const r = this.repos.get(Number(m[1]));
      if (!r) return json(404, { message: 'Not Found' });
      if (a?.kind === 'user') return this.userCanSee(a.user, r) ? json(200, this.repoJson(r, a.user)) : json(404, { message: 'Not Found' });
      if (a?.kind === 'inst' && a.inst.repoIds.includes(r.id)) return json(200, this.repoJson(r));
      return json(404, { message: 'Not Found' });
    }

    // ---- author repo content (installation token of the Modules App) ----
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/(contents|commits|releases)\/?(.*)$/.exec(p))) {
      const r = this.byName(m[1]!);
      if (!r || a?.kind !== 'inst' || !a.inst.repoIds.includes(r.id)) return json(404, { message: 'Not Found' });
      if (m[2] === 'contents') {
        const path = decodeURIComponent(m[3]!).replace(/\/$/, '');
        const c = r.files[path];
        if (c === undefined) {
          // Directory listing (no content), like the real contents API.
          const prefix = path ? `${path}/` : '';
          const names = new Map<string, string>();
          for (const f of Object.keys(r.files)) {
            if (!f.startsWith(prefix)) continue;
            const rest = f.slice(prefix.length);
            const i = rest.indexOf('/');
            names.set(i < 0 ? rest : rest.slice(0, i), i < 0 ? 'file' : 'dir');
          }
          if (!names.size) return json(404, { message: 'Not Found' });
          return json(200, [...names].map(([name, type]) => ({ name, path: prefix + name, type })));
        }
        return json(200, { type: 'file', size: enc.encode(c).length, content: b64(c), encoding: 'base64' });
      }
      if (m[2] === 'commits') return json(200, { sha: r.headSha });
      if (m[2] === 'releases' && m[3] === 'latest') return r.latestRelease ? json(200, r.latestRelease) : json(404, { message: 'Not Found' });
    }
    return json(404, { message: `fake: no route ${method} ${p}` });
  }

  private async dataRepo(req: Request, url: URL, sub: string): Promise<Response> {
    const method = req.method;
    let m: RegExpExecArray | null;
    if (url.pathname === '/graphql') {
      const { variables } = (await req.json()) as { variables: Record<string, string> };
      const resolve = (expr: string | undefined) => {
        if (!expr) return null;
        const [commit, path] = expr.split(':') as [string, string];
        const tree = this.trees.get(this.commits.get(commit)?.tree ?? '');
        if (!tree) return null;
        if (path === 'modules') {
          const entries = Object.entries(tree)
            .filter(([k]) => k.startsWith('modules/') && !k.slice(8).includes('/'))
            .map(([k, sha]) => ({ name: k.slice(8), type: 'blob', oid: sha, object: { oid: sha, text: this.blobs.get(sha), isTruncated: false } }));
          return { entries };
        }
        const sha = tree[path];
        return sha ? { oid: sha, text: this.blobs.get(sha), isTruncated: false } : null;
      };
      return json(200, {
        data: {
          repository: {
            policy: resolve(variables.policy),
            maintainers: resolve(variables.maintainers),
            banned: resolve(variables.banned),
            status: resolve(variables.status),
            mods: resolve(variables.mods),
          },
        },
      });
    }
    if (sub === '/git/ref/heads/main' && method === 'GET') return json(200, { object: { sha: this.ref } });
    if ((m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(sub)) && method === 'GET') {
      const c = this.commits.get(m[1]!);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree } }) : json(404, { message: 'Not Found' });
    }
    if ((m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(sub)) && method === 'GET') {
      const treeSha = this.commits.get(m[1]!)?.tree ?? m[1]!;
      const t = this.trees.get(treeSha);
      if (!t) return json(404, { message: 'Not Found' });
      return json(200, { sha: treeSha, truncated: false, tree: Object.entries(t).map(([path, sha]) => ({ path, type: 'blob', mode: '100644', sha })) });
    }
    if ((m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(sub)) && method === 'GET') {
      const c = this.blobs.get(m[1]!);
      if (c === undefined) return json(404, { message: 'Not Found' });
      if (req.headers.get('accept')?.includes('raw')) return new Response(c, { status: 200 });
      return json(200, { content: b64(c), encoding: 'base64' });
    }
    if (sub === '/git/blobs' && method === 'POST') {
      const b = (await req.json()) as Json;
      return json(201, { sha: await this.putBlob(b.content) });
    }
    if (sub === '/git/trees' && method === 'POST') {
      const b = (await req.json()) as Json;
      const base = { ...(this.trees.get(b.base_tree) ?? {}) };
      for (const e of b.tree as Json[]) {
        if (e.sha === null) delete base[e.path];
        else base[e.path] = e.sha;
      }
      return json(201, { sha: await this.putTree(base) });
    }
    if (sub === '/git/commits' && method === 'POST') {
      const b = (await req.json()) as Json;
      return json(201, { sha: await this.putCommit(b.tree, b.parents, b.message) });
    }
    if (sub === '/git/refs/heads/main' && method === 'PATCH') {
      const b = (await req.json()) as Json;
      if (this.patchBarrier > 0) {
        await new Promise<void>((resolve) => {
          this.patchWaiters.push(resolve);
          if (this.patchWaiters.length >= this.patchBarrier) {
            this.patchBarrier = 0;
            for (const w of this.patchWaiters.splice(0)) w();
          }
        });
      }
      const c = this.commits.get(b.sha);
      if (!c) return json(422, { message: 'Object does not exist' });
      if (!b.force && c.parents[0] !== this.ref) {
        this.patchConflicts++;
        return json(422, { message: 'Update is not a fast forward' });
      }
      this.ref = b.sha;
      return json(200, { object: { sha: b.sha } });
    }
    return json(404, { message: `fake data: no route ${method} ${sub}` });
  }
}
