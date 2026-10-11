#!/usr/bin/env node
// pnpm --filter @kernelsu-modules/sync start -- --data-dir <path> [--module <id>] [--commit|--dry-run] [--report <file>]
import { appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GitHubApp } from '@kernelsu-modules/github';
import { FatalError } from './data.ts';
import { jsonLogger } from './log.ts';
import { runSync, type SyncMode, type SyncReport } from './sync.ts';

const USAGE = `Usage: sync --data-dir <path> [--module <id>] [--commit | --dry-run] [--report <file>] [--concurrency <n>]

  --data-dir     data repo checkout (modules/*.yaml, policy.yaml, sources.lock.json)
  --module       "Sync now" / "Re-run" for one module ID: re-check it and its open request without dedupe and
                 post fresh Check Runs (every run already syncs all listed/suspended modules and validates
                 every open submit/transfer request)
  --commit       write sources.lock.json + status.json locally and commit both (one commit) to DATA_REPO via the
                 KernelSU Modules Bot
  --dry-run      read-only: no check runs, no file writes, no commit
                 (default: write the files locally and create check runs, no commit)
  --report       write a JSON report of per-module outcomes

Env: MODULES_APP_ID MODULES_APP_PRIVATE_KEY [BOT_APP_ID BOT_APP_PRIVATE_KEY] [DATA_REPO=KernelSU-Modules/repo]
     [BOT_APP_SLUG=kernelsu-modules-bot] (commit trailer "Actor: app:<slug> via sync")`;

function stepSummary(r: SyncReport): string {
  const rows = r.modules.map(
    (m) => `| ${m.id} | ${m.health} | ${m.stable ? `${m.stable.tag} (${m.stable.versionCode})` : '-'} | ${m.releases.map((x) => `${x.tag}: ${x.result}`).join(', ') || '-'} | ${(m.message ?? '').replace(/\|/g, '\\|')} |`,
  );
  return [
    `### Sync (${r.mode})`,
    '',
    `Changed: ${r.changed.join(', ') || 'none'} · Status: ${r.statusChanged.join(', ') || 'none'} · Removed: ${r.removed.join(', ') || 'none'} · Commit: ${r.commit ?? 'none'} · Invalid records: ${r.invalidRecords.length}`,
    '',
    '| Module | Health | Stable | New releases | Message |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...(r.requests.length
      ? ['| Request | Kind | Repository | OK | Re-checked | Issues |', '| --- | --- | --- | --- | --- | --- |', ...r.requests.map((q) => `| ${q.id} (${q.submissionId}) | ${q.kind} | ${q.repositoryId} | ${q.ok ? 'yes' : 'no'} | ${q.revalidated ? 'yes' : 'no'} | ${q.issues.join(', ') || '-'} |`), '']
      : []),
  ].join('\n');
}

async function main(): Promise<number> {
  let args;
  try {
    // pnpm forwards the `--` separator literally (`pnpm start -- --data-dir x`).
    const argv = process.argv.slice(2);
    args = parseArgs({
      args: argv[0] === '--' ? argv.slice(1) : argv,
      options: {
        'data-dir': { type: 'string' },
        module: { type: 'string' },
        commit: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        report: { type: 'string' },
        concurrency: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    console.error((e as Error).message + '\n\n' + USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args['data-dir'] || (args.commit && args['dry-run'])) {
    console.error(USAGE);
    return 2;
  }
  // Relative paths are relative to where the user invoked pnpm, not the package directory.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const mode: SyncMode = args.commit ? 'commit' : args['dry-run'] ? 'dry-run' : 'write';
  const log = jsonLogger({ component: 'sync' });
  const env = process.env;
  const started = new Date().toISOString();
  const writeReport = async (r: unknown) => {
    if (args.report) await writeFile(resolve(cwd, args.report), JSON.stringify(r, null, 2) + '\n');
  };

  try {
    if (!env.MODULES_APP_ID || !env.MODULES_APP_PRIVATE_KEY) throw new FatalError('MODULES_APP_ID and MODULES_APP_PRIVATE_KEY are required');
    if (mode === 'commit' && (!env.BOT_APP_ID || !env.BOT_APP_PRIVATE_KEY)) throw new FatalError('--commit requires BOT_APP_ID and BOT_APP_PRIVATE_KEY');
    // Batch job: wait out secondary rate limits (up to 60 s) instead of failing the module.
    const client = { retry: { retries: 3, maxDelayMs: 60_000 }, timeoutMs: 30_000 };
    const modulesApp = new GitHubApp({ appId: env.MODULES_APP_ID, privateKey: env.MODULES_APP_PRIVATE_KEY }, client);
    const botApp = env.BOT_APP_ID && env.BOT_APP_PRIVATE_KEY ? new GitHubApp({ appId: env.BOT_APP_ID, privateKey: env.BOT_APP_PRIVATE_KEY }, client) : undefined;
    const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    const report = await runSync(
      {
        dataDir: resolve(cwd, args['data-dir']),
        module: args.module || undefined,
        mode,
        dataRepo: env.DATA_REPO || 'KernelSU-Modules/repo',
        concurrency: Math.min(4, Math.max(1, Number(args.concurrency ?? 4) || 4)),
        modulesAppId: Number(env.MODULES_APP_ID) || undefined,
        trailers: { Actor: `app:${env.BOT_APP_SLUG || 'kernelsu-modules-bot'} via sync`, Run: runUrl },
      },
      { fetch, modulesApp, botApp, log },
    );
    await writeReport(report);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, stepSummary(report)).catch(() => {});
    if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `changed=${report.changed.length > 0}\ncommit=${report.commit ?? ''}\n`).catch(() => {});
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.log('error', e instanceof FatalError ? 'fatal' : 'unexpected failure', { error: msg, stack: e instanceof FatalError ? undefined : (e as Error)?.stack });
    await writeReport({ startedAt: started, finishedAt: new Date().toISOString(), mode, error: msg }).catch(() => {});
    if (env.GITHUB_ACTIONS) console.log(`::error title=Sync failed::${msg.replace(/\r?\n/g, ' ')}`);
    return 1;
  }
}

process.exitCode = await main();
