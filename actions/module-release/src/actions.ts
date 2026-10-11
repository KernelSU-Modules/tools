// Tiny replacement for @actions/core: inputs, outputs, annotations, step summary.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export type Env = Record<string, string | undefined>;

export interface Logger {
  info(msg: string): void;
  warning(msg: string, props?: AnnotationProps): void;
  error(msg: string, props?: AnnotationProps): void;
  notice(msg: string, props?: AnnotationProps): void;
  group<T>(title: string, fn: () => Promise<T>): Promise<T>;
}

export interface AnnotationProps {
  title?: string;
  file?: string;
}

/** Same naming rule as @actions/core: spaces -> '_', upper-cased, hyphens kept. */
export function getInput(env: Env, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

export function getBooleanInput(env: Env, name: string, def = false): boolean {
  const v = getInput(env, name).toLowerCase();
  if (v === '') return def;
  if (['true', 'yes', '1', 'on'].includes(v)) return true;
  if (['false', 'no', '0', 'off'].includes(v)) return false;
  throw new Error(`Input "${name}" must be a boolean (true/false), got "${v}"`);
}

const escapeData = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProp = (s: string) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function command(name: string, msg: string, props: AnnotationProps = {}): string {
  const p = Object.entries(props)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${escapeProp(String(v))}`)
    .join(',');
  return `::${name}${p ? ' ' + p : ''}::${escapeData(msg)}`;
}

export function consoleLogger(write: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  return {
    info: (m) => write(m),
    warning: (m, p) => write(command('warning', m, p)),
    error: (m, p) => write(command('error', m, p)),
    notice: (m, p) => write(command('notice', m, p)),
    async group(title, fn) {
      write(`::group::${escapeData(title)}`);
      try {
        return await fn();
      } finally {
        write('::endgroup::');
      }
    },
  };
}

/** Write a step output (GITHUB_OUTPUT heredoc format); falls back to the deprecated ::set-output command. */
export function setOutput(env: Env, name: string, value: string, log?: (l: string) => void): void {
  const file = env.GITHUB_OUTPUT;
  if (file) {
    const delim = `ghadelimiter_${randomUUID()}`;
    appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
  } else {
    (log ?? ((l: string) => process.stdout.write(l + '\n')))(`::set-output name=${name}::${escapeData(value)}`);
  }
}

export function appendSummary(env: Env, markdown: string): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown.endsWith('\n') ? markdown : markdown + '\n');
}
