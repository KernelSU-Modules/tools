import { z } from 'zod';
import { Architecture, GitSha, HttpsUrl, IsoDateTime, ModuleId, Sha256Hex, VersionCode, WebUrl } from './common.ts';

/* ------------------------------------------------------------------ *
 * Client protocol: {baseUrl}/api/v1/...
 * All paths inside these documents are relative to {baseUrl} (the site root),
 * e.g. "api/v1/modules/foo.json", "assets/3f9a….png".
 * Clients ignore unknown optional fields and reject unknown major schemaVersion.
 * ------------------------------------------------------------------ */

export const API_SCHEMA_VERSION = 1;
const BuildId = z.string().regex(/^[0-9a-f]{16,64}$/);
const ApiPath = z.string().regex(/^[A-Za-z0-9._\-/]+$/).refine((p) => !p.startsWith('/') && !p.includes('..'));

export const ApiIndex = z.object({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  buildId: BuildId,
  registryCommit: GitSha,
  generatedAt: IsoDateTime,
  /** "api/v1/modules.json" */
  modules: ApiPath,
});
export type ApiIndex = z.infer<typeof ApiIndex>;

export const ApiVersionRef = z.object({
  version: z.string(),
  versionCode: VersionCode,
  publishedAt: IsoDateTime,
});

export const ApiModuleSummary = z.object({
  id: ModuleId,
  /** Module content is single-language (module.yaml name / summary). */
  name: z.string(),
  summary: z.string(),
  authors: z.array(z.object({ name: z.string(), url: HttpsUrl.optional() })),
  tags: z.array(z.string()),
  metamodule: z.boolean(),
  /** Content-hashed icon, "assets/{sha256-prefix}.{ext}". */
  icon: ApiPath.nullable(),
  stable: ApiVersionRef,
  /** "api/v1/modules/{id}.json" */
  detail: ApiPath,
  updatedAt: IsoDateTime,
});
export type ApiModuleSummary = z.infer<typeof ApiModuleSummary>;

export const ApiModules = z.object({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  buildId: BuildId,
  modules: z.array(ApiModuleSummary),
});
export type ApiModules = z.infer<typeof ApiModules>;

export const ApiRelease = z.object({
  tag: z.string(),
  name: z.string().nullable(),
  version: z.string(),
  versionCode: VersionCode,
  prerelease: z.boolean(),
  publishedAt: IsoDateTime,
  /** Sanitized HTML of the release notes, or null. */
  changelogHtml: z.string().nullable(),
  zip: z.object({ url: HttpsUrl, name: z.string(), size: z.number().int().positive(), sha256: Sha256Hex }),
  tagCommit: GitSha,
  releaseUrl: HttpsUrl,
  /** https://github.com/{fullName}/attestations?... or null when not derivable. */
  attestationUrl: HttpsUrl.nullable(),
  immutable: z.literal(true),
});
export type ApiRelease = z.infer<typeof ApiRelease>;

export const ApiModuleDetail = ApiModuleSummary.extend({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  buildId: BuildId,
  license: z.string().nullable(),
  /** http(s); module.yaml tolerates http:// with a warning. */
  homepage: WebUrl.nullable(),
  support: WebUrl.nullable(),
  compatibility: z
    .object({
      androidMinApi: z.number().int().optional(),
      androidMaxApi: z.number().int().optional(),
      architectures: z.array(Architecture).optional(),
    })
    .nullable(),
  source: z.object({
    host: z.literal('github'),
    fullName: z.string(),
    url: HttpsUrl,
    commit: GitSha,
  }),
  /**
   * "api/v1/modules/{id}/readme" (sanitized HTML fragment of the module.yaml description document), or null.
   * The file is emitted as readme.html; Cloudflare Pages serves it at the extension-less URL.
   */
  readme: ApiPath.nullable(),
  /** Newest versionCode first; the first non-prerelease entry equals `stable`. */
  releases: z.array(ApiRelease),
  health: z.object({ status: z.enum(['ok', 'stale']), lastSuccessAt: IsoDateTime.nullable() }),
});
export type ApiModuleDetail = z.infer<typeof ApiModuleDetail>;

/** Optional update descriptor hosted on modules.kernelsu.org, module.prop `updateJson` compatible. */
export const ApiUpdateJson = z.object({
  version: z.string(),
  versionCode: VersionCode,
  zipUrl: HttpsUrl,
  changelog: HttpsUrl,
});
export type ApiUpdateJson = z.infer<typeof ApiUpdateJson>;
