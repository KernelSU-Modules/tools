// Manual end-to-end check against a running Worker (e.g. `wrangler dev` on :8787):
//   TG_FORWARD_SECRET=<same as worker .dev.vars> PORTAL_URL=http://127.0.0.1:8787 \
//     node --import ./test/register.mjs test/simulate.mjs [callback_data] [from_id]
//   node --import ./test/register.mjs test/simulate.mjs '/suspend demo spam' [from_id]
// Uses the real handler code; Bot API calls are printed instead of sent.
import { state } from 'sdk';
import callbackQuery from '../tgcloud/handlers/callback_query.js';
import message from '../tgcloud/handlers/message.js';

const [arg = 'v1:ap:aaaaaaaaaa', from = '1'] = process.argv.slice(2);
const user = { id: Number(from), is_bot: false, first_name: 'Sim' };
const chat = { id: -1000000000000, type: 'supergroup', title: 'sim' };
if (arg.startsWith('/')) {
  const m = { message_id: 1, from: user, chat, date: Math.floor(Date.now() / 1000), text: arg, entities: [{ type: 'bot_command', offset: 0, length: arg.split(' ')[0].length }] };
  await message(m, { update: { update_id: Date.now(), message: m } });
} else {
  const q = { id: String(Date.now()), from: user, chat_instance: '1', data: arg, message: { message_id: 1, chat, date: 0, text: 'sim' } };
  await callbackQuery(q, { update: { update_id: Date.now(), callback_query: q } });
}
console.log('Bot API calls:', JSON.stringify(state.apiCalls, null, 2));
