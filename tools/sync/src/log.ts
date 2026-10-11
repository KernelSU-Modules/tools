// Structured JSON-lines logger (stderr), friendly to GitHub Actions log viewers.

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: Level, msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function jsonLogger(
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => process.stderr.write(l + '\n'),
  minLevel: Level = 'info',
): Logger {
  const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
  return {
    log(level, msg, fields) {
      if (order[level] < order[minLevel]) return;
      sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields }));
    },
    child(fields) {
      return jsonLogger({ ...base, ...fields }, sink, minLevel);
    },
  };
}

export const silentLogger: Logger = { log() {}, child: () => silentLogger };

/** Collects log entries in memory (tests). */
export function memoryLogger(): Logger & { entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  const make = (base: Record<string, unknown>): Logger => ({
    log(level, msg, fields) {
      entries.push({ level, msg, ...base, ...fields });
    },
    child: (f) => make({ ...base, ...f }),
  });
  return Object.assign(make({}), { entries });
}
