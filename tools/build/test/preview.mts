// Build the fixtures offline into a directory for manual inspection:
//   pnpm exec tsx test/preview.mts /tmp/kernelsu-preview   (then e.g. `python3 -m http.server -d /tmp/kernelsu-preview`)
import { cpSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/index.ts';
import { fakeGet, FIX } from './fake-net.ts';

const out = path.resolve(process.argv[2] ?? 'preview-dist');
const cache = mkdtempSync(path.join(os.tmpdir(), 'kernelsu-preview-cache-'));
cpSync(path.join(FIX, 'cache'), cache, { recursive: true });
const res = await build({ dataDir: path.join(FIX, 'data'), outDir: out, cacheDir: cache, dataCommit: 'd'.repeat(40), httpGet: fakeGet() });
console.log(JSON.stringify({ out, buildId: res.buildId, outcomes: res.outcomes }, null, 2));
