// Read model of the data repo (KernelSU-Modules/repo) + Bot writes.
//
// CPU/subrequest budget (Workers Free: 10 ms CPU, 50 subrequests per invocation):
//  - `head()` is one GET ref, cached 60 s (L1 memory + Cache API) and bumped after our own commits.
//  - A snapshot (all records + policy/maintainers/banned) is keyed by commit sha and cached in memory and the
//    Cache API, so the common path is a JSON.parse of a few hundred KB (~1 ms).
//  - Building a snapshot for a new commit is incremental against the last cached one: one recursive tree
//    request, then only changed blobs (usually 1-2) are fetched and YAML-parsed.
//  - A cold build (no previous snapshot in this colo) uses ONE GraphQL request that returns every record's
//    text, then YAML-parses all of them. This is the most CPU-heavy path in the Worker: roughly 50-100 µs per
//    record with the `yaml` package -> ~5 ms at 50 modules, ~15-30 ms at 300. It runs once per colo after a
//    cache eviction; see README "CPU notes".
import {
  commitWithRetry,
  splitFullName,
  type CommitPlan,
  type CommitReader,
  type CommitResult,
  type GitHubClient,
} from '@kernelsu-modules/github';
import { DEFAULT_POLICY, type Banned, type Maintainers, type Policy, type RegistryRecord, type RegistryStatus } from '@kernelsu-modules/schema';
import { getJson, putJson } from '../lib/cache.ts';
import type { Deps } from '../services.ts';
import { parseBanned, parseMaintainers, parsePolicy, parseRecord } from './yaml.ts';

export interface Snapshot {
  commit: string;
  /** path -> blob sha of tracked files (modules/*.yaml, root yaml files, status.json). */
  blobs: Record<string, string>;
  records: Record<string, RegistryRecord>;
  /** path -> parse error (records that fail the schema are skipped, not fatal). */
  invalid: Record<string, string>;
  policy: Policy;
  maintainers: Maintainers;
  banned: Banned;
}

/** Empty status (status.json missing, e.g. before the first sync that writes it). */
export const EMPTY_STATUS: RegistryStatus = { schemaVersion: 1, modules: {} };

/** Newest `lastSuccessAt` over all modules (informational; health alerts use the Actions API). */
export function newestSuccessAt(status: RegistryStatus): string | null {
  let newest: string | null = null;
  for (const m of Object.values(status.modules)) {
    const s = m.lastSuccessAt;
    if (s && (!newest || Date.parse(s) > Date.parse(newest))) newest = s;
  }
  return newest;
}

/**
 * Cheap structural check instead of a zod parse (CPU): status.json is written by our own sync job; we only
 * need to not crash on a malformed file.
 */
export function parseStatus(text: string): RegistryStatus {
  const v = JSON.parse(text) as Partial<RegistryStatus> | null;
  if (!v || typeof v !== 'object' || v.schemaVersion !== 1 || !v.modules || typeof v.modules !== 'object' || Array.isArray(v.modules))
    throw new Error('status.json: unexpected shape');
  return v as RegistryStatus;
}

const ROOT_FILES = ['policy.yaml', 'maintainers.yaml', 'banned.yaml'] as const;
/** Compact per-module summary written by tools/sync in the same commit as sources.lock.json (never parsed here). */
const STATUS = 'status.json';
const RECORD_RE = /^modules\/([^/]+)\.yaml$/;
const isTracked = (p: string) => RECORD_RE.test(p) || (ROOT_FILES as readonly string[]).includes(p) || p === STATUS;
const MAX_INCREMENTAL = 20;

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}


export class DataRepo {
  readonly owner: string;
  readonly repo: string;
  private memo = new Map<string, Snapshot>();
  private statusMemo = new Map<string, RegistryStatus>();

