import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { DEFAULT_POLICY, RegistryStatus, SourcesLock, canonicalJson } from '@kernelsu-modules/schema';
import { checkDataDir } from '../src/check-data.ts';

const tmp: string[] = [];
afterEach(() => tmp.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A freshly initialized data repo checkout: no modules, empty lock and status. */
function freshDataDir(opts: { modulesDir?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'kernelsu-check-data-'));
  tmp.push(dir);
  if (opts.modulesDir !== false) mkdirSync(join(dir, 'modules'));
  writeFileSync(join(dir, 'policy.yaml'), YAML.stringify(DEFAULT_POLICY, { lineWidth: 0 }));
  writeFileSync(join(dir, 'maintainers.yaml'), YAML.stringify({ maintainers: [{ github: { id: 1, login: 'octocat' }, telegram: { id: 123456789 } }] }));
  writeFileSync(join(dir, 'banned.yaml'), 'banned: []\n');
  writeFileSync(join(dir, 'sources.lock.json'), canonicalJson(SourcesLock.parse({ schemaVersion: 1, modules: {} })));
  writeFileSync(join(dir, 'status.json'), canonicalJson(RegistryStatus.parse({ schemaVersion: 1, modules: {} })));
  return dir;
}

const put = (dir: string, r: Record<string, unknown>, file = `${r.id}.yaml`) => writeFileSync(join(dir, 'modules', file), YAML.stringify(r, { lineWidth: 0 }));
const t = '2026-01-01T00:00:00Z';
const src = (repositoryId: number) => ({ host: 'github', repositoryId, ownerId: 1, fullName: `o/r${repositoryId}` });
const req = (kind: string, repositoryId: number, submittedAt = '2026-10-01T00:00:00Z') => ({ submissionId: 'abcdefghij', kind, source: src(repositoryId), submittedBy: 1, submittedAt });
const fmt = (i: { file: string; message: string }) => `${i.file}: ${i.message}`;

