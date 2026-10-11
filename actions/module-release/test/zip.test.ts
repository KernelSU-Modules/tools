import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectDir, createZip } from '../src/zip.ts';
import { extractEntry, tempDir } from './helpers.ts';

const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function sampleDir(): string {
  const dir = tempDir();
  mkdirSync(join(dir, '.git/objects'), { recursive: true });
  mkdirSync(join(dir, 'system/bin'), { recursive: true });
  mkdirSync(join(dir, 'webroot'), { recursive: true });
  writeFileSync(join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, '.gitignore'), '*.zip\n');
  writeFileSync(join(dir, 'module.prop'), 'id=x\n');
  writeFileSync(join(dir, 'system/bin/tool'), 'A'.repeat(4096));
  chmodSync(join(dir, 'system/bin/tool'), 0o755);
  writeFileSync(join(dir, 'webroot/index.html'), '<p>hi</p>');
  symlinkSync('module.prop', join(dir, 'link'));
  return dir;
}

describe('zip writer', () => {
  it('collects files in sorted order, skipping VCS files and symlinks', () => {
    const { entries, skipped } = collectDir(sampleDir());
    expect(entries.map((e) => e.name)).toEqual(['module.prop', 'system/', 'system/bin/', 'system/bin/tool', 'webroot/', 'webroot/index.html']);
    expect(skipped).toEqual(['link']);
    expect(entries.find((e) => e.name === 'system/bin/tool')!.mode & 0o777).toBe(0o755);
  });

  it('is deterministic and round-trips', () => {
    const dir = sampleDir();
    const a = createZip(collectDir(dir).entries);
    const b = createZip(collectDir(dir).entries);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(new TextDecoder().decode(extractEntry(a, 'system/bin/tool')!)).toBe('A'.repeat(4096));
    expect(new TextDecoder().decode(extractEntry(a, 'module.prop')!)).toBe('id=x\n');
  });

  it.skipIf(!hasUnzip)('passes `unzip -t` and keeps unix modes', () => {
    const dir = sampleDir();
    const out = join(tempDir(), 'm.zip');
    writeFileSync(out, createZip(collectDir(dir).entries));
    expect(execFileSync('unzip', ['-t', out], { encoding: 'utf8' })).toMatch(/No errors detected/);
    expect(execFileSync('unzip', ['-Z', out], { encoding: 'utf8' })).toMatch(/-rwxr-xr-x.*system\/bin\/tool/);
  });
});
