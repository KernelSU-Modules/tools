// Maintainer API (maintainers.yaml GitHub ids).
import { Hono, type Context } from 'hono';
import { splitFullName } from '@kernelsu-modules/github';
import { ReasonCode } from '@kernelsu-modules/schema';
import { ApiError } from '../lib/errors.ts';
import { deferrer, type AppEnv } from '../types.ts';
import { ban, decide, maintainerByGithub, moderate, unban } from '../domain/ops.ts';
import { addMaintainer, listMaintainers, removeMaintainer, setMaintainerTelegram } from '../domain/maintainers.ts';
import { requestExpired, type Actor } from '../domain/state.ts';
import { newestSuccessAt } from '../domain/data.ts';
import { indexOf } from '../domain/index.ts';
import { lastSuccessfulSync } from '../domain/actions.ts';

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

admin.get('/queue', async (c) => {
  const snap = await c.var.svc.data.snapshot();
  const now = c.var.svc.now();
  const open = indexOf(snap).open; // oldest first
  const status = open.length ? await c.var.svc.data.status(snap) : null;
  const items = open
    .map((r) => {
      // The sync's validation of this request's source (status.json), only when it belongs to this request.
      const check = status?.modules[r.id]?.request;
      return {
        id: r.id,
        status: r.status,
        request: r.request!,
        ...(r.source ? { source: r.source } : {}),
        ...(check && check.submissionId === r.request!.submissionId ? { check } : {}),
        expired: requestExpired(r.request!, snap.policy, now),
      };
    });
  return c.json(items);
});

/** Single request (open or already decided) by submissionId — backs the Portal link in Telegram messages. */
admin.get('/requests/:submissionId', async (c) => {
  const sid = c.req.param('submissionId');
  const snap = await c.var.svc.data.snapshot();
  const ix = indexOf(snap);
  const r = ix.openBySubmission.get(sid) ?? ix.reviewedBySubmission.get(sid);
  if (!r) throw new ApiError(404, 'not-found', `Request ${sid} not found.`);
  return c.json({ ...r, open: r.request?.submissionId === sid });
});

admin.post('/requests/:submissionId/approve', async (c) => {
  const actor = await requireMaintainer(c);
  return c.json(await decide(c.var.svc, actor, c.req.param('submissionId'), { kind: 'approve' }, deferrer(c)));
});

admin.post('/requests/:submissionId/reject', async (c) => {
  const actor = await requireMaintainer(c);
  const b = await body(c);
  const rc = ReasonCode.safeParse(b.reasonCode);
  if (!rc.success) throw new ApiError(400, 'bad-request', `reasonCode must be one of ${ReasonCode.options.join(', ')}`);
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;
  if (rc.data === 'other' && !reason) throw new ApiError(400, 'bad-request', 'reason is required for reasonCode "other"');
  return c.json(await decide(c.var.svc, actor, c.req.param('submissionId'), { kind: 'reject', reasonCode: rc.data, reason }, deferrer(c)));
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
  let login = typeof b.login === 'string' ? b.login : undefined;
  if (!login && Number.isSafeInteger(githubId) && githubId > 0) {
    const u = await c.var.svc
      .userClient(c.var.session!.at)
      .get<{ login: string }>(`/user/${githubId}`, { allow: [404] })
      .catch(() => null);
    if (u?.status === 200) login = u.data.login;
  }
  return c.json(await ban(c.var.svc, actor, { githubId, reason: b.reason as string, login }), 201);
});
admin.delete('/banned/:githubId{[0-9]+}', async (c) => {
  const actor = await requireMaintainer(c);
  return c.json(await unban(c.var.svc, actor, Number(c.req.param('githubId'))));
});

admin.get('/status', async (c) => {
  const svc = c.var.svc;
  const snap = await svc.data.snapshot();
  const status = await svc.data.status(snap);
  const modules = Object.entries(status.modules).map(([id, m]) => {
    const rec = snap.records[id];
    const req = m.request && rec?.request?.submissionId === m.request.submissionId ? m.request : null;
    return { id, status: rec?.status, ...m, request: req };
  });
  const run = (r: any) => ({
    id: r.id,
    status: r.status,
    conclusion: r.conclusion,
    event: r.event,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    htmlUrl: r.html_url,
    displayTitle: r.display_title,
  });
  let runs: unknown[] = [];
  let lastSuccessfulRun: unknown = null;
  try {
    const { owner, repo } = splitFullName(c.env.TOOLS_REPO);
    const gh = await svc.toolsClient();
    const [res, ok] = await Promise.all([
      gh.get<{ workflow_runs: any[] }>(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(c.env.SYNC_WORKFLOW)}/runs`, {
        query: { per_page: 10 },
      }),
      lastSuccessfulSync(svc),
    ]);
    runs = res.data.workflow_runs.map(run);
    lastSuccessfulRun = ok ? run(ok) : null;
  } catch (e) {
    console.error('workflow runs failed', (e as Error).message);
  }
  return c.json({
    generatedAt: new Date(svc.now()).toISOString(),
    dataCommit: snap.commit,
    newestSuccessAt: newestSuccessAt(status),
    lastSuccessfulRun,
    invalidFiles: snap.invalid,
    modules,
    runs,
  });
});
