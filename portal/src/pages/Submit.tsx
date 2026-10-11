import { useState } from 'preact/hooks';
import { Link } from '../router.tsx';
import { useAction, useApp, useAsync, useDocumentTitle } from '../context.tsx';
import { Alert, DL, ErrorBox, Loading, PageHeader, StatusBadge } from '../components/ui.tsx';
import { IdInput, useIdCheck } from '../components/IdInput.tsx';
import { suggestId } from '../lib/ids.ts';
import { FolderGit2, ListChecks, Package, Send } from '../components/icons.tsx';
import { getRepo, invalidate } from '../store.ts';
import type { SubmitResponse } from '../api/types.ts';

export function Submit({ repositoryId, initialId }: { repositoryId: number; initialId?: string | null }) {
  const { api, t } = useApp();
  const repo = useAsync(() => getRepo(api, repositoryId), [repositoryId]);
  const [id, setId] = useState<string | null>(initialId ?? null);
  const effectiveId = id ?? (repo.data ? suggestId(repo.data.fullName) : '');
  const check = useIdCheck(effectiveId);
  const [immutable, setImmutable] = useState(false);
  const [manifest, setManifest] = useState(false);
  const [rules, setRules] = useState(false);
  const [done, setDone] = useState<SubmitResponse | null>(null);
  const action = useAction(() => api.submit({ repositoryId, id: effectiveId }));
  const name = repo.data?.fullName ?? `#${repositoryId}`;
  useDocumentTitle(`${t('action.submit')} · ${name}`);

  if (repo.loading) return <Loading />;
  if (repo.error) return <ErrorBox error={repo.error} onRetry={repo.reload} />;
  if (!repo.data) return <Alert tone="danger">{t('repos.notFound')}</Alert>;

  if (done) {
    return (
      <div class="page">
        <PageHeader title={t('submit.doneTitle')} />
        <Alert tone="success" title={t('submit.doneLead')}>
          <DL
            items={[
              [t('manifest.id'), <code>{effectiveId}</code>],
              [t('submit.submissionId'), <code>{done.submissionId}</code>],
              [t('common.status'), <StatusBadge status={done.status} />],
            ]}
          />
          <p>{t('submit.doneBody')}</p>
        </Alert>
        <div class="row-actions">
          <Link class="btn primary" href={`/modules/${encodeURIComponent(effectiveId)}`}>
            <Package size={16} /> {t('submit.viewModule')}
          </Link>
          <Link class="btn" href="/repos">
            <FolderGit2 size={16} /> {t('nav.repos')}
          </Link>
        </div>
      </div>
    );
  }

  const idOk = check.state === 'done' && check.result.available;
  const ready = idOk && immutable && manifest && rules && repo.data.isAdmin && !repo.data.registeredId;
  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (!ready) return;
    const r = await action.run();
    if (r) {
      invalidate('repos', 'modules');
      setDone(r);
    }
  };

  return (
    <div class="page">
      <PageHeader title={t('submit.title', { repo: name })} subtitle={t('submit.subtitle')} />
      {!repo.data.isAdmin && <Alert tone="danger">{t('repos.notAdminHint')}</Alert>}
      {repo.data.registeredId && <Alert tone="warning">{t('submit.alreadyRegistered', { id: repo.data.registeredId })}</Alert>}
      <form class="card form" onSubmit={onSubmit} noValidate>
        <IdInput value={effectiveId} onInput={setId} check={check} />
        <p class="hint">{t('submit.idMustMatch')}</p>
        <fieldset>
          <legend>{t('submit.checklist')}</legend>
          <label class="check">
            <input type="checkbox" checked={immutable} onChange={(e) => setImmutable((e.target as HTMLInputElement).checked)} />
            <span>{t('submit.check.immutable')}</span>
          </label>
          <label class="check">
            <input type="checkbox" checked={manifest} onChange={(e) => setManifest((e.target as HTMLInputElement).checked)} />
            <span>{t('submit.check.manifest')}</span>
          </label>
          <label class="check">
            <input type="checkbox" checked={rules} onChange={(e) => setRules((e.target as HTMLInputElement).checked)} />
            <span>{t('submit.check.rules')}</span>
          </label>
        </fieldset>
        <Link class="back" href={`/repos/${repositoryId}/precheck`}>
          <ListChecks size={16} /> {t('submit.runPrecheckFirst')}
        </Link>
        <ErrorBox error={action.error} />
        <div class="row-actions">
          <button type="submit" class="btn primary" disabled={!ready || action.pending} aria-busy={action.pending}>
            <Send size={16} /> {action.pending ? t('common.submitting') : t('submit.button')}
          </button>
          <Link class="btn" href="/repos">
            {t('common.cancel')}
          </Link>
        </div>
      </form>
    </div>
  );
}
