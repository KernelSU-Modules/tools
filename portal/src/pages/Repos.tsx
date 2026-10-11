import { Link } from '../router.tsx';
import { useApp, useAsync, useDocumentTitle } from '../context.tsx';
import { Alert, Badge, Empty, ErrorBox, ExternalLink, Loading, PageHeader, TruncatedReposNotice } from '../components/ui.tsx';
import { ArrowLeftRight, Eye, FolderGit2, GitBranch, GithubIcon, ListChecks, Plus, Send } from '../components/icons.tsx';
import { githubRepoUrl } from '../lib/format.ts';
import { getRepos } from '../store.ts';
import type { Repo } from '../api/types.ts';

export function Repos() {
  const { api, me, t } = useApp();
  useDocumentTitle(t('nav.repos'));
  const res = useAsync(() => getRepos(api, true), []);
  const list = res.data?.repos;
  const install = me?.installUrl ? (
    <ExternalLink class="btn primary" href={me.installUrl}>
      <Plus size={16} /> {t('repos.install')}
    </ExternalLink>
  ) : null;
  return (
    <div class="page">
      <PageHeader title={t('nav.repos')} subtitle={t('repos.subtitle')} actions={install} />
      {res.loading && <Loading />}
      <ErrorBox error={res.error} onRetry={res.reload} />
      <TruncatedReposNotice truncated={!!res.data?.truncated} />
      {list && list.length === 0 && (
        <Empty icon={<FolderGit2 size={28} />}>
          <h2>{t('repos.emptyTitle')}</h2>
          <p>{t('repos.emptyBody')}</p>
          {install}
        </Empty>
      )}
      {list && list.length > 0 && (
        <>
          <ul class="cards wide">
            {list.map((r) => (
              <RepoCard key={r.repositoryId} repo={r} />
            ))}
          </ul>
          <Alert tone="info">{t('repos.missingHint')}</Alert>
        </>
      )}
    </div>
  );
}

function RepoCard({ repo }: { repo: Repo }) {
  const { t } = useApp();
  const base = `/repos/${repo.repositoryId}`;
  return (
    <li class="card item-card">
      <h2 class="item-title">
        <GithubIcon size={16} />
        <ExternalLink href={githubRepoUrl(repo.fullName)}>{repo.fullName}</ExternalLink>
      </h2>
      <div class="badges">
        <Badge tone="success">{t('repos.installed')}</Badge>
        {repo.private && <Badge tone="warning" title={t('repos.privateHint')}>{t('repos.private')}</Badge>}
        {repo.isAdmin ? <Badge tone="info">{t('repos.admin')}</Badge> : <Badge title={t('repos.notAdminHint')}>{t('repos.notAdmin')}</Badge>}
        {repo.registeredId && (
          <Link class="badge badge-neutral" href={`/modules/${encodeURIComponent(repo.registeredId)}`}>
            {t('repos.registeredAs', { id: repo.registeredId })}
          </Link>
        )}
      </div>
      <p class="meta">
        <span>
          <GitBranch size={14} /> {t('repos.defaultBranch')}: <code>{repo.defaultBranch}</code>
        </span>
        <span>
          {t('repos.installation')}: <code>{repo.installationId}</code>
        </span>
      </p>
      {!repo.isAdmin && <p class="small warn-text">{t('repos.notAdminHint')}</p>}
      {repo.private && <p class="small warn-text">{t('repos.privateHint')}</p>}
      <nav class="row-actions" aria-label={t('repos.actionsFor', { repo: repo.fullName })}>
        <Link class="btn sm" href={`${base}/precheck`}>
          <ListChecks size={14} /> {t('action.precheck')}
        </Link>
        <Link class="btn sm" href={`${base}/preview`}>
          <Eye size={14} /> {t('action.preview')}
        </Link>
        {repo.isAdmin && !repo.registeredId && (
          <>
            <Link class="btn sm" href={`${base}/submit`}>
              <Send size={14} /> {t('action.submit')}
            </Link>
            <Link class="btn sm" href={`/transfer?repositoryId=${repo.repositoryId}`}>
              <ArrowLeftRight size={14} /> {t('action.transferHere')}
            </Link>
          </>
        )}
      </nav>
    </li>
  );
}
