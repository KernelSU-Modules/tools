import { docsUrl } from '../lib/docs.ts';
import { Link } from '../router.tsx';
import { useApp, useAsync, useDocumentTitle } from '../context.tsx';
import { Alert, Badge, DL, ErrorBox, ExternalLink, IssueList, Loading, PageHeader } from '../components/ui.tsx';
import { formatBytes, formatDate, githubRepoUrl } from '../lib/format.ts';
import { getRepo } from '../store.ts';
import { ArrowLeft, Eye, FileText, ListChecks, RefreshCw, Send, Tag } from '../components/icons.tsx';
import type { ModuleManifest, PrecheckRelease, PrecheckResult, Repo } from '../api/types.ts';

export function Precheck({ repositoryId }: { repositoryId: number }) {
  const { api, t } = useApp();
  const repo = useAsync(() => getRepo(api, repositoryId), [repositoryId]);
  const result = useAsync(() => api.precheck(repositoryId), [repositoryId]);
  const name = repo.data?.fullName ?? `#${repositoryId}`;
  useDocumentTitle(`${t('action.precheck')} · ${name}`);
  return (
    <div class="page">
      <PageHeader
        title={t('precheck.title', { repo: name })}
        subtitle={t('precheck.subtitle')}
        actions={
          <button type="button" class="btn" onClick={result.reload} disabled={result.loading}>
            <RefreshCw size={16} /> {t('precheck.rerun')}
          </button>
        }
      />
      {result.loading && <Loading label={t('precheck.running')} />}
      <ErrorBox error={result.error} onRetry={result.reload} />
      {result.data && !result.loading && <PrecheckView result={result.data} repo={repo.data} repositoryId={repositoryId} />}
    </div>
  );
}

export function PrecheckView({ result, repo, repositoryId }: { result: PrecheckResult; repo?: Repo | undefined; repositoryId: number }) {
  const { t, lang } = useApp();
  const errors = result.issues.filter((i) => i.severity === 'error').length;
  const warnings = result.issues.length - errors;
  const canSubmit = result.ok && repo?.isAdmin && !repo.registeredId;
  const id = result.manifest?.id;
  return (
    <div class="stack">
      {result.ok ? (
        <Alert tone="success" title={t('precheck.passed')}>
          {warnings > 0 ? t('precheck.passedWithWarnings', { n: warnings }) : t('precheck.passedBody')}
        </Alert>
      ) : (
        <Alert tone="danger" title={t('precheck.failed')}>
          {t('precheck.failedBody', { errors, warnings })}
        </Alert>
      )}
      <div class="grid-2">
        <section class="card" aria-labelledby="pc-release">
          <h2 id="pc-release">
            <Tag size={16} /> {t('precheck.latestRelease')}
          </h2>
          <ReleaseSummary release={result.latestRelease} fullName={repo?.fullName} />
        </section>
        <section class="card" aria-labelledby="pc-manifest">
          <h2 id="pc-manifest">
            <FileText size={16} /> {t('precheck.manifest')}
          </h2>
          <ManifestSummary manifest={result.manifest} />
        </section>
      </div>
      <section class="card" aria-labelledby="pc-issues">
        <h2 id="pc-issues">
          <ListChecks size={16} /> {t('precheck.issues')}
        </h2>
        <IssueList issues={result.issues} />
        <p class="hint">
          {t('precheck.docsHint')} <a href={docsUrl('/checks', lang)}>{t('nav.checks')}</a>
        </p>
      </section>
      <div class="row-actions">
        {canSubmit && (
          <Link class="btn primary" href={`/repos/${repositoryId}/submit${id ? `?id=${encodeURIComponent(id)}` : ''}`}>
            <Send size={16} /> {t('action.submit')}
          </Link>
        )}
        <Link class="btn" href={`/repos/${repositoryId}/preview`}>
          <Eye size={16} /> {t('action.preview')}
        </Link>
        <Link class="btn" href="/repos">
          <ArrowLeft size={16} /> {t('common.back')}
        </Link>
      </div>
    </div>
  );
}

export function ReleaseSummary({ release, fullName }: { release: PrecheckRelease | undefined; fullName?: string | undefined }) {
  const { t, lang } = useApp();
  if (!release) return <p class="muted">{t('precheck.noRelease')}</p>;
  const releaseUrl = release.htmlUrl ?? (fullName ? `${githubRepoUrl(fullName)}/releases/tag/${encodeURIComponent(release.tag)}` : undefined);
  return (
    <DL
      items={[
        [t('release.tag'), releaseUrl ? <ExternalLink href={releaseUrl}><code>{release.tag}</code></ExternalLink> : <code>{release.tag}</code>],
        [
          t('release.immutable'),
          release.immutable ? <Badge tone="success">{t('release.immutableYes')}</Badge> : <Badge tone="danger">{t('release.immutableNo')}</Badge>,
        ],
        [t('release.asset'), release.asset ? <span><code>{release.asset.name}</code> ({formatBytes(release.asset.size)})</span> : '—'],
        ...(release.publishedAt ? ([[t('release.published'), formatDate(release.publishedAt, lang)]] as [string, string][]) : []),
      ]}
    />
  );
}

export function ManifestSummary({ manifest }: { manifest: ModuleManifest | undefined }) {
  const { t } = useApp();
  if (!manifest) return <p class="muted">{t('precheck.noManifest')}</p>;
  return (
    <DL
      items={[
        [t('manifest.id'), <code>{manifest.id}</code>],
        [t('manifest.name'), manifest.name],
        [t('manifest.summary'), manifest.summary],
        [t('manifest.description'), <code>{manifest.description}</code>],
        [t('manifest.license'), manifest.license ?? '—'],
        [t('manifest.tags'), manifest.tags?.length ? manifest.tags.map((x) => <span key={x} class="tag">{x}</span>) : '—'],
        [t('manifest.metamodule'), manifest.metamodule ? t('common.yes') : t('common.no')],
        [t('manifest.assetPattern'), manifest.release?.assetPattern ? <code>{manifest.release.assetPattern}</code> : t('manifest.assetPatternDefault')],
      ]}
    />
  );
}
