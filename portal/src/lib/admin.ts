import type { Maintainer, ReasonCode } from '../api/types.ts';

export const REASON_CODES: readonly ReasonCode[] = ['spam', 'violation', 'bad-id', 'squatting', 'other'];

/** "other" requires a free-text explanation; preset codes make it optional. */
export function rejectNeedsText(code: ReasonCode | undefined): boolean {
  return code === 'other';
}

/** Editable row in the maintainers editor (strings, as typed). */
export interface MaintainerRow {
  githubId: string;
  login: string;
  telegramId: string;
  telegramUsername: string;
}

export function toRows(ms: readonly Maintainer[]): MaintainerRow[] {
  return ms.map((m) => ({
    githubId: String(m.github.id),
    login: m.github.login,
    telegramId: m.telegram ? String(m.telegram.id) : '',
    telegramUsername: m.telegram?.username ?? '',
  }));
}

export type RowError = 'githubId' | 'login' | 'telegramId' | 'duplicate';

const posInt = (s: string) => /^[1-9][0-9]{0,15}$/.test(s.trim()) && Number.isSafeInteger(Number(s.trim()));
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Validates rows; returns per-row errors and the parsed document when valid. */
export function fromRows(rows: readonly MaintainerRow[]): { errors: RowError[][]; value: Maintainer[] | null; empty: boolean } {
  const errors: RowError[][] = rows.map(() => []);
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const e = errors[i]!;
    if (!posInt(r.githubId)) e.push('githubId');
    if (!LOGIN.test(r.login.trim())) e.push('login');
    if (r.telegramId.trim() && !posInt(r.telegramId)) e.push('telegramId');
    const key = r.githubId.trim();
    if (seen.has(key)) e.push('duplicate');
    else seen.set(key, i);
  });
  const ok = errors.every((e) => e.length === 0) && rows.length > 0;
  const value = ok
    ? rows.map((r): Maintainer => {
        const m: Maintainer = { github: { id: Number(r.githubId.trim()), login: r.login.trim() } };
        if (r.telegramId.trim()) {
          m.telegram = r.telegramUsername.trim()
            ? { id: Number(r.telegramId.trim()), username: r.telegramUsername.trim().replace(/^@/, '') }
            : { id: Number(r.telegramId.trim()) };
        }
        return m;
      })
    : null;
  return { errors, value, empty: rows.length === 0 };
}
