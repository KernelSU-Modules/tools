// Data-repo I/O: records, policy, sources.lock.json and status.json (load, canonical serialization, merge).
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import { ModuleLock, ModuleStatus, Policy, RegistryRecord, RegistryStatus, SourcesLock, canonicalJson, sortKeys } from '@kernelsu-modules/schema';

export const LOCK_FILE = 'sources.lock.json';
export const STATUS_FILE = 'status.json';
export { sortKeys };

export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}

export interface InvalidRecord {
  file: string;
  error: string;
}

export interface DataDir {
  records: RegistryRecord[];
  invalidRecords: InvalidRecord[];
  policy: Policy;
  lock: SourcesLock;
  /** Lock entries dropped because they failed schema validation (they are rebuilt from scratch). */
  invalidLockEntries: InvalidRecord[];
  status: RegistryStatus;
}

function zodMessage(e: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return e.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

export async function loadPolicy(dataDir: string): Promise<Policy> {
  let text: string;
  try {
    text = await readFile(join(dataDir, 'policy.yaml'), 'utf8');
  } catch (e) {
    throw new FatalError(`cannot read policy.yaml: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new FatalError(`policy.yaml is not valid YAML: ${(e as Error).message}`);
  }
  const p = Policy.safeParse(raw);
  if (!p.success) throw new FatalError(`policy.yaml does not match the schema: ${zodMessage(p.error)}`);
  return p.data;
}

export async function loadRecords(dataDir: string): Promise<{ records: RegistryRecord[]; invalid: InvalidRecord[] }> {
  const dir = join(dataDir, 'modules');
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.yaml')).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new FatalError(`cannot list modules/: ${(e as Error).message}`);
  }
  const records: RegistryRecord[] = [];
  const invalid: InvalidRecord[] = [];
  for (const name of names) {
    const file = `modules/${name}`;
    try {
      const raw = YAML.parse(await readFile(join(dir, name), 'utf8'));
      const r = RegistryRecord.safeParse(raw);
      if (!r.success) {
        invalid.push({ file, error: zodMessage(r.error) });
        continue;
      }
      if (`${r.data.id}.yaml` !== name) {
        invalid.push({ file, error: `record id "${r.data.id}" does not match the file name` });
        continue;
      }
      records.push(r.data);
    } catch (e) {
      invalid.push({ file, error: (e as Error).message.split('\n')[0]! });
    }
  }
  return { records, invalid };
}

export function emptyLock(): SourcesLock {
  return { schemaVersion: 1, modules: {} };
}

/**
 * Parse a lock leniently: the envelope must be valid, individual module entries that fail the schema
 * are dropped (and reported) so one corrupt entry cannot block every other module.
 */
export function parseLock(text: string | null): { lock: SourcesLock; invalid: InvalidRecord[] } {
  if (text === null || text.trim() === '') return { lock: emptyLock(), invalid: [] };
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new FatalError(`${LOCK_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1 || typeof raw.modules !== 'object' || raw.modules === null)
    throw new FatalError(`${LOCK_FILE} has an unsupported envelope (expected schemaVersion 1)`);
  const lock = emptyLock();
  const invalid: InvalidRecord[] = [];
  for (const [id, entry] of Object.entries(raw.modules as Record<string, unknown>)) {
    const m = ModuleLock.safeParse(entry);
    if (m.success && m.data.id === id) lock.modules[id] = m.data;
    else invalid.push({ file: `${LOCK_FILE}#${id}`, error: m.success ? 'id does not match key' : zodMessage(m.error) });
  }
  // Envelope is strict too; final sanity check.
  SourcesLock.parse(lock);
  return { lock, invalid };
}

export async function loadLock(dataDir: string): Promise<{ lock: SourcesLock; invalid: InvalidRecord[] }> {
  return parseLock(await readOptional(join(dataDir, LOCK_FILE), LOCK_FILE));
}

export function emptyStatus(): RegistryStatus {
  return { schemaVersion: 1, modules: {} };
}

/** Lenient status.json parse: it is derived data, so anything unreadable is simply rebuilt. */
export function parseStatus(text: string | null): RegistryStatus {
  const st = emptyStatus();
  if (text === null || text.trim() === '') return st;
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return st;
  }
  if (!raw || raw.schemaVersion !== 1 || typeof raw.modules !== 'object' || raw.modules === null) return st;
  for (const [id, entry] of Object.entries(raw.modules as Record<string, unknown>)) {
    const m = ModuleStatus.safeParse(entry);
    if (m.success) st.modules[id] = m.data;
  }
  return st;
}

async function readOptional(path: string, label: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new FatalError(`cannot read ${label}: ${(e as Error).message}`);
    return null;
  }
}

export async function loadDataDir(dataDir: string): Promise<DataDir> {
  const policy = await loadPolicy(dataDir);
  const { records, invalid } = await loadRecords(dataDir);
  const { lock, invalid: invalidLockEntries } = await loadLock(dataDir);
  const status = parseStatus(await readOptional(join(dataDir, STATUS_FILE), STATUS_FILE));
  return { records, invalidRecords: invalid, policy, lock, invalidLockEntries, status };
}

/** Canonical lock serialization: sorted keys, 2-space indent, trailing newline. */
export function serializeLock(lock: SourcesLock): string {
  return canonicalJson(lock);
}

/** Canonical status.json serialization (same rules as the lock). */
export function serializeStatus(status: RegistryStatus): string {
  return canonicalJson(status);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

export async function writeLock(dataDir: string, lock: SourcesLock): Promise<void> {
  await writeAtomic(join(dataDir, LOCK_FILE), serializeLock(lock));
}

export async function writeStatus(dataDir: string, status: RegistryStatus): Promise<void> {
  await writeAtomic(join(dataDir, STATUS_FILE), serializeStatus(status));
}

/**
 * Merge this run's results into a (possibly newer) base document: only the module ids this run touched are
 * replaced (or removed when absent from `ours`); everything else in `base` is kept verbatim.
 */
export function mergeModules<T>(base: { modules: Record<string, T> }, ours: { modules: Record<string, T> }, touched: Iterable<string>): { schemaVersion: 1; modules: Record<string, T> } {
  const modules = { ...base.modules };
  for (const id of touched) {
    const m = ours.modules[id];
    if (m) modules[id] = m;
    else delete modules[id];
  }
  return { schemaVersion: 1, modules };
}

export function mergeLock(base: SourcesLock, ours: SourcesLock, touched: Iterable<string>): SourcesLock {
  return mergeModules(base, ours, touched);
}
