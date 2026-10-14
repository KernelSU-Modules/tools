import { issue, result, type Issue, type IssueCode, type Result, type Severity } from './issues.ts';
import { PARAMS_MAX_BYTES } from '@kernelsu-modules/schema';
import type { RangeReader } from './range.ts';

export interface ZipLimits {
  zipMaxBytes: number;
  uncompressedMaxBytes: number;
  maxCompressionRatio: number;
  maxEntries: number;
  modulePropMaxBytes: number;
  /** Optional cap on the central directory size (default 16 MiB). */
  centralDirectoryMaxBytes?: number;
}

export interface ZipInspection {
  entries: number;
  uncompressedTotal: number;
  moduleProp: string;
  /**
   * Every extracted path (normalized like ksud extracts it, see normalizeEntryPath); directories end with "/".
   * Parent directories that have no entry of their own are not listed.
   */
  files: string[];
  /**
   * The root params.json (one-shot script parameters) when present: its UTF-8 text, or why it could not be read
   * (size above PARAMS_MAX_BYTES, encrypted, unsupported compression, corrupt, not UTF-8, a directory). Not an
   * issue here: whether it matters depends on the entry kind (see checkReleaseKind).
   */
  paramsJson?: { text: string } | { error: string };
}

/** Ratio checks only apply above this many uncompressed bytes (small text files compress extremely well). */
export const RATIO_MIN_BYTES = 1024 * 1024;
export const DEFAULT_CD_MAX_BYTES = 16 * 1024 * 1024;
const EOCD_SIZE = 22;
const EOCD_MAX_SCAN = EOCD_SIZE + 0xffff;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_MIN = 56;
const CD_HEADER = 46;
const LOCAL_HEADER = 30;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const MODULE_PROP = 'module.prop';
const PARAMS_JSON = 'params.json';
/**
 * Compression methods ksud's zip crate can extract: zip 8 with features deflate, deflate64, lzma, xz
 * (KernelSU userspace/ksud/Cargo.toml) — stored, deflate, deflate64, LZMA, XZ. Anything else makes
 * `ZipArchive::extract` fail during installation.
 */
export const EXTRACTABLE_METHODS: ReadonlySet<number> = new Set([0, 8, 9, 14, 95]);
/** Per-code cap of individual messages for per-entry problems. */
const MAX_PER_CODE = 10;

class Fatal extends Error {}
/** A stored entry's data could not be read back (reported as zip-entry-corrupt for module.prop). */
class EntryError extends Error {}

class Issues {
  readonly list: Issue[] = [];
  private counts = new Map<string, number>();
  add(code: IssueCode, message: string, severity: Severity = 'error', path?: string): void {
    const n = (this.counts.get(code) ?? 0) + 1;
    this.counts.set(code, n);
    if (n <= MAX_PER_CODE) this.list.push(issue(code, message, severity, path));
  }
  fatal(code: IssueCode, message: string): never {
    this.add(code, message);
    throw new Fatal(message);
  }
  finish(): Issue[] {
    for (const [code, n] of this.counts) {
      if (n > MAX_PER_CODE) {
        const sev = this.list.find((i) => i.code === code)?.severity ?? 'error';
        this.list.push(issue(code as IssueCode, `...and ${n - MAX_PER_CODE} more "${code}" problems.`, sev));
      }
    }
    return this.list;
  }
}

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function u64(v: DataView, off: number, what: string, iss: Issues): number {
  const n = v.getBigUint64(off, true);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) iss.fatal('zip64-invalid', `ZIP64 ${what} value ${n} is out of range.`);
  return Number(n);
}

