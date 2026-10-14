// The subset of @kernelsu-modules/validator this action uses.
// Declared locally so the release logic can be unit-tested with a fake validator.
import type { ModuleManifest, Policy } from '@kernelsu-modules/schema';

export type Severity = 'error' | 'warning';
export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  path?: string;
}
export interface Result<T> {
  ok: boolean;
  value?: T;
  issues: Issue[];
}
export interface RangeReader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}
export interface ZipLimits {
  zipMaxBytes: number;
  uncompressedMaxBytes: number;
  maxCompressionRatio: number;
  maxEntries: number;
  modulePropMaxBytes: number;
}
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
export interface ModuleProp {
  props: Record<string, string>;
  id: string;
  name: string;
  version: string;
  versionCode: number;
  author: string;
  description: string;
}

export interface ZipInspection {
  entries: number;
  uncompressedTotal: number;
  moduleProp: string;
  /** Extracted paths; directories end with "/". */
  files: string[];
  /** Root params.json (script entries): its text, or why it could not be read. */
  paramsJson?: { text: string } | { error: string };
}

export interface Validator {
  checkModuleId(id: string, policy: Policy, existingIds?: Iterable<string>): Issue[];
  parseManifest(text: string, opts?: { maxBytes?: number }): Result<ModuleManifest>;
  manifestReferencedPaths(m: ModuleManifest): string[];
  parseModuleProp(text: string): Result<ModuleProp>;
  rangeReaderFromBytes(bytes: Uint8Array): RangeReader;
  rangeReaderFromUrl(url: string, opts?: { fetch?: typeof fetch; headers?: Record<string, string>; size?: number }): Promise<RangeReader>;
  inspectZip(reader: RangeReader, limits: ZipLimits): Promise<Result<ZipInspection>>;
  /** Entry-kind rules (module.yaml kind vs module.prop oneshot, script ZIP rules, params.json). */
  checkReleaseKind(input: { kind: ModuleManifest['kind'] | undefined; props: Record<string, string>; zip: Pick<ZipInspection, 'files' | 'paramsJson'> }): Issue[];
  selectAsset(release: ReleaseLike, assetPattern?: string): Result<ReleaseAssetLike>;
  globMatch(pattern: string, name: string): boolean;
}
