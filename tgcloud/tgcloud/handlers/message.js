// Maintainer commands (P1): only "/suspend <id> <reason>" is forwarded; everything else is ignored.
import { api, fetch } from 'sdk';
import { handleMessage } from '../lib/forward.js';
import { FORWARD_SECRET, PORTAL_URL } from '../lib/env.js';

export default async function (message, ctx) {
  await handleMessage(message, ctx, { api, fetch, secret: FORWARD_SECRET, portalUrl: PORTAL_URL });
}