interface CdEntry {
  index: number;
  nameBytes: Uint8Array;
  name: string;
  /** Path as ksud's zip crate extracts it ("" = the extraction root), see normalizeEntryPath. */
  path: string;
  isDir: boolean;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

let CRC_TABLE: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
const utf8Lossy = new TextDecoder('utf-8');

/** CP437 high half, exactly as the zip crate's `from_cp437` (zip 8.6.0 src/cp437.rs). */
const CP437_HIGH =
  '\u00c7\u00fc\u00e9\u00e2\u00e4\u00e0\u00e5\u00e7\u00ea\u00eb\u00e8\u00ef\u00ee\u00ec\u00c4\u00c5\u00c9\u00e6\u00c6\u00f4\u00f6\u00f2\u00fb\u00f9' +
  '\u00ff\u00d6\u00dc\u00a2\u00a3\u00a5\u20a7\u0192\u00e1\u00ed\u00f3\u00fa\u00f1\u00d1\u00aa\u00ba\u00bf\u2310\u00ac\u00bd\u00bc\u00a1\u00ab\u00bb' +
  '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556\u2555\u2563\u2551\u2557\u255d\u255c\u255b\u2510\u2514\u2534\u252c\u251c\u2500\u253c\u255e\u255f' +
  '\u255a\u2554\u2569\u2566\u2560\u2550\u256c\u2567\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256b\u256a\u2518\u250c\u2588\u2584\u258c\u2590\u2580' +
  '\u03b1\u00df\u0393\u03c0\u03a3\u03c3\u00b5\u03c4\u03a6\u0398\u03a9\u03b4\u221e\u03c6\u03b5\u2229\u2261\u00b1\u2265\u2264\u2320\u2321\u00f7\u2248' +
  '\u00b0\u2219\u00b7\u221a\u207f\u00b2\u25a0\u00a0';

/** Entry names without the UTF-8 flag are CP437 for the zip crate ksud uses. */
export function cp437(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]! < 0x80 ? String.fromCharCode(b[i]!) : CP437_HIGH[b[i]! - 0x80]!;
  return s;
}

/**
 * The path an entry is extracted to by ksud (`ZipArchive::extract`, zip 8.6.0 simplified_components):
 * "/"-separated, "" and "." segments dropped (so "./a", "a//b", "a/./b" all mean "a/b"); a trailing "/"
 * marks a directory. Names with "..", "\\", absolute paths or NULs are rejected separately (checkName),
 * so for every accepted name this also equals the crate's `mangled_name()` used to read module.prop.
 */
export function normalizeEntryPath(name: string): { path: string; isDir: boolean } {
  const isDir = name.endsWith('/') || name.endsWith('\\');
  const path = name
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
  return { path, isDir };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Path safety checks for one entry name; reports into `iss`. */
function checkName(name: string, iss: Issues, label = name): void {
  const shown = JSON.stringify(label.length > 200 ? `${label.slice(0, 200)}…` : label);
  if (name.length === 0) {
    iss.add('zip-path-invalid', 'A ZIP entry has an empty name.');
    return;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) iss.add('zip-path-invalid', `ZIP entry ${shown} contains control characters.`, 'error', label);
  if (name.includes('\\')) iss.add('zip-backslash-path', `ZIP entry ${shown} contains a backslash.`, 'error', label);
  const n = name.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[A-Za-z]:/.test(n)) iss.add('zip-absolute-path', `ZIP entry ${shown} is an absolute path.`, 'error', label);
  if (n.split('/').some((s) => s === '..')) iss.add('zip-path-traversal', `ZIP entry ${shown} contains "..".`, 'error', label);
}

/**
 * Look for the Info-ZIP Unicode Path extra field (0x7075). The zip crate replaces the entry name with it
 * after checking its CRC-32 against the raw name (mismatch / bad UTF-8 = the archive fails to open).
 * Returns the UTF-8 name, null when invalid, undefined when absent.
 */
function unicodePathExtra(extra: Uint8Array, rawName: Uint8Array): string | null | undefined {
  const v = dv(extra);
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = v.getUint16(p, true);
    const len = v.getUint16(p + 2, true);
    if (p + 4 + len > extra.length) return undefined;
    if (id === 0x7075) {
      if (len < 5 || v.getUint32(p + 5, true) !== crc32(rawName)) return null;
      try {
        return utf8Fatal.decode(extra.subarray(p + 9, p + 4 + len));
      } catch {
        return null;
      }
    }
    p += 4 + len;
  }
  return undefined;
}

