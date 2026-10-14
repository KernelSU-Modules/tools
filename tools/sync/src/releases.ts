// Release stage: eligibility -> asset selection -> download + sha256 -> ZIP validation -> version rules.
import type { GitHubClient } from '@kernelsu-modules/github';
import type { LockedRelease, ManifestKind, ModuleLock, Policy } from '@kernelsu-modules/schema';
import {
  checkReleaseEligibility,
  isMetamoduleProp,
  rangeReaderFromBytes,
  selectAsset,
  validateReleaseAsset,
  type Issue,
  type ZipLimits,
} from '@kernelsu-modules/validator';
import { createCheckOnce, type CheckSpec } from './checks.ts';
import { DownloadError, downloadAsset, parseDigest } from './download.ts';
import type { Logger } from './log.ts';
import { isTransient, resolveTagCommit, type GhRelease } from './repo-api.ts';

type Seen = ModuleLock['seen'][string];

/** seen-failures that a manual "Sync now" (--module) retries. */
export const RETRYABLE_CODES = new Set(['asset-download-failed', 'asset-size-mismatch', 'asset-digest-mismatch', 'tag-not-found']);
export const SEEN_CAP = 200;

export interface ReleaseOutcome {
  releaseId: number;
  tag: string;
  result: 'accepted' | 'same' | 'rejected' | 'retry';
  versionCode?: number;
  issues: Issue[];
  check?: 'created' | 'exists' | 'failed' | 'skipped';
}

export interface ReleaseStageInput {
  gh: GitHubClient;
  fetch: typeof fetch;
  token: () => Promise<string>;
  fullName: string;
  id: string;
  policy: Policy;
  /** High-water mark: new releases must exceed it (null: nothing accepted yet). */
  maxVersionCode: number | null;
  /** Currently locked releases (for "same version" detection). */
  locked: LockedRelease[];
  seen: ModuleLock['seen'];
  candidates: GhRelease[];
  /**
   * bound: releases of a bound source (results are locked).
   * request: validating an open request's repository; nothing is locked, version rules are only a warning.
   */
  mode?: 'bound' | 'request';
  /** Create Check Runs even when an identical one exists (Sync now / Re-run). */
  freshChecks?: boolean;
  assetPattern: string | undefined;
  /** module.yaml `metamodule` (cross-checked with module.prop as ksud reads it). */
  metamodule?: boolean;
  /** module.yaml `kind` (entry-kind rules incl. the cross-check with module.prop `oneshot`, see checkReleaseKind). */
  kind?: ManifestKind;
  now: Date;
  checks: boolean;
  appId?: number;
  log: Logger;
}

export interface ReleaseStageResult {
  accepted: LockedRelease[];
  seen: ModuleLock['seen'];
  outcomes: ReleaseOutcome[];
  /** At least one release must be retried on the next run. */
  transient: boolean;
  maxVersionCode: number | null;
}

