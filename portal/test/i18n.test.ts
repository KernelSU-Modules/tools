import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en.ts';
import { zhCN } from '../src/i18n/zh-CN.ts';
import { detectLang, matchLang, translate } from '../src/i18n/index.ts';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n dictionaries', () => {
  it('zh-CN has exactly the en keys', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });
  it('no empty strings and identical placeholders', () => {
    for (const [k, v] of Object.entries(en)) {
      expect(v.trim(), k).not.toBe('');
      const zh = (zhCN as Record<string, string>)[k]!;
      expect(zh.trim(), k).not.toBe('');
      expect(placeholders(zh), k).toEqual(placeholders(v));
    }
  });
  it('every literal key used in the source exists, and dynamic key families are complete', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const f = join(d, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.tsx?$/.test(n) && !f.includes('/i18n/')) files.push(f);
      }
    };
    walk(join(__dirname, '../src'));
    const used = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(100);
    for (const k of used) expect(en, k).toHaveProperty([k]);
    const families: Record<string, string[]> = {
      status: ['pending', 'listed', 'rejected', 'suspended', 'archived', 'unknown'],
      health: ['ok', 'stale', 'error', 'none'],
      kind: ['submit', 'transfer'],
      reason: ['spam', 'violation', 'bad-id', 'squatting', 'other'],
      moderate: ['suspend', 'unsuspend', 'archive'],
      severity: ['error', 'warning'],
      'id.invalid': ['empty', 'tooShort', 'tooLong', 'pattern'],
      'maint.err': ['githubId', 'login', 'telegramId', 'duplicate', 'empty'],
    };
    for (const [prefix, names] of Object.entries(families)) for (const n of names) expect(en, `${prefix}.${n}`).toHaveProperty([`${prefix}.${n}`]);
  });
});

describe('language detection and translation', () => {
  it('stored choice wins, then navigator languages', () => {
    expect(detectLang('zh-CN', ['en-US'])).toBe('zh-CN');
    expect(detectLang('fr', ['fr-FR', 'zh-TW', 'en'])).toBe('zh-CN');
    expect(detectLang(null, ['de-DE'])).toBe('en');
    expect(detectLang(null, ['en-GB', 'zh-CN'])).toBe('en');
    expect(matchLang('ZH-hans')).toBe('zh-CN');
    expect(matchLang(undefined)).toBeNull();
  });
  it('interpolates params and keeps unknown placeholders', () => {
    expect(translate('en', 'repos.registeredAs', { id: 'x' })).toBe('Registered: x');
    expect(translate('zh-CN', 'repos.registeredAs', { id: 'x' })).toBe('已绑定：x');
    expect(translate('en', 'repos.registeredAs')).toBe('Registered: {id}');
  });
});