/** Find the ZIP64 extended information extra field (0x0001). */
function zip64Extra(extra: Uint8Array): DataView | null {
  const v = dv(extra);
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = v.getUint16(p, true);
    const len = v.getUint16(p + 2, true);
    if (p + 4 + len > extra.length) return null;
    if (id === 0x0001) return new DataView(extra.buffer, extra.byteOffset + p + 4, len);
    p += 4 + len;
  }
  return null;
}

async function inflateLimited(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const writing = writer
    .write(data as Uint8Array<ArrayBuffer>)
    .then(() => writer.close())
    .catch(() => {});
  const out = new Uint8Array(limit + 1);
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > limit) {
        await reader.cancel().catch(() => {});
        throw new RangeError(`inflated data exceeds ${limit} bytes`);
      }
      out.set(value, total);
      total += value.length;
    }
  } finally {
    await writing;
  }
  return out.subarray(0, total);
}

/**
 * Inspect a ZIP through its central directory and read the root module.prop.
 * Never extracts anything else. Reads: one tail window (EOCD [+ZIP64] [+CD]), the CD if it
 * is outside that window, and the module.prop local header + data.
 */
export async function inspectZip(reader: RangeReader, limits: ZipLimits): Promise<Result<ZipInspection>> {
  const iss = new Issues();
  try {
    const value = await inspect(reader, limits, iss);
    return result(iss.finish(), value);
  } catch (e) {
    if (e instanceof Fatal) return result(iss.finish());
    if (e instanceof RangeError) {
      // Reader bounds error: some declared offset/size pointed outside the file.
      iss.add('zip-corrupt', `ZIP structure points outside the file: ${e.message}`);
      return result(iss.finish());
    }
    throw e;
  }
}

