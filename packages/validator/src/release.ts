import { issue, result, type Issue, type Result } from './issues.ts';

export interface ReleaseAssetLike {
  id: number;
  name: string;
  size: number;
  digest?: string | null;
  browser_download_url: string;
  state?: string;
}

export interface ReleaseLike {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  immutable?: boolean;
  published_at: string | null;
  assets: ReleaseAssetLike[];
}

/**
 * Anchored, case-sensitive glob supporting only `*` (any run, including empty) and `?`
 * (exactly one character). Every other character is literal. No regex; O(n·m) worst case.
 */
export function globMatch(pattern: string, name: string): boolean {
  const p = Array.from(pattern);
  const s = Array.from(name);
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === '?' || (p[pi] !== '*' && p[pi] === s[si]))) {
      pi++;
      si++;
    } else if (pi < p.length && p[pi] === '*') {
      star = pi++;
      mark = si;
    } else if (star >= 0) {
      pi = star + 1;
      si = ++mark;
    } else return false;
  }
  while (pi < p.length && p[pi] === '*') pi++;
  return pi === p.length;
}

/** Exactly one asset must match `assetPattern`, or (without a pattern) exactly one `.zip` asset. */
export function selectAsset(release: ReleaseLike, assetPattern?: string): Result<ReleaseAssetLike> {
  const issues: Issue[] = [];
  if (assetPattern !== undefined && (assetPattern.length === 0 || /[/\\]/.test(assetPattern))) {
    issues.push(issue('asset-pattern-invalid', `release.assetPattern ${JSON.stringify(assetPattern)} is invalid.`, 'error', 'release.assetPattern'));
    return result(issues);
  }
  const what = assetPattern !== undefined ? `matching ${JSON.stringify(assetPattern)}` : 'with a .zip extension';
  const matches = release.assets.filter((a) =>
    assetPattern !== undefined ? globMatch(assetPattern, a.name) : a.name.toLowerCase().endsWith('.zip'),
  );
  if (matches.length === 0) {
    issues.push(issue('asset-none', `Release ${release.tag_name} has no asset ${what}.`));
    return result(issues);
  }
  if (matches.length > 1) {
    const names = matches.slice(0, 10).map((a) => a.name).join(', ');
    issues.push(issue('asset-multiple', `Release ${release.tag_name} has ${matches.length} assets ${what}: ${names}.`));
    return result(issues);
  }
  return result(issues, matches[0]!);
}

/** True iff `url` is https://github.com/{owner}/{repo}/releases/download/{tag...}/{file} of `repoFullName` (owner/repo case-insensitive). */
export function isRepoReleaseDownloadUrl(url: string, repoFullName: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com' || u.port !== '' || u.username || u.password) return false;
  if (u.search || u.hash) return false;
  if (!/^https:\/\/github\.com\//i.test(url)) return false;
  const [owner, repo, ...rest] = repoFullName.split('/');
  if (!owner || !repo || rest.length) return false;
  const seg = u.pathname.split('/');
  // ['', owner, repo, 'releases', 'download', tag..., file]
  if (seg.length < 7) return false;
  if (seg[1]!.toLowerCase() !== owner.toLowerCase() || seg[2]!.toLowerCase() !== repo.toLowerCase()) return false;
  if (seg[3] !== 'releases' || seg[4] !== 'download') return false;
  const tail = seg.slice(5);
  return tail.every((s) => s.length > 0 && s !== '.' && s !== '..');
}

/** Per-asset rules: uploaded state and download URL under the bound repository. */
export function checkAsset(asset: ReleaseAssetLike, repoFullName: string): Issue[] {
  const issues: Issue[] = [];
  if (asset.state !== undefined && asset.state !== 'uploaded')
    issues.push(issue('asset-not-uploaded', `Asset ${JSON.stringify(asset.name)} is in state "${asset.state}".`));
  if (!isRepoReleaseDownloadUrl(asset.browser_download_url, repoFullName))
    issues.push(
      issue('asset-url-invalid', `Asset ${JSON.stringify(asset.name)} download URL ${asset.browser_download_url} is not a release download of ${repoFullName}.`),
    );
  return issues;
}

/** Release rules: published (not draft), immutable === true, every asset uploaded and served from the bound repository. */
export function checkReleaseEligibility(release: ReleaseLike, repoFullName: string): Issue[] {
  const issues: Issue[] = [];
  if (release.draft) issues.push(issue('release-draft', `Release ${release.tag_name} is a draft.`));
  else if (!release.published_at) issues.push(issue('release-not-published', `Release ${release.tag_name} is not published.`));
  if (release.immutable !== true)
    issues.push(issue('release-not-immutable', `Release ${release.tag_name} is not immutable. Enable release immutability and publish a new release.`));
  for (const a of release.assets) issues.push(...checkAsset(a, repoFullName));
  return issues;
}

/** Version ordering uses versionCode only. */
export function compareWithLocked(versionCode: number, lockedStable: { versionCode: number } | null): 'newer' | 'same' | 'older' {
  if (!lockedStable) return 'newer';
  if (versionCode > lockedStable.versionCode) return 'newer';
  if (versionCode === lockedStable.versionCode) return 'same';
  return 'older';
}
