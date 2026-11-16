// MCP server for maintainers (Model Context Protocol, Streamable HTTP transport, stateless): POST /mcp carries one
// JSON-RPC message and gets a JSON response (no SSE, no sessions). Auth: OAuth 2.1 access token (`Bearer ksm_…`) from
// routes/oauth.ts — the client sends the user through the Portal login + consent; the grant ends with that Portal login.
// Cookies are ignored, so there is no CSRF surface. The GitHub user must still be a maintainer at every request. Tools call the same domain functions as the
// cookie API (/api/admin/*); writes are Bot commits with `Actor: github:<id> via portal`. GitHub lookups (profiles,
// logins) use the Bot's data-repo installation token instead of a user token.
import { Hono, type Context } from 'hono';
import { RecordStatus } from '@kernelsu-modules/schema';
import { ApiError } from '../lib/errors.ts';
import { readAccess } from '../lib/mcpauth.ts';
import { resourceMetadataUrl } from './oauth.ts';
import { deferrer, type AppEnv } from '../types.ts';
import { moduleAdminView, loginOf, parseChangesReason, parseReject, queueView, requestModuleSync, requestView, statusView } from '../domain/admin.ts';
import { addMaintainer, listMaintainers, removeMaintainer, setMaintainerTelegram } from '../domain/maintainers.ts';
import { ban, decide, maintainerByGithub, moderate, unban } from '../domain/ops.ts';
import type { Actor } from '../domain/state.ts';

/** Newest first; an unknown requested version is answered with the newest. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const MCP_SERVER_INFO = { name: 'kernelsu-developer-portal', title: 'KernelSU Modules Developer Portal', version: '1.0.0' };

const instructions = (portal: string) => `Maintainer tools of the KernelSU Modules registry (modules.kernelsu.org). Every write is a commit to the data repository
by the KernelSU Modules Bot on your behalf, and decisions also update the Telegram review message: confirm approvals,
rejections, moderation, bans and maintainer changes with the human before calling them. Read-only tools are safe.
Guide: ${portal}/SKILL.md`;

type Json = Record<string, unknown>;
type Caller = Actor & { login: string };
interface ToolCtx {
  c: Context<AppEnv>;
  actor: Caller;
}
interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: false };
  run(args: Json, t: ToolCtx): Promise<unknown>;
}

/* ------------------------------------------------------------ argument helpers ----------------------------------- */

const bad = (msg: string): never => {
  throw new ApiError(400, 'bad-request', msg);
};
function str(a: Json, k: string, opts: { optional?: boolean } = {}): string {
  const v = a[k];
  if (v === undefined && opts.optional) return '';
  if (typeof v !== 'string' || !v.trim()) bad(`${k} must be a non-empty string`);
  return (v as string).trim();
}
function posInt(a: Json, k: string): number {
  const v = a[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) bad(`${k} must be a positive integer`);
  return v as number;
}
const obj = (props: Json, required: string[] = []): Json => ({ type: 'object', properties: props, required, additionalProperties: false });
const S = (description: string, extra: Json = {}): Json => ({ type: 'string', description, ...extra });
const I = (description: string): Json => ({ type: 'integer', minimum: 1, description });
const SID = S('Submission id (10 characters [a-z0-9]) from queue_list or a Telegram review message.', { pattern: '^[a-z0-9]{10}$' });
const MODULE_ID = S('Module id, e.g. "demo.toolbox".');
const RO = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

/** Bot client for public GitHub user lookups (the same scoped data-repo token the request already uses). */
const lookupClient = (c: Context<AppEnv>) => c.var.svc.bot.repoClient(c.env.DATA_REPO, { contents: 'write' });

/* ------------------------------------------------------------ tools ---------------------------------------------- */

