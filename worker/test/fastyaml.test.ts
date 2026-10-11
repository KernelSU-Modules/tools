import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { FALLBACK, fastYaml, parseYaml } from '../src/domain/fastyaml.ts';
import { serializeRecord, stringifyYaml } from '../src/domain/yaml.ts';

const tricky = [
  'plain',
  'with: colon',
  'hash # inside',
  '#leading',
  "it's",
  '"quoted"',
  '123',
  '-5',
  '1e3',
  '0x10',
  'true',
  'NULL',
  '~',
  '',
  ' leading space',
  'trailing space ',
  'multi\nline',
  'tab\there',
  '中文 理由 🚀',
  '- dash',
  '[x]',
  '{y}',
  '*star',
  '&amp',
  '!bang',
  '@at',
  '`tick`',
  'a: b: c',
  'ends with colon:',
  '2026-10-10',
  '.inf',
  'yes',
  'on',
  '\\backslash',
  'emoji \u0001 control',
  "''",
  '"',
];

function rec(i: number, reason: string) {
  return serializeRecord({
    id: `mod.n${i}`,
    status: i % 2 ? 'listed' : 'suspended',
    source: { host: 'github', repositoryId: 1000 + i, ownerId: 5000 + i, fullName: `owner${i}/repo-${i}.x`, manifestPath: 'module.yaml' },
    review: {
      submissionId: 'abcdefghij',
      kind: 'submit',
      submittedBy: 1,
      submittedAt: '2026-10-10T00:00:00Z',
      decision: 'rejected',
      decidedBy: null,
      decidedVia: 'portal',
      decidedAt: '2026-10-10T01:00:00.123Z',
      reasonCode: 'other',
      reason,
      telegram: { chatId: -1001234567890, messageId: 42 },
    },
    moderation: { action: 'suspend', by: 7, via: 'telegram', at: '2026-10-10T00:00:00Z', reason: reason || 'x' },
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-10T00:00:00Z',
  });
}

describe('fast YAML subset parser', () => {
  it('matches YAML.parse on serialized records with tricky strings', () => {
    let fast = 0;
    tricky.forEach((s, i) => {
      const text = rec(i, s);
      const f = fastYaml(text);
      if (f !== FALLBACK) {
        fast++;
        expect(f).toEqual(YAML.parse(text));
      }
      expect(parseYaml(text)).toEqual(YAML.parse(text));
    });
    expect(fast).toBeGreaterThan(tricky.length / 2); // the fast path is actually used
  });

  it('matches YAML.parse on serialized block sequences with tricky strings', () => {
    let fast = 0;
    tricky.forEach((s, i) => {
      const text = stringifyYaml({ reason: s, ids: [1, 2, 3], logins: [s || 'a', 'b'] });
      const f = fastYaml(text);
      if (f !== FALLBACK) {
        fast++;
        expect(f).toEqual(YAML.parse(text));
      }
      expect(parseYaml(text)).toEqual(YAML.parse(text));
    });
    expect(fast).toBeGreaterThan(tricky.length / 2);
  });

  it('matches YAML.parse on hand-written variants or falls back', () => {
    const docs = [
      'a: 1\nb:\n- x\n- 2\nc: null\n',
      'a:\n  b:\n    c: "q\\u00e9"\n  d: \'it\'\'s\'\n',
      'a: [1, 2]\n',
      'a: |\n  block\n',
      'a: &x 1\nb: *x\n',
      'a: 1 # comment\n',
      '# c\na: 1\n',
      'a: b\n  continued\n',
      'a:\n',
      'list: []\nmap: {}\n',
      'n: -0.5\nm: +7\nf: 1.\n',
      'k: 9007199254740993\n',
      '"quoted key": 1\n',
      'a: "unterminated\n',
      'a: x\na: y\n',
    ];
    for (const d of docs) {
      const f = fastYaml(d);
      let ref: unknown;
      try {
        ref = YAML.parse(d);
      } catch {
        expect(f).toBe(FALLBACK);
        continue;
      }
      if (f !== FALLBACK) expect(f).toEqual(ref);
    }
  });
});
