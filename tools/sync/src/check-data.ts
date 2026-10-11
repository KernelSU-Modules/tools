// Validate an entire data repo checkout against @kernelsu-modules/schema plus cross-file consistency rules
// (file names, case-fold collisions, request/status combinations, repository bindings, lock/status orphans).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { Banned, Maintainers, Policy, RegistryRecord, RegistryStatus, SourcesLock, canonicalJson, foldId } from '@kernelsu-modules/schema';

export interface CheckIssue {
  severity: 'error' | 'warning';
  file: string;
  message: string;
}

const KNOWN_TOP = new Set(['modules', 'policy.yaml', 'maintainers.yaml', 'banned.yaml', 'sources.lock.json', 'status.json', 'README.md', '.git', '.github', '.gitattributes', 'LICENSE']);

/** Structural subset of a zod schema (keeps this package free of a direct zod dependency). */
interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

function zodMessages(err: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return err.issues.map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`);
}

/** Which record statuses may carry an open request of each kind (see the record state machine in CONTRACTS.md). */
const REQUEST_ON: Record<string, readonly string[]> = { submit: ['pending'], transfer: ['listed', 'suspended'] };
const DAY = 86_400_000;

export function checkDataDir(dataDir: string, opts: { now?: Date } = {}): { issues: CheckIssue[]; stats: Record<string, number> } {
  const now = (opts.now ?? new Date()).getTime();
  const issues: CheckIssue[] = [];
  const err = (file: string, message: string) => issues.push({ severity: 'error', file, message });
  const warn = (file: string, message: string) => issues.push({ severity: 'warning', file, message });
  const stats: Record<string, number> = {};

  function loadYaml<T>(file: string, schema: Schema<T>, required = true): T | undefined {
    const p = join(dataDir, file);
    if (!existsSync(p)) {
      if (required) err(file, 'missing');
      return undefined;
    }
    let raw: unknown;
    try {
      const text = readFileSync(p, 'utf8');
      raw = file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text);
      // Tool-written JSON must be canonical (sorted keys, 2-space indent, trailing newline) so diffs stay minimal.
      if (file.endsWith('.json') && text !== canonicalJson(raw)) err(file, 'not canonically serialized (sorted keys, 2-space indent, trailing newline)');
    } catch (e) {
      err(file, `parse error: ${(e as Error).message}`);
      return undefined;
    }
    const r = schema.safeParse(raw);
    if (!r.success) {
      for (const m of zodMessages(r.error)) err(file, m);
      return undefined;
    }
    return r.data;
  }

  for (const name of readdirSync(dataDir)) if (!KNOWN_TOP.has(name)) warn(name, 'unexpected top-level entry');

  const policy = loadYaml('policy.yaml', Policy);
  const maintainers = loadYaml('maintainers.yaml', Maintainers);
  if (maintainers) {
    stats.maintainers = maintainers.maintainers.length;
    if (!maintainers.maintainers.length) warn('maintainers.yaml', 'no maintainers: nobody can approve anything');
    const gh = new Set<number>();
    const tg = new Set<number>();
    for (const m of maintainers.maintainers) {
      if (gh.has(m.github.id)) err('maintainers.yaml', `duplicate github id ${m.github.id}`);
      gh.add(m.github.id);
      if (m.telegram) {
        if (tg.has(m.telegram.id)) err('maintainers.yaml', `duplicate telegram id ${m.telegram.id}`);
        tg.add(m.telegram.id);
      }
    }
    if (!tg.size) warn('maintainers.yaml', 'no maintainer has a telegram id: Telegram approvals will all answer "Not authorized"');
  }
  const banned = loadYaml('banned.yaml', Banned);
  if (banned) {
    stats.banned = banned.banned.length;
    const seen = new Set<number>();
    for (const b of banned.banned) {
      if (seen.has(b.githubId)) err('banned.yaml', `duplicate githubId ${b.githubId}`);
      seen.add(b.githubId);
    }
  }
  const lock = loadYaml('sources.lock.json', SourcesLock);
  const status = existsSync(join(dataDir, 'status.json')) ? loadYaml('status.json', RegistryStatus) : (warn('status.json', 'missing (written by the next sync)'), undefined);

  // modules/
  const records = new Map<string, RegistryRecord>();
  const modDir = join(dataDir, 'modules');
  // An absent modules/ directory is a valid empty data repo (git does not track empty directories).
  if (existsSync(modDir)) {
    const folded = new Map<string, string>();
    const repoIds = new Map<number, { id: string; how: string; active: boolean }[]>();
    for (const f of readdirSync(modDir).sort()) {
      const rel = `modules/${f}`;
      if (statSync(join(modDir, f)).isDirectory()) {
        err(rel, 'unexpected directory');
        continue;
      }
      if (f === '.gitkeep') continue;
      if (!f.endsWith('.yaml')) {
        err(rel, 'only {id}.yaml files are allowed in modules/');
        continue;
      }
      const rec = loadYaml(rel, RegistryRecord);
      if (!rec) continue;
      if (`${rec.id}.yaml` !== f) err(rel, `file name must be "${rec.id}.yaml"`);
      const k = foldId(rec.id);
      if (folded.has(k)) err(rel, `case-fold collision with "${folded.get(k)}"`);
      folded.set(k, rec.id);
      records.set(rec.id, rec);
      stats[`status:${rec.status}`] = (stats[`status:${rec.status}`] ?? 0) + 1;

      if (policy && rec.status !== 'archived') {
        if (policy.id.reservedIds.some((r) => foldId(r) === k)) warn(rel, 'id is listed in policy.id.reservedIds');
        if (policy.id.reservedPrefixes.some((p) => k.startsWith(foldId(p)))) warn(rel, 'id starts with a prefix from policy.id.reservedPrefixes');
      }
      if (rec.request && !REQUEST_ON[rec.request.kind]!.includes(rec.status))
        err(rel, `${rec.request.kind} request on a ${rec.status} record (allowed on: ${REQUEST_ON[rec.request.kind]!.join(', ')})`);
      if ((rec.status === 'suspended' || rec.status === 'archived') && !rec.moderation) warn(rel, `${rec.status} without moderation info`);
      if (Date.parse(rec.updatedAt) < Date.parse(rec.createdAt)) err(rel, 'updatedAt < createdAt');
      // Expiry the cron should have applied.
      if (policy && rec.request && now - Date.parse(rec.request.submittedAt) > policy.pending.expireDays * DAY)
        warn(rel, `${rec.request.kind} request ${rec.request.submissionId} is older than ${policy.pending.expireDays} days (expired; released by the cron)`);
      // Repository bindings: current sources of listed/suspended records and every open request's source.
      const bind = (repositoryId: number, how: string, active: boolean) => {
        const list = repoIds.get(repositoryId) ?? [];
        list.push({ id: rec.id, how, active });
        repoIds.set(repositoryId, list);
      };
      if (rec.source && (rec.status === 'listed' || rec.status === 'suspended')) bind(rec.source.repositoryId, `${rec.status} source`, true);
      if (rec.source && rec.status === 'archived') bind(rec.source.repositoryId, 'archived source', false);
      if (rec.request) bind(rec.request.source.repositoryId, `${rec.request.kind} request`, true);
    }
    for (const [repositoryId, list] of repoIds) {
      const ids = [...new Set(list.map((b) => b.id))];
      if (ids.length < 2) continue;
      const active = [...new Set(list.filter((b) => b.active).map((b) => b.id))];
      const desc = list.map((b) => `${b.id} (${b.how})`).join(', ');
      if (active.length > 1) err('modules/', `repository ${repositoryId} is bound by several records: ${desc}`);
      else warn('modules/', `repository ${repositoryId} is referenced by several records: ${desc}`);
    }
  }
  stats.records = records.size;

  if (lock) {
    stats.locked = Object.keys(lock.modules).length;
    for (const [key, m] of Object.entries(lock.modules)) {
      if (key !== m.id) err('sources.lock.json', `modules.${key}.id is "${m.id}"`);
      const rec = records.get(key);
      if (!rec) warn('sources.lock.json', `orphan entry "${key}": no record (removed by the next sync)`);
      else if (!['listed', 'suspended', 'archived'].includes(rec.status)) warn('sources.lock.json', `orphan entry "${key}": record is ${rec.status} (removed by the next sync)`);
      else if (rec.source && rec.source.repositoryId !== m.repositoryId)
        warn('sources.lock.json', `"${key}" locked repositoryId ${m.repositoryId} != record ${rec.source.repositoryId} (stale until next sync)`);
      if (m.stable && m.maxVersionCode !== null && m.stable.versionCode > m.maxVersionCode) err('sources.lock.json', `"${key}" stable versionCode exceeds maxVersionCode`);
    }
  }
  if (status) {
    stats.status = Object.keys(status.modules).length;
    for (const [key, st] of Object.entries(status.modules)) {
      const rec = records.get(key);
      const wanted = rec && (rec.status === 'listed' || rec.status === 'suspended' || !!rec.request);
      if (!wanted) warn('status.json', `orphan entry "${key}": ${rec ? `record is ${rec.status} without an open request` : 'no record'} (removed by the next sync)`);
      else if (rec.request && st.request && st.request.submissionId !== rec.request.submissionId)
        warn('status.json', `"${key}" request result is for ${st.request.submissionId}, open request is ${rec.request.submissionId} (stale until next sync)`);
      const lm = lock?.modules[key];
      if (lm && st.maxVersionCode !== lm.maxVersionCode) warn('status.json', `"${key}" maxVersionCode differs from the lock (stale until next sync)`);
    }
  }
  return { issues, stats };
}
