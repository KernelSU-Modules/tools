import { describe, expect, it } from 'vitest';
import { crc32, inspectZip, normalizeEntryPath, rangeReaderFromBytes, zipLimitsFromPolicy, type RangeReader, type ZipLimits } from '../src/index.ts';
import { buildZip, enc, VALID_PROP, type FixtureEntry, type FixtureOptions } from './zipwriter.ts';

const LIMITS: ZipLimits = zipLimitsFromPolicy();
const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

async function inspect(entries: FixtureEntry[], opts?: FixtureOptions, limits: Partial<ZipLimits> = {}) {
  const zip = await buildZip(entries, opts);
  return inspectZip(rangeReaderFromBytes(zip), { ...LIMITS, ...limits });
}

const prop = (over: Partial<FixtureEntry> = {}): FixtureEntry => ({ name: 'module.prop', data: VALID_PROP, ...over });
const file = (name: string, data = 'x', over: Partial<FixtureEntry> = {}): FixtureEntry => ({ name, data, ...over });

function counting(r: RangeReader) {
  const reads: [number, number][] = [];
  return {
    reads,
    reader: { size: r.size, read: (o: number, l: number) => (reads.push([o, l]), r.read(o, l)) } satisfies RangeReader,
  };
}

describe('inspectZip: valid archives', () => {
  it('reads a deflated root module.prop', async () => {
    const r = await inspect([file('system/bin/tool', 'hello'), prop(), file('customize.sh', '#!/bin/sh\n')]);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.value?.moduleProp).toBe(VALID_PROP);
    expect(r.value?.entries).toBe(3);
    expect(r.value?.uncompressedTotal).toBe(5 + VALID_PROP.length + 10);
  });

  it('reads a stored module.prop', async () => {
    const r = await inspect([prop({ method: 0 }), file('a', 'b', { method: 0 })]);
    expect(r.ok).toBe(true);
    expect(r.value?.moduleProp).toBe(VALID_PROP);
  });

  it('accepts directories, non-UTF8-flag names and an archive comment containing an EOCD signature', async () => {
    const fakeEocd = String.fromCharCode(0x50, 0x4b, 0x05, 0x06);
    const r = await inspect([file('system/', ''), prop({ flags: 0 }), file('webroot/index.html', '<html>')], {
      comment: `hello ${fakeEocd} world`,
    });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('accepts ZIP64 archives', async () => {
    const r = await inspect([file('a.bin', 'abc'), prop()], { zip64: true });
    expect(r.issues).toEqual([]);
    expect(r.value?.moduleProp).toBe(VALID_PROP);
  });

  it('uses few reads (tail + module.prop local record)', async () => {
    const zip = await buildZip([prop(), ...Array.from({ length: 50 }, (_, i) => file(`f${i}`, 'data'.repeat(i)))]);
    const c = counting(rangeReaderFromBytes(zip));
    const r = await inspectZip(c.reader, LIMITS);
    expect(r.ok).toBe(true);
    expect(c.reads.length).toBeLessThanOrEqual(2);
  });
});

describe('inspectZip: size and bomb limits', () => {
  it('rejects archives over zipMaxBytes without reading', async () => {
    const zip = await buildZip([prop()]);
    const c = counting(rangeReaderFromBytes(zip));
    const r = await inspectZip(c.reader, { ...LIMITS, zipMaxBytes: 10 });
    expect(codes(r)).toEqual(['zip-too-large']);
    expect(c.reads).toEqual([]);
  });

  it('detects a real high-ratio entry', async () => {
    const r = await inspect([prop(), { name: 'zero.img', data: new Uint8Array(8 * 1024 * 1024) }]);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('zip-bomb-ratio');
  });

  it('detects declared uncompressed sizes over the limit', async () => {
    const r = await inspect([prop(), file('big', 'x'.repeat(1000), { cd: { uncompressedSize: 600 * 1024 * 1024 } })]);
    expect(codes(r)).toContain('zip-uncompressed-too-large');
    expect(codes(r)).toContain('zip-bomb-ratio');
    expect(r.ok).toBe(false);
  });

  it('rejects too many entries before parsing the CD', async () => {
    const r = await inspect([prop(), file('a'), file('b'), file('c')], {}, { maxEntries: 3 });
    expect(codes(r)).toEqual(['zip-too-many-entries']);
  });

  it('rejects overlapping entries (shared local data)', async () => {
    const r = await inspect([prop(), file('a', 'aaaa'), file('b', 'aaaa', { cd: { localOffset: 0 } })]);
    expect(codes(r)).toContain('zip-overlapping-entries');
  });
});

describe('inspectZip: entry names', () => {
  it.each([
    ['../evil.sh', 'zip-path-traversal'],
    ['system/../../etc/passwd', 'zip-path-traversal'],
    ['/system/bin/sh', 'zip-absolute-path'],
    ['C:/Windows/x', 'zip-absolute-path'],
    ['c:evil', 'zip-absolute-path'],
    ['system\\bin\\sh', 'zip-backslash-path'],
    ['..\\evil', 'zip-path-traversal'],
    ['bad\u0001name', 'zip-path-invalid'],
    ['', 'zip-path-invalid'],
  ])('%j -> %s', async (name, code) => {
    const r = await inspect([prop(), file(name)]);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain(code);
  });

  it('flags invalid UTF-8 names with the UTF-8 flag', async () => {
    const r = await inspect([prop(), file(new Uint8Array([0x61, 0xff, 0x62]) as unknown as string)]);
    expect(codes(r)).toContain('zip-path-invalid');
  });

  it('flags a conflicting Info-ZIP Unicode path extra field', async () => {
    const r = await inspect([prop(), file('innocent', 'x', { cd: { extra: unicodePath('innocent', '../evil') } })]);
    expect(codes(r)).toContain('zip-path-invalid');
    expect(codes(r)).toContain('zip-path-traversal');
  });

  it('flags a Unicode path extra field with a wrong CRC (the zip crate refuses the archive)', async () => {
    const r = await inspect([prop(), file('innocent', 'x', { cd: { extra: unicodePath('other', 'innocent') } })]);
    expect(codes(r)).toEqual(['zip-path-invalid']);
  });

  it('rejects duplicate entries', async () => {
    const r = await inspect([prop(), file('a'), file('a')]);
    expect(codes(r)).toEqual(['zip-duplicate-entry']);
  });

  it('caps repeated per-entry messages', async () => {
    const r = await inspect([prop(), ...Array.from({ length: 15 }, (_, i) => file(`../x${i}`))]);
    const t = r.issues.filter((i) => i.code === 'zip-path-traversal');
    expect(t.length).toBe(11);
    expect(t[10]!.message).toMatch(/and 5 more/);
  });

  it('rejects encrypted entries', async () => {
    const r = await inspect([prop(), file('secret', 'x', { flags: 0x0801 })]);
    expect(codes(r)).toContain('zip-encrypted');
  });

  // Audit B11: only what ksud's zip crate (features deflate, deflate64, lzma, xz) can extract.
  it.each([9, 14, 95])('accepts method %i (extractable by ksud) for other entries', async (method) => {
    const r = await inspect([prop(), file('x.bin', 'x', { method, payload: enc('zz') })]);
    expect(r.issues).toEqual([]);
  });

  it.each([1, 6, 12, 93, 98, 2000])('rejects method %i for every entry', async (method) => {
    const r = await inspect([prop(), file('x.bin', 'x', { method, payload: enc('zz') }), file('y.bin', 'y', { method, payload: enc('zz') })]);
    expect(r.ok).toBe(false);
    expect(r.issues).toMatchObject([
      { code: 'zip-unsupported-method', severity: 'error' },
      { code: 'zip-unsupported-method', severity: 'error' },
    ]);
  });
});

/** Info-ZIP Unicode Path extra field (0x7075) with the CRC of `crcOf`. */
function unicodePath(crcOf: string, uname: string): Uint8Array {
  const u = enc(uname);
  const extra = new Uint8Array(4 + 5 + u.length);
  const v = new DataView(extra.buffer);
  v.setUint16(0, 0x7075, true);
  v.setUint16(2, 5 + u.length, true);
  extra[4] = 1;
  v.setUint32(5, crc32(enc(crcOf)), true);
  extra.set(u, 9);
  return extra;
}

// Audit B2: names are compared the way ksud's zip crate (8.6.0) extracts them.
describe('inspectZip: extraction-path normalization', () => {
  it.each([
    ['./a', { path: 'a', isDir: false }],
    ['a//b', { path: 'a/b', isDir: false }],
    ['a/./b/', { path: 'a/b', isDir: true }],
    ['./', { path: '', isDir: true }],
    ['.', { path: '', isDir: false }],
  ])('normalizeEntryPath(%j)', (name, want) => {
    expect(normalizeEntryPath(name)).toEqual(want);
  });

  it('./module.prop next to module.prop is a duplicate module.prop', async () => {
    const r = await inspect([prop(), prop({ name: './module.prop', data: VALID_PROP.replace('demo.toolbox', 'evil') })]);
    expect(codes(r)).toEqual(['prop-duplicate']);
  });

  it.each(['./module.prop', './/module.prop', './/./module.prop'])('finds the root module.prop under %j', async (name) => {
    const r = await inspect([prop({ name }), file('a')]);
    expect(r.issues).toEqual([]);
    expect(r.value?.moduleProp).toBe(VALID_PROP);
  });

  it.each([
    ['a/b', 'a/./b'],
    ['a/b', 'a//b'],
    ['a/b', './a/b'],
    ['dir/', 'dir'],
  ])('%j and %j extract to the same path', async (a, b) => {
    const r = await inspect([prop(), file(a), file(b)]);
    expect(codes(r)).toEqual(['zip-duplicate-entry']);
  });

  it('module.prop/ directory alongside module.prop is a duplicate', async () => {
    const r = await inspect([prop(), file('module.prop/', '')]);
    expect(codes(r)).toEqual(['prop-duplicate']);
  });

  it('a module.prop directory is not a module.prop', async () => {
    const r = await inspect([file('module.prop/', ''), file('module.prop/x')]);
    expect(codes(r)).toEqual(['prop-missing']);
  });

  it('a file entry that resolves to the extraction root is invalid; "./" directories are fine', async () => {
    expect(codes(await inspect([prop(), file('./', '')]))).toEqual([]);
    expect(codes(await inspect([prop(), file('a/.')]))).toEqual([]);
    expect(codes(await inspect([prop(), file('.')]))).toEqual(['zip-path-invalid']);
  });

  it('names without the UTF-8 flag are CP437 (zip crate) when looking for duplicates', async () => {
    const r = await inspect([prop(), file(new Uint8Array([0x82]) as unknown as string, 'x', { flags: 0 }), file('\u00e9', 'y', { flags: 0x0800 })]);
    expect(codes(r)).toEqual(['zip-duplicate-entry']);
  });

  it('uses the Unicode path field as the extracted name', async () => {
    const extra = unicodePath('caf\u00e9', 'caf\u00e9');
    const ok = await inspect([prop(), file('caf\u00e9', 'x', { flags: 0, cd: { extra } })]);
    expect(ok.issues).toEqual([]);
  });
});

describe('inspectZip: module.prop location and content', () => {
  it('missing module.prop', async () => {
    const r = await inspect([file('a'), file('Module.prop')]);
    expect(codes(r)).toEqual(['prop-missing']);
  });

  it('nested-only module.prop', async () => {
    const r = await inspect([file('my-module/'), { name: 'my-module/module.prop', data: VALID_PROP }]);
    expect(codes(r)).toEqual(['prop-not-at-root']);
  });

  it('duplicate root module.prop', async () => {
    const r = await inspect([prop(), prop({ data: VALID_PROP.replace('123', '999') })]);
    expect(codes(r)).toEqual(['prop-duplicate']);
  });

  it('module.prop too large', async () => {
    const r = await inspect([prop()], {}, { modulePropMaxBytes: 16 });
    expect(codes(r)).toEqual(['prop-too-large']);
  });

  it('unsupported method for module.prop is an error', async () => {
    const r = await inspect([prop({ method: 14, payload: enc('lzma') })]);
    expect(codes(r)).toEqual(['zip-unsupported-method']);
    expect(r.ok).toBe(false);
  });

  it('inflated size larger than declared is caught (stream-limited)', async () => {
    const r = await inspect([prop({ cd: { uncompressedSize: 10 }, local: { uncompressedSize: 10 } })]);
    expect(codes(r)).toEqual(['zip-entry-corrupt']);
  });

  it('inflated size smaller than declared is caught', async () => {
    const r = await inspect([prop({ cd: { uncompressedSize: VALID_PROP.length + 5 }, local: { uncompressedSize: VALID_PROP.length + 5 } })]);
    expect(codes(r)).toEqual(['zip-entry-corrupt']);
  });

  it('CRC mismatch', async () => {
    const r = await inspect([prop({ cd: { crc: 1 }, local: { crc: 1 } })]);
    expect(codes(r)).toEqual(['zip-entry-corrupt']);
  });

  it('local header name differs from CD', async () => {
    const r = await inspect([prop({ local: { name: 'module.pro_' } })]);
    expect(codes(r)).toEqual(['zip-entry-corrupt']);
  });

  it('local header sizes differ from CD', async () => {
    const r = await inspect([prop({ method: 0, local: { uncompressedSize: 5 } })]);
    expect(codes(r)).toEqual(['zip-entry-corrupt']);
  });

  it('corrupt deflate data', async () => {
    const junk = new Uint8Array(40).fill(0xff);
    const r = await inspect([prop({ payload: junk })]);
    expect(codes(r)).toEqual(['zip-entry-corrupt']);
  });

  it('non UTF-8 module.prop', async () => {
    const r = await inspect([prop({ data: new Uint8Array([0x69, 0x64, 0x3d, 0xc3, 0x28]) })]);
    expect(codes(r)).toEqual(['prop-encoding']);
  });
});

describe('inspectZip: entry list and params.json', () => {
  it('lists extracted paths (directories end with "/") and has no paramsJson without params.json', async () => {
    const r = await inspect([file('./system/', ''), file('system/bin/tool', 'x'), prop(), file('a//action.sh', '#!/bin/sh')]);
    expect(r.ok).toBe(true);
    expect(r.value?.files).toEqual(['system/', 'system/bin/tool', 'module.prop', 'a/action.sh']);
    expect(r.value?.paramsJson).toBeUndefined();
  });

  it.each([0, 8])('reads a root params.json (method %i)', async (method) => {
    const json = '{"schemaVersion":1,"params":[]}';
    const r = await inspect([prop(), file('params.json', json, { method }), file('sub/params.json', '{')]);
    expect(r.issues).toEqual([]);
    expect(r.value?.paramsJson).toEqual({ text: json });
  });

  it('reports unreadable params.json without failing the ZIP', async () => {
    const big = await inspect([prop(), file('params.json', ' '.repeat(64 * 1024 + 1))]);
    expect(big.ok).toBe(true);
    expect(big.value?.paramsJson).toEqual({ error: expect.stringContaining('the limit is 65536') });
    const crc = await inspect([prop(), file('params.json', '{}', { cd: { crc: 1 }, local: { crc: 1 } })]);
    expect(crc.ok).toBe(true);
    expect(crc.value?.paramsJson).toEqual({ error: 'params.json CRC-32 mismatch.' });
    const latin1 = await inspect([prop(), { name: 'params.json', data: new Uint8Array([0x7b, 0xe9, 0x7d]) }]);
    expect(latin1.value?.paramsJson).toEqual({ error: 'params.json is not valid UTF-8.' });
    const method = await inspect([prop(), file('params.json', '{}', { method: 14, payload: enc('lzma') })]);
    expect(codes(method)).toEqual([]);
    expect(method.value?.paramsJson).toEqual({ error: expect.stringContaining('compression method 14') });
    const dir = await inspect([prop(), file('params.json/', '')]);
    expect(dir.value?.paramsJson).toEqual({ error: 'params.json is a directory, not a file.' });
  });
});

describe('inspectZip: structural corruption', () => {
  it('not a zip', async () => {
    const r = await inspectZip(rangeReaderFromBytes(enc('this is definitely not a zip archive at all')), LIMITS);
    expect(codes(r)).toEqual(['zip-not-zip']);
  });

  it('tiny file', async () => {
    const r = await inspectZip(rangeReaderFromBytes(new Uint8Array(3)), LIMITS);
    expect(codes(r)).toEqual(['zip-not-zip']);
  });

  it('data appended after EOCD', async () => {
    const r = await inspect([prop()], { suffix: enc('trailing junk') });
    expect(codes(r)).toEqual(['zip-not-zip']);
  });

  it('truncated archive (head cut off)', async () => {
    const zip = await buildZip([prop(), file('a', 'hello')]);
    const r = await inspectZip(rangeReaderFromBytes(zip.subarray(10)), LIMITS);
    expect(codes(r)).toEqual(['zip-corrupt']);
  });

  it('CD offset beyond file', async () => {
    const r = await inspect([prop()], { eocd: { cdOffset: 0x7fffffff } });
    expect(codes(r)).toEqual(['zip-corrupt']);
  });

  it('CD size lies', async () => {
    const zip = await buildZip([prop(), file('a')]);
    const v = new DataView(zip.buffer, zip.byteOffset);
    const eocd = zip.length - 22;
    v.setUint32(eocd + 12, v.getUint32(eocd + 12, true) - 4, true);
    v.setUint32(eocd + 16, v.getUint32(eocd + 16, true) + 4, true);
    const r = await inspectZip(rangeReaderFromBytes(zip), LIMITS);
    expect(codes(r)).toEqual(['zip-corrupt']);
  });

  it('declared entry count larger than CD', async () => {
    const r = await inspect([prop(), file('a')], { eocd: { entries: 3 } });
    expect(codes(r)).toEqual(['zip-corrupt']);
  });

  it('declared entry count smaller than CD (trailing CD bytes)', async () => {
    const r = await inspect([prop(), file('a')], { eocd: { entries: 1 } });
    expect(codes(r)).toEqual(['zip-corrupt']);
  });

  it('bad CD signature', async () => {
    const r = await inspect([prop()], { cdTrailing: new Uint8Array(46), eocd: { entries: 2 } });
    expect(codes(r)).toEqual(['zip-corrupt']);
  });

  it('entry local offset beyond CD', async () => {
    const r = await inspect([prop({ cd: { localOffset: 100000 } })]);
    expect(codes(r)).toEqual(['zip-corrupt']);
  });

  it('multi-disk', async () => {
    const r = await inspect([prop()], { eocd: { disk: 1 } });
    expect(codes(r)).toEqual(['zip-multi-disk']);
  });

  it('ZIP64 EOCD contradicting the classic EOCD', async () => {
    const r = await inspect([prop()], { zip64: true, eocd: { entries: 7 } });
    expect(codes(r)).toEqual(['zip64-invalid']);
  });

  it('ZIP64 EOCD lying about the CD offset', async () => {
    const r = await inspect([prop(), file('a')], { zip64: true, zip64Eocd: { cdOffset: 3 } });
    expect(codes(r)).toEqual(['zip-corrupt']);
  });

  it('ZIP64 entry lacking the extra field', async () => {
    const r = await inspect([prop({ cd: { extra: new Uint8Array(0) } })], { zip64: true });
    expect(codes(r)).toEqual(['zip64-invalid']);
  });

  it('ZIP64 values beyond 2^53', async () => {
    const zip = await buildZip([prop()], { zip64: true });
    // zip64 EOCD record starts at locator's pointed offset; corrupt its CD size high bits.
    const v = new DataView(zip.buffer, zip.byteOffset);
    const loc = zip.length - 22 - 20;
    const rec = Number(v.getBigUint64(loc + 8, true));
    v.setUint32(rec + 40 + 4, 0xffffffff, true);
    const r = await inspectZip(rangeReaderFromBytes(zip), LIMITS);
    expect(codes(r)).toEqual(['zip64-invalid']);
  });

  it('central directory over the CD byte cap', async () => {
    const r = await inspect([prop(), file('a'.repeat(200))], {}, { centralDirectoryMaxBytes: 100 });
    expect(codes(r)).toEqual(['zip-corrupt']);
  });
});
