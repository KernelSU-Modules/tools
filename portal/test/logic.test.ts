import { describe, expect, it } from 'vitest';
import { MODULE_ID_PATTERN as SCHEMA_PATTERN } from '@kernelsu-modules/schema';
import { attention, canSync, groupIssues, healthTone, isPublic, moderationActions, RECORD_STATUSES, requestCheckOf, statusKey, statusTone } from '../src/lib/status.ts';
import { idFormatError, MODULE_ID_PATTERN, suggestId } from '../src/lib/ids.ts';
import { parseLogin, parseTelegramId, rejectNeedsText, telegramOwner } from '../src/lib/admin.ts';
import { healthSummary, runTone, sortByHealth } from '../src/lib/dashboard.ts';
import { formatBytes, formatWait, publicModuleUrl } from '../src/lib/format.ts';
import { blockSync, syncBlockedUntil } from '../src/lib/ratelimit.ts';
import { buildPreviewDoc, renderPreview } from '../src/lib/preview.ts';
import { matchRoute, isServerPath } from '../src/lib/route.ts';
import { docsUrl, issueDocUrl } from '../src/lib/docs.ts';
import { loginUrl } from '../src/lib/login.ts';
import type { ModuleStatus, MyModule, SyncHealth } from '../src/api/types.ts';

const status = (health: SyncHealth, installation: ModuleStatus['installation'] = 'present', extra: Partial<ModuleStatus> = {}): ModuleStatus => ({
  repositoryId: 1, fullName: 'x/y', health, installation, lastSuccessAt: null, message: null, contentCommit: null, stable: null, maxVersionCode: null, request: null, ...extra,
});

describe('status mapping', () => {
  it('covers every record status', () => {
    expect(RECORD_STATUSES).toHaveLength(5);
    expect(RECORD_STATUSES.map(statusTone)).toEqual(['info', 'success', 'danger', 'warning', 'neutral']);
    for (const s of RECORD_STATUSES) expect(statusKey(s)).toBe(`status.${s}`);
    expect(statusKey('weird')).toBe('status.unknown');
    expect(statusTone('weird')).toBe('neutral');
  });
  it('health tone', () => {
    expect(healthTone('ok')).toBe('success');
    expect(healthTone('ok', 'missing')).toBe('warning');
    expect(healthTone('stale')).toBe('warning');
    expect(healthTone('error')).toBe('danger');
    expect(healthTone(undefined)).toBe('neutral');
  });
  it('moderation follows the record state machine', () => {
    expect(moderationActions('listed')).toEqual(['suspend', 'archive']);
    expect(moderationActions('suspended')).toEqual(['unsuspend', 'archive']);
    expect(moderationActions('pending')).toEqual([]);
    expect(moderationActions('archived')).toEqual([]);
  });
  it('visibility, sync and attention', () => {
    const m: MyModule = { id: 'a', status: 'listed', sync: status('error', 'missing') };
    expect(isPublic(m)).toBe(false);
    expect(isPublic({ status: 'listed', sync: status('ok', 'present', { stable: { tag: 'v1', version: '1', versionCode: 1, publishedAt: '2026-10-10T00:00:00Z' } }) })).toBe(true);
    expect(canSync(m)).toBe(true);
    expect(canSync({ status: 'pending' })).toBe(false);
    expect(canSync({ status: 'rejected' })).toBe(false);
    expect(attention(m)).toEqual(['attention.noStable', 'attention.installMissing', 'attention.syncError']);
    expect(attention({ id: 'b', status: 'rejected' })).toEqual(['attention.rejected']);
  });
  it('records with an open request can be synced and surface a failed sync check', () => {
    const request = {
      submissionId: 'abcdefghij', kind: 'submit' as const, submittedBy: 1, submittedAt: '2026-10-10T00:00:00Z',
      source: { host: 'github' as const, repositoryId: 2, ownerId: 1, fullName: 'x/z', manifestPath: 'module.yaml' },
    };
    const check = { submissionId: 'abcdefghij', repositoryId: 2, ok: false, checkedAt: '2026-10-10T00:00:00Z', latestTag: null, issues: [{ code: 'asset-none', severity: 'error' as const }] };
    expect(canSync({ status: 'pending', request })).toBe(true);
    expect(attention({ id: 'r', status: 'pending', request, sync: status('ok', 'present', { request: check }) })).toEqual(['attention.requestCheckFailed']);
    expect(attention({ id: 'r', status: 'pending', request, sync: status('ok', 'present', { request: { ...check, ok: true } }) })).toEqual([]);
    // a check for an older request is ignored
    const stale = { ...check, submissionId: 'zzzzzzzzzz' };
    expect(requestCheckOf({ request, sync: status('ok', 'present', { request: stale }) })).toBeNull();
    expect(attention({ id: 'r', status: 'pending', request, sync: status('ok', 'present', { request: stale }) })).toEqual([]);
    expect(requestCheckOf({ sync: status('ok', 'present', { request: check }) })).toBeNull();
  });
  it('groups issues by severity preserving order', () => {
    const g = groupIssues([
      { code: 'a', severity: 'warning', message: '' },
      { code: 'b', severity: 'error', message: '' },
      { code: 'c', severity: 'error', message: '' },
    ]);
    expect(g.error.map((i) => i.code)).toEqual(['b', 'c']);
    expect(g.warning.map((i) => i.code)).toEqual(['a']);
  });
});

