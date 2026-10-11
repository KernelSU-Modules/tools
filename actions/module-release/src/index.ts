// Action entry point (bundled into dist/index.js).
import * as validator from '@kernelsu-modules/validator';
import { consoleLogger } from './actions.ts';
import { ActionFailed, run } from './main.ts';

const log = consoleLogger();
run({ env: process.env, log, validator })
  .then(() => undefined)
  .catch((e: unknown) => {
    if (e instanceof ActionFailed) log.error(e.message);
    else log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exitCode = 1;
  });