  constructor(
    readonly fullName: string,
    private readonly client: () => Promise<GitHubClient>,
    private readonly deps: Deps,
  ) {
    ({ owner: this.owner, repo: this.repo } = splitFullName(fullName));
  }

  private get base() {
    return `/repos/${this.owner}/${this.repo}`;
  }

  async head(fresh = false): Promise<string> {
    if (!fresh) {
      const c = await this.deps.cache.get('data/head');
      if (c) return c;
    }
    const gh = await this.client();
    const ref = await gh.get<{ object: { sha: string } }>(`${this.base}/git/ref/heads/main`);
    await this.setHead(ref.data.object.sha);
    return ref.data.object.sha;
  }

  async setHead(commit: string): Promise<void> {
    await this.deps.cache.put('data/head', commit, 60);
  }

  async snapshot(commit?: string): Promise<Snapshot> {
    const c = commit ?? (await this.head());
    const m = this.memo.get(c);
    if (m) return m;
    let snap = await getJson<Snapshot>(this.deps.cache, `data/v2/snap/${c}`);
    if (!snap) {
      snap = await this.build(c);
      await putJson(this.deps.cache, `data/v2/snap/${c}`, snap, 86400);
      await this.deps.cache.put('data/v2/latest', c, 86400);
    }
    this.remember(snap);
    return snap;
  }

  private remember(s: Snapshot) {
    this.memo.set(s.commit, s);
    while (this.memo.size > 3) this.memo.delete(this.memo.keys().next().value!);
  }

  private async previous(): Promise<Snapshot | null> {
    const last = [...this.memo.values()].pop();
    if (last) return last;
    const c = await this.deps.cache.get('data/v2/latest');
    return c ? getJson<Snapshot>(this.deps.cache, `data/v2/snap/${c}`) : null;
  }

  private async build(commit: string): Promise<Snapshot> {
    const prev = await this.previous();
    if (prev) {
      const inc = await this.buildIncremental(commit, prev);
      if (inc) return inc;
    }
    return this.buildFull(commit);
  }

  private async buildIncremental(commit: string, prev: Snapshot): Promise<Snapshot | null> {
    const gh = await this.client();
    const t = await gh.get<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(`${this.base}/git/trees/${commit}`, {
      query: { recursive: 1 },
    });
    if (t.data.truncated) return null;
    const blobs: Record<string, string> = {};
    for (const e of t.data.tree) if (e.type === 'blob' && isTracked(e.path)) blobs[e.path] = e.sha;
    const changed = Object.keys(blobs).filter((p) => p !== STATUS && prev.blobs[p] !== blobs[p]);
    if (changed.length > MAX_INCREMENTAL) return null;
    const texts = await Promise.all(
      changed.map(async (p) => {
        const b = await gh.get<{ content: string; encoding: string }>(`${this.base}/git/blobs/${blobs[p]}`);
        return [p, b.data.encoding === 'base64' ? decodeBase64Utf8(b.data.content) : b.data.content] as const;
      }),
    );
    const snap: Snapshot = {
      commit,
      blobs,
      records: {},
      invalid: {},
      policy: prev.policy,
      maintainers: prev.maintainers,
      banned: prev.banned,
    };
    // carry over unchanged records
    for (const [id, r] of Object.entries(prev.records)) {
      const p = `modules/${id}.yaml`;
      if (blobs[p] && blobs[p] === prev.blobs[p]) snap.records[id] = r;
    }
    for (const [p, e] of Object.entries(prev.invalid)) if (blobs[p] && blobs[p] === prev.blobs[p]) snap.invalid[p] = e;
    for (const p of ROOT_FILES) if (!blobs[p]) applyFile(snap, p, null);
    for (const [p, text] of texts) applyFile(snap, p, text);
    return snap;
  }

