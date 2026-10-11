import { describe, expect, it } from 'vitest';
import { bundleRender } from '../scripts/size.mts';

describe('worker bundle', () => {
  it('bundles for a neutral (Workers) platform without Node built-ins and stays small', async () => {
    const r = await bundleRender();
    expect(r.gzip).toBeLessThan(150 * 1024);
  }, 30_000);
});
