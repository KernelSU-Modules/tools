// Content stage: tracked ref -> commit -> module.yaml + referenced files (description, icon, repository images
// referenced by the description) with sha256 per path and git blob shas for cheap change detection.
import { createHash } from 'node:crypto';
import type { GitHubClient } from '@kernelsu-modules/github';
import { referencedImagePaths } from '@kernelsu-modules/render';
import type { ModuleManifest, Policy } from '@kernelsu-modules/schema';
import { manifestReferencedPaths, parseManifest, type Issue } from '@kernelsu-modules/validator';
import { TreeLookup, getBlob, resolveCommit } from './repo-api.ts';

/** Issue codes emitted by sync itself (all defined in the validator's ISSUE_CODES). */
export const SYNC_ISSUE_CODES = {
  'ref-not-found': 'The tracked branch (source.ref or the default branch) does not exist in the repository.',
  'repo-not-found': 'The bound repository could not be read (deleted, or the KernelSU Modules App lost access).',
  'repo-private': 'The repository is private; KernelSU Modules only lists public repositories.',
  'owner-changed': 'The repository owner changed since the module was bound; a transfer must be approved in the Portal.',
  'content-not-file': 'A path referenced by module.yaml is not a regular file (directory, symlink or submodule).',
  'content-too-large': 'A file referenced by module.yaml exceeds the size limit from policy.yaml.',
  'tag-not-found': 'The release tag could not be resolved to a commit.',
} as const;

/** Blob sha recorded for a tracked path that does not exist (so adding it later is detected). */
export const ABSENT_BLOB = '0'.repeat(40);

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const err = (code: string, message: string, path?: string): Issue => (path ? { code, severity: 'error', message, path } : { code, severity: 'error', message });
const warn = (code: string, message: string, path?: string): Issue => ({ ...err(code, message, path), severity: 'warning' });

export interface ContentAtCommit {
  ok: boolean;
  issues: Issue[];
  manifest?: ModuleManifest;
  /** path -> sha256 (manifest + referenced files + tracked images); present when ok. */
  files?: Record<string, string>;
  /** path -> git blob sha of every tracked path (ABSENT_BLOB when missing); present when ok. */
  blobs?: Record<string, string>;
}

/** Repository paths of images a Markdown document references (same resolution as the build). */
export { referencedImagePaths };

/**
 * True when every tracked path still has the same git blob sha at the commit behind `tree`
 * (tracked = keys of a previous `blobs` map). One tree listing, no blob downloads.
 */
export async function trackedUnchanged(tree: TreeLookup, blobs: Record<string, string>): Promise<boolean> {
  for (const [path, sha] of Object.entries(blobs)) {
    const e = await tree.get(path);
    if ((e ? e.sha : ABSENT_BLOB) !== sha) return false;
  }
  return true;
}

/** Validate module.yaml (and, unless manifestOnly, every referenced file) at a fixed commit. */
export async function checkContentAt(
  gh: GitHubClient,
  o: { fullName: string; commit: string; manifestPath: string; id: string; limits: Policy['limits']; manifestOnly?: boolean; tree?: TreeLookup },
): Promise<ContentAtCommit> {
  const tree = o.tree ?? new TreeLookup(gh, o.fullName, o.commit);
  const issues: Issue[] = [];
  const me = await tree.get(o.manifestPath);
  if (!me) return { ok: false, issues: [err('manifest-missing', `${o.manifestPath} does not exist at ${o.commit.slice(0, 7)}.`, o.manifestPath)] };
  if (me.type !== 'blob' || me.mode === '120000')
    return { ok: false, issues: [err('content-not-file', `${o.manifestPath} is not a regular file.`, o.manifestPath)] };
  if (me.size !== undefined && me.size > o.limits.manifestMaxBytes)
    return { ok: false, issues: [err('manifest-too-large', `${o.manifestPath} is ${me.size} bytes; the limit is ${o.limits.manifestMaxBytes}.`, o.manifestPath)] };
  const manifestBytes = await getBlob(gh, o.fullName, me.sha);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes);
  } catch {
    return { ok: false, issues: [err('manifest-yaml', `${o.manifestPath} is not valid UTF-8.`, o.manifestPath)] };
  }
  const parsed = parseManifest(text, { maxBytes: o.limits.manifestMaxBytes });
  issues.push(...parsed.issues);
  if (!parsed.ok || !parsed.value) return { ok: false, issues };
  const manifest = parsed.value;
  if (manifest.id !== o.id) {
    issues.push(err('manifest-id-mismatch', `module.yaml id "${manifest.id}" differs from the registered id "${o.id}".`, 'id'));
    return { ok: false, issues, manifest };
  }
  if (o.manifestOnly) return { ok: true, issues, manifest };

  const files: Record<string, string> = { [o.manifestPath]: sha256(manifestBytes) };
  const blobs: Record<string, string> = { [o.manifestPath]: me.sha };
  let docText: string | null = null;
  for (const path of manifestReferencedPaths(manifest)) {
    if (path in files) continue;
    const e = await tree.get(path);
    if (!e) {
      issues.push(err('manifest-path-missing', `${path} is referenced by module.yaml but does not exist at ${o.commit.slice(0, 7)}.`, path));
      continue;
    }
    if (e.type !== 'blob' || e.mode === '120000' || e.mode === '160000') {
      issues.push(err('content-not-file', `${path} is not a regular file (directory, symlink or submodule).`, path));
      continue;
    }
    const limit = path === manifest.icon ? o.limits.imageMaxBytes : o.limits.docMaxBytes;
    if (e.size !== undefined && e.size > limit) {
      issues.push(err('content-too-large', `${path} is ${e.size} bytes; the limit is ${limit} bytes.`, path));
      continue;
    }
    const bytes = await getBlob(gh, o.fullName, e.sha);
    if (bytes.byteLength > limit) {
      issues.push(err('content-too-large', `${path} is ${bytes.byteLength} bytes; the limit is ${limit} bytes.`, path));
      continue;
    }
    files[path] = sha256(bytes);
    blobs[path] = e.sha;
    if (path === manifest.description) docText = new TextDecoder().decode(bytes);
  }
  if (issues.some((i) => i.severity === 'error')) return { ok: false, issues, manifest };

  // Repository images referenced by the description: tracked so that changing only an image advances the locked
  // commit. Within policy limits they are hashed (the build verifies them); others are tracked by blob sha only
  // (missing / oversized -> the build drops them).
  if (docText !== null) {
    let count = 0;
    let total = 0;
    for (const path of referencedImagePaths(docText, { fullName: o.fullName, commit: o.commit, docPath: manifest.description })) {
      if (path in blobs) continue;
      if (count >= o.limits.imagesMaxPerModule) break;
      const e = await tree.get(path);
      if (!e) {
        blobs[path] = ABSENT_BLOB;
        continue;
      }
      if (e.type !== 'blob' || e.mode === '120000' || e.mode === '160000') {
        blobs[path] = e.sha;
        continue;
      }
      blobs[path] = e.sha;
      count++;
      if (e.size !== undefined && (e.size > o.limits.imageMaxBytes || total + e.size > o.limits.imagesMaxTotalBytes)) {
        issues.push(warn('content-too-large', `${path} is ${e.size} bytes; images over ${o.limits.imageMaxBytes} bytes (or beyond ${o.limits.imagesMaxTotalBytes} bytes in total) are not shown.`, path));
        continue;
      }
      const bytes = await getBlob(gh, o.fullName, e.sha);
      total += bytes.byteLength;
      files[path] = sha256(bytes);
    }
  }
  return { ok: true, issues, manifest, files, blobs };
}

export { resolveCommit };
