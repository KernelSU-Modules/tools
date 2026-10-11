// Telegram Bot API client (sendMessage / editMessageText / answerCallbackQuery only).
// While Telegram Serverless (tgcloud) owns the webhook, the Worker must never call setWebhook/deleteWebhook/getUpdates.

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}
export type InlineKeyboard = InlineButton[][];
export interface TelegramRef {
  chatId: number;
  messageId: number;
}

export class TelegramError extends Error {}

export class Telegram {
  readonly chatId: number | null;
  constructor(
    private readonly token: string | undefined,
    chatId: string | undefined,
    private readonly fetchImpl: typeof fetch,
  ) {
    const n = chatId ? Number(chatId) : NaN;
    this.chatId = Number.isFinite(n) && n !== 0 ? n : null;
  }

  get enabled(): boolean {
    return !!this.token && this.chatId !== null;
  }
  get canCall(): boolean {
    return !!this.token;
  }

  async call<T = unknown>(method: 'sendMessage' | 'editMessageText' | 'answerCallbackQuery', body: Record<string, unknown>): Promise<T> {
    if (!this.token) throw new TelegramError('TELEGRAM_BOT_TOKEN is not configured');
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string } | null;
    if (!data?.ok) throw new TelegramError(`Telegram ${method} failed: ${res.status} ${data?.description ?? ''}`);
    return data.result as T;
  }

  /** Post to the maintainers chat. Returns null (never throws) when unconfigured or on failure. */
  async send(text: string, keyboard?: InlineKeyboard, chatId = this.chatId): Promise<TelegramRef | null> {
    if (!this.token || chatId === null) return null;
    try {
      const msg = await this.call<{ message_id: number; chat: { id: number } }>('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
      return { chatId: msg.chat.id, messageId: msg.message_id };
    } catch (e) {
      console.error('telegram send failed', (e as Error).message);
      return null;
    }
  }

  async reply(chatId: number, replyTo: number | undefined, text: string): Promise<void> {
    if (!this.token) return;
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    }).catch((e) => console.error('telegram reply failed', (e as Error).message));
  }

  /** Replace the text and drop the inline keyboard (no reply_markup => keyboard removed). Never throws. */
  async edit(ref: TelegramRef, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
    if (!this.token) return false;
    try {
      await this.call('editMessageText', {
        chat_id: ref.chatId,
        message_id: ref.messageId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
      return true;
    } catch (e) {
      console.error('telegram edit failed', (e as Error).message);
      return false;
    }
  }

  async answer(callbackQueryId: string, text: string, showAlert = false): Promise<void> {
    if (!this.token) return;
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: showAlert }).catch((e) =>
      console.error('telegram answer failed', (e as Error).message),
    );
  }
}

/** Escape for Telegram HTML parse mode (only &, <, > and quotes in attributes matter). */
export function h(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