describe('ids', () => {
  it('local pattern mirrors the schema package', () => {
    expect(MODULE_ID_PATTERN.source).toBe(SCHEMA_PATTERN.source);
  });
  it('format errors', () => {
    expect(idFormatError('')).toBe('empty');
    expect(idFormatError('a')).toBe('tooShort');
    expect(idFormatError('a'.repeat(65))).toBe('tooLong');
    expect(idFormatError('1abc')).toBe('pattern');
    expect(idFormatError('demo.tool_box-2')).toBeNull();
  });
  it('suggests valid ids from repo names', () => {
    expect(suggestId('alice/zygisk-assistant')).toBe('zygisk-assistant');
    expect(suggestId('alice/123 My Mod!')).toBe('My_Mod_');
    expect(idFormatError(suggestId('x/__ok'))).toBeNull();
  });
});

describe('admin helpers', () => {
  it('reject text is required only for "other"', () => {
    expect(rejectNeedsText('other')).toBe(true);
    expect(rejectNeedsText('spam')).toBe(false);
  });
  it('parses the add-maintainer login input', () => {
    expect(parseLogin(' octocat ')).toBe('octocat');
    expect(parseLogin('@Octo-Cat')).toBe('Octo-Cat');
    expect(parseLogin('https://github.com/octocat')).toBe('octocat');
    expect(parseLogin('github.com/octocat/')).toBe('octocat');
    for (const bad of ['', '-x', 'a b', 'a'.repeat(40), 'https://github.com/a/b', 'https://gitlab.com/x']) expect(parseLogin(bad), bad).toBeNull();
  });
  it('validates Telegram user ids and detects bindings taken by another maintainer', () => {
    expect(parseTelegramId('')).toBeNull();
    expect(parseTelegramId(' 819401657 ')).toBe(819401657);
    for (const bad of ['0', '-5', '1.5', '@name', '12a', '99999999999999999']) expect(parseTelegramId(bad), bad).toBe('invalid');
    const list = [
      { githubId: 1, login: 'a', name: null, avatarUrl: '', telegramId: 9 },
      { githubId: 2, login: 'b', name: null, avatarUrl: '', telegramId: null },
    ];
    expect(telegramOwner(list, 2, 9)?.login).toBe('a');
    expect(telegramOwner(list, 1, 9)).toBeNull();
    expect(telegramOwner(list, 2, null)).toBeNull();
  });
});

describe('dashboard', () => {
  const mods = [
    { ...status('ok'), id: 'b' },
    { ...status('error', 'missing'), id: 'a' },
    { ...status('stale'), id: 'c' },
  ];
  it('summarizes and sorts', () => {
    expect(healthSummary(mods)).toEqual({ total: 3, ok: 1, stale: 1, error: 1, installMissing: 1 });
    expect(sortByHealth(mods).map((m) => m.id)).toEqual(['a', 'c', 'b']);
  });
  it('run tone', () => {
    expect(runTone({ status: 'in_progress', conclusion: null })).toBe('info');
    expect(runTone({ status: 'completed', conclusion: 'success' })).toBe('success');
    expect(runTone({ status: 'completed', conclusion: 'failure' })).toBe('danger');
  });
});

