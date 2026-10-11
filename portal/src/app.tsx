import { docsUrl } from './lib/docs.ts';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';
import { ApiClient, ApiError } from './api/client.ts';
import type { Me } from './api/types.ts';
import { AppContext, type AppCtx, useApp, useAsync, useDocumentTitle } from './context.tsx';
import { detectLang, type Lang, LANG_STORAGE_KEY, type MessageKey, translate } from './i18n/index.ts';
import { Alert, Avatar, Badge, ErrorBox, Loading, PageHeader } from './components/ui.tsx';
import { LangSelect } from './components/LangSelect.tsx';
import {
  Activity,
  ArrowLeft,
  ArrowLeftRight,
  Ban,
  BookOpen,
  Eye,
  FileText,
  FolderGit2,
  Inbox,
  ListChecks,
  LogOut,
  LucideProvider,
  Menu,
  Package,
  Send,
  ShieldAlert,
  Users,
  X,
} from './components/icons.tsx';
import { Link, navigate, useLocation } from './router.tsx';
import { matchRoute } from './lib/route.ts';
import { getRepo, invalidate } from './store.ts';
import { Landing } from './pages/Landing.tsx';
import { Repos } from './pages/Repos.tsx';
import { Precheck } from './pages/Precheck.tsx';
import { Submit } from './pages/Submit.tsx';
import { Transfer } from './pages/Transfer.tsx';
import { Modules } from './pages/Modules.tsx';
import { ModuleDetail } from './pages/ModuleDetail.tsx';
import { Preview } from './pages/Preview.tsx';
import { Queue, RequestDetail } from './pages/admin/Queue.tsx';
import { Moderation } from './pages/admin/Moderation.tsx';
import { Maintainers } from './pages/admin/Maintainers.tsx';
import { Banned } from './pages/admin/Banned.tsx';
import { Status } from './pages/admin/Status.tsx';

