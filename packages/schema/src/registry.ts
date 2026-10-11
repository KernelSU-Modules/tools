import { z } from 'zod';
import { GitHubId, IsoDateTime, ModuleId, RelativePath } from './common.ts';

/* ------------------------------------------------------------------ *
 * Data repo: modules/{id}.yaml
 * ------------------------------------------------------------------ */

export const RecordStatus = z.enum(['pending', 'listed', 'rejected', 'suspended', 'archived']);
export type RecordStatus = z.infer<typeof RecordStatus>;

export const Source = z
  .object({
    host: z.literal('github'),
    /** Authoritative binding; survives renames. */
    repositoryId: GitHubId,
    /** A change here is treated as an ownership transfer. */
    ownerId: GitHubId,
    /** Display / lookup only. */
    fullName: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
    /** Branch to read module.yaml and docs from; default branch when omitted. */
    ref: z.string().min(1).max(255).optional(),
    manifestPath: RelativePath.default('module.yaml'),
  })
  .strict();
export type Source = z.infer<typeof Source>;

export const RequestKind = z.enum(['submit', 'transfer']);
export type RequestKind = z.infer<typeof RequestKind>;

/** submissionId: 10 chars of [a-z0-9]. Fits in Telegram callback_data. */
export const SubmissionId = z.string().regex(/^[a-z0-9]{10}$/);

export const TelegramRef = z.object({ chatId: z.number().int(), messageId: z.number().int() }).strict();

/** An open request awaiting maintainer review. At most one per record. */
export const OpenRequest = z
  .object({
    submissionId: SubmissionId,
    kind: RequestKind,
    /** Source to bind on approval. */
    source: Source,
    submittedBy: GitHubId,
    submittedByLogin: z.string().optional(),
    submittedAt: IsoDateTime,
    telegram: TelegramRef.optional(),
  })
  .strict();
export type OpenRequest = z.infer<typeof OpenRequest>;

export const DecidedVia = z.enum(['portal', 'telegram', 'auto']);
export const ReasonCode = z.enum(['spam', 'violation', 'bad-id', 'squatting', 'other']);
export type ReasonCode = z.infer<typeof ReasonCode>;

/** Last decision made on this record (history lives in git). */
export const Review = z
  .object({
    submissionId: SubmissionId,
    kind: RequestKind,
    submittedBy: GitHubId,
    submittedAt: IsoDateTime,
    decision: z.enum(['approved', 'rejected']),
    decidedBy: GitHubId.nullable(),
    decidedVia: DecidedVia,
    decidedAt: IsoDateTime,
    reasonCode: ReasonCode.optional(),
    reason: z.string().max(500).nullable().default(null),
    telegram: TelegramRef.optional(),
  })
  .strict();
export type Review = z.infer<typeof Review>;

/** Moderation state for suspended / archived records. */
export const Moderation = z
  .object({
    action: z.enum(['suspend', 'archive']),
    by: GitHubId.nullable(),
    via: DecidedVia,
    at: IsoDateTime,
    reason: z.string().max(500),
  })
  .strict();

export const RegistryRecord = z
  .object({
    id: ModuleId,
    status: RecordStatus,
    /** Current binding. Absent only for `pending` (see request.source) and `rejected` submissions. */
    source: Source.optional(),
    request: OpenRequest.optional(),
    review: Review.optional(),
    moderation: Moderation.optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .strict()
  .superRefine((r, ctx) => {
    const needSource = r.status === 'listed' || r.status === 'suspended' || r.status === 'archived';
    if (needSource && !r.source) ctx.addIssue({ code: 'custom', path: ['source'], message: `status ${r.status} requires source` });
    if (r.status === 'pending' && (!r.request || r.request.kind !== 'submit'))
      ctx.addIssue({ code: 'custom', path: ['request'], message: 'pending requires a submit request' });
  });
export type RegistryRecord = z.infer<typeof RegistryRecord>;

/* ------------------------------------------------------------------ *
 * Data repo: policy.yaml
 * ------------------------------------------------------------------ */

export const Policy = z
  .object({
    schemaVersion: z.literal(1),
    id: z
      .object({
        reservedPrefixes: z.array(z.string()).default([]),
        reservedIds: z.array(z.string()).default([]),
      })
      .strict(),
    limits: z
      .object({
        zipMaxBytes: z.number().int().positive(),
        uncompressedMaxBytes: z.number().int().positive(),
        maxCompressionRatio: z.number().positive(),
        maxEntries: z.number().int().positive(),
        modulePropMaxBytes: z.number().int().positive(),
        manifestMaxBytes: z.number().int().positive(),
        docMaxBytes: z.number().int().positive(),
        imageMaxBytes: z.number().int().positive(),
        imagesMaxPerModule: z.number().int().positive(),
        imagesMaxTotalBytes: z.number().int().positive(),
        imageMaxRedirects: z.number().int().min(0),
        changelogMaxBytes: z.number().int().positive(),
      })
      .strict(),
    history: z.object({ keepReleases: z.number().int().positive() }).strict(),
    pending: z.object({ expireDays: z.number().int().positive() }).strict(),
  })
  .strict();
export type Policy = z.infer<typeof Policy>;

/* ------------------------------------------------------------------ *
 * Data repo: maintainers.yaml and banned.yaml
 * ------------------------------------------------------------------ */

export const Maintainer = z
  .object({
    /** Identity. `login` is informational (refreshed from GitHub on Portal writes). */
    github: z.object({ id: GitHubId, login: z.string() }).strict(),
    /** Numeric Telegram user id: authorizes the review buttons and bot commands. Usernames are never used. */
    telegram: z.object({ id: z.number().int().positive() }).strict().optional(),
  })
  .strict();
export const Maintainers = z.object({ maintainers: z.array(Maintainer) }).strict();
export type Maintainers = z.infer<typeof Maintainers>;

/**
 * Pre-release migration for maintainers.yaml: files written before Telegram usernames were dropped may still carry
 * `maintainers[].telegram.username`. Readers (Portal Worker, check-data) call this before `Maintainers.parse` so such a
 * file keeps parsing under the strict schema; the next Bot write omits the key. Returns a copy without the legacy key
 * and the dotted paths that were dropped. Anything else is passed through untouched (the strict schema judges it).
 */
export function stripLegacyMaintainerFields(raw: unknown): { value: unknown; dropped: string[] } {
  const dropped: string[] = [];
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { maintainers?: unknown }).maintainers)) return { value: raw, dropped };
  const list = (raw as { maintainers: unknown[] }).maintainers.map((m, i) => {
    const tg = m && typeof m === 'object' ? (m as { telegram?: unknown }).telegram : undefined;
    if (!tg || typeof tg !== 'object' || !('username' in tg)) return m;
    const { username: _legacy, ...rest } = tg as Record<string, unknown>;
    dropped.push(`maintainers.${i}.telegram.username`);
    return { ...(m as object), telegram: rest };
  });
  return { value: dropped.length ? { ...(raw as object), maintainers: list } : raw, dropped };
}

export const BannedEntry = z
  .object({
    githubId: GitHubId,
    login: z.string().optional(),
    reason: z.string().max(500),
    by: GitHubId,
    at: IsoDateTime,
  })
  .strict();
export const Banned = z.object({ banned: z.array(BannedEntry) }).strict();
export type Banned = z.infer<typeof Banned>;
