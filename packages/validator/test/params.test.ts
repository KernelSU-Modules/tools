import { describe, expect, it } from 'vitest';
import { duplicateJsonKeys, parseParams } from '../src/index.ts';

const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);
const errors = (r: { issues: { severity: string; message: string }[] }) => r.issues.filter((i) => i.severity === 'error').map((i) => i.message);
const doc = (params: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1, params, ...extra });

/** The example from the script-entry docs. */
const EXAMPLE = `{
  "schemaVersion": 1,
  "params": [
    {
      "key": "ENABLE_FASTBOOT",
      "type": "bool",
      "label": "Also enable fastboot",
      "description": "Optional longer help text",
      "default": true
    },
    { "key": "MODE", "type": "enum", "label": "Mode", "default": "a",
      "options": [ { "value": "a", "label": "A" }, { "value": "b" } ] },
    { "key": "NAME", "type": "string", "label": "Name", "default": "", "maxLength": 64,
      "required": false },
    { "key": "COUNT", "type": "int", "label": "Count", "default": 1, "min": 0, "max": 10 }
  ]
}`;

describe('parseParams', () => {
  it('accepts the documented example', () => {
    const r = parseParams(EXAMPLE);
    expect(r.issues).toEqual([]);
    expect(r.value?.params.map((p) => p.key)).toEqual(['ENABLE_FASTBOOT', 'MODE', 'NAME', 'COUNT']);
  });

  it('accepts an empty parameter list and a BOM', () => {
    expect(parseParams('\uFEFF' + doc([])).ok).toBe(true);
  });

  it('resolves defaults', () => {
    const r = parseParams(
      doc([
        { key: 'B', type: 'bool', label: 'b' },
        { key: 'E', type: 'enum', label: 'e', options: [{ value: 'x' }, { value: 'y' }] },
        { key: 'S', type: 'string', label: 's' },
        { key: 'I', type: 'int', label: 'i' },
        { key: 'J', type: 'int', label: 'j', min: 3 },
      ]),
    );
    expect(r.issues).toEqual([]);
    expect(r.value?.params).toEqual([
      { key: 'B', type: 'bool', label: 'b', default: false },
      { key: 'E', type: 'enum', label: 'e', options: [{ value: 'x' }, { value: 'y' }], default: 'x' },
      { key: 'S', type: 'string', label: 's', default: '', maxLength: 256, required: false },
      { key: 'I', type: 'int', label: 'i', default: 0 },
      { key: 'J', type: 'int', label: 'j', min: 3, default: 3 },
    ]);
  });

  it('rejects invalid JSON, non-objects and unsupported schemaVersion', () => {
    expect(errors(parseParams('{"schemaVersion": 1,'))).toEqual([expect.stringMatching(/^params\.json is not valid JSON/)]);
    expect(errors(parseParams('[]'))).toEqual(['params.json must be a JSON object.']);
    const v2 = parseParams(doc([], { schemaVersion: 2 }));
    expect(v2.issues).toMatchObject([{ code: 'script-params-invalid', severity: 'error', path: 'schemaVersion', message: expect.stringContaining('schemaVersion 2 is not supported') }]);
    expect(codes(parseParams('{"params": []}'))).toEqual(['script-params-invalid']);
    expect(parseParams('x'.repeat(10), { maxBytes: 5 }).issues[0]?.message).toContain('the limit is 5 bytes');
  });

  it('warns about unknown fields (ignored)', () => {
    const r = parseParams(
      doc([{ key: 'E', type: 'enum', label: 'e', options: [{ value: 'x', icon: 'y' }], min: 1 }], { title: 't' }),
    );
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => [i.severity, i.path])).toEqual([
      ['warning', 'title'],
      ['warning', 'params[0].min'],
      ['warning', 'params[0].options[0].icon'],
    ]);
    expect(r.value).not.toHaveProperty('title');
  });

  it('schema errors carry the path', () => {
    const r = parseParams(
      doc([
        { key: 'lower', type: 'bool', label: 'x' },
        { key: 'T', type: 'color', label: 'x' },
        { key: 'L', type: 'bool', label: '' },
        { key: 'M', type: 'bool', label: {} },
        { key: 'N', type: 'bool', label: { en: 'x' } },
        { key: 'O', type: 'enum', label: 'x', options: [] },
        { key: 'P', type: 'enum', label: 'x', options: [{ value: 'a b' }] },
        { key: 'Q', type: 'string', label: 'x', maxLength: 2000 },
        { key: 'R', type: 'int', label: 'x', default: 1.5 },
        { key: 'S', type: 'bool', label: 'x'.repeat(201) },
      ]),
    );
    expect(r.ok).toBe(false);
    const paths = new Set(r.issues.map((i) => i.path?.replace(/\..*$/, '')));
    expect(paths).toEqual(new Set(['params[0]', 'params[1]', 'params[2]', 'params[3]', 'params[4]', 'params[5]', 'params[6]', 'params[7]', 'params[8]', 'params[9]']));
    expect(r.issues[0]!.message).toContain('params[0].key: must match');
  });

  it('limits the number of parameters', () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ key: `K${i}`, type: 'bool', label: 'x' }));
    expect(parseParams(doc(many)).ok).toBe(false);
    expect(parseParams(doc(many.slice(1))).ok).toBe(true);
  });

  it('rejects duplicate parameter keys, option values and JSON object keys', () => {
    const r = parseParams(
      doc([
        { key: 'A', type: 'bool', label: 'x' },
        { key: 'A', type: 'int', label: 'x' },
        { key: 'E', type: 'enum', label: 'x', options: [{ value: 'v' }, { value: 'w' }, { value: 'v' }] },
      ]),
    );
    expect(errors(r)).toEqual(['params.json declares the key A more than once.', 'params.json params[2].options: duplicate option value "v".']);
    const dupObj = parseParams('{"schemaVersion":1,"params":[{"key":"A","type":"bool","label":"x","label":"y"}]}');
    expect(errors(dupObj)).toEqual(['params.json repeats the object key "label" within one object.']);
  });

  it('pattern is not part of the format: an unknown field, never compiled', () => {
    const r = parseParams(doc([{ key: 'S', type: 'string', label: 'x', pattern: '([a-z', default: 'ABC' }]));
    expect(r.ok).toBe(true);
    expect(r.issues).toMatchObject([{ code: 'script-params-invalid', severity: 'warning', path: 'params[0].pattern' }]);
    expect(r.value?.params[0]).not.toHaveProperty('pattern');
  });

  it('rejects defaults that violate their own constraints', () => {
    const r = parseParams(
      doc([
        { key: 'E', type: 'enum', label: 'x', options: [{ value: 'a' }], default: 'b' },
        { key: 'T', type: 'string', label: 'x', maxLength: 2, default: 'abc' },
        { key: 'U', type: 'string', label: 'x', default: 'a\nb' },
        { key: 'I', type: 'int', label: 'x', min: 0, max: 10, default: 11 },
        { key: 'J', type: 'int', label: 'x', min: 5, default: 4 },
        { key: 'K', type: 'int', label: 'x', max: -1 },
        { key: 'L', type: 'int', label: 'x', min: 5, max: 1 },
      ]),
    );
    expect(errors(r)).toEqual([
      'params.json params[0].default: "b" is not one of the option values ("a").',
      'params.json params[1].default: is 3 characters long; maxLength is 2.',
      'params.json params[2].default: must not contain NUL or newline characters.',
      'params.json params[3].default: 11 is greater than max 10.',
      'params.json params[4].default: 4 is less than min 5.',
      'params.json params[5].default: 0 (implicit; set "default") is greater than max -1.',
      'params.json params[6].min: min 5 is greater than max 1.',
    ]);
  });

  it('an empty string default is fine with required: true', () => {
    expect(parseParams(doc([{ key: 'S', type: 'string', label: 'x', required: true }])).issues).toEqual([]);
  });

  it('int values are 32-bit', () => {
    expect(parseParams(doc([{ key: 'I', type: 'int', label: 'x', max: 2147483647, default: -2147483648 }])).ok).toBe(true);
    expect(parseParams(doc([{ key: 'I', type: 'int', label: 'x', max: 2147483648 }])).ok).toBe(false);
  });
});

describe('params helpers', () => {
  it('duplicateJsonKeys only reports keys repeated within one object', () => {
    expect(duplicateJsonKeys('{"a":1,"b":{"a":2},"c":[{"a":1},{"a":2}],"d":"\\"a\\""}')).toEqual([]);
    expect(duplicateJsonKeys('{"a":1,"b":{"x":1,"x":2},"a":3}')).toEqual(['x', 'a']);
    expect(duplicateJsonKeys('{"k\\u0061":1,"ka":2}')).toEqual(['ka']);
  });
});
