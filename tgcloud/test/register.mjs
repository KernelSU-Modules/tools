// Node harness: `node --import ./test/register.mjs ...` maps the platform-only imports
// ('sdk', 'sdk/*', '../lib/env.js') to local fakes so the real handler modules can run under Node.
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