export function zipLimits(policy: Policy): ZipLimits {
  const l = policy.limits;
  return {
    zipMaxBytes: l.zipMaxBytes,
    uncompressedMaxBytes: l.uncompressedMaxBytes,
    maxCompressionRatio: l.maxCompressionRatio,
    maxEntries: l.maxEntries,
    modulePropMaxBytes: l.modulePropMaxBytes,
  };
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(s: string | null, maxBytes: number): string | null {
  if (s === null) return null;
  const b = new TextEncoder().encode(s);
  if (b.byteLength <= maxBytes) return s;
  return new TextDecoder().decode(b.subarray(0, maxBytes)).replace(/�$/, '');
}

const err = (code: string, message: string): Issue => ({ code, severity: 'error', message });

/** Releases needing a decision: not drafts, not yet seen (or retryable when forced). Oldest first. */
export function pickCandidates(releases: GhRelease[], seen: ModuleLock['seen'], force: boolean): GhRelease[] {
  return releases
    .filter((r) => !r.draft)
    .filter((r) => {
      const s = seen[String(r.id)];
      return !s || (force && !s.ok && !!s.code && RETRYABLE_CODES.has(s.code));
    })
    .sort((a, b) => (a.published_at ?? '').localeCompare(b.published_at ?? '') || a.id - b.id);
}

const publishedKey = (r: GhRelease) => `${r.published_at ?? ''}\u0000${String(r.id).padStart(20, '0')}`;

/**
 * First sync of a binding (no lock for this repository yet): only the newest eligible stable release (immutable,
 * published, not a prerelease — cheap API-only checks) and releases published after it and after the binding are
 * examined; everything older is recorded as seen without download or Check Run. Without any eligible release the
 * newest one is examined so the author gets a Check Run explaining why.
 */
export function selectFirstSync(releases: GhRelease[], fullName: string, bindTime: string | null): { process: GhRelease[]; skip: GhRelease[] } {
  const list = releases.filter((r) => !r.draft).sort((a, b) => publishedKey(b).localeCompare(publishedKey(a)));
  if (!list.length) return { process: [], skip: [] };
  const eligible = (r: GhRelease) => !checkReleaseEligibility(r, fullName).some((i) => i.severity === 'error');
  const anchor = list.find((r) => !r.prerelease && eligible(r)) ?? list.find(eligible) ?? list[0]!;
  const ak = publishedKey(anchor);
  const process: GhRelease[] = [];
  const skip: GhRelease[] = [];
  for (const r of list) {
    if (r === anchor) process.push(r);
    else if (publishedKey(r) > ak && (!bindTime || !r.published_at || r.published_at >= bindTime)) process.push(r);
    else skip.push(r);
  }
  return { process: process.reverse(), skip };
}

export type VersionDecision = { kind: 'newer' } | { kind: 'same'; ref: LockedRelease } | { kind: 'older'; message: string };

/**
 * versionCode rules against the module's high-water mark: strictly greater -> new version; equal to the highest
 * accepted versionCode of a still-locked release on the same channel -> same version (ignored); anything else
 * (lower, reused after deletion, final release re-using a prerelease's versionCode) -> version-not-newer.
 */
export function versionDecision(versionCode: number, prerelease: boolean, max: number | null, locked: LockedRelease[]): VersionDecision {
  if (max === null || versionCode > max) return { kind: 'newer' };
  const at = locked.filter((r) => r.versionCode === versionCode);
  if (versionCode === max) {
    const same = at.find((r) => r.prerelease === prerelease);
    if (same) return { kind: 'same', ref: same };
    if (at.length)
      return {
        kind: 'older',
        message: `versionCode ${versionCode} is already used by the ${at[0]!.prerelease ? 'prerelease' : 'release'} ${at[0]!.tag}. ${
          at[0]!.prerelease ? 'To promote it, untick "pre-release" on that release; otherwise publish' : 'Publish'
        } a new release with a versionCode above ${max}.`,
      };
    return { kind: 'older', message: `versionCode ${versionCode} was already accepted for this module (the release is gone); versionCodes cannot be reused. Use a versionCode above ${max}.` };
  }
  const top = locked.find((r) => r.versionCode === max);
  return { kind: 'older', message: `versionCode ${versionCode} is not higher than ${max}, the highest versionCode accepted for this module${top ? ` (${top.tag})` : ''}.` };
}

export async function processReleases(i: ReleaseStageInput): Promise<ReleaseStageResult> {
  const seen = { ...i.seen };
  const outcomes: ReleaseOutcome[] = [];
  const accepted: LockedRelease[] = [];
  let transient = false;
  let max = i.maxVersionCode;
  const locked = [...i.locked];
  const request = i.mode === 'request';
  const limits = zipLimits(i.policy);

  for (const rel of i.candidates) {
    const log = i.log.child({ releaseId: rel.id, tag: rel.tag_name });
    const out: ReleaseOutcome = { releaseId: rel.id, tag: rel.tag_name, result: 'rejected', issues: [] };
    outcomes.push(out);
    const markSeen = (ok: boolean, issue?: Issue) => {
      seen[String(rel.id)] = { ok, ...(issue ? { code: issue.code, message: issue.message.slice(0, 500) } : {}), checkedAt: i.now.toISOString() };
    };

    let tagCommit: string | null;
    try {
      tagCommit = await resolveTagCommit(i.gh, i.fullName, rel.tag_name);
    } catch (e) {
      if (!isTransient(e)) throw e;
      out.result = 'retry';
      out.issues.push(err('tag-not-found', `could not resolve tag: ${(e as Error).message}`));
      transient = true;
      log.log('warn', 'tag resolution failed; will retry', { error: (e as Error).message });
      continue;
    }
    if (!tagCommit) {
      const is = err('tag-not-found', `Tag ${rel.tag_name} does not resolve to a commit.`);
      out.issues.push(is);
      markSeen(false, is);
      log.log('warn', 'tag not found');
      continue;
    }

    const lines = [`Release [${rel.tag_name}](${rel.html_url}) (id ${rel.id}).`];
    let checkTitle = '';
    let conclusion: CheckSpec['conclusion'] = 'failure';

    // 1. eligibility + asset selection
    out.issues.push(...checkReleaseEligibility(rel, i.fullName));
    let asset: GhRelease['assets'][number] | undefined;
    if (!out.issues.some((x) => x.severity === 'error')) {
      const sel = selectAsset(rel, i.assetPattern);
      out.issues.push(...sel.issues);
      if (sel.ok) asset = sel.value;
    }

    // 2. download + digest + ZIP validation
    let validated: { props: Record<string, string>; version: string; versionCode: number } | undefined;
    let sha256: string | undefined;
    if (asset && !out.issues.some((x) => x.severity === 'error')) {
      try {
        const dl = await downloadAsset({
          fetch: i.fetch,
          fullName: i.fullName,
          assetId: asset.id,
          token: await i.token(),
          maxBytes: limits.zipMaxBytes,
          expectedSize: asset.size,
        });
        sha256 = dl.sha256;
        const digest = parseDigest(asset.digest);
        if (digest && digest !== dl.sha256) {
          out.issues.push(err('asset-digest-mismatch', `sha256 ${dl.sha256} does not match the GitHub digest ${digest}.`));
        } else {
          const v = await validateReleaseAsset({ reader: rangeReaderFromBytes(dl.bytes), expectedId: i.id, limits, kind: i.kind });
          out.issues.push(...v.issues);
          if (v.ok && v.value) {
            validated = v.value;
            const propMeta = isMetamoduleProp(v.value.props);
            if (i.metamodule !== undefined && propMeta !== i.metamodule)
              out.issues.push({
                code: 'manifest-metamodule-mismatch',
                severity: 'warning',
                message: propMeta
                  ? 'module.prop declares metamodule=1/true (KernelSU installs it as a metamodule) but module.yaml has metamodule: false.'
                  : 'module.yaml has metamodule: true but module.prop does not set metamodule=1 or true, so KernelSU installs it as a regular module.',
              });
          }
        }
      } catch (e) {
        if (e instanceof DownloadError && e.transient) {
          out.result = 'retry';
          out.issues.push(err(e.code, e.message));
          transient = true;
          log.log('warn', 'asset download failed; will retry', { error: e.message });
          continue;
        }
        if (e instanceof DownloadError) out.issues.push(err(e.code, e.message));
        else throw e;
      }
    }

    // 3. version rules
    if (validated && asset && sha256) {
      out.versionCode = validated.versionCode;
      const d = versionDecision(validated.versionCode, rel.prerelease, max, locked);
      const label = `${validated.version} (${validated.versionCode})`;
      if (request) {
        // Validation of a requested repository: nothing is locked; version rules only inform the reviewer.
        if (d.kind !== 'newer')
          out.issues.push({ code: 'version-not-newer', severity: 'warning', message: `${d.kind === 'same' ? `versionCode ${validated.versionCode} is already published.` : d.message} It will not be published after approval.` });
        out.result = 'accepted';
        conclusion = 'success';
        checkTitle = `${label} is valid`;
        lines.push(`**${validated.version}** (versionCode ${validated.versionCode}) passed all checks. It is used for the pending request.`, `Asset \`${asset.name}\`, sha256 \`${sha256}\`.`);
      } else if (d.kind === 'older') {
        out.issues.push(err('version-not-newer', d.message));
      } else if (d.kind === 'same') {
        out.result = 'same';
        conclusion = 'success';
        checkTitle = `${label} already published`;
        lines.push(`versionCode ${validated.versionCode} equals the published ${d.ref.tag}; the listed version is not updated.`);
      } else {
        const lockedRel: LockedRelease = {
          releaseId: rel.id,
          tag: rel.tag_name,
          tagCommit,
          name: rel.name ?? null,
          body: truncateUtf8(rel.body ?? null, i.policy.limits.changelogMaxBytes),
          prerelease: rel.prerelease,
          publishedAt: rel.published_at!,
          htmlUrl: rel.html_url,
          immutable: true,
          asset: { id: asset.id, name: asset.name, url: asset.browser_download_url, size: asset.size, sha256, digest: asset.digest ?? null },
          version: validated.version,
          versionCode: validated.versionCode,
          prop: validated.props,
        };
        accepted.push(lockedRel);
        locked.push(lockedRel);
        max = validated.versionCode;
        out.result = 'accepted';
        conclusion = 'success';
        checkTitle = `${label} accepted${rel.prerelease ? ' as prerelease' : ''}`;
        lines.push(`Accepted **${validated.version}** (versionCode ${validated.versionCode})${rel.prerelease ? ' as a prerelease' : ''}.`, `Asset \`${asset.name}\`, sha256 \`${sha256}\`.`);
      }
    }

    const firstError = out.issues.find((x) => x.severity === 'error');
    if (out.result === 'rejected') {
      markSeen(false, firstError ?? err('release-rejected', 'rejected'));
      checkTitle = `Release rejected: ${firstError?.code ?? 'error'}`;
      lines.push('This release was **not** accepted. Immutable releases cannot be changed; publish a new release with a higher versionCode after fixing the problem.');
    } else markSeen(true);
    log.log(out.result === 'rejected' ? 'warn' : 'info', `release ${out.result}`, { versionCode: out.versionCode, code: firstError?.code });

    if (!i.checks) {
      out.check = 'skipped';
      continue;
    }
    try {
      const r = await createCheckOnce(
        i.gh,
        i.fullName,
        { headSha: tagCommit, externalId: `release:${rel.id}`, conclusion, title: checkTitle, lines, issues: out.issues },
        { appId: i.appId, now: i.now, dedupe: !i.freshChecks },
      );
      out.check = r.created ? 'created' : 'exists';
    } catch (e) {
      out.check = 'failed';
      log.log('warn', 'check run creation failed', { error: (e as Error).message });
    }
  }
  return { accepted, seen: capSeen(seen), outcomes, transient, maxVersionCode: max };
}

export function capSeen(seen: ModuleLock['seen'], cap = SEEN_CAP): ModuleLock['seen'] {
  const keys = Object.keys(seen).sort((a, b) => Number(b) - Number(a));
  if (keys.length <= cap) return seen;
  return Object.fromEntries(keys.slice(0, cap).map((k) => [k, seen[k]!]));
}

const byNewest = (a: LockedRelease, b: LockedRelease) => b.versionCode - a.versionCode || b.releaseId - a.releaseId;

/**
 * Merge previously locked + newly accepted releases, refresh mutable fields (name, body, prerelease) from the
 * current releases list, drop releases that were deleted (only when the list is complete), and recompute
 * stable / prerelease / releases and the two high-water marks.
 *
 * stable = the non-prerelease release with the highest versionCode, but never below maxStableVersionCode: deleting
 * (or demoting) the stable release does not fall back to an older one — stable becomes null (module hidden) until
 * a release above maxVersionCode is accepted.
 */
export function recomputeReleases(
  prev: Pick<ModuleLock, 'stable' | 'prerelease' | 'releases' | 'maxVersionCode' | 'maxStableVersionCode'>,
  accepted: LockedRelease[],
  list: GhRelease[] | null,
  o: { keep: number; listComplete: boolean; changelogMaxBytes: number },
): Pick<ModuleLock, 'stable' | 'prerelease' | 'releases' | 'maxVersionCode' | 'maxStableVersionCode'> & { note: string | null } {
  const pool = new Map<number, LockedRelease>();
  for (const r of [...prev.releases, prev.stable, prev.prerelease, ...accepted]) if (r) pool.set(r.releaseId, r);
  if (list) {
    const byId = new Map(list.map((r) => [r.id, r]));
    for (const [id, r] of pool) {
      const cur = byId.get(id);
      if (!cur) {
        if (o.listComplete) pool.delete(id);
        continue;
      }
      if (cur.draft) {
        pool.delete(id);
        continue;
      }
      const name = cur.name ?? null;
      const body = truncateUtf8(cur.body ?? null, o.changelogMaxBytes);
      if (name !== r.name || body !== r.body || cur.prerelease !== r.prerelease) pool.set(id, { ...r, name, body, prerelease: cur.prerelease });
    }
  }
  const all = [...pool.values()].sort(byNewest);
  const vmax = (...xs: (number | null | undefined)[]) => xs.reduce<number | null>((m, x) => (x == null ? m : m === null || x > m ? x : m), null);
  const floorPrev = prev.maxStableVersionCode;
  const top = all.find((r) => !r.prerelease) ?? null;
  const stable = top && (floorPrev === null || top.versionCode >= floorPrev) ? top : null;
  const maxStableVersionCode = vmax(floorPrev, stable?.versionCode);
  const maxVersionCode = vmax(prev.maxVersionCode, ...all.map((r) => r.versionCode));
  const prerelease = all.find((r) => r.prerelease && r.versionCode > (stable?.versionCode ?? 0)) ?? null;
  let releases = all.slice(0, o.keep);
  if (stable && !releases.includes(stable)) releases = [...releases.slice(0, Math.max(0, o.keep - 1)), stable];
  const note =
    !stable && maxStableVersionCode !== null
      ? `stable-unavailable: the stable release (versionCode ${maxStableVersionCode}) was deleted or marked as prerelease; the module is hidden until a release with a versionCode above ${maxVersionCode} is published.`
      : null;
  return { stable, prerelease, releases, maxVersionCode, maxStableVersionCode, note };
}
