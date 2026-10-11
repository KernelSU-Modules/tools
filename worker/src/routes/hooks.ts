// GitHub App webhooks + Telegram ingress. All verify a secret over the exact received bytes before parsing.
import { Hono } from 'hono';
import type { RegistryRecord } from '@kernelsu-modules/schema';
import { timingSafeEqual, verifySha256Signature } from '@kernelsu-modules/github';
import { deferrer, type AppEnv } from '../types.ts';
import type { Services } from '../services.ts';
import { dispatchSync } from '../domain/ops.ts';
import { syncTargetsByRepo } from '../domain/state.ts';
import { indexOf } from '../domain/index.ts';
import { handleUpdate, type TgUpdate } from '../domain/tgupdate.ts';

export const hooks = new Hono<AppEnv>();

const RELEASE_ACTIONS = new Set(['published', 'released', 'edited', 'prereleased', 'deleted']);
const CHECK_RUN_NAME = 'KernelSU Modules';

interface Repoish {
  id: number;
}

/** repoId -> module id index, memoized per snapshot (recomputed only when the data commit changes). */
const targetIndex = new WeakMap<object, Map<number, string>>();
function targetsOf(snap: { records: Record<string, RegistryRecord> }): Map<number, string> {
  let m = targetIndex.get(snap);
  if (!m) targetIndex.set(snap, (m = syncTargetsByRepo(Object.values(snap.records))));
  return m;
}

/**
 * Route a Modules App webhook. Only events that touch a repository bound to a listed/suspended record, or the
 * source repository of an open request (submit / transfer: the sync validates those and writes their
 * Check Run), wake the sync workflow; everything else (including repos not bound to a module) is ignored.
 */
export async function routeGithubEvent(svc: Services, event: string, payload: any): Promise<{ dispatched: boolean; module?: string; reason?: string }> {
  let repoIds: number[] = [];
  let reason = event;
  let ownerId: number | null = null;
  switch (event) {
    case 'release':
      if (!RELEASE_ACTIONS.has(payload.action)) return { dispatched: false };
      repoIds = [payload.repository?.id];
      reason = `release.${payload.action}`;
      break;
    case 'installation':
      repoIds = (payload.repositories ?? []).map((r: Repoish) => r.id);
      reason = `installation.${payload.action}`;
      if (!repoIds.length) ownerId = payload.installation?.account?.id ?? null; // "All repositories" installs omit the list
      break;
    case 'installation_repositories':
      repoIds = [...(payload.repositories_added ?? []), ...(payload.repositories_removed ?? [])].map((r: Repoish) => r.id);
      reason = `installation_repositories.${payload.action}`;
      break;
    case 'check_run': {
      const name = payload.check_run?.name;
      if (name && name !== CHECK_RUN_NAME) return { dispatched: false };
      if (payload.action === 'rerequested') reason = 'check_run.rerequested';
      else if (payload.action === 'requested_action' && payload.requested_action?.identifier === 'sync') reason = 'check_run.requested_action';
      else return { dispatched: false };
      repoIds = [payload.repository?.id];
      break;
    }
    default:
      return { dispatched: false };
  }
  repoIds = repoIds.filter((x) => Number.isSafeInteger(x));
  if (!repoIds.length && ownerId === null) return { dispatched: false };
  const snap = await svc.data.snapshot();
  const index = targetsOf(snap);
  const modules = new Set<string>();
  for (const id of repoIds) {
    const m = index.get(id);
    if (m) modules.add(m);
  }
  if (ownerId !== null)
    for (const r of indexOf(snap).byOwner.get(ownerId) ?? [])
      if (((r.status === 'listed' || r.status === 'suspended') && r.source?.ownerId === ownerId) || r.request?.source.ownerId === ownerId) modules.add(r.id);
  if (!modules.size) return { dispatched: false };
  // sync always scans every listed module and every open request; `module` additionally forces checks for that one.
  const module = modules.size === 1 ? [...modules][0] : undefined;
  const ok = await dispatchSync(svc, { reason, module });
  return { dispatched: ok, module, reason };
}

hooks.post('/webhooks/github', async (c) => {
  // Never verify against an empty key (an HMAC with "" is forgeable): refuse until the secret is configured.
  const secret = c.env.MODULES_APP_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: { code: 'disabled', message: 'webhook secret not configured' } }, 503);
  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (!(await verifySha256Signature(secret, raw, c.req.header('x-hub-signature-256'))))
    return c.json({ error: { code: 'bad-signature', message: 'invalid signature' } }, 401);
  const event = c.req.header('x-github-event') ?? '';
  if (event === 'ping') return c.json({ ok: true });
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json({ error: { code: 'bad-request', message: 'invalid JSON' } }, 400);
  }
  const res = await routeGithubEvent(c.var.svc, event, payload);
  if (!res.dispatched) return c.body(null, 204);
  return c.json(res, 202);
});

/** tgcloud forwarder: body = raw Update bytes, X-KernelSU-Signature: sha256=<hex HMAC(TG_FORWARD_SECRET, body)>. */
hooks.post('/internal/telegram', async (c) => {
  const secret = c.env.TG_FORWARD_SECRET;
  if (!secret) return c.json({ error: { code: 'disabled', message: 'forwarder not configured' } }, 503);
  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (!(await verifySha256Signature(secret, raw, c.req.header('x-kernelsu-signature'))))
    return c.json({ error: { code: 'bad-signature', message: 'invalid signature' } }, 401);
  let update: TgUpdate;
  try {
    update = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json({ error: { code: 'bad-request', message: 'invalid JSON' } }, 400);
  }
  // The forwarder waits ≤ 8 s for the answer: Telegram edit + dispatch run after the response (waitUntil).
  const res = await handleUpdate(c.var.svc, update, deferrer(c));
  return c.json({ answer: res.answer });
});

/** Optional direct Telegram webhook (fallback when tgcloud is not used); answers callback queries itself. */
hooks.post('/webhooks/telegram', async (c) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: { code: 'disabled', message: 'direct webhook not configured' } }, 404);
  if (!timingSafeEqual(c.req.header('x-telegram-bot-api-secret-token') ?? '', secret))
    return c.json({ error: { code: 'bad-signature', message: 'invalid secret token' } }, 401);
  let update: TgUpdate;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ ok: true }); // never make Telegram retry garbage
  }
  const res = await handleUpdate(c.var.svc, update, deferrer(c));
  if (res.callbackQueryId && res.answer) await c.var.svc.telegram.answer(res.callbackQueryId, res.answer.text, res.answer.show_alert);
  return c.json({ ok: true });
});