describe('checkDataDir', () => {
  it('accepts a fresh data repo with an empty or absent modules/ directory', () => {
    for (const modulesDir of [true, false]) {
      const dir = freshDataDir({ modulesDir });
      if (modulesDir) writeFileSync(join(dir, 'modules', '.gitkeep'), '');
      const { issues, stats } = checkDataDir(dir);
      expect(issues).toEqual([]);
      expect(stats).toMatchObject({ records: 0, locked: 0, status: 0, maintainers: 1, banned: 0 });
    }
  });

  it('accepts a legacy telegram.username in maintainers.yaml with a warning (pre-release migration)', () => {
    const dir = freshDataDir();
    writeFileSync(join(dir, 'maintainers.yaml'), YAML.stringify({ maintainers: [{ github: { id: 1, login: 'octocat' }, telegram: { id: 123456789, username: 'octo' } }] }));
    const { issues, stats } = checkDataDir(dir);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.map(fmt)).toEqual([expect.stringContaining('maintainers.yaml: maintainers.0.telegram.username: Telegram usernames are no longer used')]);
    expect(stats.maintainers).toBe(1);
    writeFileSync(join(dir, 'maintainers.yaml'), YAML.stringify({ maintainers: [{ github: { id: 1, login: 'octocat' }, telegram: { id: 1, nick: 'x' } }] }));
    expect(checkDataDir(dir).issues.filter((i) => i.severity === 'error').length).toBe(1);
  });

  it('accepts listed, pending and archived records', () => {
    const dir = freshDataDir();
    put(dir, { id: 'listed.a', status: 'listed', source: src(1), createdAt: t, updatedAt: t });
    put(dir, { id: 'pend.b', status: 'pending', request: req('submit', 2), createdAt: t, updatedAt: t });
    put(dir, { id: 'arch.c', status: 'archived', source: src(3), moderation: { action: 'archive', by: 1, via: 'portal', at: t, reason: 'abandoned' }, createdAt: t, updatedAt: t });
    const { issues } = checkDataDir(dir, { now: new Date('2026-10-10T00:00:00Z') });
    expect(issues.filter((i) => i.severity === 'error').map(fmt)).toEqual([]);
  });

  it('rejects bad file names, collisions, stray files and invalid YAML', () => {
    const dir = freshDataDir();
    const rec = { id: 'gamma', status: 'listed', source: src(1), createdAt: t, updatedAt: t };
    put(dir, rec, 'wrong-name.yaml');
    put(dir, { ...rec, id: 'Gamma', source: src(2) });
    put(dir, { ...rec, source: src(3) });
    writeFileSync(join(dir, 'modules', 'notes.txt'), 'x');
    writeFileSync(join(dir, 'banned.yaml'), 'banned: [{githubId: -1}]\n');
    mkdirSync(join(dir, 'stray'));
    const { issues } = checkDataDir(dir);
    const errors = issues.filter((i) => i.severity === 'error').map(fmt);
    expect(errors.some((e) => e.includes('file name must be "gamma.yaml"'))).toBe(true);
    expect(errors.some((e) => e.includes('case-fold collision'))).toBe(true);
    expect(errors.some((e) => e.startsWith('modules/notes.txt'))).toBe(true);
    expect(errors.some((e) => e.startsWith('banned.yaml'))).toBe(true);
    expect(issues.some((i) => i.severity === 'warning' && i.file === 'stray')).toBe(true);
  });

  it('request/status consistency, duplicate bindings, expiry, orphans, canonical JSON', () => {
    const dir = freshDataDir();
    put(dir, { id: 'listed.a', status: 'listed', source: src(1), request: req('submit', 9), createdAt: t, updatedAt: t });
    put(dir, { id: 'pend.b', status: 'pending', request: req('submit', 1), createdAt: t, updatedAt: t });
    put(dir, { id: 'pend.old', status: 'pending', request: req('submit', 2, '2026-01-01T00:00:00Z'), createdAt: t, updatedAt: t });
    put(dir, { id: 'listed.t', status: 'listed', source: src(4), request: req('transfer', 5), createdAt: t, updatedAt: t });
    writeFileSync(join(dir, 'sources.lock.json'), JSON.stringify({ schemaVersion: 1, modules: {} }) + '\n');
    writeFileSync(
      join(dir, 'status.json'),
      '{\n  "modules": {\n    "ghost": {"repositoryId": 3, "fullName": "o/r3", "health": "ok", "installation": "present", "lastSuccessAt": null, "message": null, "contentCommit": null, "stable": null, "maxVersionCode": null, "request": null}\n  },\n  "schemaVersion": 1\n}\n',
    );
    const { issues } = checkDataDir(dir, { now: new Date('2026-10-10T00:00:00Z') });
    const errs = issues.filter((i) => i.severity === 'error').map(fmt);
    const warns = issues.filter((i) => i.severity === 'warning').map(fmt);
    expect(errs.some((e) => e.includes('listed.a') && e.includes('submit request on a listed record'))).toBe(true);
    expect(errs.some((e) => e.includes('listed.t'))).toBe(false);
    expect(errs.some((e) => e.includes('repository 1 is bound by several records'))).toBe(true);
    expect(errs.some((e) => e.startsWith('sources.lock.json: not canonically serialized'))).toBe(true);
    expect(errs.some((e) => e.startsWith('status.json: not canonically serialized'))).toBe(true);
    expect(warns.some((w) => w.startsWith('modules/pend.old.yaml') && w.includes('expired'))).toBe(true);
    expect(warns.some((w) => w.includes('orphan entry "ghost"'))).toBe(true);
  });

  it('warns about IDs listed in policy.id.reservedIds', () => {
    const dir = freshDataDir();
    const id = DEFAULT_POLICY.id.reservedIds[0]!;
    put(dir, { id, status: 'listed', source: src(1), createdAt: t, updatedAt: t });
    const { issues } = checkDataDir(dir);
    expect(issues.some((i) => i.severity === 'warning' && i.message === 'id is listed in policy.id.reservedIds')).toBe(true);
  });
});
