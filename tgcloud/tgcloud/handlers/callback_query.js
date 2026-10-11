// Inline-button presses in the maintainer group (callback_data "v1:{action}:{submissionId}").
import { api, fetch } from 'sdk';
import { handleCallbackQuery } from '../lib/forward.js';
import { FORWARD_SECRET, PORTAL_URL } from '../lib/env.js';

export default async function (query, ctx) {
  await handleCallbackQuery(query, ctx, { api, fetch, secret: FORWARD_SECRET, portalUrl: PORTAL_URL });
}