  private async buildFull(commit: string): Promise<Snapshot> {
    const gh = await this.client();
    const blobFrag = '... on Blob { oid text isTruncated }';
    const query = `query($owner:String!,$name:String!,$policy:String!,$maintainers:String!,$banned:String!,$status:String!,$mods:String!){
  repository(owner:$owner,name:$name){
    policy: object(expression:$policy){ ${blobFrag} }
    maintainers: object(expression:$maintainers){ ${blobFrag} }
    banned: object(expression:$banned){ ${blobFrag} }
    status: object(expression:$status){ ... on Blob { oid } }
    mods: object(expression:$mods){ ... on Tree { entries { name type oid object { ${blobFrag} } } } }
  }
}`;
    const res = await gh.post<{ data?: { repository: any }; errors?: { message: string }[] }>('/graphql', {
      query,
      variables: {
        owner: this.owner,
        name: this.repo,
        policy: `${commit}:policy.yaml`,
        maintainers: `${commit}:maintainers.yaml`,
        banned: `${commit}:banned.yaml`,
        status: `${commit}:${STATUS}`,
        mods: `${commit}:modules`,
      },
    });
    const repo = res.data.data?.repository;
    if (!repo) throw new Error(`GraphQL snapshot failed: ${res.data.errors?.map((e) => e.message).join('; ') ?? 'no data'}`);
    const snap: Snapshot = {
      commit,
      blobs: {},
      records: {},
      invalid: {},
      policy: DEFAULT_POLICY,
      maintainers: { maintainers: [] },
      banned: { banned: [] },
    };
    const textOf = async (o: { oid: string; text: string | null; isTruncated: boolean }) => {
      if (o.text !== null && !o.isTruncated) return o.text;
      const b = await gh.get<{ content: string; encoding: string }>(`${this.base}/git/blobs/${o.oid}`);
      return b.data.encoding === 'base64' ? decodeBase64Utf8(b.data.content) : b.data.content;
    };
    for (const p of ROOT_FILES) {
      const o = repo[p.replace('.yaml', '')];
      if (o?.oid) {
        snap.blobs[p] = o.oid;
        applyFile(snap, p, await textOf(o));
      }
    }
    if (repo.status?.oid) snap.blobs[STATUS] = repo.status.oid;
    for (const e of repo.mods?.entries ?? []) {
      if (e.type !== 'blob' || !e.name.endsWith('.yaml') || !e.object) continue;
      const p = `modules/${e.name}`;
      snap.blobs[p] = e.oid;
      applyFile(snap, p, await textOf(e.object));
    }
    return snap;
  }

  /**
   * Records with an open request, for the cron Worker (expiry). The cron Worker has no cache, so a full snapshot
   * would YAML-parse every record on every run (~5 ms CPU at 300 records); instead one GraphQL request returns the
   * texts and only records with a top-level `request:` key are parsed. Uses an already memoized snapshot if any.
   */
  async openRequests(commit: string): Promise<{ commit: string; policy: Policy; records: RegistryRecord[] }> {
    const memo = this.memo.get(commit);
    if (memo) return { commit, policy: memo.policy, records: Object.values(memo.records).filter((r) => r.request) };
    const gh = await this.client();
    const query = `query($owner:String!,$name:String!,$policy:String!,$mods:String!){
  repository(owner:$owner,name:$name){
    policy: object(expression:$policy){ ... on Blob { text } }
    mods: object(expression:$mods){ ... on Tree { entries { name type object { ... on Blob { oid text isTruncated } } } } }
  }
}`;
    const res = await gh.post<{ data?: { repository: any }; errors?: { message: string }[] }>('/graphql', {
      query,
      variables: { owner: this.owner, name: this.repo, policy: `${commit}:policy.yaml`, mods: `${commit}:modules` },
    });
    const repo = res.data.data?.repository;
    if (!repo) throw new Error(`GraphQL open-requests scan failed: ${res.data.errors?.map((e) => e.message).join('; ') ?? 'no data'}`);
    let policy = DEFAULT_POLICY;
    try {
      if (typeof repo.policy?.text === 'string') policy = parsePolicy(repo.policy.text);
    } catch {
      /* keep defaults */
    }
    const records: RegistryRecord[] = [];
    for (const e of repo.mods?.entries ?? []) {
      const o = e.object;
      if (e.type !== 'blob' || !e.name.endsWith('.yaml') || !o) continue;
      let text: string | null = o.text;
      if (text !== null && !/^request:/m.test(text)) continue;
      if (text === null || o.isTruncated) {
        const b = await gh.get<{ content: string; encoding: string }>(`${this.base}/git/blobs/${o.oid}`);
        text = b.data.encoding === 'base64' ? decodeBase64Utf8(b.data.content) : b.data.content;
        if (!/^request:/m.test(text)) continue;
      }
      try {
        const rec = parseRecord(text);
        if (rec.request && `${rec.id}.yaml` === e.name) records.push(rec);
      } catch {
        /* invalid records are surfaced by /api/admin/status */
      }
    }
    return { commit, policy, records };
  }

