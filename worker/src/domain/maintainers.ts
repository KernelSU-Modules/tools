// Maintainers (maintainers.yaml): list with GitHub profiles, add by GitHub login, bind a numeric Telegram user id, remove.
// Every write is one KernelSU Modules Bot commit (commitWithRetry). Preconditions are re-checked against the files at
// the base commit inside the mutate callback, so concurrent edits never lose an update or remove the last maintainer.
//
// Budget (Workers Free: 50 subrequests, 10 ms CPU): profiles (name, avatar, current login) come from GET /user/{id}
// with the maintainer's user token, cached per id for a day in the KvCache; uncached ids are fetched in parallel,
// at most MAX_PROFILE_FETCHES per request, and failures fall back to the stored login + the id-based avatar URL.
import { PreconditionFailed, withTrailers, type CommitPlan, type GitHubClient } from '@kernelsu-modules/github';
import type { Maintainers } from '@kernelsu-modules/schema';
import { getJson, putJson } from '../lib/cache.ts';
import { ApiError } from '../lib/errors.ts';
import type { Services } from '../services.ts';
import { rethrow } from './ops.ts';
import type { Actor } from './state.ts';
import { parseBanned, parseMaintainers, serializeMaintainers } from './yaml.ts';

type Maintainer = Maintainers['maintainers'][number];

/** Row of GET /api/admin/maintainers. */
export interface MaintainerView {
  githubId: number;
  /** Current GitHub login when known (profile), else the stored one. */
  login: string;
  /** GitHub display name, null when unset or unknown. */
  name: string | null;
  avatarUrl: string;
  telegramId: number | null;
}

interface GitHubProfile {
  login: string;
  name: string | null;
  avatarUrl: string;
}

interface GhUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  type?: string;
}

const PROFILE_TTL = 86_400;
/** Uncached profile lookups per request; the rest show stored data until a later request fills the cache. */
export const MAX_PROFILE_FETCHES = 10;
/** GitHub login rules (alphanumerics and single hyphens, ≤ 39 chars); lenient on old logins with odd hyphens. */
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const FILE = 'maintainers.yaml';
const profileKey = (id: number) => `ghuser/${id}`;

export const fallbackAvatar = (id: number) => `https://avatars.githubusercontent.com/u/${id}?s=64`;

/** Only GitHub's avatar host is passed to the browser (64 px); anything else falls back to the id-based URL. */
function avatarOf(url: string | undefined, id: number): string {
  try {
    const u = new URL(url ?? '');
    if (u.protocol !== 'https:' || u.hostname !== 'avatars.githubusercontent.com') return fallbackAvatar(id);
    u.searchParams.set('s', '64');
    return u.toString();
  } catch {
    return fallbackAvatar(id);
  }
}

const toProfile = (u: GhUser): GitHubProfile => ({ login: u.login, name: u.name?.trim() || null, avatarUrl: avatarOf(u.avatar_url, u.id) });

function cacheProfile(svc: Services, id: number, p: GitHubProfile) {
  return putJson(svc.deps.cache, profileKey(id), p, PROFILE_TTL).catch(() => {});
}

/** Cached profiles only (no GitHub requests). */
async function cachedProfiles(svc: Services, ids: readonly number[]): Promise<Map<number, GitHubProfile>> {
  const got = await Promise.all(ids.map((id) => getJson<GitHubProfile>(svc.deps.cache, profileKey(id)).catch(() => null)));
  const out = new Map<number, GitHubProfile>();
  ids.forEach((id, i) => got[i] && out.set(id, got[i]!));
  return out;
}

/** Cached profiles plus parallel lookups of up to MAX_PROFILE_FETCHES missing ones; failures are skipped. */
async function profiles(svc: Services, gh: GitHubClient, ids: readonly number[]): Promise<Map<number, GitHubProfile>> {
  const out = await cachedProfiles(svc, ids);
  const missing = ids.filter((id) => !out.has(id)).slice(0, MAX_PROFILE_FETCHES);
  await Promise.all(
    missing.map(async (id) => {
      try {
        const r = await gh.get<GhUser>(`/user/${id}`, { allow: [404] });
        if (r.status !== 200 || r.data?.id !== id) return;
        const p = toProfile(r.data);
        out.set(id, p);
        await cacheProfile(svc, id, p);
      } catch (e) {
        console.error('maintainer profile lookup failed', id, (e as Error).message);
      }
    }),
  );
  return out;
}

function view(m: Maintainer, p: GitHubProfile | undefined): MaintainerView {
  return {
    githubId: m.github.id,
    login: p?.login ?? m.github.login,
    name: p?.name ?? null,
    avatarUrl: p?.avatarUrl ?? fallbackAvatar(m.github.id),
    telegramId: m.telegram?.id ?? null,
  };
}

export async function listMaintainers(svc: Services, gh: GitHubClient): Promise<MaintainerView[]> {
  const list = (await svc.data.snapshot()).maintainers.maintainers;
  const ps = await profiles(svc, gh, list.map((m) => m.github.id));
  return list.map((m) => view(m, ps.get(m.github.id)));
}

/**
 * One Bot commit of maintainers.yaml. `change` gets the list at the base commit (re-read on every attempt) and
 * throws PreconditionFailed / ApiError to abort. Stored logins are refreshed from cached profiles (renamed accounts),
 * never from new GitHub requests. An unchanged file means no commit.
 */
