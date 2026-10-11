// Build cache (--cache-dir). Layout:
//   blobs/{sha256}            content-addressed file bytes (verified on every read)
//   images/{sha256(url)}.json remote image fetch result {url, sha256|null, ext, fetchedAt, error}
//   modules/{id}.json         last successfully built content input per module (stale fallback)
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

export interface LastGood {
  repositoryId: number;
  fullName: string;
  commit: string;
  manifestPath: string;
  files: Record<string, string>;
}

export interface ImageMeta {
  url: string;
  sha256: string | null;
  ext: string | null;
  fetchedAt: number;
  error: string | null;
  errorKind: string | null;
}

async function atomicWrite(file: string, data: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export class BuildCache {
  constructor(readonly dir: string) {}

  async getBlob(hash: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    try {
      const b = new Uint8Array(await readFile(path.join(this.dir, 'blobs', hash)));
      return sha256(b) === hash ? b : null;
    } catch {
      return null;
    }
  }

  async putBlob(data: Uint8Array): Promise<string> {
    const hash = sha256(data);
    await atomicWrite(path.join(this.dir, 'blobs', hash), data);
    return hash;
  }

  async getImageMeta(url: string): Promise<ImageMeta | null> {
    try {
      const m = JSON.parse(await readFile(path.join(this.dir, 'images', `${sha256(url)}.json`), 'utf8')) as ImageMeta;
      return m.url === url ? m : null;
    } catch {
      return null;
    }
  }

  async putImageMeta(meta: ImageMeta): Promise<void> {
    await atomicWrite(path.join(this.dir, 'images', `${sha256(meta.url)}.json`), JSON.stringify(meta, null, 2) + '\n');
  }

  async getLastGood(id: string): Promise<LastGood | null> {
    try {
      return JSON.parse(await readFile(path.join(this.dir, 'modules', `${id}.json`), 'utf8')) as LastGood;
    } catch {
      return null;
    }
  }

  async putLastGood(id: string, v: LastGood): Promise<void> {
    await atomicWrite(path.join(this.dir, 'modules', `${id}.json`), JSON.stringify(v, null, 2) + '\n');
  }
}
