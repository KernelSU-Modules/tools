import { z } from 'zod';
import { Architecture, HttpsUrl, ModuleId, RelativePath, WebUrl } from './common.ts';

/**
 * Author-side module.yaml (schemaVersion 1). Display metadata only, in a single language:
 * version / versionCode / sha256 / download URL are derived from the release ZIP.
 *
 * Forward compatibility: objects are NOT strict. Unknown fields are dropped by the schema (the validator reports
 * them as warnings), so a manifest written for a newer minor revision still parses. Only an unsupported
 * `schemaVersion` major is fatal.
 *
 * Normalization (applied by the schema, so every consumer sees the same values):
 *  - repository paths may start with "./" (stripped);
 *  - tags are trimmed and lowercased.
 */

const stripDotSlash = (v: unknown) => (typeof v === 'string' ? v.replace(/^(?:\.\/)+/, '') : v);

/** Repository-relative path as written in module.yaml; a leading "./" is accepted and removed. */
export const ManifestPath = z.preprocess(stripDotSlash, RelativePath);

export const Author = z.object({
  name: z.string().trim().min(1).max(64),
  url: HttpsUrl.optional(),
});

export const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Case-insensitive on input, stored lowercased. */
export const Tag = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/)
  .toLowerCase();

export const Compatibility = z.object({
  androidMinApi: z.number().int().min(21).max(99).optional(),
  androidMaxApi: z.number().int().min(21).max(99).optional(),
  architectures: z.array(Architecture).min(1).optional(),
});

export const ReleaseConfig = z.object({
  /** Glob (only `*` and `?` wildcards) matched against release asset names. */
  assetPattern: z.string().min(1).max(128).regex(/^[^/\\]+$/).optional(),
});

/** GitHub repository "owner/name" (owner: GitHub login rules; name: letters, digits, ".", "_", "-"). */
export const GitHubFullName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, 'must be "owner/name" of a GitHub repository')
  .refine((v) => !/\/\.{1,2}$/.test(v), 'must be "owner/name" of a GitHub repository');

export const MANIFEST_NAME_MAX = 100;
export const MANIFEST_SUMMARY_MAX = 500;

export const ModuleManifest = z.object({
  schemaVersion: z.literal(1),
  id: ModuleId,
  name: z.string().trim().min(1).max(MANIFEST_NAME_MAX),
  summary: z.string().trim().min(1).max(MANIFEST_SUMMARY_MAX),
  /** Markdown document shown as the module page, relative to the repository root. */
  description: ManifestPath,
  license: z.string().trim().min(1).max(64).optional(),
  /** http:// is tolerated (validator warning); https is recommended. */
  homepage: WebUrl.optional(),
  support: WebUrl.optional(),
  tags: z.array(Tag).max(10).optional(),
  icon: ManifestPath.optional(),
  metamodule: z.boolean().default(false),
  /** Complete author list; when omitted the site shows the owner of the bound repository. */
  authors: z.array(Author).min(1).max(20).optional(),
  /**
   * Show the GitHub stars of this repository ("owner/name") instead of the bound repository's, e.g. the former
   * open-source repository of a module now published from a closed-source release repository. Used only when
   * verified by sync: public, and the same owner as the bound repository or the KernelSU Modules App installed on it.
   */
  starsRepository: GitHubFullName.optional(),
  compatibility: Compatibility.optional(),
  release: ReleaseConfig.optional(),
});

export type ModuleManifest = z.infer<typeof ModuleManifest>;

/** Known keys per object level (the validator warns about anything else). */
export const MANIFEST_KNOWN_KEYS = {
  root: Object.keys(ModuleManifest.shape),
  author: Object.keys(Author.shape),
  compatibility: Object.keys(Compatibility.shape),
  release: Object.keys(ReleaseConfig.shape),
} as const;

/** Supported manifest major versions. Clients/validators MUST reject others. */
export const SUPPORTED_MANIFEST_VERSIONS = [1] as const;