describe('format, rate limit, routing', () => {
  it('format helpers', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatWait(59)).toBe('59s');
    expect(formatWait(125)).toBe('2:05');
    expect(publicModuleUrl('demo.toolbox', 'zh-CN')).toBe('https://modules.kernelsu.org/zh-CN/modules/demo.toolbox/');
    expect(publicModuleUrl('demo.toolbox', 'en')).toBe('https://modules.kernelsu.org/en/modules/demo.toolbox/');
  });
  it('sync rate limit memory', () => {
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    expect(syncBlockedUntil(kv, 'x', 1000)).toBeNull();
    const until = blockSync(kv, 'x', 30, 1000);
    expect(until).toBe(31_000);
    expect(syncBlockedUntil(kv, 'x', 2000)).toBe(31_000);
    expect(syncBlockedUntil(kv, 'x', 40_000)).toBeNull();
    expect(m.size).toBe(0);
    expect(blockSync(kv, 'y', null, 0)).toBe(600_000);
  });
  it('route matching', () => {
    expect(matchRoute('/repos/:rid/precheck', '/repos/12/precheck')).toEqual({ rid: '12' });
    expect(matchRoute('/repos/:rid/precheck', '/repos/12/precheck/')).toEqual({ rid: '12' });
    expect(matchRoute('/modules/:id', '/modules/a%2Eb')).toEqual({ id: 'a.b' });
    expect(matchRoute('/modules/:id', '/modules')).toBeNull();
    expect(matchRoute('/modules/:id', '/modules/%E0%A4%A')).toBeNull();
    expect(isServerPath('/docs/checks')).toBe(true);
    expect(isServerPath('/auth/login')).toBe(true);
    expect(isServerPath('/documents')).toBe(false);
  });
  it('docs links are locale-aware', () => {
    const routes = { 'zh-CN': ['/', '/checks'] };
    expect(issueDocUrl('release-not-immutable', 'en', routes)).toBe('/docs/checks#release-not-immutable');
    expect(issueDocUrl('release-not-immutable', 'zh-CN', routes)).toBe('/docs/zh-CN/checks#release-not-immutable');
    expect(docsUrl('/faq', 'zh-CN', undefined, routes)).toBe('/docs/faq');
    expect(docsUrl('/', 'zh-CN', undefined, routes)).toBe('/docs/zh-CN/');
  });
  it('login url only forwards same-origin paths', () => {
    expect(loginUrl('/')).toBe('/auth/login');
    expect(loginUrl('/admin/requests/abcdefghij')).toBe('/auth/login?next=%2Fadmin%2Frequests%2Fabcdefghij');
    expect(loginUrl('//evil.example')).toBe('/auth/login');
  });
});

describe('preview rendering (client-side, @kernelsu-modules/render)', () => {
  it('renders raw markdown with the site sanitizer and resolves relative links against ctx', async () => {
    const commit = 'a'.repeat(40);
    const html = await renderPreview({
      markdown: '# Hi\n\n**bold** <script>alert(1)</script> [doc](docs/USAGE.md) ![img](img/a.png) <img src="x" onerror="alert(1)">\n',
      ctx: { fullName: 'alice/mod', commit, docPath: 'README.md' },
    });
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toMatch(/<script|onerror/i);
    expect(html).toContain(`https://github.com/alice/mod/blob/${commit}/docs/USAGE.md`);
    expect(html).toContain(`https://raw.githubusercontent.com/alice/mod/${commit}/img/a.png`);
  });
});

describe('preview document', () => {
  it('embeds sanitized html with a restrictive CSP and external stylesheet', () => {
    const doc = buildPreviewDoc('<p>hi</p>', { origin: 'https://developers.kernelsu.org/', lang: 'zh-CN', dark: true });
    expect(doc).toContain('<main class="markdown-body"><p>hi</p></main>');
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain('href="https://developers.kernelsu.org/preview.css"');
    expect(doc).toContain('lang="zh-CN" class="dark"');
    expect(doc).not.toMatch(/<script/i);
    expect(doc).not.toMatch(/<style/i);
  });
});