async function inspect(reader: RangeReader, limits: ZipLimits, iss: Issues): Promise<ZipInspection | undefined> {
  const size = reader.size;
  if (size > limits.zipMaxBytes) iss.fatal('zip-too-large', `ZIP is ${size} bytes; the limit is ${limits.zipMaxBytes} bytes.`);
  if (size < EOCD_SIZE) iss.fatal('zip-not-zip', `File is too small to be a ZIP (${size} bytes).`);

  /* ---------- EOCD ---------- */
  const tailLen = Math.min(size, EOCD_MAX_SCAN);
  const tailStart = size - tailLen;
  const tail = await reader.read(tailStart, tailLen);
  const tv = dv(tail);
  let eocd = -1;
  for (let p = tailLen - EOCD_SIZE; p >= 0; p--) {
    if (tv.getUint32(p, true) === SIG_EOCD && p + EOCD_SIZE + tv.getUint16(p + 20, true) === tailLen) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) iss.fatal('zip-not-zip', 'No end-of-central-directory record found (not a ZIP, or data appended after it).');
  const eocdAbs = tailStart + eocd;
  const diskNo = tv.getUint16(eocd + 4, true);
  const cdDisk = tv.getUint16(eocd + 6, true);
  const entriesDisk = tv.getUint16(eocd + 8, true);
  let totalEntries = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);
  let cdEnd = eocdAbs;

  /* ---------- ZIP64 ---------- */
  const locPos = eocd - ZIP64_LOCATOR_SIZE;
  const hasLocator = locPos >= 0 && tv.getUint32(locPos, true) === SIG_ZIP64_LOCATOR;
  if (hasLocator) {
    const locAbs = tailStart + locPos;
    const z64Disk = tv.getUint32(locPos + 4, true);
    const z64Off = u64(tv, locPos + 8, 'EOCD offset', iss);
    const disks = tv.getUint32(locPos + 16, true);
    if (z64Disk !== 0 || disks > 1) iss.fatal('zip-multi-disk', 'Split / multi-disk ZIP archives are not supported.');
    if (z64Off + ZIP64_EOCD_MIN > locAbs) iss.fatal('zip64-invalid', 'ZIP64 end-of-central-directory offset is out of range.');
    const rec = z64Off >= tailStart ? tail.subarray(z64Off - tailStart, locAbs - tailStart) : await reader.read(z64Off, locAbs - z64Off);
    const rv = dv(rec);
    if (rv.getUint32(0, true) !== SIG_ZIP64_EOCD) iss.fatal('zip64-invalid', 'ZIP64 end-of-central-directory record signature mismatch.');
    const recSize = u64(rv, 4, 'record size', iss);
    if (12 + recSize !== rec.length) iss.fatal('zip64-invalid', 'ZIP64 end-of-central-directory record size does not match its position.');
    const d = rv.getUint32(16, true);
    const cdD = rv.getUint32(20, true);
    const eD = u64(rv, 24, 'entry count', iss);
    const eT = u64(rv, 32, 'entry count', iss);
    const s = u64(rv, 40, 'CD size', iss);
    const o = u64(rv, 48, 'CD offset', iss);
    if (d !== 0 || cdD !== 0 || eD !== eT) iss.fatal('zip-multi-disk', 'Split / multi-disk ZIP archives are not supported.');
    // Values in the classic EOCD must be the sentinel or agree with ZIP64.
    if (
      (totalEntries !== U16_MAX && totalEntries !== eT) ||
      (entriesDisk !== U16_MAX && entriesDisk !== eD) ||
      (cdSize !== U32_MAX && cdSize !== s) ||
      (cdOffset !== U32_MAX && cdOffset !== o)
    )
      iss.fatal('zip64-invalid', 'ZIP64 end-of-central-directory values contradict the classic EOCD record.');
    totalEntries = eT;
    cdSize = s;
    cdOffset = o;
    cdEnd = z64Off;
  } else if (diskNo !== 0 || cdDisk !== 0 || entriesDisk !== totalEntries) {
    iss.fatal('zip-multi-disk', 'Split / multi-disk ZIP archives are not supported.');
  }

  if (totalEntries > limits.maxEntries)
    iss.fatal('zip-too-many-entries', `ZIP declares ${totalEntries} entries; the limit is ${limits.maxEntries}.`);
  if (cdOffset + cdSize !== cdEnd)
    iss.fatal('zip-corrupt', `Central directory (offset ${cdOffset}, size ${cdSize}) does not end where the end record begins (${cdEnd}).`);
  if (cdSize < totalEntries * CD_HEADER) iss.fatal('zip-corrupt', 'Central directory is too small for the declared entry count.');
  const cdMax = limits.centralDirectoryMaxBytes ?? DEFAULT_CD_MAX_BYTES;
  if (cdSize > cdMax) iss.fatal('zip-corrupt', `Central directory is ${cdSize} bytes; the limit is ${cdMax}.`);

  /* ---------- Central directory ---------- */
  const cd = cdOffset >= tailStart ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize) : await reader.read(cdOffset, cdSize);
  const cv = dv(cd);
  const entries: CdEntry[] = [];
  const seen = new Set<string>();
  let uncompressedTotal = 0;
  let compressedTotal = 0;
  let p = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (p + CD_HEADER > cd.length || cv.getUint32(p, true) !== SIG_CD)
      iss.fatal('zip-corrupt', `Central directory entry #${i} is truncated or has a bad signature.`);
    const flags = cv.getUint16(p + 8, true);
    const method = cv.getUint16(p + 10, true);
    const crc = cv.getUint32(p + 16, true);
    let compressedSize = cv.getUint32(p + 20, true);
    let uncompressedSize = cv.getUint32(p + 24, true);
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    let diskStart = cv.getUint16(p + 34, true);
    let localOffset = cv.getUint32(p + 42, true);
    const recEnd = p + CD_HEADER + nameLen + extraLen + commentLen;
    if (recEnd > cd.length) iss.fatal('zip-corrupt', `Central directory entry #${i} overruns the central directory.`);
    const nameBytes = cd.subarray(p + CD_HEADER, p + CD_HEADER + nameLen);
    const extra = cd.subarray(p + CD_HEADER + nameLen, p + CD_HEADER + nameLen + extraLen);
    p = recEnd;

    const isUtf8 = (flags & 0x0800) !== 0;
    let name: string;
    if (isUtf8) {
      try {
        name = utf8Fatal.decode(nameBytes);
      } catch {
        name = utf8Lossy.decode(nameBytes);
        iss.add('zip-path-invalid', `ZIP entry #${i} name is flagged UTF-8 but is not valid UTF-8.`, 'error', name);
      }
    } else {
      name = cp437(nameBytes);
    }

    if (uncompressedSize === U32_MAX || compressedSize === U32_MAX || localOffset === U32_MAX || diskStart === U16_MAX) {
      const z = zip64Extra(extra);
      let q = 0;
      const need = (what: string): number => {
        if (!z || q + 8 > z.byteLength) iss.fatal('zip64-invalid', `ZIP entry ${JSON.stringify(name)} lacks the ZIP64 ${what} field.`);
        const n = z.getBigUint64(q, true);
        q += 8;
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) iss.fatal('zip64-invalid', `ZIP entry ${JSON.stringify(name)} ZIP64 ${what} is out of range.`);
        return Number(n);
      };
      if (uncompressedSize === U32_MAX) uncompressedSize = need('uncompressed size');
      if (compressedSize === U32_MAX) compressedSize = need('compressed size');
      if (localOffset === U32_MAX) localOffset = need('local header offset');
      if (diskStart === U16_MAX) {
        if (!z || q + 4 > z.byteLength) iss.fatal('zip64-invalid', `ZIP entry ${JSON.stringify(name)} lacks the ZIP64 disk field.`);
        diskStart = z.getUint32(q, true);
      }
    }
    if (diskStart !== 0) iss.fatal('zip-multi-disk', 'Split / multi-disk ZIP archives are not supported.');

    if (localOffset + LOCAL_HEADER + nameLen + compressedSize > cdOffset)
      iss.fatal('zip-corrupt', `ZIP entry ${JSON.stringify(name)} data lies outside the archive body (offset ${localOffset}, compressed ${compressedSize}).`);

    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || method === 99)
      iss.add('zip-encrypted', `ZIP entry ${JSON.stringify(name)} is encrypted.`, 'error', name);
    checkName(name, iss);
    const uni = unicodePathExtra(extra, nameBytes);
    if (uni === null) iss.add('zip-path-invalid', `ZIP entry ${JSON.stringify(name)} has an invalid Unicode path field.`, 'error', name);
    else if (uni !== undefined && uni !== name && uni !== utf8Lossy.decode(nameBytes)) {
      checkName(uni, iss);
      iss.add('zip-path-invalid', `ZIP entry ${JSON.stringify(name)} has a conflicting Unicode path field ${JSON.stringify(uni)}.`, 'error', name);
    }
    // The zip crate extracts under the Unicode path name when present.
    if (typeof uni === 'string') name = uni;

    const { path, isDir } = normalizeEntryPath(name);
    if (path === '' && !isDir && name.length > 0) iss.add('zip-path-invalid', `ZIP file entry ${JSON.stringify(name)} has no file name.`, 'error', name);
    if (path !== '') {
      if (seen.has(path)) {
        if (path !== MODULE_PROP)
          iss.add(
            'zip-duplicate-entry',
            `ZIP entry ${JSON.stringify(name)} is extracted to ${JSON.stringify(path)}, which another entry also uses.`,
            'error',
            name,
          );
      } else seen.add(path);
    }

    if (!EXTRACTABLE_METHODS.has(method) && method !== 99)
      iss.add(
        'zip-unsupported-method',
        `ZIP entry ${JSON.stringify(name)} uses compression method ${method}, which KernelSU cannot extract (supported: ${[...EXTRACTABLE_METHODS].join(', ')}).`,
        'error',
        name,
      );
    if (method === 0 && compressedSize !== uncompressedSize && (flags & 1) === 0)
      iss.add('zip-corrupt', `Stored ZIP entry ${JSON.stringify(name)} has different compressed and uncompressed sizes.`, 'error', name);

    if (uncompressedSize > RATIO_MIN_BYTES && uncompressedSize / Math.max(compressedSize, 1) > limits.maxCompressionRatio)
      iss.add(
        'zip-bomb-ratio',
        `ZIP entry ${JSON.stringify(name)} expands ${uncompressedSize} bytes from ${compressedSize} (ratio > ${limits.maxCompressionRatio}).`,
        'error',
        name,
      );

    uncompressedTotal += uncompressedSize;
    compressedTotal += compressedSize;
    entries.push({ index: i, nameBytes, name, path, isDir, flags, method, crc, compressedSize, uncompressedSize, localOffset });
  }
  if (p !== cd.length) iss.fatal('zip-corrupt', `Central directory has ${cd.length - p} unexpected trailing bytes.`);

  if (uncompressedTotal > limits.uncompressedMaxBytes)
    iss.add('zip-uncompressed-too-large', `ZIP expands to ${uncompressedTotal} bytes; the limit is ${limits.uncompressedMaxBytes}.`);
  if (uncompressedTotal > RATIO_MIN_BYTES && uncompressedTotal / size > limits.maxCompressionRatio)
    iss.add('zip-bomb-ratio', `ZIP expands ${uncompressedTotal} bytes from a ${size}-byte archive (ratio > ${limits.maxCompressionRatio}).`);
  if (compressedTotal > cdOffset) iss.add('zip-overlapping-entries', 'Sum of compressed entry sizes exceeds the archive body.');

  // Overlap: local records must be disjoint (lower bound: header + name + data; extras/descriptors only add).
  const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  for (let k = 1; k < byOffset.length; k++) {
    const a = byOffset[k - 1]!;
    const b = byOffset[k]!;
    if (a.localOffset + LOCAL_HEADER + a.nameBytes.length + a.compressedSize > b.localOffset) {
      iss.add('zip-overlapping-entries', `ZIP entries ${JSON.stringify(a.name)} and ${JSON.stringify(b.name)} overlap.`);
    }
  }

  /* ---------- module.prop ---------- */
  const roots = entries.filter((e) => e.path === MODULE_PROP);
  if (roots.length > 1) iss.fatal('prop-duplicate', `The ZIP contains ${roots.length} entries that extract to the root module.prop.`);
  if (roots.length === 1 && roots[0]!.isDir) iss.fatal('prop-missing', 'The ZIP root module.prop is a directory, not a file.');
  if (roots.length === 0) {
    const nested = entries.find((e) => !e.isDir && e.path.endsWith('/' + MODULE_PROP));
    if (nested)
      iss.fatal('prop-not-at-root', `module.prop is not at the ZIP root (found ${JSON.stringify(nested.name)}); zip the module contents, not its folder.`);
    iss.fatal('prop-missing', 'The ZIP has no module.prop at its root.');
  }
  const e = roots[0]!;
  if ((e.flags & 0x0001) !== 0 || (e.flags & 0x0040) !== 0 || e.method === 99) throw new Fatal('encrypted module.prop');
  if (e.method !== 0 && e.method !== 8) {
    // Already reported as an error above when KernelSU cannot extract it either.
    if (EXTRACTABLE_METHODS.has(e.method))
      iss.add('zip-unsupported-method', `module.prop uses compression method ${e.method}; KernelSU Modules can only read a stored (0) or deflated (8) module.prop.`);
    throw new Fatal('module.prop method');
  }
  if (e.uncompressedSize > limits.modulePropMaxBytes)
    iss.fatal('prop-too-large', `module.prop is ${e.uncompressedSize} bytes; the limit is ${limits.modulePropMaxBytes}.`);
  if (e.method === 0 && e.compressedSize !== e.uncompressedSize) throw new Fatal('stored size mismatch');
  let data: Uint8Array;
  try {
    data = await readEntry(reader, e, cdOffset, MODULE_PROP);
  } catch (err) {
    if (err instanceof EntryError) iss.fatal('zip-entry-corrupt', err.message);
    throw err;
  }

  let moduleProp: string;
  try {
    moduleProp = utf8Fatal.decode(data);
  } catch {
    iss.fatal('prop-encoding', 'module.prop is not valid UTF-8.');
  }
  const files = entries.filter((x) => x.path !== '').map((x) => (x.isDir ? `${x.path}/` : x.path));
  const value: ZipInspection = { entries: entries.length, uncompressedTotal, moduleProp, files };
  const params = entries.find((x) => x.path === PARAMS_JSON);
  if (params) value.paramsJson = await readParamsJson(reader, params, cdOffset);
  return value;
}

