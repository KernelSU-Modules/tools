// Telegram Update handling shared by /internal/telegram (tgcloud forwarder) and /webhooks/telegram (direct).
// callback_data is untrusted: it only locates the request; authorization is from.id ∈ maintainers.yaml.
import { ApiError } from '../lib/errors.ts';
import type { Services } from '../services.ts';
import { CALLBACK_ACTIONS, parseCallbackData } from './messages.ts';
import { decide, maintainerByTelegram, moderate, type Defer } from './ops.ts';
import { h } from './telegram.ts';

export interface CallbackAnswer {
  text: string;
  show_alert: boolean;
}

interface TgUser {
  id: number;
  username?: string;
}
export interface TgUpdate {
  update_id?: number;
  callback_query?: { id: string; from: TgUser; data?: string; message?: { message_id: number; chat: { id: number } } };
  message?: { message_id: number; from?: TgUser; chat: { id: number }; text?: string };
}

export interface UpdateResult {
  /** For callback queries: what to show the clicker (forwarder calls answerCallbackQuery with it). */
  answer: CallbackAnswer | null;
  callbackQueryId?: string;
}

function errorAnswer(e: unknown): CallbackAnswer {
  if (e instanceof ApiError) {
    if (e.status === 409) return { text: `Already handled: ${e.message}`.slice(0, 190), show_alert: true };
    if (e.status === 404) return { text: 'Request not found', show_alert: true };
    return { text: `Error: ${e.message}`.slice(0, 190), show_alert: true };
  }
  console.error('telegram action failed', (e as Error).message);
  return { text: 'Internal error; please use the Portal', show_alert: true };
}

export async function handleUpdate(svc: Services, update: TgUpdate, defer?: Defer): Promise<UpdateResult> {
  const cq = update.callback_query;
  if (cq) {
    const parsed = parseCallbackData(cq.data);
    if (!parsed) return { answer: { text: 'Unknown action', show_alert: false }, callbackQueryId: cq.id };
    const snap = await svc.data.snapshot();
    const m = maintainerByTelegram(snap, cq.from?.id);
    if (!m) return { answer: { text: 'Not authorized', show_alert: true }, callbackQueryId: cq.id };
    const actor = { githubId: m.github.id, login: m.github.login, via: 'telegram' as const };
    const act = CALLBACK_ACTIONS[parsed.action];
    try {
      const res =
        act.decision === 'approve'
          ? await decide(svc, actor, parsed.submissionId, { kind: 'approve' }, defer)
          : await decide(svc, actor, parsed.submissionId, { kind: 'reject', reasonCode: act.reasonCode }, defer);
      return {
        answer: { text: `${res.decision === 'approved' ? 'Approved' : 'Rejected'} ${res.id}`, show_alert: false },
        callbackQueryId: cq.id,
      };
    } catch (e) {
      return { answer: errorAnswer(e), callbackQueryId: cq.id };
    }
  }

  const msg = update.message;
  const text = msg?.text?.trim();
  if (msg && text && /^\/suspend(@\w+)?(\s|$)/.test(text)) {
    const snap = await svc.data.snapshot();
    const m = msg.from ? maintainerByTelegram(snap, msg.from.id) : null;
    if (!m) {
      await svc.telegram.reply(msg.chat.id, msg.message_id, 'Not authorized.');
      return { answer: null };
    }
    const mm = /^\/suspend(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/.exec(text);
    if (!mm) {
      await svc.telegram.reply(msg.chat.id, msg.message_id, 'Usage: <code>/suspend &lt;module-id&gt; &lt;reason&gt;</code>');
      return { answer: null };
    }
    const [, id, reason] = mm;
    try {
      await moderate(svc, { githubId: m.github.id, login: m.github.login, via: 'telegram' }, id!, 'suspend', reason!, defer);
      await svc.telegram.reply(msg.chat.id, msg.message_id, `⏸ <code>${h(id)}</code> suspended by @${h(m.github.login)}. The site rebuild has been triggered.`);
    } catch (e) {
      const why = e instanceof ApiError ? e.message : 'internal error';
      await svc.telegram.reply(msg.chat.id, msg.message_id, `Failed to suspend <code>${h(id)}</code>: ${h(why)}`);
    }
  }
  return { answer: null };
}
