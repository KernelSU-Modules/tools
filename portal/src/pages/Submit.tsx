import { useState } from 'preact/hooks';
import { Link } from '../router.tsx';
import { useAction, useApp, useAsync, useDocumentTitle } from '../context.tsx';
import { Alert, DL, ErrorBox, Field, Loading, PageHeader, StatusBadge } from '../components/ui.tsx';
import { IdInput, useIdCheck } from '../components/IdInput.tsx';
import { suggestId } from '../lib/ids.ts';
import { formatDate } from '../lib/format.ts';
import { returnedSubmission } from '../lib/status.ts';
import { FolderGit2, ListChecks, Package, Send } from '../components/icons.tsx';
import { getRepo, invalidate } from '../store.ts';
import type { SubmitResponse } from '../api/types.ts';

/** Same limit as the Worker (NOTE_MAX). */
export const NOTE_MAX = 1000;

export function Submit({ repositoryId, initialId }: { repositoryId: number; initialId?: string | null }) {
  const { api, t, lang } = useApp();
  const repo = useAsync(() => getRepo(api, repositoryId), [repositoryId]);
  // Without an explicit ?id=, suggest the id declared in the repository's module.yaml (precheck), else the repo name.
  const declared = useAsync(
    () => (initialId ? Promise.resolve(null) : api.precheck(repositoryId).then((r) => r.manifest?.id ?? null, () => null)),
    [repositoryId, initialId],
  );
  const [id, setId] = useState<string | null>(initialId ?? null);
  const effectiveId = id ?? declared.data ?? (repo.data ? suggestId(repo.data.fullName) : '');
  const check = useIdCheck(effectiveId);
  const [immutable, setImmutable] = useState(false);
  const [manifest, setManifest] = useState(false);
  const [rules, setRules] = useState(false);
  const [note, setNote] = useState('');
  const [done, setDone] = useState<SubmitResponse | null>(null);
  // Resubmitting a submission that was sent back for changes: show what the reviewers asked for.
  const returned = useAsync(
    () => (check.state === 'done' && check.result.status === 'changes-requested' && check.result.available ? api.module(effectiveId).then(returnedSubmission, () => null) : Promise.resolve(null)),
    [effectiveId, check.state === 'done' && check.result.status],
  );
  const action = useAction(() => api.submit({ repositoryId, id: effectiveId, ...(note.trim() ? { note: note.trim() } : {}) }));
  const name = repo.data?.fullName ?? `#${repositoryId}`;
  useDocumentTitle(`${t('action.submit')} · ${name}`);

  if (repo.loading || declared.loading) return <Loading />;
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
  const ready = idOk && immutable && manifest && rules && repo.data.isAdmin && !repo.data.registeredId && note.length <= NOTE_MAX;
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
      {returned.data && (
        <Alert tone="warning" title={t('modules.changesRequested')}>
          <p>{t('submit.resubmitting', { id: effectiveId })}</p>
          <blockquote class="note">{returned.data.reason}</blockquote>
          <p class="small muted">{t('modules.changesRequestedBody', { id: effectiveId, date: formatDate(returned.data.reservedUntil, lang) })}</p>
        </Alert>
      )}
      <form class="card form" onSubmit={onSubmit} noValidate>
        <IdInput value={effectiveId} onInput={setId} check={check} />
        <p class="hint">{t('submit.idMustMatch')}</p>
        <Field label={t('submit.note')} id="submit-note" hint={t('submit.noteHint')}>
          <textarea id="submit-note" rows={4} maxLength={NOTE_MAX} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
        </Field>
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