/** Read the root params.json without reporting issues (see ZipInspection.paramsJson). */
async function readParamsJson(reader: RangeReader, e: CdEntry, cdOffset: number): Promise<{ text: string } | { error: string }> {
  if (e.isDir) return { error: `${PARAMS_JSON} is a directory, not a file.` };
  if ((e.flags & 0x0001) !== 0 || (e.flags & 0x0040) !== 0 || e.method === 99) return { error: `${PARAMS_JSON} is encrypted.` };
  if (e.method !== 0 && e.method !== 8)
    return { error: `${PARAMS_JSON} uses compression method ${e.method}; it must be stored (0) or deflated (8).` };
  if (e.uncompressedSize > PARAMS_MAX_BYTES) return { error: `${PARAMS_JSON} is ${e.uncompressedSize} bytes; the limit is ${PARAMS_MAX_BYTES}.` };
  if (e.method === 0 && e.compressedSize !== e.uncompressedSize) return { error: `${PARAMS_JSON} has inconsistent stored sizes.` };
  let data: Uint8Array;
  try {
    data = await readEntry(reader, e, cdOffset, PARAMS_JSON);
  } catch (err) {
    if (err instanceof EntryError || err instanceof RangeError) return { error: err.message };
    throw err;
  }
  try {
    return { text: utf8Fatal.decode(data) };
  } catch {
    return { error: `${PARAMS_JSON} is not valid UTF-8.` };
  }
}

