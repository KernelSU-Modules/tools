import { useState } from 'preact/hooks';
import { useAction, useApp, useAsync, useDocumentTitle } from '../../context.tsx';
import { Alert, Empty, ErrorBox, ExternalLink, Field, Loading, PageHeader, Section } from '../../components/ui.tsx';
import { formatDate, githubUserUrl } from '../../lib/format.ts';
import { Ban, Users } from '../../components/icons.tsx';

export function Banned() {
  const { api, t, lang } = useApp();
  useDocumentTitle(t('admin.banned'));
  const list = useAsync(() => api.banned(), []);
  const [githubId, setGithubId] = useState('');
  const [reason, setReason] = useState('');
  const ban = useAction(() => api.ban({ githubId: Number(githubId), reason: reason.trim() }));
  const unban = useAction((id: number) => api.unban(id));
  const validId = /^[1-9][0-9]{0,15}$/.test(githubId);
  const ready = validId && reason.trim().length > 0 && reason.length <= 500;

  return (
    <div class="page">
      <PageHeader title={t('admin.banned')} subtitle={t('banned.subtitle')} />
      <form
        class="card form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready || !confirm(t('banned.confirmBan', { id: githubId }))) return;
          if ((await ban.run()) !== undefined) {
            setGithubId('');
            setReason('');
            list.reload();
          }
        }}
      >
        <h2 class="card-title">{t('banned.add')}</h2>
        <div class="form-grid">
          <Field label={t('maint.githubId')} id="ban-id" hint={t('banned.idHint')} error={githubId && !validId ? t('maint.err.githubId') : null}>
            <input id="ban-id" inputMode="numeric" value={githubId} onInput={(e) => setGithubId((e.target as HTMLInputElement).value.trim())} required />
          </Field>
          <Field label={t('admin.reasonRequired')} id="ban-reason">
            <input id="ban-reason" maxLength={500} value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} required />
          </Field>
        </div>
        <ErrorBox error={ban.error} />
        <button type="submit" class="btn danger" disabled={!ready || ban.pending}>
          <Ban size={16} /> {t('banned.ban')}
        </button>
      </form>
      <Section id="ban-list" title={t('banned.list')}>
        {list.loading && !list.data && <Loading />}
        <ErrorBox error={list.error ?? unban.error} onRetry={list.reload} />
        {list.data && list.data.banned.length === 0 && <Empty icon={<Users size={28} />}>{t('banned.empty')}</Empty>}
        {list.data && list.data.banned.length > 0 && (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">{t('banned.user')}</th>
                  <th scope="col">{t('admin.reason')}</th>
                  <th scope="col">{t('banned.by')}</th>
                  <th scope="col">{t('banned.at')}</th>
                  <th scope="col">
                    <span class="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.banned.map((b) => (
                  <tr key={b.githubId}>
                    <td>
                      {b.login ? <ExternalLink href={githubUserUrl(b.login)}>@{b.login}</ExternalLink> : null} <code>#{b.githubId}</code>
                    </td>
                    <td>{b.reason}</td>
                    <td>
                      <code>#{b.by}</code>
                    </td>
                    <td class="nowrap">{formatDate(b.at, lang)}</td>
                    <td>
                      <button
                        type="button"
                        class="btn sm"
                        disabled={unban.pending}
                        onClick={async () => {
                          if (!confirm(t('banned.confirmUnban', { id: b.login ?? b.githubId }))) return;
                          if ((await unban.run(b.githubId)) !== undefined) list.reload();
                        }}
                      >
                        {t('banned.unban')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Alert tone="info">{t('banned.note')}</Alert>
      </Section>
    </div>
  );
}