  /**
   * status.json at the snapshot's commit (missing file -> empty), cached by blob sha in memory and
   * the Cache API, so it is fetched and parsed once per change per colo.
   */
  async status(snap: Snapshot): Promise<RegistryStatus> {
    const sha = snap.blobs[STATUS];
    if (!sha) return EMPTY_STATUS;
    const m = this.statusMemo.get(sha);
    if (m) return m;
    const key = `data/status/${sha}`;
    const cached = await this.deps.cache.get(key);
    let st: RegistryStatus;
    if (cached !== null) st = JSON.parse(cached) as RegistryStatus;
    else {
      const gh = await this.client();
      const res = await gh.get<unknown>(`${this.base}/git/blobs/${sha}`, { headers: { accept: 'application/vnd.github.raw+json' } });
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      try {
        st = parseStatus(text);
      } catch (e) {
        console.error('status.json invalid', (e as Error).message);
        st = EMPTY_STATUS;
      }
      await this.deps.cache.put(key, JSON.stringify(st), 86400);
    }
    this.statusMemo.clear();
    this.statusMemo.set(sha, st);
    return st;
  }

  /** Commit through the KernelSU Modules Bot with optimistic concurrency; bumps the cached head on success. */
  async commit(mutate: (reader: CommitReader) => Promise<CommitPlan>, opts: { maxAttempts?: number } = {}): Promise<CommitResult> {
    const gh = await this.client();
    const res = await commitWithRetry(gh, { owner: this.owner, repo: this.repo, branch: 'main', maxAttempts: opts.maxAttempts }, mutate);
    if (res.commit) await this.setHead(res.commit);
    return res;
  }
}

function applyFile(snap: Snapshot, path: string, text: string | null) {
  try {
    if (path === 'policy.yaml') snap.policy = text === null ? DEFAULT_POLICY : parsePolicy(text);
    else if (path === 'maintainers.yaml') snap.maintainers = text === null ? { maintainers: [] } : parseMaintainers(text);
    else if (path === 'banned.yaml') snap.banned = text === null ? { banned: [] } : parseBanned(text);
    else {
      const m = RECORD_RE.exec(path);
      if (!m || text === null) return;
      const rec = parseRecord(text);
      if (rec.id !== m[1]) throw new Error(`record id "${rec.id}" does not match file name`);
      snap.records[rec.id] = rec;
      delete snap.invalid[path];
    }
  } catch (e) {
    if (RECORD_RE.test(path)) {
      snap.invalid[path] = (e as Error).message.slice(0, 300);
      const id = RECORD_RE.exec(path)![1]!;
      delete snap.records[id];
    } else {
      // A broken policy/maintainers/banned file must not silently open things up: keep safe defaults
      // (no maintainers => admin API locked) and surface it in /api/admin/status.
      snap.invalid[path] = (e as Error).message.slice(0, 300);
    }
  }
}
