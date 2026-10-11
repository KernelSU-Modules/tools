import { useState } from 'preact/hooks';
import { useAction, useApp, useAsync, useDocumentTitle } from '../../context.tsx';
import { Alert, ErrorBox, ExternalLink, Field, Loading, PageHeader, Section, StatusBadge } from '../../components/ui.tsx';
import { githubRepoUrl } from '../../lib/format.ts';
import { idFormatError } from '../../lib/ids.ts';
import { moderationActions } from '../../lib/status.ts';
import type { ModerationAction } from '../../api/types.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { Search, ShieldAlert } from '../../components/icons.tsx';

export function Moderation({ initialId }: { initialId?: string | null }) {
  const { api, t } = useApp();
  useDocumentTitle(t('admin.moderation'));
  const st = useAsync(() => api.status(), []);
  const [id, setId] = useState(initialId ?? '');
  const [act, setAct] = useState<ModerationAction>('suspend');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const action = useAction(() => api.moderate(id, act, reason.trim()));
  const [filter, setFilter] = useState('');

  const known = st.data?.modules.find((m) => m.id === id);
  const allowed = known?.status ? moderationActions(known.status) : (['suspend', 'unsuspend', 'archive'] as ModerationAction[]);
  const ready = !idFormatError(id) && reason.trim().length > 0 && reason.length <= 500 && allowed.includes(act);

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (!ready) return;
    if (!confirm(t('admin.confirmModerate', { action: t(`moderate.${act}` as MessageKey), id }))) return;
    setDone(null);
    if ((await action.run()) !== undefined) {
      setDone(t('admin.moderated', { action: t(`moderate.${act}` as MessageKey), id }));
      setReason('');
      st.reload();
    }
  };

  const rows = (st.data?.modules ?? []).filter((m) => !filter || m.id.toLowerCase().includes(filter.toLowerCase()) || m.fullName.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div class="page">
      <PageHeader title={t('admin.moderation')} subtitle={t('admin.moderationSubtitle')} />
      <form class="card form" onSubmit={onSubmit} noValidate>
        <div class="form-grid">
          <Field label={t('manifest.id')} id="mod-id">
            <input id="mod-id" value={id} onInput={(e) => setId((e.target as HTMLInputElement).value.trim())} autoComplete="off" spellcheck={false} required />
          </Field>
          <Field label={t('admin.action')} id="mod-action">
            <select id="mod-action" value={act} onChange={(e) => setAct((e.target as HTMLSelectElement).value as ModerationAction)}>
              {(['suspend', 'unsuspend', 'archive'] as const).map((a) => (
                <option key={a} value={a} disabled={!allowed.includes(a)}>
                  {t(`moderate.${a}` as MessageKey)}
                </option>
              ))}
            </select>
          </Field>
          <div class="field">
            <span class="label-like">{t('common.status')}</span>
            <p class="value-like">{known?.status ? <StatusBadge status={known.status} /> : <span class="muted">—</span>}</p>
          </div>
        </div>
        <Field label={t('admin.reasonRequired')} id="mod-reason" hint={t('admin.moderationReasonHint')}>
          <textarea id="mod-reason" rows={2} maxLength={500} value={reason} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} required />
        </Field>
        {act === 'archive' && <Alert tone="warning">{t('admin.archiveWarning')}</Alert>}
        <ErrorBox error={action.error} />
        {done && <Alert tone="success">{done}</Alert>}
        <button type="submit" class={`btn ${act === 'unsuspend' ? 'primary' : 'danger'}`} disabled={!ready || action.pending}>
          <ShieldAlert size={16} /> {t(`moderate.${act}` as MessageKey)}
        </button>
      </form>
      <Section id="mod-list" title={t('admin.allModules')}>
        <div class="toolbar">
          <div class="search">
            <Search size={16} />
            <label class="sr-only" for="mod-filter">
              {t('common.filter')}
            </label>
            <input id="mod-filter" type="search" placeholder={t('common.filter')} value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        {st.loading && !st.data && <Loading />}
        <ErrorBox error={st.error} onRetry={st.reload} />
        {st.data && (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">{t('manifest.id')}</th>
                  <th scope="col">{t('modules.repo')}</th>
                  <th scope="col">{t('common.status')}</th>
                  <th scope="col">
                    <span class="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <code>{m.id}</code>
                    </td>
                    <td>
                      <ExternalLink href={githubRepoUrl(m.fullName)}>{m.fullName}</ExternalLink>
                    </td>
                    <td>{m.status ? <StatusBadge status={m.status} /> : '—'}</td>
                    <td>
                      <div class="row-actions">
                      {(m.status ? moderationActions(m.status) : []).map((a) => (
                        <button
                          key={a}
                          type="button"
                          class="btn sm"
                          onClick={() => {
                            setId(m.id);
                            setAct(a);
                            document.getElementById('mod-reason')?.focus();
                          }}
                        >
                          {t(`moderate.${a}` as MessageKey)}
                        </button>
                      ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
