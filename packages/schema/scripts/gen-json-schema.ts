// Generates JSON Schema files into <repo>/schemas from the zod source of truth.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as S from '../src/index.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../schemas');
mkdirSync(out, { recursive: true });
const targets: Record<string, z.ZodType> = {
  'module.schema.json': S.ModuleManifest,
  'record.schema.json': S.RegistryRecord,
  'policy.schema.json': S.Policy,
  'maintainers.schema.json': S.Maintainers,
  'banned.schema.json': S.Banned,
  'sources-lock.schema.json': S.SourcesLock,
  'status.schema.json': S.RegistryStatus,
  'api-v1-index.schema.json': S.ApiIndex,
  'api-v1-modules.schema.json': S.ApiModules,
  'api-v1-module.schema.json': S.ApiModuleDetail,
  'api-v1-update.schema.json': S.ApiUpdateJson,
};
for (const [file, schema] of Object.entries(targets)) {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  writeFileSync(join(out, file), JSON.stringify(json, null, 2) + '\n');
  console.log('wrote', file);
}