async function commitMaintainers(
  svc: Services,
  actor: Actor,
  target: number,
  subject: string,
  change: (cur: Maintainer[], read: (path: string) => Promise<string | null>) => Promise<Maintainer[]> | Maintainer[],
): Promise<Maintainer[]> {
  const known = await cachedProfiles(svc, (await svc.data.snapshot()).maintainers.maintainers.map((m) => m.github.id));
  let out: Maintainer[] = [];
  await svc.data
    .commit(async (reader): Promise<CommitPlan> => {
      const text = await reader.read(FILE);
      let cur: Maintainer[];
      try {
        cur = text === null ? [] : parseMaintainers(text).maintainers;
      } catch (e) {
        throw new PreconditionFailed(`${FILE} is invalid; fix it in the data repository first (${(e as Error).message.slice(0, 200)})`, 'invalid-file');
      }
      const next = (await change(cur, (p) => reader.read(p))).map((m) => {
        const login = known.get(m.github.id)?.login;
        return login && login !== m.github.login ? { ...m, github: { ...m.github, login } } : m;
      });
      if (!next.length) throw new PreconditionFailed('at least one maintainer is required', 'last-maintainer');
      out = next;
      const body = serializeMaintainers({ maintainers: next });
      if (body === text) return { files: {}, message: '' };
      return {
        files: { [FILE]: body },
        message: withTrailers(subject, { Action: 'maintainers', Target: `github:${target}`, Actor: `github:${actor.githubId} via ${actor.via}` }),
      };
    })
    .catch(rethrow);
  return out;
}

function notMaintainer(githubId: number): never {
  throw new ApiError(404, 'not-maintainer', `GitHub user #${githubId} is not a maintainer.`);
}

/** POST /api/admin/maintainers {login}: resolves the login with the caller's token; users only (no organizations / bots). */
export async function addMaintainer(svc: Services, actor: Actor, gh: GitHubClient, rawLogin: unknown): Promise<MaintainerView> {
  const login = typeof rawLogin === 'string' ? rawLogin.trim().replace(/^@/, '') : '';
  if (!LOGIN_RE.test(login)) throw new ApiError(400, 'bad-login', 'login must be a GitHub username.');
  const r = await gh.get<GhUser>(`/users/${encodeURIComponent(login)}`, { allow: [404] });
  if (r.status === 404 || !r.data?.id) throw new ApiError(404, 'user-not-found', `GitHub user "${login}" was not found.`);
  const u = r.data;
  if (u.type !== 'User') throw new ApiError(400, 'not-a-user', `@${u.login} is ${u.type === 'Organization' ? 'an organization' : `a ${u.type ?? 'non-user'} account`}; only personal accounts can be maintainers.`);
  const profile = toProfile(u);
  await cacheProfile(svc, u.id, profile);
  let added: Maintainer | undefined;
  await commitMaintainers(svc, actor, u.id, `Add maintainer @${u.login}`, async (cur, read) => {
    if (cur.some((m) => m.github.id === u.id)) throw new PreconditionFailed(`@${u.login} is already a maintainer`, 'already-maintainer');
    const banned = await read('banned.yaml');
    if (banned && parseBanned(banned).banned.some((b) => b.githubId === u.id)) throw new PreconditionFailed(`@${u.login} is banned`, 'banned');
    added = { github: { id: u.id, login: u.login } };
    return [...cur, added];
  });
  return view(added!, profile);
}

/** PATCH /api/admin/maintainers/:githubId {telegramId}: bind (positive integer, unique) or clear (null). */
export async function setMaintainerTelegram(svc: Services, actor: Actor, githubId: number, telegramId: unknown): Promise<MaintainerView> {
  if (telegramId !== null && (typeof telegramId !== 'number' || !Number.isSafeInteger(telegramId) || telegramId <= 0))
    throw new ApiError(400, 'bad-telegram-id', 'telegramId must be a positive integer (the numeric Telegram user id) or null.');
  const subject = telegramId === null ? `Unbind Telegram from maintainer github:${githubId}` : `Bind Telegram to maintainer github:${githubId}`;
  const next = await commitMaintainers(svc, actor, githubId, subject, (cur) => {
    if (!cur.some((m) => m.github.id === githubId)) notMaintainer(githubId);
    const owner = telegramId === null ? undefined : cur.find((m) => m.github.id !== githubId && m.telegram?.id === telegramId);
    if (owner) throw new PreconditionFailed(`Telegram user ${telegramId} is already bound to @${owner.github.login}`, 'telegram-taken');
    return cur.map((m) => (m.github.id !== githubId ? m : telegramId === null ? { github: m.github } : { github: m.github, telegram: { id: telegramId as number } }));
  });
  const m = next.find((x) => x.github.id === githubId)!;
  return view(m, (await cachedProfiles(svc, [githubId])).get(githubId));
}

/** DELETE /api/admin/maintainers/:githubId: never yourself, never the last maintainer. */
export async function removeMaintainer(svc: Services, actor: Actor, githubId: number): Promise<{ removed: number }> {
  if (githubId === actor.githubId) throw new ApiError(400, 'cannot-remove-self', 'You cannot remove yourself; ask another maintainer.');
  await commitMaintainers(svc, actor, githubId, `Remove maintainer github:${githubId}`, (cur) => {
    const gone = cur.find((m) => m.github.id === githubId);
    if (!gone) notMaintainer(githubId);
    if (cur.length <= 1) throw new PreconditionFailed('at least one maintainer is required', 'last-maintainer');
    return cur.filter((m) => m !== gone);
  });
  return { removed: githubId };
}