function readStoredLang(): string | null {
  try {
    return localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function App({ api, extra }: { api: ApiClient; extra?: ComponentChildren }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang(readStoredLang(), navigator.languages ?? [navigator.language]));
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<ApiError | null>(null);
  const [booting, setBooting] = useState(true);

  const reloadMe = async () => {
    try {
      setMe(await api.me());
      setMeError(null);
    } catch (e) {
      setMeError(e instanceof ApiError ? e : new ApiError(0, 'client', String(e)));
    } finally {
      setBooting(false);
    }
  };
  useEffect(() => {
    void reloadMe();
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const ctx = useMemo<AppCtx>(
    () => ({
      api,
      me,
      lang,
      setLang(l) {
        setLangState(l);
        try {
          localStorage.setItem(LANG_STORAGE_KEY, l);
        } catch {
          /* private mode */
        }
      },
      t: (key, params) => translate(lang, key, params),
      reloadMe,
    }),
    [api, me, lang],
  );

  const signedIn = !!me?.user;
  return (
    <AppContext.Provider value={ctx}>
      <LucideProvider size={16} strokeWidth={1.8}>
        <a class="skip-link" href="#main">
          {translate(lang, 'nav.skip')}
        </a>
        {extra}
        {booting ? (
          <div class="center">
            <Loading />
          </div>
        ) : meError ? (
          <div class="center">
            <div class="auth-card" id="main">
              <ErrorBox error={meError} onRetry={() => void reloadMe()} />
            </div>
          </div>
        ) : signedIn ? (
          <Shell />
        ) : (
          <SignedOut />
        )}
      </LucideProvider>
    </AppContext.Provider>
  );
}

/** Signed out: every path shows the centered sign-in card (deep links get a "please sign in" note). */
function SignedOut() {
  const { path } = useLocation();
  return <Landing required={!(path === '/' || path === '')} />;
}

type NavItem = { href: string; label: string; icon: LucideIcon; active: boolean };

const REPO_PAGE = /^\/repos\/(\d{1,16})\/(precheck|submit|preview)\/?$/;

function NavLinks({ items }: { items: NavItem[] }) {
  return (
    <>
      {items.map(({ href, label, icon: Icon, active }) => (
        <Link key={href} href={href} class={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
          <Icon size={18} /> {label}
        </Link>
      ))}
    </>
  );
}

function NavGroup({ id, title, items, titleAttr }: { id: string; title: string; items: NavItem[]; titleAttr?: string }) {
  return (
    <div class="nav-group" role="group" aria-labelledby={id}>
      <div class="nav-title" id={id} title={titleAttr}>
        {title}
      </div>
      <NavLinks items={items} />
    </div>
  );
}

/** Contextual group for /repos/:rid/{precheck,submit,preview}. */
function RepoNav({ repositoryId, page }: { repositoryId: number; page: string }) {
  const { api, t } = useApp();
  const { query } = useLocation();
  const repo = useAsync(() => getRepo(api, repositoryId), [repositoryId]);
  const r = repo.data;
  const name = r?.fullName ?? query.get('repo') ?? `#${repositoryId}`;
  const base = `/repos/${repositoryId}`;
  const keep = query.get('repo') ? `?repo=${encodeURIComponent(query.get('repo')!)}` : '';
  const canRegister = !!r?.isAdmin && !r.registeredId;
  const items: NavItem[] = [
    { href: `${base}/precheck`, label: t('action.precheck'), icon: ListChecks, active: page === 'precheck' },
    { href: `${base}/preview${keep}`, label: t('action.preview'), icon: Eye, active: page === 'preview' },
    ...(canRegister || page === 'submit' ? [{ href: `${base}/submit`, label: t('action.submit'), icon: Send, active: page === 'submit' }] : []),
  ];
  return <NavGroup id="nav-repo" title={name} titleAttr={t('nav.repoGroup', { repo: name })} items={items} />;
}

/** Title shown in the top bar (section name; the page itself carries the detailed <h1>). */
function topbarTitle(path: string, t: AppCtx['t']): string {
  const repoPage = REPO_PAGE.exec(path)?.[2];
  if (repoPage) return t(`action.${repoPage}` as MessageKey);
  if (path === '/' || path === '' || matchRoute('/repos', path)) return t('nav.repos');
  if (matchRoute('/transfer', path)) return t('action.transfer');
  if (path === '/modules' || path.startsWith('/modules/')) return t('nav.modules');
  if (matchRoute('/admin', path) || matchRoute('/admin/queue', path) || path.startsWith('/admin/requests/')) return t('admin.queue');
  if (matchRoute('/admin/modules', path)) return t('admin.moderation');
  if (matchRoute('/admin/status', path)) return t('admin.status');
  if (matchRoute('/admin/maintainers', path)) return t('admin.maintainers');
  if (matchRoute('/admin/banned', path)) return t('admin.banned');
  return '';
}

function Shell() {
  const { me, t, lang, api } = useApp();
  const { path } = useLocation();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const user = me!.user!;

  // Close the mobile drawer and reset the scroll container on navigation.
  useEffect(() => {
    setOpen(false);
    if (!location.hash && panel.current) panel.current.scrollTop = 0;
  }, [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      /* ignore; reload anyway */
    }
    invalidate();
    location.assign('/');
  };

  const developer: NavItem[] = [
    { href: '/repos', label: t('nav.repos'), icon: FolderGit2, active: path === '/' || !!matchRoute('/repos', path) },
    { href: '/modules', label: t('nav.modules'), icon: Package, active: path === '/modules' || path.startsWith('/modules/') },
    { href: '/transfer', label: t('action.transfer'), icon: ArrowLeftRight, active: !!matchRoute('/transfer', path) },
  ];
  const maintainers: NavItem[] = [
    { href: '/admin', label: t('admin.queue'), icon: Inbox, active: !!matchRoute('/admin', path) || !!matchRoute('/admin/queue', path) || path.startsWith('/admin/requests/') },
    { href: '/admin/modules', label: t('admin.moderation'), icon: ShieldAlert, active: !!matchRoute('/admin/modules', path) },
    { href: '/admin/status', label: t('admin.status'), icon: Activity, active: !!matchRoute('/admin/status', path) },
    { href: '/admin/maintainers', label: t('admin.maintainers'), icon: Users, active: !!matchRoute('/admin/maintainers', path) },
    { href: '/admin/banned', label: t('admin.banned'), icon: Ban, active: !!matchRoute('/admin/banned', path) },
  ];
  const repoPage = REPO_PAGE.exec(path);

  return (
    <div class={`layout${open ? ' nav-open' : ''}`}>
      <aside class="sidebar" id="sidebar">
        <Link href="/" class="brand">
          <img class="logo" src="/kernelsu-logo.svg" alt="" width="30" height="30" />
          <span class="brand-text">
            <span class="brand-name">KernelSU</span>
            <span class="brand-sub">{t('brand.sub')}</span>
          </span>
        </Link>
        <nav class="nav" aria-label={t('nav.main')}>
          <NavGroup id="nav-dev" title={t('nav.group.developer')} items={developer} />
          {repoPage && <RepoNav key={repoPage[1]} repositoryId={Number(repoPage[1])} page={repoPage[2]!} />}
          {me!.isMaintainer && <NavGroup id="nav-admin" title={t('nav.admin')} items={maintainers} />}
          <div class="nav-group" role="group" aria-labelledby="nav-res">
            <div class="nav-title" id="nav-res">
              {t('nav.group.resources')}
            </div>
            <a href={docsUrl('/', lang)}>
              <BookOpen size={18} /> {t('nav.docs')}
            </a>
            <a href={docsUrl('/checks', lang)}>
              <FileText size={18} /> {t('nav.checks')}
            </a>
          </div>
        </nav>
        <div class="spacer" />
        <div class="user-box">
          <LangSelect />
          <div class="row">
            <Avatar url={user.avatarUrl} login={user.login} />
            <div class="who">
              <div class="name">{user.login}</div>
              <div class="sub">
                {me!.isMaintainer ? <Badge tone="info">{t('role.maintainer')}</Badge> : t('role.developer')}
              </div>
            </div>
          </div>
          <button type="button" class="logout" onClick={logout}>
            <LogOut size={18} /> {t('auth.signOut')}
          </button>
        </div>
      </aside>
      <div class="scrim" aria-hidden="true" onClick={() => setOpen(false)} />
      <div class="main">
        <header class="topbar">
          <button
            type="button"
            class="icon-btn menu-btn"
            aria-label={t('nav.toggleMenu')}
            aria-controls="sidebar"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div class="topbar-title">{topbarTitle(path, t)}</div>
        </header>
        <main id="main" class="panel" ref={panel}>
          <div class="panel-body">
            <Routes />
          </div>
          <footer class="site-footer">
            <a href="https://modules.kernelsu.org/" rel="noopener">
              modules.kernelsu.org
            </a>
            <a href="https://github.com/KernelSU-Modules/tools" rel="noopener">
              GitHub
            </a>
          </footer>
        </main>
      </div>
    </div>
  );
}

function NotFound() {
  const { t } = useApp();
  useDocumentTitle(t('error.notFound'));
  return (
    <div class="page">
      <PageHeader title={t('error.notFound')} />
      <Link class="btn back" href="/">
        <ArrowLeft size={16} /> {t('common.home')}
      </Link>
    </div>
  );
}

function MaintainerOnly() {
  const { t } = useApp();
  return (
    <div class="page">
      <Alert tone="danger" title={t('error.forbidden')}>
        {t('admin.onlyMaintainers')}
      </Alert>
    </div>
  );
}

const intParam = (s: string | undefined): number | null => (s && /^\d{1,16}$/.test(s) ? Number(s) : null);

function Routes() {
  const { me } = useApp();
  const { path, query } = useLocation();
  const signedIn = !!me?.user;

  if (!signedIn) return null; // the shell is only rendered for signed-in users
  if (path === '/' || path === '') return <Repos />;

  let p: Record<string, string> | null;
  if (matchRoute('/repos', path)) return <Repos />;
  if ((p = matchRoute('/repos/:rid/precheck', path)) && intParam(p.rid)) return <Precheck repositoryId={intParam(p.rid)!} />;
  if ((p = matchRoute('/repos/:rid/submit', path)) && intParam(p.rid)) return <Submit repositoryId={intParam(p.rid)!} initialId={query.get('id')} />;
  if ((p = matchRoute('/repos/:rid/preview', path)) && intParam(p.rid)) return <Preview repositoryId={intParam(p.rid)!} repoName={query.get('repo')} />;
  if (matchRoute('/transfer', path)) return <Transfer initialId={query.get('id')} initialRepositoryId={intParam(query.get('repositoryId') ?? undefined)} />;
  if (matchRoute('/modules', path)) return <Modules />;
  if ((p = matchRoute('/modules/:id', path))) return <ModuleDetail id={p.id!} />;

  if (path === '/admin' || path.startsWith('/admin/')) {
    if (!me.isMaintainer) return <MaintainerOnly />;
    if (matchRoute('/admin', path) || matchRoute('/admin/queue', path)) return <Queue />;
    if ((p = matchRoute('/admin/requests/:sid', path))) return <RequestDetail submissionId={p.sid!} />;
    if (matchRoute('/admin/modules', path)) return <Moderation initialId={query.get('id')} />;
    if (matchRoute('/admin/maintainers', path)) return <Maintainers />;
    if (matchRoute('/admin/banned', path)) return <Banned />;
    if (matchRoute('/admin/status', path)) return <Status />;
  }
  return <NotFound />;
}

export { navigate };
