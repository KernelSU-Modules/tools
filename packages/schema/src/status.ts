import { z } from 'zod';
import { GitSha, IsoDateTime, ModuleId, VersionCode } from './common.ts';
import { SubmissionId } from './registry.ts';

/* ------------------------------------------------------------------ *
 * Data repo: status.json — compact summary written by tools/sync in the
 * same commit as sources.lock.json. Read by the Portal and the cron Worker so
 * they never parse the full lock. Contains no wall-clock "generatedAt" so it
 * only changes when something substantive changes.
 *
 * Entries exist for every record with a lock entry (listed / suspended / archived) and for every record with an
 * open request. For records without a bound source (pending submit) the top-level fields
 * describe the requested repository (health = request result, lastSuccessAt null, stable null).
 * Canonical serialization (sorted keys, 2-space indent, trailing newline) — see canonicalJson().
 * ------------------------------------------------------------------ */

export const StatusIssue = z
  .object({ code: z.string(), severity: z.enum(['error', 'warning']), message: z.string().max(300).optional() })
  .strict();

export const ModuleStatus = z
  .object({
    repositoryId: z.number().int().positive(),
    fullName: z.string(),
    health: z.enum(['ok', 'stale', 'error']),
    installation: z.enum(['present', 'missing']),
    lastSuccessAt: IsoDateTime.nullable(),
    message: z.string().nullable(),
    contentCommit: GitSha.nullable(),
    stable: z
      .object({ tag: z.string(), version: z.string(), versionCode: VersionCode, publishedAt: IsoDateTime })
      .strict()
      .nullable(),
    /** Highest versionCode ever accepted for this ID (never decreases, survives transfers). */
    maxVersionCode: VersionCode.nullable(),
    /** Result of validating the open request's source (submit / transfer), if any. */
    request: z
      .object({
        submissionId: SubmissionId,
        repositoryId: z.number().int().positive(),
        ok: z.boolean(),
        /** Time of the last validation that produced a different result, or of a forced re-check. */
        checkedAt: IsoDateTime,
        /** Newest release examined (null: none). */
        latestTag: z.string().nullable(),
        issues: z.array(StatusIssue),
        /** Dedupe keys: branch head commit and newest release id that were validated. */
        commit: GitSha.nullable().optional(),
        releaseId: z.number().int().positive().nullable().optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ModuleStatus = z.infer<typeof ModuleStatus>;

export const RegistryStatus = z
  .object({
    schemaVersion: z.literal(1),
    modules: z.record(ModuleId, ModuleStatus),
  })
  .strict();
export type RegistryStatus = z.infer<typeof RegistryStatus>;
