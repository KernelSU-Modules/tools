// Run: node --import ./test/register.mjs --test test/   (from tools/tgcloud)
import { createHmac, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { state, BotApiError } from 'sdk';
import callbackQuery from '../tgcloud/handlers/callback_query.js';
import message from '../tgcloud/handlers/message.js';
import { hmacSha256Hex, sha256, toHex, utf8 } from '../tgcloud/lib/hmac.js';
import {
  TEXT_TIMEOUT,
  TEXT_UNAVAILABLE,
  TEXT_UNSUPPORTED,
  forwardUpdate,
  handleCallbackQuery,
} from '../tgcloud/lib/forward.js';
import { FORWARD_SECRET, PORTAL_URL } from './fake-env.mjs';

const nodeHmac = (secret, bytes) => createHmac('sha256', secret).update(bytes).digest('hex');

function workerStub(respond) {
  const seen = [];
  state.fetch = async (url, init) => {
    seen.push({ url, init });
    return respond(url, init);
  };
  return seen;
}
const json = (status, obj) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(obj),
});

const cbUpdate = (data = 'v1:ap:k7q2m9x4ta', fromId = 42) => ({
  update_id: 1001,
  callback_query: {
    id: '4382bfdwdsb323b2d9',
    from: { id: fromId, is_bot: false, first_name: 'Ma', username: 'maint' },
    message: { message_id: 7, chat: { id: -1001234567890, type: 'supergroup' }, date: 1760000000, text: '新收录 demo — ✓' },
    chat_instance: '-123',
    data,
  },
});

beforeEach(() => state.reset());

describe('hmac', () => {
  it('pure-JS sha256 matches known vectors', () => {
    assert.equal(toHex(sha256(utf8(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(toHex(sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('pure-JS and WebCrypto HMAC match node:crypto for many lengths and unicode', async () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70000]) {
      const bytes = randomBytes(len);
      const secret = len % 2 ? 'k'.repeat(100) : 'short-key-ä✓';
      const want = nodeHmac(secret, bytes);
      assert.equal(await hmacSha256Hex(secret, new Uint8Array(bytes), { forceJs: true }), want, `js len=${len}`);
      assert.equal(await hmacSha256Hex(secret, new Uint8Array(bytes)), want, `subtle len=${len}`);
    }
    const s = 'Grüße 🚀 \ud800 x';
    assert.deepEqual([...utf8(s)], [...Buffer.from(s, 'utf8')]);
  });
});

describe('callback_query handler', () => {
  it('signs the exact body, forwards the raw Update and answers with the Worker text', async () => {
    const seen = workerStub(() => json(200, { answer: { text: 'Approved demo', show_alert: true } }));
    const update = cbUpdate();
    await callbackQuery(update.callback_query, { update });

    assert.equal(seen.length, 1);
    const { url, init } = seen[0];
    assert.equal(url, `${PORTAL_URL}/internal/telegram`);
    assert.equal(init.method, 'POST');
    assert.ok(init.body instanceof Uint8Array);
    assert.equal(init.headers['X-KernelSU-Signature'], 'sha256=' + nodeHmac(FORWARD_SECRET, init.body));
    assert.deepEqual(JSON.parse(Buffer.from(init.body).toString('utf8')), update);

    assert.deepEqual(state.apiCalls, [
      { method: 'answerCallbackQuery', params: { callback_query_id: update.callback_query.id, text: 'Approved demo', show_alert: true } },
    ]);
  });

  it('answers "Not authorized" style texts verbatim and clamps to 200 chars', async () => {
    workerStub(() => json(200, { answer: { text: 'x'.repeat(300) } }));
    const update = cbUpdate('v1:rs:k7q2m9x4ta', 999);
    await callbackQuery(update.callback_query, { update });
    assert.equal(state.apiCalls[0].params.text.length, 200);
  });

  it('falls back when the Worker fails, errors or is unreachable', async () => {
    for (const respond of [() => json(500, {}), () => json(401, { error: { code: 'bad-signature' } }), () => Promise.reject(new TypeError('fetch failed'))]) {
      state.reset();
      workerStub(respond);
      const update = cbUpdate();
      await callbackQuery(update.callback_query, { update });
      assert.equal(state.apiCalls[0].method, 'answerCallbackQuery');
      assert.equal(state.apiCalls[0].params.text, TEXT_UNAVAILABLE);
    }
  });

  it('uses the timeout text when the Worker is slow', async () => {
    const update = cbUpdate();
    const api = { calls: [], answerCallbackQuery: async (p) => api.calls.push(p) };
    const slow = () => new Promise((r) => setTimeout(() => r(json(200, {})), 500));
    await handleCallbackQuery(update.callback_query, { update }, { api, fetch: slow, secret: FORWARD_SECRET, portalUrl: PORTAL_URL, timeoutMs: 20 });
    assert.equal(api.calls[0].text, TEXT_TIMEOUT);
  });

  it('does not forward unknown callback_data', async () => {
    const seen = workerStub(() => json(200, {}));
    const update = cbUpdate('unknown-button');
    await callbackQuery(update.callback_query, { update });
    assert.equal(seen.length, 0);
    assert.equal(state.apiCalls[0].params.text, TEXT_UNSUPPORTED);
  });

  it('rebuilds an Update when ctx.update is missing', async () => {
    const seen = workerStub(() => json(200, { answer: { text: 'ok' } }));
    const update = cbUpdate();
    await callbackQuery(update.callback_query, {});
    const body = JSON.parse(Buffer.from(seen[0].init.body).toString('utf8'));
    assert.deepEqual(body.callback_query, update.callback_query);
  });

  it('survives answerCallbackQuery errors (query too old)', async () => {
    workerStub(() => json(200, { answer: { text: 'ok' } }));
    state.apiErrors.answerCallbackQuery = new BotApiError('answerCallbackQuery', 400, 'Bad Request: query is too old');
    const update = cbUpdate();
    await callbackQuery(update.callback_query, { update });
  });

  it('refuses to forward without a usable secret', async () => {
    const r = await forwardUpdate(cbUpdate(), { fetch: () => assert.fail('must not fetch'), secret: 'short' });
    assert.equal(r.reason, 'no-secret');
  });
});

describe('message handler', () => {
  const msg = (text) => ({ message_id: 55, from: { id: 42 }, chat: { id: -1001234567890, type: 'supergroup' }, date: 1, text });

  it('forwards /suspend and /whoami (with and without @bot) and ignores everything else', async () => {
    const seen = workerStub(() => json(200, {}));
    for (const t of ['/suspend demo spam', '/suspend@ksudevbot demo spam', '/whoami', '/whoami@ksudevbot', 'hello', '/suspended', '/whoamix', '/start', 'say /whoami']) {
      const m = msg(t);
      await message(m, { update: { update_id: 1, message: m } });
    }
    assert.deepEqual(
      seen.map((s) => JSON.parse(new TextDecoder().decode(s.init.body)).message.text),
      ['/suspend demo spam', '/suspend@ksudevbot demo spam', '/whoami', '/whoami@ksudevbot'],
    );
    assert.equal(state.apiCalls.length, 0);
  });

  it('replies with a fallback when the Worker is down', async () => {
    workerStub(() => json(503, {}));
    const m = msg('/suspend demo spam');
    await message(m, { update: { update_id: 2, message: m } });
    assert.equal(state.apiCalls[0].method, 'sendMessage');
    assert.equal(state.apiCalls[0].params.text, TEXT_UNAVAILABLE);
    assert.equal(state.apiCalls[0].params.reply_parameters.message_id, 55);
  });
});
