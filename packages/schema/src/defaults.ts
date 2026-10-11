import type { Policy } from './registry.ts';

const MiB = 1024 * 1024;

/** Initial policy.yaml values (data repo); also the fallback for local/author-side checks. */
export const DEFAULT_POLICY: Policy = {
  schemaVersion: 1,
  id: {
    reservedPrefixes: ['org.kernelsu.', 'me.weishu.'],
    reservedIds: ['ksu', 'kernelsu', 'magisk', 'apatch', 'test', 'example', 'module'],
  },
  limits: {
    zipMaxBytes: 100 * MiB,
    uncompressedMaxBytes: 512 * MiB,
    maxCompressionRatio: 200,
    maxEntries: 20000,
    modulePropMaxBytes: 64 * 1024,
    manifestMaxBytes: 64 * 1024,
    docMaxBytes: 512 * 1024,
    imageMaxBytes: 5 * MiB,
    imagesMaxPerModule: 40,
    imagesMaxTotalBytes: 40 * MiB,
    imageMaxRedirects: 3,
    changelogMaxBytes: 64 * 1024,
  },
  history: { keepReleases: 10 },
  pending: { expireDays: 30 },
};
