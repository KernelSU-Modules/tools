import { useState } from 'preact/hooks';
import { Link } from '../router.tsx';
import { useAction, useApp, useAsync, useDocumentTitle } from '../context.tsx';
import { Alert, DL, Empty, ErrorBox, Field, Loading, PageHeader, TruncatedReposNotice } from '../components/ui.tsx';
import { getModules, getRepos, invalidate } from '../store.ts';
import { ArrowLeftRight, Package } from '../components/icons.tsx';
import type { TransferResponse } from '../api/types.ts';

/** Move a module (listed|suspended) to another repository the user administers. */
export function Transfer({ initialId, initialRepositoryId }: { initialId?: string | null; initialRepositoryId?: number | null }) {
  const { api, t } = useApp();
  useDocumentTitle(t('transfer.title'));
  const data = useAsync(() => Promise.all([getModules(api), getRepos(api)]), []);
  const [id, setId] = useState(initialId ?? '');
  const [repoId, setRepoId] = useState<number | null>(initialRepositoryId ?? null);
  const [done, setDone] = useState<TransferResponse | null>(null);
  const action = useAction(() => api.transfer({ id, repositoryId: repoId! }));

  if (data.loading) return <Loading />;
  if (data.error || !data.data) return <ErrorBox error={data.error} onRetry={data.reload} />;
  const [modules, { repos, truncated }] = data.data;
  const movable = modules.filter((m) => m.status === 'listed' || m.status === 'suspended');
  const current = movable.find((m) => m.id === id);
  const targets = repos.filter((r) => r.isAdmin && !r.registeredId && r.repositoryId !== current?.source?.repositoryId);
  const target = repos.find((r) => r.repositoryId === repoId);

  if (done) {
    return (
      <div class="page">
        <PageHeader title={t('transfer.doneTitle')} />
        {done.autoApproved ? (
          <Alert tone="success" title={t('transfer.autoApproved')}>
            {t('transfer.autoApprovedBody', { id, repo: target?.fullName ?? '' })}
          </Alert>
        ) : (
          <Alert tone="info" title={t('transfer.queued')}>
            <DL items={[[t('submit.submissionId'), done.submissionId ? <code>{done.submissionId}</code> : '—']]} />
            <p>{t('transfer.queuedBody')}</p>
          </Alert>
        )}
        <div class="row-actions">
          <Link class="btn primary" href={`/modules/${encodeURIComponent(id)}`}>
            <Package size={16} /> {t('submit.viewModule')}
          </Link>
        </div>
      </div>
    );
  }

  const ready = !!current && !!target && targets.includes(target);
  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (!ready) return;
    if (!confirm(t('transfer.confirm', { id, from: current.source?.fullName ?? '?', to: target.fullName }))) return;
    const r = await action.run();
    if (r) {
      invalidate('repos', 'modules');
      setDone(r);
    }
  };
  return (
    <div class="page">
      <PageHeader title={t('transfer.title')} subtitle={t('transfer.subtitle')} />
      <Alert tone="info">{t('transfer.explain')}</Alert>
      <TruncatedReposNotice truncated={truncated} />
      {movable.length === 0 ? (
        <Empty icon={<Package size={28} />}>{t('transfer.noModules')}</Empty>
      ) : (
        <form class="card form" onSubmit={onSubmit} noValidate>
          <Field label={t('transfer.module')} id="tr-module">
            <select id="tr-module" value={id} onChange={(e) => setId((e.target as HTMLSelectElement).value)} required>
              <option value="">{t('common.choose')}</option>
              {movable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} — {m.source?.fullName ?? ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('transfer.target')} id="tr-repo" hint={t('transfer.targetHint')}>
            <select
              id="tr-repo"
              value={repoId == null ? '' : String(repoId)}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                setRepoId(v ? Number(v) : null);
              }}
              required
            >
              <option value="">{t('common.choose')}</option>
              {targets.map((r) => (
                <option key={r.repositoryId} value={String(r.repositoryId)}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </Field>
          {target && !targets.includes(target) && <Alert tone="warning">{t('transfer.targetInvalid')}</Alert>}
          <ErrorBox error={action.error} />
          <div class="row-actions">
            <button type="submit" class="btn primary" disabled={!ready || action.pending} aria-busy={action.pending}>
              <ArrowLeftRight size={16} /> {action.pending ? t('common.submitting') : t('transfer.button')}
            </button>
            <Link class="btn" href="/modules">
              {t('common.cancel')}
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}
