// YAML (de)serialization of data-repo files with stable key order.
import YAML from 'yaml';
import { parseYaml } from './fastyaml.ts';
import { Banned, Maintainers, Policy, RegistryRecord, type Source } from '@kernelsu-modules/schema';

export const stringifyYaml = (v: unknown): string => YAML.stringify(v, { lineWidth: 0 });

export function parseRecord(text: string): RegistryRecord {
  return RegistryRecord.parse(parseYaml(text));
}
export function parsePolicy(text: string): Policy {
  return Policy.parse(YAML.parse(text));
}
export function parseMaintainers(text: string): Maintainers {
  return Maintainers.parse(YAML.parse(text) ?? { maintainers: [] });
}
export function parseBanned(text: string): Banned {
  return Banned.parse(YAML.parse(text) ?? { banned: [] });
}

function pick<T extends object>(o: T | undefined, keys: (keyof T)[]): T | undefined {
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k as string] = o[k];
  // keep unknown keys last (schema is strict, so normally none)
  for (const [k, v] of Object.entries(o)) if (!(k in out) && v !== undefined) out[k] = v;
  return out as T;
}

export function normalizeSource(s: Source): Source;
export function normalizeSource(s: Source | undefined): Source | undefined;
export function normalizeSource(s: Source | undefined): Source | undefined {
  return pick(s, ['host', 'repositoryId', 'ownerId', 'fullName', 'ref', 'manifestPath']);
}

/** Serialize a record in schema key order (validated first, so we never write an invalid record). */
export function serializeRecord(r: RegistryRecord): string {
  const valid = RegistryRecord.parse(r);
  const ordered = {
    id: valid.id,
    status: valid.status,
    source: normalizeSource(valid.source),
    request: valid.request
      ? pick({ ...valid.request, source: normalizeSource(valid.request.source) }, ['submissionId', 'kind', 'source', 'submittedBy', 'submittedByLogin', 'submittedAt', 'telegram'])
      : undefined,
    review: pick(valid.review, ['submissionId', 'kind', 'submittedBy', 'submittedAt', 'decision', 'decidedBy', 'decidedVia', 'decidedAt', 'reasonCode', 'reason', 'telegram']),
    moderation: pick(valid.moderation, ['action', 'by', 'via', 'at', 'reason']),
    createdAt: valid.createdAt,
    updatedAt: valid.updatedAt,
  };
  return stringifyYaml(JSON.parse(JSON.stringify(ordered)));
}

export const recordPath = (id: string) => `modules/${id}.yaml`;
