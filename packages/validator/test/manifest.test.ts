import { describe, expect, it } from 'vitest';
import { manifestReferencedPaths, parseManifest } from '../src/index.ts';

const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

const FULL = `schemaVersion: 1
id: demo.toolbox
name: Demo Toolbox
summary: Utilities for rooted Android devices
description: README.md
license: MIT
homepage: https://example.org/demo-toolbox
support: https://github.com/demo/toolbox/issues
tags: [system, tools]
icon: assets/icon.png
metamodule: false

authors:
  - name: Demo Author
    url: https://github.com/demo

compatibility:
  androidMinApi: 28
  architectures: [arm64-v8a]

release:
  assetPattern: "demo.toolbox-*.zip"
`;

const MIN = `schemaVersion: 1
id: demo.toolbox
name: Demo
summary: Short
description: README.md
`;

describe('parseManifest', () => {
  it('accepts the design-doc example', () => {
    const r = parseManifest(FULL);
    expect(r.issues).toEqual([]);
    expect(r.value?.id).toBe('demo.toolbox');
    expect(r.value?.release?.assetPattern).toBe('demo.toolbox-*.zip');
    expect(manifestReferencedPaths(r.value!)).toEqual(['assets/icon.png', 'README.md']);
  });

  it('accepts a minimal manifest with BOM', () => {
    const r = parseManifest('\uFEFF' + MIN);
    expect(r.ok).toBe(true);
    expect(r.value?.metamodule).toBe(false);
    expect(manifestReferencedPaths(r.value!)).toEqual(['README.md']);
  });

  it('rejects oversize input', () => {
    expect(codes(parseManifest(MIN, { maxBytes: 10 }))).toEqual(['manifest-too-large']);
  });

  it('rejects YAML syntax errors, duplicate keys and multiple documents', () => {
    expect(codes(parseManifest('a: [1, 2'))).toContain('manifest-yaml');
    expect(codes(parseManifest(MIN + 'id: other\n'))).toContain('manifest-yaml');
    expect(codes(parseManifest(MIN + '---\nfoo: 1\n'))).toContain('manifest-yaml');
  });

  it('rejects alias bombs', () => {
    const bomb = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 10; i++) bomb.push(`${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [${Array(10).fill('*' + String.fromCharCode(96 + i)).join(', ')}]`);
    const r = parseManifest(bomb.join('\n'));
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('manifest-yaml');
  });

  it('rejects non-mapping documents', () => {
    expect(codes(parseManifest('- a\n- b\n'))).toEqual(['manifest-schema']);
    expect(codes(parseManifest(''))).toEqual(['manifest-schema']);
  });

  it('rejects unsupported schemaVersion', () => {
    expect(codes(parseManifest(MIN.replace('schemaVersion: 1', 'schemaVersion: 2')))).toEqual(['manifest-unsupported-version']);
  });

  it('reports schema errors with paths (numeric YAML values are not strings)', () => {
    const r = parseManifest(MIN.replace('name: Demo', 'name: 1.10'));
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'manifest-schema', path: 'name' });
  });

  it('unknown fields are warnings and are dropped; bad ids/paths are errors', () => {
    const r = parseManifest(MIN + 'extra: 1\ncompatibility: { androidMinApi: 28, future: x }\nauthors: [{ name: A, mail: a@b }]\n');
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => [i.code, i.severity, i.path])).toEqual([
      ['manifest-schema', 'warning', 'extra'],
      ['manifest-schema', 'warning', 'authors[0].mail'],
      ['manifest-schema', 'warning', 'compatibility.future'],
    ]);
    expect(r.value && 'extra' in r.value).toBe(false);
    expect(codes(parseManifest(MIN.replace('id: demo.toolbox', 'id: 1bad')))).toEqual(['manifest-schema']);
    expect(codes(parseManifest(MIN.replace('README.md', '../secret.md')))).toEqual(['manifest-schema']);
    expect(codes(parseManifest(MIN + 'icon: /etc/passwd\n'))).toEqual(['manifest-schema']);
  });

  it('starsRepository: "owner/name" (a known field; verified later by sync)', () => {
    const r = parseManifest(MIN + 'starsRepository: LSPosed/LSPosed\n');
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.value!.starsRepository).toBe('LSPosed/LSPosed');
    const bad = parseManifest(MIN + 'starsRepository: https://github.com/LSPosed/LSPosed\n');
    expect(bad.issues.map((i) => [i.code, i.severity, i.path])).toEqual([['manifest-schema', 'error', 'starsRepository']]);
  });

  it('normalizes ./ paths and tag case, tolerates http homepage with a warning, raises text limits', () => {
    const r = parseManifest(MIN.replace('README.md', './docs/README.md') + `icon: ./assets/icon.png\ntags: [Root, System-Tools]\nhomepage: http://example.org\n`);
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ description: 'docs/README.md', icon: 'assets/icon.png', tags: ['root', 'system-tools'], homepage: 'http://example.org' });
    expect(r.issues).toMatchObject([{ code: 'manifest-schema', severity: 'warning', path: 'homepage' }]);
    expect(manifestReferencedPaths(r.value!)).toEqual(['assets/icon.png', 'docs/README.md']);
    expect(parseManifest(MIN.replace('name: Demo', `name: ${'n'.repeat(100)}`).replace('summary: Short', `summary: ${'s'.repeat(500)}`)).ok).toBe(true);
    expect(parseManifest(MIN.replace('name: Demo', `name: ${'n'.repeat(101)}`)).ok).toBe(false);
    expect(codes(parseManifest(MIN + 'support: ftp://example.org\n'))).toEqual(['manifest-schema']);
    expect(codes(parseManifest(MIN + 'authors: [{ name: A, url: "http://a.example" }]\n'))).toEqual(['manifest-schema']);
  });

  it('unknown top-level fields are ignored with a warning', () => {
    const r = parseManifest(MIN + 'locales: {}\nextra: 1\n');
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => [i.severity, i.path])).toEqual([
      ['warning', 'locales'],
      ['warning', 'extra'],
    ]);
  });

  it('semantic checks', () => {
    const r = parseManifest(MIN + 'compatibility: { androidMinApi: 30, androidMaxApi: 28 }\n');
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'manifest-schema', path: 'compatibility' });
    const w = parseManifest(MIN + 'tags: [a, a]\n');
    expect(w.ok).toBe(true);
    expect(w.issues).toMatchObject([{ severity: 'warning' }]);
  });
});
