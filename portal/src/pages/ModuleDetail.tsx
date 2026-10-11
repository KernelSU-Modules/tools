import { Link } from '../router.tsx';
import { useApp, useAsync, useDocumentTitle } from '../context.tsx';
import { Badge, DL, ErrorBox, ExternalLink, HealthBadge, Loading, PageHeader, StatusBadge } from '../components/ui.tsx';
import { SyncButton } from '../components/SyncButton.tsx';
import { Activity, ArrowLeft, ArrowLeftRight, ExternalLinkIcon, Eye, FolderGit2, ListChecks, Tag } from '../components/icons.tsx';
import { formatDate, githubRepoUrl, publicModuleUrl } from '../lib/format.ts';
import { canSync, isPublic } from '../lib/status.ts';
import { ReasonNotes } from './Modules.tsx';

export function ModuleDetail({ id }: { id: string }) {
  const { api, t, lang } = useApp();
  useDocumentTitle(id);
  const mod = useAsync(() => api.module(id), [id]);
  if (mod.loading && !mod.data) return <Loading />;
  if (mod.error) return <ErrorBox error={mod.error} onRetry={mod.reload} />;
  const m = mod.data!;
  const src = m.source ?? m.request?.source;
  const sync = m.sync;
  const stable = sync?.stable;
  // The sync's view of the bound repository (status.json follows `source`, not a pending transfer target).
  const syncRepo = sync?.fullName ?? src?.fullName;
  return (
    <div class="page">
      <PageHeader
        title={
          <>
            <code class="title-code">{m.id}</code> <StatusBadge status={m.status} />
          </>
        }
        subtitle={src ? <ExternalLink href={githubRepoUrl(src.fullName)}>{src.fullName}</ExternalLink> : undefined}
        actions={
          <>
            {canSync(m) && <SyncButton id={m.id} onDone={() => setTimeout(mod.reload, 1500)} />}
            {isPublic(m) && (
              <ExternalLink class="btn sm" href={publicModuleUrl(m.id, lang)}>
                <ExternalLinkIcon size={14} /> {t('modules.publicPage')}
              </ExternalLink>
            )}
          </>
        }
      />
      <ReasonNotes m={m} />
      <div class="grid-2">
        <section class="card" aria-labelledby="md-stable">
          <h2 id="md-stable">
            <Tag size={16} /> {t('modules.stable')}
          </h2>
          {stable ? (
            <DL
              items={[
                [
                  t('release.tag'),
                  syncRepo ? (
                    <ExternalLink href={`${githubRepoUrl(syncRepo)}/releases/tag/${encodeURIComponent(stable.tag)}`}>
                      <code>{stable.tag}</code>
                    </ExternalLink>
                  ) : (
                    <code>{stable.tag}</code>
                  ),
                ],
                [t('release.version'), stable.version],
                [t('release.versionCode'), <code>{stable.versionCode}</code>],
                [t('release.published'), formatDate(stable.publishedAt, lang)],
                [t('modules.maxVersionCode'), sync?.maxVersionCode != null ? <code>{sync.maxVersionCode}</code> : '—'],
              ]}
            />
          ) : (
            <>
              <p class="muted">{t('modules.noStable')}</p>
              {sync?.maxVersionCode != null && (
                <p class="small">
                  {t('modules.maxVersionCode')}: <code>{sync.maxVersionCode}</code>
                </p>
              )}
            </>
          )}
          {sync?.maxVersionCode != null && <p class="hint">{t('modules.maxVersionCodeHint')}</p>}
        </section>
        <section class="card" aria-labelledby="md-sync">
          <h2 id="md-sync">
            <Activity size={16} /> {t('modules.syncHealth')}
          </h2>
          {sync ? (
            <DL
              items={[
                [t('common.status'), <HealthBadge health={sync.health} installation={sync.installation} />],
                [t('modules.installation'), sync.installation === 'present' ? <Badge tone="success">{t('modules.installPresent')}</Badge> : <Badge tone="danger">{t('modules.installMissing')}</Badge>],
                [t('modules.lastSync'), formatDate(sync.lastSuccessAt, lang)],
                [t('modules.healthMessage'), sync.message ?? '—'],
                [
                  t('modules.contentCommit'),
                  sync.contentCommit && syncRepo ? (
                    <ExternalLink href={`${githubRepoUrl(syncRepo)}/commit/${sync.contentCommit}`}>{sync.contentCommit.slice(0, 12)}</ExternalLink>
                  ) : (
                    '—'
                  ),
                ],
              ]}
            />
          ) : (
            <p class="muted">{t('modules.notSynced')}</p>
          )}
        </section>
      </div>
      {src && (
        <section class="card" aria-labelledby="md-source">
          <h2 id="md-source">
            <FolderGit2 size={16} /> {t('modules.source')}
          </h2>
          <DL
            items={[
              [t('modules.repo'), <ExternalLink href={githubRepoUrl(src.fullName)}>{src.fullName}</ExternalLink>],
              ['repositoryId', <code>{src.repositoryId}</code>],
              [t('modules.ref'), <code>{src.ref ?? t('modules.defaultBranch')}</code>],
              [t('modules.manifestPath'), <code>{src.manifestPath}</code>],
            ]}
          />
          <div class="row-actions">
            <Link class="btn sm" href={`/repos/${src.repositoryId}/preview`}>
              <Eye size={14} /> {t('action.preview')}
            </Link>
            <Link class="btn sm" href={`/repos/${src.repositoryId}/precheck`}>
              <ListChecks size={14} /> {t('action.precheck')}
            </Link>
            {(m.status === 'listed' || m.status === 'suspended') && (
              <Link class="btn sm" href={`/transfer?id=${encodeURIComponent(m.id)}`}>
                <ArrowLeftRight size={14} /> {t('action.transfer')}
              </Link>
            )}
          </div>
        </section>
      )}
      <Link class="back" href="/modules">
        <ArrowLeft size={16} /> {t('nav.modules')}
      </Link>
    </div>
  );
}
