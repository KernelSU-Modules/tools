import type { ManifestKind } from '@kernelsu-modules/schema';
import { issue, result, type Issue, type Result } from './issues.ts';
import { checkReleaseKind } from './kind.ts';
import { parseModuleProp } from './prop.ts';
import type { RangeReader } from './range.ts';
import { inspectZip, type ZipLimits } from './zip.ts';

export interface ValidatedAsset {
  props: Record<string, string>;
  version: string;
  versionCode: number;
  /** Extra (non-contract) details. */
  entries: number;
  uncompressedTotal: number;
}

/**
 * End-to-end check of one release asset: ZIP structure + root module.prop + id binding + entry-kind rules
 * (checkReleaseKind with module.yaml `kind`; when omitted, module.prop `oneshot` decides which rules apply).
 */
export async function validateReleaseAsset(input: {
  reader: RangeReader;
  expectedId: string;
  limits: ZipLimits;
  kind?: ManifestKind;
}): Promise<Result<ValidatedAsset>> {
  const zip = await inspectZip(input.reader, input.limits);
  const issues: Issue[] = [...zip.issues];
  if (!zip.value) return result(issues);
  const prop = parseModuleProp(zip.value.moduleProp);
  issues.push(...prop.issues);
  if (!prop.value) return result(issues);
  const p = prop.value;
  if (p.id !== input.expectedId)
    issues.push(issue('prop-id-mismatch', `module.prop id "${p.id}" does not equal the registered ID "${input.expectedId}".`, 'error', 'id'));
  issues.push(...checkReleaseKind({ kind: input.kind, props: p.props, zip: zip.value }));
  return result(issues, {
    props: p.props,
    version: p.version,
    versionCode: p.versionCode,
    entries: zip.value.entries,
    uncompressedTotal: zip.value.uncompressedTotal,
  });
}
