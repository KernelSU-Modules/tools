import { Link } from '../router.tsx';
import { useApp, useAsync, useDocumentTitle } from '../context.tsx';
import { Alert, Badge, DL, Empty, ErrorBox, ExternalLink, HealthBadge, Loading, PageHeader, RequestCheckView, StatusBadge } from '../components/ui.tsx';
import { SyncButton } from '../components/SyncButton.tsx';
import { ExternalLinkIcon, FolderGit2, Package, RefreshCw, TriangleAlert } from '../components/icons.tsx';
import { formatDate, formatRelative, githubRepoUrl, publicModuleUrl } from '../lib/format.ts';
import { attention, canSync, isPublic, requestCheckOf } from '../lib/status.ts';
import { getModules } from '../store.ts';
import type { MyModule } from '../api/types.ts';
import type { MessageKey } from '../i18n/index.ts';

export function Modules() {
  const { api, t } = useApp();
  useDocumentTitle(t('nav.modules'));
  const mods = useAsync(() => getModules(api, true), []);
  return (
    <div class="page">
      <PageHeader
        title={t('nav.modules')}
        subtitle={t('modules.subtitle')}
        actions={
          <button type="button" class="btn" onClick={mods.reload} disabled={mods.loading}>
            <RefreshCw size={16} /> {t('common.refresh')}
          </button>
        }
      />
      {mods.loading && !mods.data && <Loading />}
      <ErrorBox error={mods.error} onRetry={mods.reload} />
      {mods.data && mods.data.length === 0 && (
        <Empty icon={<Package size={28} />}>
          <p>{t('modules.empty')}</p>
          <Link class="btn primary" href="/repos">
            <FolderGit2 size={16} /> {t('nav.repos')}
          </Link>
        </Empty>
      )}
      {mods.data && mods.data.length > 0 && (
        <ul class="cards wide">
          {mods.data.map((m) => (
            <ModuleCard key={m.id} m={m} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ModuleCard({ m }: { m: MyModule }) {
  const { t, lang } = useApp();
  const sync = m.sync;
  const stable = sync?.stable;
  const notes = attention(m);
  return (
    <li class="card item-card">
      <div class="item-head">
        <h2 class="item-title">
          <Package size={16} />
          <Link href={`/modules/${encodeURIComponent(m.id)}`}>{m.id}</Link>
        </h2>
        <div class="badges">
          <StatusBadge status={m.status} />
          {sync && <HealthBadge health={sync.health} installation={sync.installation} />}
          {m.request && <Badge tone="info">{t(`kind.${m.request.kind}` as MessageKey)}</Badge>}
        </div>
      </div>
      <DL
        items={[
          [
            t('modules.repo'),
            m.source ? (
              <ExternalLink href={githubRepoUrl(m.source.fullName)}>{m.source.fullName}</ExternalLink>
            ) : m.request ? (
              <ExternalLink href={githubRepoUrl(m.request.source.fullName)}>{m.request.source.fullName}</ExternalLink>
            ) : (
              '—'
            ),
          ],
          [t('modules.stable'), stable ? <span><strong>{stable.version}</strong> <code>({stable.versionCode})</code></span> : t('modules.noStable')],
          [t('modules.lastSync'), sync ? <time dateTime={sync.lastSuccessAt ?? undefined} title={formatDate(sync.lastSuccessAt, lang)}>{formatRelative(sync.lastSuccessAt, lang)}</time> : '—'],
        ]}
      />
      {sync?.message && <p class={`small ${sync.health === 'ok' ? 'muted' : 'warn-text'}`}>{sync.message}</p>}
      {notes.length > 0 && (
        <ul class="attention">
          {notes.map((k) => (
            <li key={k}>
              <TriangleAlert size={14} /> {t(k as MessageKey)}
            </li>
          ))}
        </ul>
      )}
      <ReasonNotes m={m} />
      <div class="row-actions">
        <Link class="btn sm" href={`/modules/${encodeURIComponent(m.id)}`}>
          {t('common.details')}
        </Link>
        {canSync(m) && <SyncButton id={m.id} />}
        {isPublic(m) && (
          <ExternalLink class="btn sm" href={publicModuleUrl(m.id, lang)}>
            <ExternalLinkIcon size={14} /> {t('modules.publicPage')}
          </ExternalLink>
        )}
      </div>
    </li>
  );
}

/** Review / moderation explanations shown to the author. */
export function ReasonNotes({ m }: { m: MyModule }) {
  const { t, lang } = useApp();
  const out = [];
  if (m.request) {
    out.push(
      <Alert key="req" tone="info" title={t('modules.pendingRequest', { kind: t(`kind.${m.request.kind}` as MessageKey) })}>
        <p>{t('modules.pendingRequestBody', { id: m.request.submissionId, date: formatDate(m.request.submittedAt, lang) })}</p>
        <p class="small">
          <strong>{t('check.title')}</strong>
        </p>
        <RequestCheckView check={requestCheckOf(m)} />
      </Alert>,
    );
  }
  if (m.moderation && (m.status === 'suspended' || m.status === 'archived')) {
    out.push(
      <Alert key="mod" tone="warning" title={t(m.moderation.action === 'suspend' ? 'modules.suspendedBy' : 'modules.archivedBy')}>
        <p>{m.moderation.reason}</p>
        <p class="small muted">{formatDate(m.moderation.at, lang)}</p>
      </Alert>,
    );
  }
  if (m.review && m.review.decision === 'rejected') {
    out.push(
      <Alert key="rev" tone="danger" title={t('modules.rejectedReason')}>
        <p>
          {m.review.reasonCode && <Badge tone="danger">{t(`reason.${m.review.reasonCode}` as MessageKey)}</Badge>} {m.review.reason ?? ''}
        </p>
        <p class="small muted">
          {t(`kind.${m.review.kind}` as MessageKey)} · <code>{m.review.submissionId}</code> · {formatDate(m.review.decidedAt, lang)}
        </p>
      </Alert>,
    );
  }
  return <>{out}</>;
}
