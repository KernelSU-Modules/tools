// Thin forwarder: Telegram Update -> signed POST to the Portal Worker (CONTRACTS.md, section 8).
// Holds no GitHub credentials and no state; every authorization decision is made by the Worker.
// Pure functions with injected dependencies so they can be tested outside the platform.
import { hmacSha256Hex, utf8 } from './hmac.js';
import { DEFAULT_PORTAL_URL, FORWARD_PATH, FORWARD_TIMEOUT_MS, USER_AGENT } from './config.js';

export const TEXT_UNAVAILABLE = 'Service unavailable, use the Portal';
export const TEXT_TIMEOUT = 'Still processing. If the message does not update shortly, use the Portal.';
export const TEXT_UNSUPPORTED = 'This button is no longer supported.';
/** Bot API limit for answerCallbackQuery.text */
const MAX_ANSWER = 200;

const TIMEOUT = Symbol('timeout');

function withTimeout(promise, ms) {
  if (!ms || typeof setTimeout !== 'function') return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), ms);
    }),
  ]).finally(() => typeof clearTimeout === 'function' && clearTimeout(timer));
}

/** A usable secret: at least 32 chars and not an obvious placeholder. */
export function secretUsable(secret) {
  return typeof secret === 'string' && secret.length >= 32 && !/^(changeme|placeholder|x+)$/i.test(secret);
}

/** Clamp the Worker's {text, show_alert} to what answerCallbackQuery accepts. */
export function normalizeAnswer(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {};
  if (typeof a.text === 'string') out.text = a.text.length > MAX_ANSWER ? a.text.slice(0, MAX_ANSWER - 1) + '…' : a.text;
  if (typeof a.show_alert === 'boolean') out.show_alert = a.show_alert;
  return out;
}

/**
 * Serialize the Update once, sign exactly those bytes, POST them.
 * @returns {Promise<{ok: true, status: number, answer: {text?: string, show_alert?: boolean} | null}
 *                  | {ok: false, reason: 'no-secret'|'timeout'|'network'|'http'|'bad-json', status?: number, error?: string}>}
 */
export async function forwardUpdate(update, deps) {
  const { fetch, secret } = deps;
  if (!secretUsable(secret)) return { ok: false, reason: 'no-secret' };
  const base = (deps.portalUrl || DEFAULT_PORTAL_URL).replace(/\/+$/, '');
  const body = utf8(JSON.stringify(update));
  const signature = 'sha256=' + (await hmacSha256Hex(secret, body));
  let res;
  try {
    res = await withTimeout(
      fetch(base + FORWARD_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-KernelSU-Signature': signature, 'User-Agent': USER_AGENT },
        body,
      }),
      deps.timeoutMs ?? FORWARD_TIMEOUT_MS,
    );
  } catch (e) {
    return { ok: false, reason: 'network', error: String(e && e.message ? e.message : e) };
  }
  if (res === TIMEOUT) return { ok: false, reason: 'timeout' };
  if (!res.ok) return { ok: false, reason: 'http', status: res.status };
  let json = null;
  try {
    const text = await res.text();
    json = text ? JSON.parse(text) : {};
  } catch (e) {
    return { ok: false, reason: 'bad-json', status: res.status, error: String(e) };
  }
  return { ok: true, status: res.status, answer: normalizeAnswer(json && json.answer) };
}

function fallbackText(result) {
  return result.reason === 'timeout' ? TEXT_TIMEOUT : TEXT_UNAVAILABLE;
}

/** handlers/callback_query: forward `v1:*` buttons, then answer with the Worker's text (or a fallback). */
export async function handleCallbackQuery(query, ctx, deps) {
  const { api } = deps;
  let answer;
  if (typeof query.data !== 'string' || !query.data.startsWith('v1:')) {
    answer = { text: TEXT_UNSUPPORTED };
  } else {
    const update = (ctx && ctx.update) || { update_id: 0, callback_query: query };
    const result = await forwardUpdate(update, deps);
    if (result.ok) answer = result.answer || {};
    else {
      console.error('forward failed', { reason: result.reason, status: result.status, error: result.error });
      answer = { text: fallbackText(result), show_alert: false };
    }
  }
  try {
    await api.answerCallbackQuery({ callback_query_id: query.id, ...answer });
  } catch (e) {
    // e.g. 400 "query is too old" when the Worker took too long; nothing else to do.
    console.warn('answerCallbackQuery failed', { code: e && e.code, description: e && e.description });
  }
  return answer;
}

const COMMAND = /^\/suspend(?:@[A-Za-z0-9_]+)?(?:\s|$)/;

/** handlers/message: only `/suspend ...` is forwarded; the Worker replies via the Bot API itself. */
export async function handleMessage(message, ctx, deps) {
  const text = typeof message.text === 'string' ? message.text : '';
  if (!COMMAND.test(text)) return { forwarded: false };
  const update = (ctx && ctx.update) || { update_id: 0, message };
  const result = await forwardUpdate(update, deps);
  if (!result.ok) {
    console.error('forward failed', { reason: result.reason, status: result.status, error: result.error });
    try {
      await deps.api.sendMessage({
        chat_id: message.chat.id,
        text: fallbackText(result),
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      });
    } catch (e) {
      console.warn('sendMessage failed', { code: e && e.code, description: e && e.description });
    }
  }
  return { forwarded: true, result };
}
