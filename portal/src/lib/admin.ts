import type { MaintainerView, ReasonCode } from '../api/types.ts';

export const REASON_CODES: readonly ReasonCode[] = ['spam', 'violation', 'bad-id', 'squatting', 'other'];

/** "other" requires a free-text explanation; preset codes make it optional. */
export function rejectNeedsText(code: ReasonCode | undefined): boolean {
  return code === 'other';
}

/** Telegram review bot (privacy mode: group commands must be addressed to it). */
export const BOT_USERNAME = 'ksudevbot';
/** Bot command that replies with the sender's numeric Telegram user id (see worker/src/domain/tgupdate.ts). */
export const WHOAMI_COMMAND = `/whoami@${BOT_USERNAME}`;

/** GitHub login rules (as the Worker checks them): alphanumerics and hyphens, 1-39 chars, no leading hyphen. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Input of the "add maintainer" form: `octocat`, `@octocat` or a github.com profile URL -> login, else null.
 */
export function parseLogin(input: string): string | null {
  let s = input.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(s);
  if (url) s = url[1]!;
  s = s.replace(/^@/, '');
  return LOGIN.test(s) ? s : null;
}

/** Telegram user id field: '' -> null (not bound), a positive safe integer -> number, anything else -> 'invalid'. */
export function parseTelegramId(input: string): number | null | 'invalid' {
  const s = input.trim();
  if (!s) return null;
  if (!/^[1-9][0-9]{0,15}$/.test(s) || !Number.isSafeInteger(Number(s))) return 'invalid';
  return Number(s);
}

/** Another maintainer already bound to `telegramId` (the Worker re-checks this at commit time). */
export function telegramOwner(list: readonly MaintainerView[], githubId: number, telegramId: number | null): MaintainerView | null {
  if (telegramId === null) return null;
  return list.find((m) => m.githubId !== githubId && m.telegramId === telegramId) ?? null;
}
