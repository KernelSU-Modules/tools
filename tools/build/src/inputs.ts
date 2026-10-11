import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { GitSha, Policy, RegistryRecord, SourcesLock } from '@kernelsu-modules/schema';
import { sha256 } from './cache.ts';

export interface DataInputs {
  dataCommit: string;
  policy: Policy;
  policySha256: string | null;
  lock: SourcesLock;
  lockSha256: string;
  records: Map<string, RegistryRecord>;
  recordSha256: Record<string, string>;
}

function fail(msg: string): never {
  throw new Error(`[input] ${msg}`);
}

export function resolveDataCommit(dataDir: string, explicit?: string): string {
  const c = explicit ?? process.env['DATA_COMMIT'];
  if (c) {
    if (!GitSha.safeParse(c).success) fail(`--data-commit must be a 40-hex commit, got "${c}"`);
    return c;
  }
  try {
    const out = execFileSync('git', ['-C', dataDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (GitSha.safeParse(out).success) return out;
  } catch {
    /* fallthrough */
  }
  fail(`cannot determine the data repo commit of ${dataDir}; pass --data-commit`);
}

export async function loadInputs(dataDir: string, dataCommit: string): Promise<DataInputs> {
  let policy: Policy;
  let policySha256: string | null = null;
  try {
    const text = await readFile(path.join(dataDir, 'policy.yaml'), 'utf8');
    policySha256 = sha256(text);
    const r = Policy.safeParse(YAML.parse(text));
    if (!r.success) fail(`policy.yaml invalid: ${r.error.message}`);
    policy = r.data;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') fail('policy.yaml missing');
    throw e;
  }

  let lockText: string;
  try {
    lockText = await readFile(path.join(dataDir, 'sources.lock.json'), 'utf8');
  } catch {
    fail('sources.lock.json missing');
  }
  let lockJson: unknown;
  try {
    lockJson = JSON.parse(lockText);
  } catch (e) {
    fail(`sources.lock.json is not JSON: ${(e as Error).message}`);
  }
  const lr = SourcesLock.safeParse(lockJson);
  if (!lr.success) fail(`sources.lock.json invalid: ${lr.error.message}`);
  for (const [k, v] of Object.entries(lr.data.modules)) if (k !== v.id) fail(`lock key ${k} != id ${v.id}`);

  const records = new Map<string, RegistryRecord>();
  const recordSha256: Record<string, string> = {};
  let names: string[] = [];
  try {
    names = (await readdir(path.join(dataDir, 'modules'))).filter((n) => n.endsWith('.yaml')).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    const text = await readFile(path.join(dataDir, 'modules', name), 'utf8');
    const r = RegistryRecord.safeParse(YAML.parse(text));
    if (!r.success) fail(`modules/${name} invalid: ${r.error.message}`);
    if (`${r.data.id}.yaml` !== name) fail(`modules/${name}: id ${r.data.id} does not match file name`);
    records.set(r.data.id, r.data);
    recordSha256[r.data.id] = sha256(text);
  }
  return { dataCommit, policy, policySha256, lock: lr.data, lockSha256: sha256(lockText), records, recordSha256 };
}
