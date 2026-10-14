export * from './issues.ts';
export * from './id.ts';
export * from './manifest.ts';
export * from './prop.ts';
export * from './range.ts';
export * from './zip.ts';
export * from './release.ts';
export * from './asset.ts';
export * from './params.ts';
export * from './kind.ts';

import { DEFAULT_POLICY, type Policy } from '@kernelsu-modules/schema';
import type { ZipLimits } from './zip.ts';

/** ZipLimits from a policy (defaults to DEFAULT_POLICY). */
export function zipLimitsFromPolicy(policy: Pick<Policy, 'limits'> = DEFAULT_POLICY): ZipLimits {
  const l = policy.limits;
  return {
    zipMaxBytes: l.zipMaxBytes,
    uncompressedMaxBytes: l.uncompressedMaxBytes,
    maxCompressionRatio: l.maxCompressionRatio,
    maxEntries: l.maxEntries,
    modulePropMaxBytes: l.modulePropMaxBytes,
  };
}
