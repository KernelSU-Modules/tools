// Static build: data repo + sources.lock.json -> complete dist/ for Cloudflare Pages.
// Data work happens here (locked fetches + sha256 checks, render/sanitize, image copies, api/v1,
// search indexes); the pages are rendered by the Astro project in site/ from a page-data JSON.
// Module content is single-language (module.yaml name/summary/description); only the site UI is translated.
// Output order: data files -> Astro pages/assets -> CSP check -> build-manifest.json (last).
import { mkdir, readdir, readFile, rename, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { renderChangelog, renderMarkdown, renderNotes, type RenderContext } from '@kernelsu-modules/render';
import {
  API_SCHEMA_VERSION,
  ApiIndex,
  ApiModuleDetail,
  ApiModules,
  ApiModuleSummary,
  ApiUpdateJson,
  canonicalJson,
  ModuleManifest,
  type LockedRelease,
  type ModuleLock,
  type Policy,
  type RegistryRecord,
} from '@kernelsu-modules/schema';
import { buildSearchIndex, searchPath, SITE_DATA_SCHEMA, UI_LOCALES, type SiteData, type SiteModule } from '@kernelsu-modules/site';
import { buildSite } from '@kernelsu-modules/site/build';
import { BuildCache, sha256, type LastGood } from './cache.ts';
import { assertCspClean } from './csp-check.ts';
import { builderFingerprint } from './fingerprint.ts';
import { renderHeaders } from './headers.ts';
import { sanitizeSvg, sniffImage } from './image.ts';
import { loadInputs, resolveDataCommit } from './inputs.ts';
import { checkFetchUrl, DEFAULT_RETRY, FetchError, fetchRetry, isTransient, nodeHttpGet, type HttpGet, type RetryPolicy } from './net.ts';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
export const BUILDER_VERSION = `${PKG.name}@${PKG.version}`;

/** Projected file count above which remaining images are rendered as links instead of being copied. */
export const FILE_COUNT_WARN = 15_000;
/** Hard limit (Pages allows 20,000 files per deployment). Exceeding it without images to shed fails the build. */
export const FILE_COUNT_MAX = 19_500;
/** Files that do not scale with modules (pages, site assets, indexes, headers, manifest), with headroom. */
const BASE_FILE_OVERHEAD = 64;
/** Per module: {id}.json, update.json, changelog.md, readme.html + one detail page per UI locale. */
export const FILES_PER_MODULE = 4 + UI_LOCALES.length;
const PAGES_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** API path of the README fragment. Served by Pages from `readme.html` (Pages 308-redirects `*.html` to this). */
export const readmeApiPath = (id: string): string => `api/v1/modules/${id}/readme`;
export const readmeFile = (id: string): string => `${readmeApiPath(id)}.html`;
export const changelogPath = (id: string): string => `api/v1/modules/${id}/changelog.md`;
export const NO_RELEASE_NOTES = '(no release notes)';

export type LogLevel = 'info' | 'warn' | 'error';

export interface BuildOptions {
  dataDir: string;
  outDir: string;
  cacheDir?: string;
  baseUrl?: string;
  /** Data repo commit (index.json repoCommit only; not part of the buildId). Defaults to $DATA_COMMIT or git HEAD. */
  dataCommit?: string;
  portalUrl?: string;
  /** Network access (injectable for tests). Default: SSRF-guarded node:https. */
  httpGet?: HttpGet;
  /** Retries for 429 / 5xx / network errors (repository files; remote images get at most one retry). */
  retry?: Partial<RetryPolicy>;
  /** Injectable sleep for the retry backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Astro's log level for the page build. Default 'warn'. */
  siteLogLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Re-fetch remote (non-repo) images older than this. Default 24 h. */
  imageTtlMs?: number;
  /** File-count thresholds (tests): images degrade to links above `soft`, the build fails above `max`. */
  fileLimits?: { soft?: number; max?: number };
  /** Override the builder fingerprint (tests). Default: builderFingerprint(). */
  builderFingerprint?: string;
  now?: () => number;
  log?: (level: LogLevel, msg: string) => void;
}

export interface ModuleOutcome {
  id: string;
  status: 'ok' | 'stale' | 'skipped';
  contentCommit?: string;
  reason?: string;
}

export interface BuildResult {
  buildId: string;
  repoCommit: string;
  generatedAt: string;
  fileCount: number;
  outcomes: ModuleOutcome[];
  warnings: string[];
}

/** The build cannot produce a trustworthy dist (e.g. module inputs unreachable without a last-good copy). */
export class BuildFailure extends Error {
  override name = 'BuildFailure';
}

/** Per-module problem: the module is skipped (or served stale from the last good content). */
class ModuleError extends Error {
  constructor(
    message: string,
    /** Network / 429 / 5xx after retries: the input exists but could not be fetched right now. */
    readonly transient = false,
  ) {
    super(message);
  }
}

const iso = (s: string) => Date.parse(s);
function maxIso(values: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const v of values) if (v && (best === null || iso(v) > iso(best))) best = v;
  return best;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const td = new TextDecoder('utf-8', { fatal: false });
const enc = new TextEncoder();
const PLACEHOLDER_BUILD_ID = '0'.repeat(16);

function sortKeys<T>(rec: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function truncateUtf8(s: string, maxBytes: number): string {
  const b = enc.encode(s);
  if (b.length <= maxBytes) return s;
  return td.decode(b.subarray(0, maxBytes)).replace(/�$/, '') + '\n\n…';
}

/* ------------------------------------------------------------------ *
 * buildId: depends only on what reaches dist/
 * ------------------------------------------------------------------ */

/** Lock fields that reach the output (no seen / etags / installation / lastAttemptAt / module.prop dump). */
export function lockSubset(ml: ModuleLock): unknown {
  const rel = (r: LockedRelease) => ({
    releaseId: r.releaseId,
    tag: r.tag,
    tagCommit: r.tagCommit,
    name: r.name,
    body: r.body,
    prerelease: r.prerelease,
    publishedAt: r.publishedAt,
    htmlUrl: r.htmlUrl,
    version: r.version,
    versionCode: r.versionCode,
    asset: { url: r.asset.url, name: r.asset.name, size: r.asset.size, sha256: r.asset.sha256 },
  });
  return {
    repositoryId: ml.repositoryId,
    fullName: ml.fullName,
    content: ml.content
      ? { commit: ml.content.commit, fetchedAt: ml.content.fetchedAt, manifestPath: ml.content.manifestPath, files: ml.content.files }
      : null,
    stable: ml.stable ? rel(ml.stable) : null,
    releases: ml.releases.map(rel),
    health: { status: ml.health.status, lastSuccessAt: ml.health.lastSuccessAt },
    stars: ml.stars ? { count: ml.stars.count, fullName: ml.stars.fullName } : null,
  };
}

/** Policy fields the build reads. */
export function policySubset(p: Policy): unknown {
  const L = p.limits;
  return {
    limits: {
      manifestMaxBytes: L.manifestMaxBytes,
      docMaxBytes: L.docMaxBytes,
      imageMaxBytes: L.imageMaxBytes,
      imagesMaxPerModule: L.imagesMaxPerModule,
      imagesMaxTotalBytes: L.imagesMaxTotalBytes,
      imageMaxRedirects: L.imageMaxRedirects,
      changelogMaxBytes: L.changelogMaxBytes,
    },
    keepReleases: p.history.keepReleases,
  };
}

export interface BuildIdInputs {
  builder: string;
  baseUrl: string;
  portalUrl: string;
  policy: unknown;
  /** Included modules (listed + stable + matching binding), sorted by id. */
  modules: {
    id: string;
    repositoryId: number;
    lock: unknown;
    /** What the build made of it: status, the content commit actually used, digest of the module's outputs. */
    result: { status: ModuleOutcome['status']; contentCommit?: string; digest?: string };
  }[];
}

/**
 * First 16 hex of sha256 over the canonical JSON of everything that affects dist/: the builder fingerprint,
 * base/portal URLs, used policy fields, the included records + their lock subset, and the per-module build results
 * (stale fallback, image copies). The data repo commit is deliberately NOT an input: data commits that do not
 * change the output (other records, status.json, sync bookkeeping) keep the buildId and skip the deploy.
 */
export function computeBuildId(inputs: BuildIdInputs): string {
  return sha256(canonicalJson({ v: 2, ...inputs })).slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * Output path claims: per-module file/dir collisions
 * ------------------------------------------------------------------ */

function ancestors(p: string): string[] {
  const parts = p.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/**
 * Tracks which output paths are taken. A path is either a file (with an owner token: a content hash for shared
 * content-addressed assets, else the owner) or an implicit directory. A claim fails when a file path is taken
 * by a different owner, is somebody's directory, or one of its parent directories is somebody's file.
 */
export class PathClaims {
  private files = new Map<string, string>();
  private dirs = new Set<string>();

  /** Claims all entries or none; returns the conflict description, or null on success. */
  tryClaim(entries: [path: string, owner: string][]): string | null {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const fileOwner = (p: string) => files.get(p) ?? this.files.get(p);
    const isDir = (p: string) => dirs.has(p) || this.dirs.has(p);
    for (const [p, owner] of entries) {
      const prev = fileOwner(p);
      if (prev !== undefined && prev !== owner) return `${p} is already taken by ${prev}`;
      if (isDir(p)) return `${p} is already a directory of another output`;
      for (const d of ancestors(p)) {
        const f = fileOwner(d);
        if (f !== undefined) return `${p} needs ${d}/ as a directory, but ${d} is a file of ${f}`;
      }
      files.set(p, owner);
      for (const d of ancestors(p)) dirs.add(d);
    }
    for (const [p, o] of files) this.files.set(p, o);
    for (const d of dirs) this.dirs.add(d);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Per-module build
 * ------------------------------------------------------------------ */

interface LoadedContent {
  fullName: string;
  commit: string;
  manifestPath: string;
  files: Record<string, string>;
  manifest: ModuleManifest;
  doc: string;
  icon: Uint8Array | null;
}

/** Everything one module contributes to dist/ (detail.buildId is filled in once the buildId is known). */
interface ModuleBuild {
  detail: ApiModuleDetail;
  update: ApiUpdateJson;
  /** Sanitized README HTML (fragment and site page), or null. */
  readme: string | null;
  changelog: string;
  assets: Map<string, Uint8Array>;
  outcome: ModuleOutcome;
}

function moduleDigest(mb: ModuleBuild): string {
  const { buildId: _omit, ...detail } = mb.detail;
  return sha256(canonicalJson({ detail, update: mb.update, readme: mb.readme, changelog: mb.changelog, assets: [...mb.assets.keys()].sort() }));
}

class Builder {
  readonly warnings: string[] = [];
  readonly cache: BuildCache;
  readonly get: HttpGet;
  readonly now: () => number;
  readonly ttl: number;
  readonly retry: RetryPolicy;
  readonly imageRetry: RetryPolicy;
  readonly sleep: ((ms: number) => Promise<void>) | undefined;
  /** Asset paths already allocated by any module (content-addressed, shared). */
  readonly assetPaths = new Set<string>();
  private degradedLogged = false;

  constructor(
    readonly opts: BuildOptions,
    readonly policy: Policy,
    readonly baseUrl: string,
    /** Remaining new image files before images degrade to links (global file budget). */
    private imageSlots: number,
  ) {
    this.cache = new BuildCache(opts.cacheDir ?? path.join(os.tmpdir(), 'kernelsu-modules-build-cache'));
    this.get = opts.httpGet ?? nodeHttpGet;
    this.now = opts.now ?? Date.now;
    this.ttl = opts.imageTtlMs ?? 24 * 3600 * 1000;
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.imageRetry = { ...this.retry, retries: Math.min(1, this.retry.retries) };
    this.sleep = opts.sleep;
  }

  log(level: LogLevel, msg: string): void {
    if (level !== 'info') this.warnings.push(msg);
    (this.opts.log ?? ((l, m) => console.error(`[build] ${l}: ${m}`)))(level, msg);
  }

  /** True when a new image file may still be added to dist (global budget); logs the first refusal. */
  private hasImageSlot(): boolean {
    if (this.imageSlots > 0) return true;
    if (!this.degradedLogged) {
      this.degradedLogged = true;
      this.log('warn', 'file budget reached: remaining images are linked instead of copied (plan moving images to separate storage)');
    }
    return false;
  }

  /** Reserve `p` for an image; false = over the global budget (caller degrades the image). */
  claimImage(p: string): boolean {
    if (this.assetPaths.has(p)) return true;
    if (!this.hasImageSlot()) return false;
    this.imageSlots--;
    this.assetPaths.add(p);
    return true;
  }

  /** A file of the module repo at a locked commit, verified against the lock digest. */
  async repoFile(fullName: string, commit: string, filePath: string, expected: string | undefined, maxBytes: number): Promise<Uint8Array> {
    if (!expected) throw new ModuleError(`${filePath} is not recorded in the lock (content.files)`);
    const cached = await this.cache.getBlob(expected);
    if (cached) return cached;
    const url = `https://raw.githubusercontent.com/${fullName}/${commit}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
    let body: Uint8Array;
    try {
      body = (await fetchRetry(this.get, url, { maxRedirects: this.policy.limits.imageMaxRedirects, maxBytes }, this.retry, this.sleep)).body;
    } catch (e) {
      throw new ModuleError(`fetch ${filePath}@${commit.slice(0, 12)} failed: ${(e as Error).message}`, isTransient(e));
    }
    const got = sha256(body);
    if (got !== expected) throw new ModuleError(`sha256 mismatch for ${filePath}@${commit.slice(0, 12)}: expected ${expected}, got ${got}`);
    await this.cache.putBlob(body);
    return body;
  }

  async loadContent(id: string, src: LastGood): Promise<LoadedContent> {
    const L = this.policy.limits;
    const mBytes = await this.repoFile(src.fullName, src.commit, src.manifestPath, src.files[src.manifestPath], L.manifestMaxBytes);
    let parsed: unknown;
    try {
      parsed = YAML.parse(td.decode(mBytes));
    } catch (e) {
      throw new ModuleError(`module.yaml is not valid YAML: ${(e as Error).message}`);
    }
    const r = ModuleManifest.safeParse(parsed);
    if (!r.success) throw new ModuleError(`module.yaml invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    const manifest = r.data;
    if (manifest.id !== id) throw new ModuleError(`module.yaml id "${manifest.id}" != record id "${id}"`);
    const docBytes = await this.repoFile(src.fullName, src.commit, manifest.description, src.files[manifest.description], L.docMaxBytes);
    const doc = td.decode(docBytes).replace(/^﻿/, '');
    const icon = manifest.icon
      ? await this.repoFile(src.fullName, src.commit, manifest.icon, src.files[manifest.icon], L.imageMaxBytes)
      : null;
    return { fullName: src.fullName, commit: src.commit, manifestPath: src.manifestPath, files: src.files, manifest, doc, icon };
  }

  /** Normalize image bytes -> [ext, bytes] or null if not an acceptable image. */
  normalizeImage(bytes: Uint8Array): { ext: string; bytes: Uint8Array } | null {
    const ext = sniffImage(bytes);
    if (!ext) return null;
    if (ext === 'svg') {
      const clean = sanitizeSvg(bytes);
      return clean ? { ext, bytes: clean } : null;
    }
    return { ext, bytes };
  }

  /**
   * Copy one referenced image. Returns the asset path, '' to drop the image (unsafe / not an
   * image), or null to render it as a link (limits / file budget exceeded, transient errors).
   */
  async copyImage(
    url: string,
    content: LoadedContent,
    budget: { count: number; bytes: number },
    assets: Map<string, Uint8Array>,
  ): Promise<string | '' | null> {
    const L = this.policy.limits;
    try {
      checkFetchUrl(url);
    } catch {
      return '';
    }
    if (budget.count >= L.imagesMaxPerModule) return null;
    if (!this.hasImageSlot()) return null;
    let raw: Uint8Array | null = null;
    const repoPrefix = `https://raw.githubusercontent.com/${content.fullName}/${content.commit}/`;
    let repoPath: string | null = null;
    if (url.startsWith(repoPrefix)) {
      try {
        repoPath = url.slice(repoPrefix.length).split('/').map(decodeURIComponent).join('/');
      } catch {
        repoPath = null;
      }
    }
    if (repoPath && content.files[repoPath]) {
      try {
        raw = await this.repoFile(content.fullName, content.commit, repoPath, content.files[repoPath], L.imageMaxBytes);
      } catch (e) {
        this.log('warn', `image ${url}: ${(e as Error).message}`);
        return null;
      }
    } else {
      const meta = await this.cache.getImageMeta(url);
      const fresh = meta && this.now() - meta.fetchedAt < this.ttl;
      if (fresh && meta.error) return meta.errorKind === 'policy' ? '' : null;
      if (fresh && meta.sha256) raw = await this.cache.getBlob(meta.sha256);
      if (!raw) {
        try {
          const res = await fetchRetry(this.get, url, { maxRedirects: L.imageMaxRedirects, maxBytes: L.imageMaxBytes }, this.imageRetry, this.sleep);
          const norm = this.normalizeImage(res.body);
          if (!norm) {
            await this.cache.putImageMeta({ url, sha256: null, ext: null, fetchedAt: this.now(), error: 'not a supported image', errorKind: 'policy' });
            this.log('warn', `image ${url}: not a supported image type, dropped`);
            return '';
          }
          const h = await this.cache.putBlob(res.body);
          await this.cache.putImageMeta({ url, sha256: h, ext: norm.ext, fetchedAt: this.now(), error: null, errorKind: null });
          raw = res.body;
        } catch (e) {
          const kind = e instanceof FetchError ? e.kind : 'network';
          // Transient failure: fall back to an older cached copy if we have one.
          if ((kind === 'network' || kind === 'http') && meta?.sha256) raw = await this.cache.getBlob(meta.sha256);
          if (!raw) {
            await this.cache.putImageMeta({ url, sha256: null, ext: null, fetchedAt: this.now(), error: (e as Error).message, errorKind: kind });
            this.log('warn', `image ${url}: ${(e as Error).message}`);
            return kind === 'policy' ? '' : null;
          }
        }
      }
    }
    const norm = this.normalizeImage(raw);
    if (!norm) {
      this.log('warn', `image ${url}: not a supported image type, dropped`);
      return '';
    }
    if (norm.bytes.length > L.imageMaxBytes || budget.bytes + norm.bytes.length > L.imagesMaxTotalBytes) return null;
    const p = `assets/${sha256(norm.bytes).slice(0, 16)}.${norm.ext}`;
    if (!this.claimImage(p)) return null;
    budget.count++;
    budget.bytes += norm.bytes.length;
    assets.set(p, norm.bytes);
    return p;
  }

  changelogSource(r: LockedRelease): string | null {
    return r.body?.trim() ? truncateUtf8(r.body, this.policy.limits.changelogMaxBytes) : null;
  }

  /** `resolveImage` maps images to root-absolute local copies ("/assets/…"); others become links. */
  release(r: LockedRelease, fullName: string, resolveImage: (u: string) => string | null): ApiModuleDetail['releases'][number] {
    const body = this.changelogSource(r);
    const changelogHtml = body
      ? renderChangelog(body, { fullName, commit: r.tagCommit, resolveImage, remoteImages: 'link' }).trim() || null
      : null;
    return {
      tag: r.tag,
      name: r.name,
      version: r.version,
      versionCode: r.versionCode,
      prerelease: r.prerelease,
      publishedAt: r.publishedAt,
      changelogHtml,
      zip: { url: r.asset.url, name: r.asset.name, size: r.asset.size, sha256: r.asset.sha256 },
      tagCommit: r.tagCommit,
      releaseUrl: r.htmlUrl,
      attestationUrl: `https://github.com/${fullName}/attestations`,
      immutable: true,
    };
  }

  /**
   * Content for one module: the locked commit, else the verified last good content (stale). When the locked
   * content could not be fetched (network / 429 / 5xx after retries) and no last good copy is usable, the whole
   * build fails (BuildFailure) so the live site keeps its previous deployment; content problems (digest mismatch,
   * missing file, invalid module.yaml) only skip the module.
   */
  async resolveContent(id: string, ml: ModuleLock): Promise<{ content: LoadedContent; stale: boolean }> {
    let failure: ModuleError;
    if (ml.content) {
      const cur: LastGood = {
        repositoryId: ml.repositoryId,
        fullName: ml.fullName,
        commit: ml.content.commit,
        manifestPath: ml.content.manifestPath,
        files: ml.content.files,
      };
      try {
        const content = await this.loadContent(id, cur);
        await this.cache.putLastGood(id, cur);
        return { content, stale: false };
      } catch (e) {
        if (!(e instanceof ModuleError)) throw e;
        failure = e;
      }
    } else failure = new ModuleError('lock has no content commit');
    const last = await this.cache.getLastGood(id);
    let lastProblem = last ? '' : '; no last good content cached';
    if (last && last.repositoryId === ml.repositoryId) {
      try {
        const content = await this.loadContent(id, { ...last, fullName: ml.fullName });
        this.log('warn', `${id}: ${failure.message}; using last good content ${last.commit.slice(0, 12)} (stale)`);
        return { content, stale: true };
      } catch (e) {
        if (!(e instanceof ModuleError)) throw e;
        lastProblem = `; last good content unusable: ${e.message}`;
      }
    } else if (last) lastProblem = '; last good content belongs to another repository';
    if (failure.transient) throw new BuildFailure(`${id}: module inputs could not be fetched (${failure.message})${lastProblem}`);
    throw new ModuleError(failure.message + lastProblem);
  }

  async module(record: RegistryRecord, ml: ModuleLock): Promise<ModuleBuild> {
    const id = record.id;
    const stable = ml.stable!;
    const resolved = await this.resolveContent(id, ml);
    const content = resolved.content;
    const stale = resolved.stale || ml.health.status !== 'ok';

    const m = content.manifest;
    const fullName = content.fullName;
    const assets = new Map<string, Uint8Array>();

    // Icon (repo file, verified). An unusable icon is dropped, not fatal.
    let icon: string | null = null;
    if (content.icon) {
      const norm = this.normalizeImage(content.icon);
      if (!norm) this.log('warn', `${id}: icon ${m.icon} is not a supported image, ignored`);
      else {
        const p = `assets/${sha256(norm.bytes).slice(0, 16)}.${norm.ext}`;
        if (this.claimImage(p)) {
          icon = p;
          assets.set(p, norm.bytes);
        }
      }
    }

    // Releases: newest versionCode first, stable always present, prereleases recorded.
    const byId = new Map<number, LockedRelease>();
    for (const r of [stable, ...ml.releases]) if (!byId.has(r.releaseId)) byId.set(r.releaseId, r);
    let rels = [...byId.values()]
      .filter((r) => r === stable || r.prerelease || r.versionCode < stable.versionCode)
      .sort((a, b) => b.versionCode - a.versionCode || iso(b.publishedAt) - iso(a.publishedAt) || b.releaseId - a.releaseId);
    const keep = this.policy.history.keepReleases;
    if (rels.length > keep) {
      const head = rels.slice(0, keep);
      if (!head.includes(stable)) head[keep - 1] = stable;
      rels = head.sort((a, b) => b.versionCode - a.versionCode || iso(b.publishedAt) - iso(a.publishedAt));
    }
    const firstStable = rels.find((r) => !r.prerelease);
    if (firstStable !== stable) throw new ModuleError('lock inconsistency: stable is not the newest non-prerelease release');

    // Pass 1: collect images referenced by the description, then by the changelogs.
    const docCtx: RenderContext = { fullName, commit: content.commit, docPath: m.description };
    const images: string[] = [];
    const want = (list: string[]) => {
      for (const u of list) if (!images.includes(u)) images.push(u);
    };
    want(renderMarkdown(content.doc, docCtx).images);
    for (const r of rels) {
      const body = this.changelogSource(r);
      if (body) want(renderNotes(body, { fullName, commit: r.tagCommit }).images);
    }
    const imageMap = new Map<string, string | '' | null>();
    const budget = { count: 0, bytes: 0 };
    for (const u of images) imageMap.set(u, await this.copyImage(u, content, budget, assets));
    /** Local copy "/assets/…", '' = drop, null = not copied (rendered as a link). */
    const resolveImage = (u: string) => {
      const r = imageMap.get(u);
      return r === undefined || r === null ? null : r === '' ? '' : '/' + r;
    };

    // One README rendering for both the API fragment and the site page: same-origin "/assets/…" images only
    // (the Manager WebView loads no remote subresources; the site CSP is img-src 'self' data:), images without
    // a local copy become plain links.
    const readmeHtml = renderMarkdown(content.doc, { ...docCtx, resolveImage, remoteImages: 'link' }).html;
    const readme = readmeHtml.trim() ? readmeHtml : null;

    const healthStatus: 'ok' | 'stale' = stale ? 'stale' : 'ok';
    const detailRaw = {
      id,
      name: m.name,
      summary: m.summary,
      authors: moduleAuthors(m.authors, fullName),
      tags: m.tags ?? [],
      metamodule: m.metamodule,
      icon,
      stable: { version: stable.version, versionCode: stable.versionCode, publishedAt: stable.publishedAt },
      stars: ml.stars?.count ?? null,
      starsRepository: ml.stars?.fullName ?? null,
      detail: `api/v1/modules/${id}.json`,
      updatedAt: maxIso([stable.publishedAt, ml.content?.commit === content.commit ? ml.content.fetchedAt : null]) ?? stable.publishedAt,
      schemaVersion: API_SCHEMA_VERSION,
      buildId: PLACEHOLDER_BUILD_ID,
      license: m.license ?? null,
      homepage: m.homepage ?? null,
      support: m.support ?? null,
      compatibility: m.compatibility ?? null,
      source: { host: 'github', fullName, url: `https://github.com/${fullName}`, commit: content.commit },
      readme: readme === null ? null : readmeApiPath(id),
      releases: rels.map((r) => this.release(r, fullName, resolveImage)),
      // From the lock; there is no sync heartbeat: lastSuccessAt is the last successful sync that changed something.
      health: { status: healthStatus, lastSuccessAt: ml.health.lastSuccessAt },
    };
    const dr = ApiModuleDetail.safeParse(detailRaw);
    if (!dr.success) throw new ModuleError(`detail does not match ApiModuleDetail: ${dr.error.message}`);
    const ur = ApiUpdateJson.safeParse({
      version: stable.version,
      versionCode: stable.versionCode,
      zipUrl: stable.asset.url,
      changelog: `${this.baseUrl}/${changelogPath(id)}`,
    });
    if (!ur.success) throw new ModuleError(`update.json invalid: ${ur.error.message}`);
    const notes = this.changelogSource(stable);
    const changelog = (notes ?? NO_RELEASE_NOTES).replace(/\n*$/, '\n');
    return {
      detail: dr.data,
      update: ur.data,
      readme,
      changelog,
      assets,
      outcome: { id, status: healthStatus === 'stale' ? 'stale' : 'ok', contentCommit: content.commit },
    };
  }
}

/**
 * module.yaml `authors` (the complete list) when non-empty; otherwise the owner of the bound repository
 * ({fullName} = "owner/repo"), shown by login and linked to the GitHub profile.
 */
export function moduleAuthors(authors: { name: string; url?: string }[] | undefined, fullName: string): { name: string; url?: string }[] {
  if (authors?.length) return authors.map((a) => (a.url ? { name: a.name, url: a.url } : { name: a.name }));
  const owner = fullName.split('/')[0] ?? '';
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) ? [{ name: owner, url: `https://github.com/${owner}` }] : [];
}

/** Every output path of one module, with its owner token (content hash for shared assets). */
function moduleEntries(mb: ModuleBuild): [string, string][] {
  const id = mb.detail.id;
  const own = `module ${id}`;
  const out: [string, string][] = [
    [`api/v1/modules/${id}.json`, own],
    [`api/v1/modules/${id}/update.json`, own],
    [changelogPath(id), own],
    ...UI_LOCALES.map((ui): [string, string] => [`${ui}/modules/${id}/index.html`, own]),
  ];
  if (mb.readme !== null) out.push([readmeFile(id), own]);
  for (const [p, bytes] of mb.assets) out.push([p, `sha256:${sha256(bytes)}`]);
  return out;
}

/** Files under `dir`, relative, "/"-separated, sorted. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of (await readdir(path.join(dir, prefix), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
    else throw new Error(`unexpected non-regular file: ${path.join(dir, rel)}`);
  }
  return out;
}

function assertSafeOutDir(outDir: string, dataDir: string, cacheDir: string | undefined): void {
  const o = path.resolve(outDir);
  const forbidden = [path.parse(o).root, os.homedir(), process.cwd(), path.resolve(dataDir)];
  if (forbidden.includes(o)) throw new Error(`refusing to use ${o} as output directory`);
  for (const inner of [dataDir, cacheDir].filter((x): x is string => !!x)) {
    const rel = path.relative(o, path.resolve(inner));
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error(`output directory ${o} contains ${inner}`);
  }
}

/** Site-level paths the build always produces (claimed before any module). */
function fixedEntries(): [string, string][] {
  const g = 'site';
  return [
    'api/v1/index.json', 'api/v1/modules.json', '_headers', 'build-manifest.json',
    'index.html', '404.html', 'sitemap.xml', 'robots.txt', 'favicon.ico',
    ...UI_LOCALES.flatMap((ui) => [`${ui}/index.html`, searchPath(ui)]),
  ].map((p): [string, string] => [p, g]);
}

export async function build(opts: BuildOptions): Promise<BuildResult> {
  const dataCommit = resolveDataCommit(opts.dataDir, opts.dataCommit);
  const inputs = await loadInputs(opts.dataDir, dataCommit);
  assertSafeOutDir(opts.outDir, opts.dataDir, opts.cacheDir);
  const baseUrl = (opts.baseUrl ?? 'https://modules.kernelsu.org').replace(/\/+$/, '');
  const portalUrl = opts.portalUrl ?? 'https://developers.kernelsu.org';
  const softLimit = opts.fileLimits?.soft ?? FILE_COUNT_WARN;
  const maxFiles = opts.fileLimits?.max ?? FILE_COUNT_MAX;

  // ---- select: listed records whose lock has a stable release from the bound repository ----
  const outcomes: ModuleOutcome[] = [];
  const candidates: [RegistryRecord, ModuleLock][] = [];
  for (const [id, record] of [...inputs.records].sort(([a], [x]) => (a < x ? -1 : 1))) {
    if (record.status !== 'listed') continue;
    const ml = inputs.lock.modules[id];
    if (!ml?.stable) {
      outcomes.push({ id, status: 'skipped', reason: 'no validated stable release in the lock (module hidden)' });
      continue;
    }
    if (!record.source || record.source.repositoryId !== ml.repositoryId) {
      outcomes.push({ id, status: 'skipped', reason: 'lock is bound to a different repository than the record' });
      continue;
    }
    candidates.push([record, ml]);
  }

  const projected = BASE_FILE_OVERHEAD + candidates.length * FILES_PER_MODULE;
  const b = new Builder(opts, inputs.policy, baseUrl, Math.max(0, softLimit - projected));
  for (const o of outcomes)
    if (o.reason?.startsWith('lock is bound')) b.log('warn', `${o.id}: lock repositoryId != record source; skipped until the next sync`);

  const claims = new PathClaims();
  const fixedConflict = claims.tryClaim(fixedEntries());
  if (fixedConflict) throw new BuildFailure(`site paths overlap: ${fixedConflict}`);

  const builds: ModuleBuild[] = [];
  const results = new Map<string, BuildIdInputs['modules'][number]['result']>();
  for (const [record, ml] of candidates) {
    const id = record.id;
    let mb: ModuleBuild;
    try {
      mb = await b.module(record, ml);
    } catch (e) {
      if (!(e instanceof ModuleError)) throw e;
      b.log('warn', `${id}: skipped: ${e.message}`);
      outcomes.push({ id, status: 'skipped', reason: e.message });
      results.set(id, { status: 'skipped' });
      continue;
    }
    const conflict = claims.tryClaim(moduleEntries(mb));
    if (conflict) {
      const reason = `output path collision: ${conflict}`;
      b.log('warn', `${id}: skipped: ${reason}`);
      outcomes.push({ id, status: 'skipped', reason });
      results.set(id, { status: 'skipped' });
      continue;
    }
    builds.push(mb);
    outcomes.push(mb.outcome);
    results.set(id, { status: mb.outcome.status, contentCommit: mb.outcome.contentCommit, digest: moduleDigest(mb) });
  }
  outcomes.sort((a, c) => (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));

  // ---- buildId + generatedAt: functions of the included modules only (never the data commit / wall clock) ----
  const buildId = computeBuildId({
    builder: opts.builderFingerprint ?? builderFingerprint(),
    baseUrl,
    portalUrl,
    policy: policySubset(inputs.policy),
    modules: candidates.map(([r, ml]) => ({ id: r.id, repositoryId: ml.repositoryId, lock: lockSubset(ml), result: results.get(r.id)! })),
  });
  const generatedAt =
    maxIso(candidates.flatMap(([, ml]) => [ml.health.lastSuccessAt, ml.content?.fetchedAt, ...ml.releases.map((r) => r.publishedAt), ml.stable?.publishedAt])) ??
    '1970-01-01T00:00:00Z';
  for (const mb of builds) mb.detail.buildId = buildId;

  // ---- assemble dist ----
  const files = new Map<string, Uint8Array>();
  const add = (p: string, content: string | Uint8Array) => {
    const bytes = typeof content === 'string' ? enc.encode(content) : content;
    const prev = files.get(p);
    if (prev && sha256(prev) !== sha256(bytes)) throw new Error(`output path collision: ${p}`);
    if (bytes.length > PAGES_MAX_FILE_BYTES) throw new Error(`${p} exceeds the Pages per-file limit`);
    files.set(p, bytes);
  };

  for (const mb of builds) {
    for (const [p, bytes] of mb.assets) add(p, bytes);
    const id = mb.detail.id;
    add(`api/v1/modules/${id}.json`, json(mb.detail));
    add(`api/v1/modules/${id}/update.json`, json(mb.update));
    add(changelogPath(id), mb.changelog);
    if (mb.readme !== null) add(readmeFile(id), mb.readme + '\n');
  }
  const modules = ApiModules.parse({
    schemaVersion: API_SCHEMA_VERSION,
    buildId,
    modules: builds.map((mb) => ApiModuleSummary.parse(mb.detail)),
  });
  add('api/v1/modules.json', json(modules));
  add(
    'api/v1/index.json',
    json(ApiIndex.parse({ schemaVersion: API_SCHEMA_VERSION, buildId, repoCommit: dataCommit, generatedAt, modules: 'api/v1/modules.json' })),
  );

  const siteModules: SiteModule[] = builds.map((mb) => ({ detail: mb.detail, readme: mb.readme }));
  for (const ui of UI_LOCALES) add(searchPath(ui), json(buildSearchIndex({ buildId, modules: siteModules }, ui)));
  add('_headers', renderHeaders());

  // ---- pages: Astro (site/) renders the page data into static HTML + hashed CSS/JS ----
  const work = await mkdtemp(path.join(os.tmpdir(), 'kernelsu-build-site-'));
  try {
    const siteData: SiteData = { schemaVersion: SITE_DATA_SCHEMA, baseUrl, portalUrl, buildId, generatedAt, modules: siteModules };
    const dataFile = path.join(work, 'site-data.json');
    await writeFile(dataFile, JSON.stringify(siteData));
    const siteOut = path.join(work, 'dist');
    await buildSite({ dataFile, outDir: siteOut, site: baseUrl, logLevel: opts.siteLogLevel });
    for (const rel of await listFiles(siteOut)) add(rel, new Uint8Array(await readFile(path.join(siteOut, rel))));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  for (const ui of UI_LOCALES) for (const p of [`${ui}/index.html`, searchPath(ui)]) if (!files.has(p)) throw new Error(`site build did not produce ${p}`);
  for (const p of ['index.html', '404.html']) if (!files.has(p)) throw new Error(`site build did not produce ${p}`);
  assertCspClean([...files].filter(([p]) => p.endsWith('.html')).map(([p, bytes]): [string, string] => [p, td.decode(bytes)]));

  const fileCount = files.size + 1; // + build-manifest.json
  if (fileCount > maxFiles) throw new BuildFailure(`dist has ${fileCount} files, above the safety limit ${maxFiles} (Pages max 20,000) even with images linked`);
  if (fileCount > softLimit) b.log('warn', `dist has ${fileCount} files (Pages limit 20,000); plan to move images to separate storage`);

  const manifest = {
    schemaVersion: 1,
    buildId,
    builder: BUILDER_VERSION,
    // Informational: the data commit this dist was built from. A later data commit with the same buildId is not
    // deployed, so the live repoCommit (here and in api/v1/index.json) may lag behind the data repo.
    repoCommit: dataCommit,
    generatedAt,
    inputs: {
      lockSha256: inputs.lockSha256,
      policySha256: inputs.policySha256,
      records: sortKeys(inputs.recordSha256),
      modules: Object.fromEntries(outcomes.map((o) => [o.id, o.status === 'skipped' ? { status: o.status } : { status: o.status, contentCommit: o.contentCommit }])),
    },
    fileCount,
    files: sortKeys(Object.fromEntries([...files].map(([p, bytes]) => [p, sha256(bytes)]))),
  };
  add('build-manifest.json', json(manifest));

  // ---- write atomically-ish: staging dir, then swap; build-manifest.json is written last ----
  const out = path.resolve(opts.outDir);
  const staging = `${out}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  for (const p of [...files.keys()].sort((a, c) => (a === 'build-manifest.json' ? 1 : c === 'build-manifest.json' ? -1 : a < c ? -1 : 1))) {
    const full = path.join(staging, p);
    if (!full.startsWith(staging + path.sep)) throw new Error(`bad output path ${p}`);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, files.get(p)!);
  }
  await rm(out, { recursive: true, force: true });
  await rename(staging, out);

  return { buildId, repoCommit: dataCommit, generatedAt, fileCount, outcomes, warnings: b.warnings };
}