/**
 * Read and verify one stored (0) or deflated (8) entry whose central directory record was already checked:
 * local header consistency, inflated size and CRC-32. Throws EntryError (messages start with `label`).
 */
async function readEntry(reader: RangeReader, e: CdEntry, cdOffset: number, label: string): Promise<Uint8Array> {
  const fail = (message: string): never => {
    throw new EntryError(`${label} ${message}`);
  };
  // Deflate cannot expand data by more than ~0.1% + a few bytes; anything bigger is junk.
  if (e.compressedSize > e.uncompressedSize + (e.uncompressedSize >> 6) + 64) fail('compressed size is implausibly large for its declared size.');

  const maxLocal = cdOffset - e.localOffset;
  const want = Math.min(maxLocal, LOCAL_HEADER + e.nameBytes.length + 64 + e.compressedSize);
  let buf = await reader.read(e.localOffset, want);
  let lv = dv(buf);
  if (lv.getUint32(0, true) !== SIG_LOCAL) fail('local header signature mismatch.');
  const lFlags = lv.getUint16(6, true);
  const lMethod = lv.getUint16(8, true);
  const lCrc = lv.getUint32(14, true);
  const lComp = lv.getUint32(18, true);
  const lUncomp = lv.getUint32(22, true);
  const lNameLen = lv.getUint16(26, true);
  const lExtraLen = lv.getUint16(28, true);
  const dataStart = LOCAL_HEADER + lNameLen + lExtraLen;
  const dataEnd = dataStart + e.compressedSize;
  if (e.localOffset + dataEnd > cdOffset) fail('data runs into the central directory.');
  if (dataEnd > buf.length) {
    buf = await reader.read(e.localOffset, dataEnd);
    lv = dv(buf);
  }
  if (!bytesEqual(buf.subarray(LOCAL_HEADER, LOCAL_HEADER + lNameLen), e.nameBytes)) fail('local header name differs from the central directory.');
  if (lMethod !== e.method || (lFlags & 0x0041) !== (e.flags & 0x0041)) fail('local header method/flags differ from the central directory.');
  if ((lFlags & 0x0008) === 0) {
    const sizesOk =
      (lComp === U32_MAX || lComp === e.compressedSize) && (lUncomp === U32_MAX || lUncomp === e.uncompressedSize) && lCrc === e.crc;
    if (!sizesOk) fail('local header sizes/CRC differ from the central directory.');
  }

  const raw = buf.subarray(dataStart, dataEnd);
  let data: Uint8Array = raw;
  if (e.method !== 0) {
    try {
      data = await inflateLimited(raw, e.uncompressedSize);
    } catch (err) {
      fail(`could not be inflated: ${(err as Error).message}`);
    }
  }
  if (data.length !== e.uncompressedSize) fail(`inflated to ${data.length} bytes but ${e.uncompressedSize} were declared.`);
  if (crc32(data) !== e.crc) fail('CRC-32 mismatch.');
  return data;
}
