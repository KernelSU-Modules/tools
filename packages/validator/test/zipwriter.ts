/** Minimal hand-rolled ZIP writer for test fixtures (supports forging headers). */
import { crc32 } from '../src/zip.ts';

export interface FixtureEntry {
  name: string | Uint8Array;
  data?: Uint8Array | string;
  method?: number; // 0 stored, 8 deflate (default 8)
  flags?: number;
  /** Override values written in the central directory. */
  cd?: { crc?: number; compressedSize?: number; uncompressedSize?: number; localOffset?: number; extra?: Uint8Array };
  /** Override values written in the local header. */
  local?: { name?: string; crc?: number; compressedSize?: number; uncompressedSize?: number; method?: number; extra?: Uint8Array };
  /** Replace the stored payload bytes (after compression). */
  payload?: Uint8Array;
}

export interface FixtureOptions {
  zip64?: boolean;
  comment?: string;
  prefix?: Uint8Array;
  suffix?: Uint8Array;
  eocd?: { entries?: number; cdSize?: number; cdOffset?: number; disk?: number };
  zip64Eocd?: { entries?: number; cdSize?: number; cdOffset?: number };
  cdTrailing?: Uint8Array;
}

const te = new TextEncoder();
export const enc = (s: string) => te.encode(s);

export async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const out = new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(cs));
  return new Uint8Array(await out.arrayBuffer());
}

class Buf {
  parts: Uint8Array[] = [];
  length = 0;
  push(b: Uint8Array) {
    this.parts.push(b);
    this.length += b.length;
  }
  u16(n: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, n, true);
    this.push(b);
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    this.push(b);
  }
  u64(n: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    this.push(b);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let p = 0;
    for (const x of this.parts) {
      out.set(x, p);
      p += x.length;
    }
    return out;
  }
}

function zip64ExtraField(values: number[]): Uint8Array {
  const b = new Buf();
  b.u16(1);
  b.u16(values.length * 8);
  for (const v of values) b.u64(v);
  return b.bytes();
}

export async function buildZip(entries: FixtureEntry[], opts: FixtureOptions = {}): Promise<Uint8Array> {
  const body = new Buf();
  if (opts.prefix) body.push(opts.prefix);
  const recs: { e: FixtureEntry; nameBytes: Uint8Array; crc: number; csize: number; usize: number; offset: number; method: number; flags: number }[] = [];
  for (const e of entries) {
    const nameBytes = typeof e.name === 'string' ? enc(e.name) : e.name;
    const raw = typeof e.data === 'string' ? enc(e.data) : (e.data ?? new Uint8Array(0));
    const method = e.method ?? 8;
    const flags = e.flags ?? 0x0800;
    const payload = e.payload ?? (method === 8 ? await deflateRaw(raw) : raw);
    const crc = crc32(raw);
    const offset = body.length;
    const l = e.local ?? {};
    const lname = l.name !== undefined ? enc(l.name) : nameBytes;
    const lextra = l.extra ?? (opts.zip64 ? zip64ExtraField([raw.length, payload.length]) : new Uint8Array(0));
    body.u32(0x04034b50);
    body.u16(opts.zip64 ? 45 : 20);
    body.u16(flags);
    body.u16(l.method ?? method);
    body.u16(0);
    body.u16(0x21);
    body.u32(l.crc ?? crc);
    body.u32(l.compressedSize ?? (opts.zip64 ? 0xffffffff : payload.length));
    body.u32(l.uncompressedSize ?? (opts.zip64 ? 0xffffffff : raw.length));
    body.u16(lname.length);
    body.u16(lextra.length);
    body.push(lname);
    body.push(lextra);
    body.push(payload);
    recs.push({ e, nameBytes, crc, csize: payload.length, usize: raw.length, offset, method, flags });
  }
  const cdOffset = body.length;
  for (const r of recs) {
    const c = r.e.cd ?? {};
    const usize = c.uncompressedSize ?? r.usize;
    const csize = c.compressedSize ?? r.csize;
    const off = c.localOffset ?? r.offset;
    const extra = c.extra ?? (opts.zip64 ? zip64ExtraField([usize, csize, off]) : new Uint8Array(0));
    body.u32(0x02014b50);
    body.u16(0x031e);
    body.u16(opts.zip64 ? 45 : 20);
    body.u16(r.flags);
    body.u16(r.method);
    body.u16(0);
    body.u16(0x21);
    body.u32(c.crc ?? r.crc);
    body.u32(opts.zip64 ? 0xffffffff : csize);
    body.u32(opts.zip64 ? 0xffffffff : usize);
    body.u16(r.nameBytes.length);
    body.u16(extra.length);
    body.u16(0);
    body.u16(0);
    body.u16(0);
    body.u32(0o100644 << 16);
    body.u32(opts.zip64 ? 0xffffffff : off);
    body.push(r.nameBytes);
    body.push(extra);
  }
  if (opts.cdTrailing) body.push(opts.cdTrailing);
  const cdSize = body.length - cdOffset;
  if (opts.zip64) {
    const z = opts.zip64Eocd ?? {};
    const recOff = body.length;
    body.u32(0x06064b50);
    body.u64(44);
    body.u16(45);
    body.u16(45);
    body.u32(0);
    body.u32(0);
    body.u64(z.entries ?? recs.length);
    body.u64(z.entries ?? recs.length);
    body.u64(z.cdSize ?? cdSize);
    body.u64(z.cdOffset ?? cdOffset);
    body.u32(0x07064b50);
    body.u32(0);
    body.u64(recOff);
    body.u32(1);
  }
  const o = opts.eocd ?? {};
  const comment = enc(opts.comment ?? '');
  body.u32(0x06054b50);
  body.u16(o.disk ?? 0);
  body.u16(0);
  body.u16(o.entries ?? (opts.zip64 ? 0xffff : recs.length));
  body.u16(o.entries ?? (opts.zip64 ? 0xffff : recs.length));
  body.u32(o.cdSize ?? (opts.zip64 ? 0xffffffff : cdSize));
  body.u32(o.cdOffset ?? (opts.zip64 ? 0xffffffff : cdOffset));
  body.u16(comment.length);
  body.push(comment);
  if (opts.suffix) body.push(opts.suffix);
  return body.bytes();
}

export const VALID_PROP = [
  'id=demo.toolbox',
  'name=Demo Toolbox',
  'version=v1.2.3',
  'versionCode=123',
  'author=Demo',
  'description=Utilities for rooted devices',
  '',
].join('\n');