export const TOOLS: Tool[] = [
  {
    name: 'queue_list',
    title: 'Review queue',
    description:
      'Open requests (pending submissions and transfers), oldest first: module id, request {submissionId, kind, source, submittedBy, submittedAt, note?}, ' +
      'expired, check (the sync\'s validation of the requested source: ok + issues, when it already ran) and sync (current repository name).',
    inputSchema: obj({}),
    annotations: RO,
    run: ({}, { c }) => queueView(c.var.svc),
  },
  {
    name: 'request_get',
    title: 'Get a request',
    description: 'One request by submission id, open or already decided: the registry record plus `open`.',
    inputSchema: obj({ submissionId: SID }, ['submissionId']),
    annotations: RO,
    run: (a, { c }) => requestView(c.var.svc, str(a, 'submissionId')),
  },
  {
    name: 'request_approve',
    title: 'Approve a request',
    description: 'Approve an open request: a submission becomes listed, a transfer swaps the source. Dispatches the sync.',
    inputSchema: obj({ submissionId: SID }, ['submissionId']),
    annotations: WRITE,
    run: (a, { c, actor }) => decide(c.var.svc, actor, str(a, 'submissionId'), { kind: 'approve' }, deferrer(c)),
  },
  {
    name: 'request_reject',
    title: 'Reject a request',
    description: 'Reject an open request. A rejected submission frees the id; a rejected transfer leaves the module unchanged.',
    inputSchema: obj(
      {
        submissionId: SID,
        reasonCode: { type: 'string', enum: ['spam', 'violation', 'bad-id', 'squatting', 'other'], description: 'Shown to the submitter.' },
        reason: S('Free text for the submitter (≤500 characters). Required for reasonCode "other".', { maxLength: 500 }),
      },
      ['submissionId', 'reasonCode'],
    ),
    annotations: DESTRUCTIVE,
    run: (a, { c, actor }) => decide(c.var.svc, actor, str(a, 'submissionId'), { kind: 'reject', ...parseReject(a) }, deferrer(c)),
  },
  {
    name: 'request_changes',
    title: 'Request changes',
    description:
      'Send a pending submission back to the submitter (submit requests only). The id and repository stay reserved for them; they resubmit from the Portal.',
    inputSchema: obj({ submissionId: SID, reason: S('What to change (required, ≤500 characters).', { maxLength: 500 }) }, ['submissionId', 'reason']),
    annotations: WRITE,
    run: (a, { c, actor }) =>
      decide(c.var.svc, actor, str(a, 'submissionId'), { kind: 'request-changes', reason: parseChangesReason(a.reason) }, deferrer(c)),
  },
  {
    name: 'modules_list',
    title: 'List modules',
    description: 'Every registry record (id, status, bound repository, open request kind), optionally filtered by status.',
    inputSchema: obj({ status: { type: 'string', enum: [...RecordStatus.options], description: 'Only records in this status.' } }),
    annotations: RO,
    run: async (a, { c }) => {
      const want = a.status === undefined ? null : RecordStatus.safeParse(a.status);
      if (want && !want.success) bad(`status must be one of ${RecordStatus.options.join(', ')}`);
      const snap = await c.var.svc.data.snapshot();
      return Object.values(snap.records)
        .filter((r) => !want || r.status === want.data)
        .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
        .map((r) => ({
          id: r.id,
          status: r.status,
          repository: r.source?.fullName ?? r.request?.source.fullName ?? null,
          ...(r.request ? { request: { kind: r.request.kind, submissionId: r.request.submissionId } } : {}),
        }));
    },
  },
  {
    name: 'module_get',
    title: 'Get a module',
    description: 'Full registry record of a module (source, request, review, moderation) plus its sync status (health, stable release, issues).',
    inputSchema: obj({ id: MODULE_ID }, ['id']),
    annotations: RO,
    run: (a, { c }) => moduleAdminView(c.var.svc, str(a, 'id')),
  },
  {
    name: 'module_moderate',
    title: 'Moderate a module',
    description: 'suspend (listed → suspended, hidden from the site), unsuspend (suspended → listed) or archive (listed/suspended → archived, final).',
    inputSchema: obj(
      {
        id: MODULE_ID,
        action: { type: 'string', enum: ['suspend', 'unsuspend', 'archive'] },
        reason: S('Reason recorded in the moderation entry.', { maxLength: 500 }),
      },
      ['id', 'action', 'reason'],
    ),
    annotations: DESTRUCTIVE,
    run: (a, { c, actor }) => {
      const action = a.action;
      if (action !== 'suspend' && action !== 'unsuspend' && action !== 'archive') return bad('action must be suspend, unsuspend or archive');
      return moderate(c.var.svc, actor, str(a, 'id'), action, typeof a.reason === 'string' ? a.reason : '', deferrer(c));
    },
  },
  {
    name: 'module_sync',
    title: 'Re-run the sync for a module',
    description:
      'Dispatch the sync workflow for one module (listed/suspended, or with an open request: re-validates the requested source). Rate-limited to once per 10 minutes per module.',
    inputSchema: obj({ id: MODULE_ID }, ['id']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (a, { c }) => {
      const id = str(a, 'id');
      const rec = (await c.var.svc.data.snapshot()).records[id];
      if (!rec) throw new ApiError(404, 'not-found', `Module "${id}" not found.`);
      if (!['listed', 'suspended'].includes(rec.status) && !rec.request) throw new ApiError(409, 'bad-state', `Module "${id}" is ${rec.status}.`);
      return { ok: true, ...(await requestModuleSync(c.var.svc, id)) };
    },
  },
  {
    name: 'sync_status',
    title: 'Sync status',
    description:
      'status.json (per-module health, installation, stable release, request check) plus the newest sync workflow runs and invalid data files. Filter with `ids` or `unhealthyOnly`.',
    inputSchema: obj({
      ids: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'Only these module ids.' },
      unhealthyOnly: { type: 'boolean', description: 'Only modules whose health is not "ok" or whose App installation is missing.' },
    }),
    annotations: RO,
    run: async (a, { c }) => {
      if (a.ids !== undefined && (!Array.isArray(a.ids) || a.ids.some((x) => typeof x !== 'string'))) bad('ids must be an array of strings');
      const v = await statusView(c.var.svc, a.ids ? new Set(a.ids as string[]) : undefined);
      return a.unhealthyOnly === true ? { ...v, modules: v.modules.filter((m) => m.health !== 'ok' || m.installation !== 'present') } : v;
    },
  },
  {
    name: 'maintainers_list',
    title: 'List maintainers',
    description: 'Maintainers (maintainers.yaml) with GitHub profile data and bound Telegram user id.',
    inputSchema: obj({}),
    annotations: RO,
    run: async ({}, { c }) => ({ maintainers: await listMaintainers(c.var.svc, await lookupClient(c)) }),
  },
  {
    name: 'maintainer_add',
    title: 'Add a maintainer',
    description: 'Add a GitHub user (personal account, not banned) as maintainer. Grants full maintainer rights including these tools.',
    inputSchema: obj({ login: S('GitHub login.') }, ['login']),
    annotations: WRITE,
    run: async (a, { c, actor }) => addMaintainer(c.var.svc, actor, await lookupClient(c), a.login),
  },
  {
    name: 'maintainer_set_telegram',
    title: 'Bind Telegram to a maintainer',
    description: 'Bind a numeric Telegram user id to a maintainer (enables Telegram review buttons), or clear it with null.',
    inputSchema: obj(
      { githubId: I('GitHub user id of the maintainer.'), telegramId: { type: ['integer', 'null'], minimum: 1, description: 'Numeric Telegram user id, or null to unbind.' } },
      ['githubId', 'telegramId'],
    ),
    annotations: { ...WRITE, idempotentHint: true },
    run: (a, { c, actor }) => {
      if (!('telegramId' in a)) bad('telegramId (number or null) is required');
      return setMaintainerTelegram(c.var.svc, actor, posInt(a, 'githubId'), a.telegramId);
    },
  },
  {
    name: 'maintainer_remove',
    title: 'Remove a maintainer',
    description: 'Remove a maintainer (never yourself, never the last one). Their MCP tokens stop working immediately.',
    inputSchema: obj({ githubId: I('GitHub user id of the maintainer.') }, ['githubId']),
    annotations: DESTRUCTIVE,
    run: (a, { c, actor }) => removeMaintainer(c.var.svc, actor, posInt(a, 'githubId')),
  },
  {
    name: 'banned_list',
    title: 'List banned users',
    description: 'banned.yaml: GitHub users who may not submit or transfer modules.',
    inputSchema: obj({}),
    annotations: RO,
    run: async ({}, { c }) => (await c.var.svc.data.snapshot()).banned,
  },
  {
    name: 'user_ban',
    title: 'Ban a GitHub user',
    description: 'Ban a GitHub user by numeric id from submitting or transferring modules. Existing modules are not touched.',
    inputSchema: obj({ githubId: I('GitHub user id.'), reason: S('Reason (required).', { maxLength: 500 }) }, ['githubId', 'reason']),
    annotations: DESTRUCTIVE,
    run: async (a, { c, actor }) => {
      const githubId = posInt(a, 'githubId');
      const login = await loginOf(await lookupClient(c), githubId);
      return ban(c.var.svc, actor, { githubId, reason: a.reason as string, login });
    },
  },
  {
    name: 'user_unban',
    title: 'Unban a GitHub user',
    description: 'Remove a GitHub user id from banned.yaml.',
    inputSchema: obj({ githubId: I('GitHub user id.') }, ['githubId']),
    annotations: { ...WRITE, idempotentHint: true },
    run: (a, { c, actor }) => unban(c.var.svc, actor, posInt(a, 'githubId')),
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const TOOL_LIST = TOOLS.map(({ run: _run, ...t }) => t);

/* ------------------------------------------------------------ transport ------------------------------------------ */

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const textResult = (value: unknown, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** RFC 6750 / RFC 9728: points the client at the protected-resource metadata, which starts the OAuth flow. */
function unauthorized(c: Context<AppEnv>, message: string, invalid: boolean) {
  c.header('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl(c)}", scope="admin"${invalid ? ', error="invalid_token"' : ''}`);
  return c.json({ error: { code: 'unauthorized', message } }, 401);
}

export const mcp = new Hono<AppEnv>();

mcp.use('*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

mcp.on(['GET', 'DELETE'], '/', (c) => {
  // Stateless server: no server-initiated SSE stream, no sessions to terminate.
  c.header('Allow', 'POST');
  return c.json({ error: { code: 'method-not-allowed', message: 'Use POST (MCP Streamable HTTP, JSON responses).' } }, 405);
});

mcp.post('/', async (c) => {
  // DNS-rebinding guard of the MCP transport: browsers send Origin; only the Portal itself may call.
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.env.PORTAL_URL).origin) return c.json({ error: { code: 'forbidden', message: 'Origin not allowed.' } }, 403);

  const svc = c.var.svc;
  const auth = c.req.header('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!m) return unauthorized(c, 'Authorization required: connect through OAuth (the client opens the Portal to sign in).', false);
  const tok = await readAccess(c.env.SESSION_KEY, m[1], svc.now());
  if (!tok) return unauthorized(c, 'Invalid or expired access token; refresh it or authorize again in the Portal.', true);
  const snap = await svc.data.snapshot();
  if (!maintainerByGithub(snap, tok.uid)) return c.json({ error: { code: 'forbidden', message: 'Maintainers only.' } }, 403);
  const pv = c.req.header('mcp-protocol-version');
  if (pv && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(pv)) return c.json(rpcError(null, -32600, `Unsupported MCP-Protocol-Version ${pv}`), 400);

  let msg: any;
  try {
    msg = await c.req.json();
  } catch {
    return c.json(rpcError(null, -32700, 'Parse error'), 400);
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return c.json(rpcError(null, -32600, 'Invalid request: one JSON-RPC 2.0 message per POST'), 400);
  // Notifications and responses (no `method` + `id` pair to answer): accepted, nothing to say.
  if (msg.id === undefined || msg.id === null || typeof msg.method !== 'string') return c.body(null, 202);

  const id = msg.id;
  const params = msg.params && typeof msg.params === 'object' ? (msg.params as Json) : {};
  switch (msg.method) {
    case 'initialize': {
      const want = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(want) ? want : MCP_PROTOCOL_VERSIONS[0];
      return c.json(
        rpcResult(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: instructions(new URL(c.env.PORTAL_URL).origin),
        }),
      );
    }
    case 'ping':
      return c.json(rpcResult(id, {}));
    case 'tools/list':
      return c.json(rpcResult(id, { tools: TOOL_LIST }));
    case 'tools/call': {
      const tool = typeof params.name === 'string' ? TOOL_BY_NAME.get(params.name) : undefined;
      if (!tool) return c.json(rpcError(id, -32602, `Unknown tool: ${String(params.name)}`));
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Json) : {};
      const actor: Caller = { githubId: tok.uid, login: tok.login, via: 'portal' };
      try {
        return c.json(rpcResult(id, textResult(await tool.run(args, { c, actor }))));
      } catch (e) {
        // Tool failures are results (the model sees them), not protocol errors.
        if (e instanceof ApiError) return c.json(rpcResult(id, textResult({ error: { code: e.code, message: e.message, ...e.details } }, true)));
        console.error('mcp tool failed', tool.name, e instanceof Error ? (e.stack ?? e.message) : String(e));
        return c.json(rpcResult(id, textResult({ error: { code: 'internal', message: 'Internal error' } }, true)));
      }
    }
    default:
      return c.json(rpcError(id, -32601, `Method not found: ${msg.method}`));
  }
});
