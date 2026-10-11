// Portal precheck: API-only checks run with the Modules App installation token. The release ZIP is NOT
// downloaded here: module.prop, ZIP limits, sha256, images and docs are validated by the Actions sync, which
// the Portal dispatches with `--module <id>` right after a submit/transfer request is recorded and
// which reports the result as a Check Run.
//
// Subrequests: contents(module.yaml) + 1 directory listing per distinct parent directory of the referenced
// files (icon, description doc; capped) + releases/latest. CPU: YAML+zod of module.yaml (<1 ms).
import type { GitHubClient } from '@kernelsu-modules/github';
import type { ModuleManifest, Policy } from '@kernelsu-modules/schema';
import { checkModuleId, checkReleaseEligibility, manifestReferencedPaths, parseManifest, selectAsset, type Issue, type ReleaseLike } from '@kernelsu-modules/validator';
import { FileTooLarge, readRepoFile, type RepoInfo } from './repo.ts';

export interface PrecheckResult {
  ok: boolean;
  issues: Issue[];
  manifest?: ModuleManifest;
  /** Latest published non-prerelease release. No version/versionCode: those come from module.prop, read only by the sync. */
  latestRelease?: {
    tag: string;
    immutable: boolean;
    url?: string;
    asset?: { name: string; size: number; digest: string | null; url: string };
  };
}

export interface PrecheckOptions {
  ref?: string;
  manifestPath?: string;
  /** The ID the caller wants to bind (submit/transfer); module.yaml must declare exactly this. */
  expectedId?: string;
  /**
   * ID rules for module.yaml's id against the active module IDs (case-fold collisions; exact matches are not
   * collisions). Skipped when `isRegistered(id)`: an ID that already has a record passed these rules when it was
   * submitted. Availability itself is /api/ids.
   */
  ids?: { existing: Iterable<string>; isRegistered?: (id: string) => boolean };
}

/** Parent directories listed at most per precheck (each listing is one subrequest). */
const MAX_DIR_LISTINGS = 4;

const err = (code: string, message: string, severity: Issue['severity'] = 'error', path?: string): Issue => ({
  code,
  severity,
  message,
  ...(path ? { path } : {}),
});

export async function precheck(
  gh: GitHubClient,
  repo: Pick<RepoInfo, 'full_name' | 'default_branch' | 'private'>,
  policy: Policy,
  opts: PrecheckOptions = {},
): Promise<PrecheckResult> {
  const issues: Issue[] = [];
  const out: PrecheckResult = { ok: false, issues };
  const ref = opts.ref ?? repo.default_branch;
  const manifestPath = opts.manifestPath ?? 'module.yaml';
  if (repo.private) issues.push(err('repo-private', `${repo.full_name} is private; only public repositories can be listed.`));

  let text: string | null = null;
  let tooLarge = false;
  try {
    text = await readRepoFile(gh, repo.full_name, manifestPath, ref, policy.limits.manifestMaxBytes);
  } catch (e) {
    if (!(e instanceof FileTooLarge)) throw e;
    tooLarge = true;
    issues.push(err('manifest-too-large', e.message));
  }
  if (text === null && !tooLarge) issues.push(err('manifest-missing', `${manifestPath} not found on ${ref}.`));
  if (text !== null) {
    const m = parseManifest(text, { maxBytes: policy.limits.manifestMaxBytes });
    issues.push(...m.issues);
    if (m.value) out.manifest = m.value;
  }
  const manifest = out.manifest;
  if (manifest) {
    if (opts.expectedId && manifest.id !== opts.expectedId)
      issues.push(err('manifest-id-mismatch', `module.yaml id "${manifest.id}" does not match the requested ID "${opts.expectedId}".`));
    if (opts.ids && !opts.ids.isRegistered?.(manifest.id)) issues.push(...checkModuleId(manifest.id, policy, opts.ids.existing));
    issues.push(...(await checkReferencedPaths(gh, repo.full_name, ref, manifestPath, manifestReferencedPaths(manifest))));
  }

  const rel = await gh.get<ReleaseLike & { html_url: string }>(`/repos/${repo.full_name}/releases/latest`, { allow: [404] });
  if (rel.status === 404) {
    issues.push(err('release-none', 'No published (non-prerelease) release yet. Publish an immutable release with the module ZIP.', 'warning'));
  } else {
    const r = rel.data;
    out.latestRelease = { tag: r.tag_name, immutable: r.immutable === true, url: r.html_url };
    issues.push(...checkReleaseEligibility(r, repo.full_name));
    const sel = selectAsset(r, manifest?.release?.assetPattern);
    issues.push(...sel.issues);
    const asset = sel.value;
    if (asset) {
      // Pre-June-2025 assets have no `digest`; tolerate null.
      out.latestRelease.asset = { name: asset.name, size: asset.size, digest: asset.digest ?? null, url: asset.browser_download_url };
      if (asset.size > policy.limits.zipMaxBytes) issues.push(err('zip-too-large', `${asset.name} is ${asset.size} bytes (limit ${policy.limits.zipMaxBytes}).`));
    }
  }
  out.ok = !issues.some((i) => i.severity === 'error');
  return out;
}

/**
 * Referenced files (icon, description doc) must exist as regular files at `ref`. Paths are relative to the
 * repository root (manifest RelativePath). One contents-API directory listing per distinct parent directory;
 * no file bodies are downloaded.
 */
async function checkReferencedPaths(gh: GitHubClient, fullName: string, ref: string, manifestPath: string, paths: string[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const clean = p.replace(/^\.\//, '');
    const i = clean.lastIndexOf('/');
    const dir = i < 0 ? '' : clean.slice(0, i);
    byDir.set(dir, [...(byDir.get(dir) ?? []), clean]);
  }
  let listed = 0;
  for (const [dir, files] of byDir) {
    if (listed++ >= MAX_DIR_LISTINGS) {
      issues.push(err('manifest-paths-unchecked', `${files.join(', ')} not checked by the Portal; the sync job verifies them.`, 'warning', manifestPath));
      continue;
    }
    const encDir = dir ? '/' + dir.split('/').map(encodeURIComponent).join('/') : '';
    const res = await gh.get<{ name: string; type: string }[] | { type: string }>(`/repos/${fullName}/contents${encDir}`, { query: { ref }, allow: [404] });
    const entries = new Map<string, string>(res.status === 200 && Array.isArray(res.data) ? res.data.map((e) => [e.name, e.type] as const) : []);
    for (const f of files) {
      const type = entries.get(f.slice(f.lastIndexOf('/') + 1));
      if (type !== 'file')
        issues.push(err('manifest-path-missing', type ? `${f} is a ${type}, not a regular file (at ${ref}).` : `${f} does not exist at ${ref}.`, 'error', manifestPath));
    }
  }
  return issues;
}

export function precheckSummary(p: PrecheckResult | null): string {
  if (!p) return 'precheck unavailable';
  const errors = p.issues.filter((i) => i.severity === 'error');
  const warnings = p.issues.filter((i) => i.severity === 'warning');
  if (!errors.length && !warnings.length) return 'all checks passed';
  const codes = [...new Set(errors.map((i) => i.code))].slice(0, 5).join(', ');
  return `${errors.length} error(s)${codes ? ` [${codes}]` : ''}, ${warnings.length} warning(s)`;
}
