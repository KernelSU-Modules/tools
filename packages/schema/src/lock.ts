import { z } from 'zod';
import { GitHubId, GitSha, HttpsUrl, IsoDateTime, ModuleId, Sha256Hex, VersionCode } from './common.ts';

/* ------------------------------------------------------------------ *
 * Data repo: sources.lock.json — written only by tools/sync.
 * ------------------------------------------------------------------ */

export const LockedAsset = z
  .object({
    id: GitHubId,
    name: z.string(),
    /** browser_download_url; must be under https://github.com/{fullName}/releases/download/ */
    url: HttpsUrl,
    size: z.number().int().positive(),
    sha256: Sha256Hex,
    /** GitHub-reported digest ("sha256:..."), when available. */
    digest: z.string().nullable(),
  })
  .strict();

export const LockedRelease = z
  .object({
    releaseId: GitHubId,
    tag: z.string(),
    tagCommit: GitSha,
    /** Mutable fields, refreshed on every sync. */
    name: z.string().nullable(),
    body: z.string().nullable(),
    prerelease: z.boolean(),
    publishedAt: IsoDateTime,
    htmlUrl: HttpsUrl,
    immutable: z.literal(true),
    asset: LockedAsset,
    /** From module.prop inside the ZIP. */
    version: z.string(),
    versionCode: VersionCode,
    /** Raw module.prop key/values (trimmed), for display/debugging. */
    prop: z.record(z.string(), z.string()),
  })
  .strict();
export type LockedRelease = z.infer<typeof LockedRelease>;

export const SeenRelease = z
  .object({
    ok: z.boolean(),
    /** Error code from validator when !ok. */
    code: z.string().optional(),
    message: z.string().optional(),
    /**
     * Not validated: on the first sync of a binding, releases older than the newest eligible one (or published before
     * the binding) are recorded without download or Check Run. Always with ok: false.
     */
    skipped: z.literal(true).optional(),
    checkedAt: IsoDateTime,
  })
  .strict();

export const SyncHealth = z
  .object({
    /** ok: last attempt succeeded; stale: using last good data; error: never succeeded. */
    status: z.enum(['ok', 'stale', 'error']),
    installation: z.enum(['present', 'missing']),
    /**
     * Time of the sync run that last changed this entry. There is no heartbeat: runs that change nothing
     * (timestamps only) are not persisted, so this is NOT "last attempt" in wall-clock terms.
     */
    lastAttemptAt: IsoDateTime,
    /** Time of the last successful run that changed something or brought health back to ok. */
    lastSuccessAt: IsoDateTime.nullable(),
    /** Problems (health != ok) and notes (e.g. stable release deleted), or null. */
    message: z.string().nullable(),
  })
  .strict();

export const LockedContent = z
  .object({
    ref: z.string(),
    commit: GitSha,
    fetchedAt: IsoDateTime,
    manifestPath: z.string(),
    /**
     * path -> sha256 of every file the build needs: manifest, description, icon and repository images referenced by
     * the description (within policy image limits). The build fetches them at `commit` and verifies the digest.
     */
    files: z.record(z.string(), Sha256Hex),
    /**
     * path -> git blob sha at `commit` of every tracked path (files + referenced images that are missing or over the
     * size limit; "0"*40 = absent). Used to detect changes from a tree listing alone: `commit` only advances when a
     * tracked blob changes.
     */
    blobs: z.record(z.string(), GitSha).optional(),
  })
  .strict();

/**
 * GitHub stargazers count shown for the module (display only; never affects health, validation or Check Runs).
 * Refreshed from repository responses sync already reads (plus, for module.yaml `starsRepository`, one lookup of
 * that repository and possibly of the App installation on it); persisted only when the module's lock entry changes
 * anyway, when the stored entry is at least 24 hours old and differs, or on a forced run ("Sync now").
 */
export const LockedStars = z
  .object({
    count: z.number().int().nonnegative(),
    /** When this entry was recorded (unchanged while nothing but the time would change). */
    fetchedAt: IsoDateTime,
    /** Repository the count belongs to (the bound repository unless a verified starsRepository is used). */
    repositoryId: GitHubId,
    fullName: z.string(),
    /** self: the bound repository; owner: same owner as the bound repository; app: KernelSU Modules App installed on it. */
    verified: z.enum(['self', 'owner', 'app']),
    /** module.yaml `starsRepository` as written, when set. */
    requested: z.string().optional(),
    /** Why `requested` is not used (deterministic text); the count is then the bound repository's own. */
    problem: z.string().max(300).optional(),
  })
  .strict();
export type LockedStars = z.infer<typeof LockedStars>;

export const ModuleLock = z
  .object({
    id: ModuleId,
    repositoryId: GitHubId,
    fullName: z.string(),
    installationId: GitHubId.nullable(),
    content: LockedContent.nullable(),
    stable: LockedRelease.nullable(),
    prerelease: LockedRelease.nullable(),
    /**
     * Highest versionCode ever accepted for this module ID, any channel. Never decreases; survives deleted releases and
     * repository transfers. New releases must exceed it (equal = same version when that release is still locked).
     */
    maxVersionCode: VersionCode.nullable(),
    /**
     * Highest versionCode that was ever the stable release. Stable is only chosen among releases with at least this
     * versionCode, so deleting (or demoting) the stable release never falls back to an older one.
     */
    maxStableVersionCode: VersionCode.nullable(),
    /** Validated releases (stable + pre), newest versionCode first, max policy.history.keepReleases. */
    releases: z.array(LockedRelease),
    /** releaseId (string) -> result; each releaseId is downloaded at most once. */
    seen: z.record(z.string(), SeenRelease),
    health: SyncHealth,
    /** Absent: not recorded yet (e.g. entries written before stars were tracked). */
    stars: LockedStars.optional(),
  })
  .strict();
export type ModuleLock = z.infer<typeof ModuleLock>;

export const SourcesLock = z
  .object({
    schemaVersion: z.literal(1),
    modules: z.record(ModuleId, ModuleLock),
  })
  .strict();
export type SourcesLock = z.infer<typeof SourcesLock>;
