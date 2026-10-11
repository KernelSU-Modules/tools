// Minimal deterministic ZIP writer (stored/deflate, no ZIP64) used for the `module-dir` input.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/** Names skipped anywhere in the tree (VCS metadata and OS junk). */
export const DEFAULT_EXCLUDES = new Set([
  '.git',
  '.github',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.gitkeep',
  '.svn',
  '.hg',
  '.hgignore',
  '.DS_Store',
  'Thumbs.db',
]);

export interface ZipFileEntry {
  name: string; // '/'-separated, directories end with '/'
  data: Uint8Array;
  mode: number; // unix mode incl. file type bits
}

export interface CollectResult {
  entries: ZipFileEntry[];
  skipped: string[]; // symlinks and other non-regular files
}

/** Walk `dir` in sorted order and collect files and directories, skipping excluded names. */
export function collectDir(dir: string, excludes: Set<string> = DEFAULT_EXCLUDES): CollectResult {
  const entries: ZipFileEntry[] = [];
  const skipped: string[] = [];
  const walk = (abs: string, rel: string) => {
    const names = readdirSync(abs).sort();
    for (const name of names) {
      if (excludes.has(name)) continue;
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isDirectory()) {
        entries.push({ name: r + '/', data: new Uint8Array(0), mode: 0o040755 });
        walk(p, r);
      } else if (st.isFile()) {
        entries.push({ name: r, data: readFileSync(p), mode: 0o100000 | (st.mode & 0o111 ? 0o755 : 0o644) });
      } else {
        skipped.push(r);
      }
    }
  };
  walk(dir, '');
  return { entries, skipped };
}

// 1980-01-01 00:00:00 (DOS epoch) for reproducible archives.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const LIMIT = 0xfffffffe;

/** Build a ZIP archive in memory. Entry order is preserved. */
export function createZip(entries: ZipFileEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const isDir = e.name.endsWith('/');
    const crc = isDir ? 0 : crc32(e.data) >>> 0;
    let method = 0;
    let body: Uint8Array = e.data;
    if (!isDir && e.data.length > 0) {
      const deflated = deflateRawSync(e.data, { level: 9 });
      if (deflated.length < e.data.length) {
        method = 8;
        body = deflated;
      }
    }
    if (e.data.length > LIMIT || offset > LIMIT) throw new Error('module directory too large for a non-ZIP64 archive');
    const flags = 0x0800; // UTF-8 names
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, flags, true);
    lh.setUint16(8, method, true);
    lh.setUint16(10, DOS_TIME, true);
    lh.setUint16(12, DOS_DATE, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, body);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, (3 << 8) | 20, true); // made by: unix, 2.0
    ch.setUint16(6, 20, true);
    ch.setUint16(8, flags, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, DOS_TIME, true);
    ch.setUint16(14, DOS_DATE, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true);
    ch.setUint16(36, 0, true);
    ch.setUint32(38, ((e.mode & 0xffff) << 16 | (isDir ? 0x10 : 0)) >>> 0, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + body.length;
  }
  if (entries.length > 0xfffe) throw new Error('too many entries for a non-ZIP64 archive');
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
