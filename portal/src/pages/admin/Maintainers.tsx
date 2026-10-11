import { useEffect, useState } from 'preact/hooks';
import { useAction, useApp, useAsync, useDocumentTitle } from '../../context.tsx';
import { Alert, ErrorBox, Loading, PageHeader } from '../../components/ui.tsx';
import { fromRows, toRows, type MaintainerRow, type RowError } from '../../lib/admin.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { Plus, Save } from '../../components/icons.tsx';

const EMPTY: MaintainerRow = { githubId: '', login: '', telegramId: '', telegramUsername: '' };

export function Maintainers() {
  const { api, t, me } = useApp();
  useDocumentTitle(t('admin.maintainers'));
  const doc = useAsync(() => api.maintainers(), []);
  const [rows, setRows] = useState<MaintainerRow[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [touched, setTouched] = useState(false);
  const save = useAction((v: Parameters<typeof api.saveMaintainers>[0]) => api.saveMaintainers(v));

  useEffect(() => {
    if (doc.data) setRows(toRows(doc.data.maintainers));
  }, [doc.data]);

  if (doc.loading && !rows) return <Loading />;
  if (doc.error) return <ErrorBox error={doc.error} onRetry={doc.reload} />;
  if (!rows) return null;

  const parsed = fromRows(rows);
  const selfRemoved = !!me?.user && !rows.some((r) => r.githubId.trim() === String(me.user!.id));
  const update = (i: number, patch: Partial<MaintainerRow>) => {
    setSaved(false);
    setTouched(true);
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (!parsed.value) return;
    if (selfRemoved && !confirm(t('maint.confirmSelfRemove'))) return;
    if ((await save.run({ maintainers: parsed.value })) !== undefined) {
      setSaved(true);
      setTouched(false);
    }
  };
  const errText = (e: RowError[]) => e.map((x) => t(`maint.err.${x}` as MessageKey)).join(' ');

  return (
    <div class="page">
      <PageHeader title={t('admin.maintainers')} subtitle={t('maint.subtitle')} />
      <form class="form" onSubmit={onSubmit} noValidate>
        <div class="table-wrap">
          <table class="table editor">
            <thead>
              <tr>
                <th scope="col">{t('maint.githubId')}</th>
                <th scope="col">{t('maint.login')}</th>
                <th scope="col">{t('maint.telegramId')}</th>
                <th scope="col">{t('maint.telegramUsername')}</th>
                <th scope="col">
                  <span class="sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const errs = parsed.errors[i] ?? [];
                const n = i + 1;
                return (
                  <tr key={i} class={errs.length && touched ? 'row-error' : ''}>
                    <td>
                      <input aria-label={t('maint.githubIdN', { n })} inputMode="numeric" value={r.githubId} aria-invalid={errs.includes('githubId') || errs.includes('duplicate')} onInput={(e) => update(i, { githubId: (e.target as HTMLInputElement).value })} />
                    </td>
                    <td>
                      <input aria-label={t('maint.loginN', { n })} value={r.login} aria-invalid={errs.includes('login')} onInput={(e) => update(i, { login: (e.target as HTMLInputElement).value })} />
                    </td>
                    <td>
                      <input aria-label={t('maint.telegramIdN', { n })} inputMode="numeric" value={r.telegramId} aria-invalid={errs.includes('telegramId')} onInput={(e) => update(i, { telegramId: (e.target as HTMLInputElement).value })} />
                    </td>
                    <td>
                      <input aria-label={t('maint.telegramUsernameN', { n })} value={r.telegramUsername} onInput={(e) => update(i, { telegramUsername: (e.target as HTMLInputElement).value })} />
                    </td>
                    <td>
                      <button
                        type="button"
                        class="btn sm danger"
                        aria-label={t('maint.removeN', { n })}
                        onClick={() => {
                          setTouched(true);
                          setSaved(false);
                          setRows(rows.filter((_, j) => j !== i));
                        }}
                      >
                        {t('common.remove')}
                      </button>
                      {errs.length > 0 && touched && <p class="field-error small">{errText(errs)}</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {parsed.empty && <Alert tone="danger">{t('maint.err.empty')}</Alert>}
        {selfRemoved && <Alert tone="warning">{t('maint.selfRemoved')}</Alert>}
        <p class="hint">{t('maint.hint')}</p>
        <ErrorBox error={save.error} />
        {saved && <Alert tone="success">{t('common.saved')}</Alert>}
        <div class="row-actions">
          <button type="button" class="btn" onClick={() => setRows([...rows, { ...EMPTY }])}>
            <Plus size={16} /> {t('maint.add')}
          </button>
          <button type="submit" class="btn primary" disabled={!parsed.value || save.pending || !touched}>
            <Save size={16} /> {save.pending ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
