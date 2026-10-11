import { z } from 'zod';

/** Same rule as ksud (userspace/ksud/src/module.rs): ^[a-zA-Z][a-zA-Z0-9._-]+$ */
export const MODULE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]+$/;
export const ModuleId = z.string().min(2).max(64).regex(MODULE_ID_PATTERN);
export type ModuleId = z.infer<typeof ModuleId>;

/** Case-folded key used for collision detection between IDs. */
export const foldId = (id: string): string => id.toLowerCase();

/** Simplified BCP 47: language[-Script][-REGION], e.g. en, en-US, zh-CN, zh-Hant-TW. */
export const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;
export const Locale = z.string().regex(LOCALE_PATTERN);
export type Locale = z.infer<typeof Locale>;

/** Repository-relative path: no leading slash, no backslash, no "..", no scheme. */
export const RelativePath = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\\') &&
      !p.includes('://') &&
      !p.split('/').some((s) => s === '..' || s === '.' || s === ''),
    { message: 'must be a normalized repository-relative path' },
  );

export const HttpsUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => u.startsWith('https://'), { message: 'must be an https URL' });

/** http(s) URL; used where plain http is tolerated (module homepage / support). */
export const WebUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => u.startsWith('https://') || u.startsWith('http://'), { message: 'must be an http(s) URL' });

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export const GitSha = z.string().regex(/^[0-9a-f]{40}$/);
export const IsoDateTime = z.iso.datetime({ offset: true });
export const GitHubId = z.number().int().positive();

export const INT32_MAX = 2147483647;
export const VersionCode = z.number().int().min(1).max(INT32_MAX);

export const ARCHITECTURES = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86', 'riscv64'] as const;
export const Architecture = z.enum(ARCHITECTURES);
