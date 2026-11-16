// Maintainer API (maintainers.yaml GitHub ids).
import { Hono, type Context } from 'hono';
import { ApiError } from '../lib/errors.ts';
import { deferrer, type AppEnv } from '../types.ts';
import { ban, decide, maintainerByGithub, moderate, unban } from '../domain/ops.ts';
import { addMaintainer, listMaintainers, removeMaintainer, setMaintainerTelegram } from '../domain/maintainers.ts';
import type { Actor } from '../domain/state.ts';
import { loginOf, parseChangesReason, parseReject, queueView, requestView, statusView } from '../domain/admin.ts';

export const admin = new Hono<AppEnv>();

async function requireMaintainer(c: Context<AppEnv>): Promise<Actor & { login: string }> {
  const s = c.var.session;
  if (!s) throw new ApiError(401, 'unauthorized', 'Sign in first.');
  const snap = await c.var.svc.data.snapshot();
  const m = maintainerByGithub(snap, s.uid);
  if (!m) throw new ApiError(403, 'forbidden', 'Maintainers only.');
  return { githubId: s.uid, login: s.login, via: 'portal' };
}

admin.use('*', async (c, next) => {
  await requireMaintainer(c);
  await next();
});

const body = async (c: Context<AppEnv>): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== 'object') throw new ApiError(400, 'bad-request', 'Expected a JSON object body.');
  return b as Record<string, unknown>;
};

admin.get('/queue', async (c) => c.json(await queueView(c.var.svc)));

/** Single request (open or already decided) by submissionId — backs the Portal link in Telegram messages. */
admin.get('/requests/:submissionId', async (c) => c.json(await requestView(c.var.svc, c.req.param('submissionId'))));

admin.post('/requests/:submissionId/approve', async (c) => {
  const actor = await requireMaintainer(c);
  return c.json(await decide(c.var.svc, actor, c.req.param('submissionId'), { kind: 'approve' }, deferrer(c)));
});

admin.post('/requests/:submissionId/reject', async (c) => {
  const actor = await requireMaintainer(c);
  const r = parseReject(await body(c));
  return c.json(await decide(c.var.svc, actor, c.req.param('submissionId'), { kind: 'reject', ...r }, deferrer(c)));
});

/** Send a pending submission back to the submitter for changes (reason required; the ID stays reserved for them). */
admin.post('/requests/:submissionId/request-changes', async (c) => {
  const actor = await requireMaintainer(c);
  const reason = parseChangesReason((await body(c)).reason);
  return c.json(await decide(c.var.svc, actor, c.req.param('submissionId'), { kind: 'request-changes', reason }, deferrer(c)));
});

admin.post('/modules/:id/:action{suspend|unsuspend|archive}', async (c) => {
  const actor = await requireMaintainer(c);
  const b = await body(c);
  const action = c.req.param('action') as 'suspend' | 'unsuspend' | 'archive';
  return c.json(await moderate(c.var.svc, actor, c.req.param('id'), action, typeof b.reason === 'string' ? b.reason : '', deferrer(c)));
});

// maintainers.yaml: granular edits, one Bot commit each (see domain/maintainers.ts). GitHub lookups use the caller's token.
admin.get('/maintainers', async (c) =>
  c.json({ maintainers: await listMaintainers(c.var.svc, c.var.svc.userClient(c.var.session!.at)) }),
);
admin.post('/maintainers', async (c) => {
  const actor = await requireMaintainer(c);
  const b = await body(c);
  return c.json(await addMaintainer(c.var.svc, actor, c.var.svc.userClient(c.var.session!.at), b.login), 201);
});
admin.patch('/maintainers/:githubId{[0-9]+}', async (c) => {
  const actor = await requireMaintainer(c);
  const b = await body(c);
  if (!('telegramId' in b)) throw new ApiError(400, 'bad-request', 'telegramId (number or null) is required');
  return c.json(await setMaintainerTelegram(c.var.svc, actor, Number(c.req.param('githubId')), b.telegramId));
});
admin.delete('/maintainers/:githubId{[0-9]+}', async (c) => {
  const actor = await requireMaintainer(c);
  return c.json(await removeMaintainer(c.var.svc, actor, Number(c.req.param('githubId'))));
});

admin.get('/banned', async (c) => c.json((await c.var.svc.data.snapshot()).banned));
admin.post('/banned', async (c) => {
  const actor = await requireMaintainer(c);
  const b = await body(c);
  const githubId = typeof b.githubId === 'number' ? b.githubId : Number(b.githubId);
  const login = typeof b.login === 'string' ? b.login : await loginOf(c.var.svc.userClient(c.var.session!.at), githubId);
  return c.json(await ban(c.var.svc, actor, { githubId, reason: b.reason as string, login }), 201);
});
admin.delete('/banned/:githubId{[0-9]+}', async (c) => {
  const actor = await requireMaintainer(c);
  return c.json(await unban(c.var.svc, actor, Number(c.req.param('githubId'))));
});

admin.get('/status', async (c) => c.json(await statusView(c.var.svc)));

