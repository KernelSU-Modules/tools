import type { ComponentChildren } from 'preact';
import { useApp, useAsync, useDocumentTitle } from '../../context.tsx';
import { Alert, Badge, ErrorBox, ExternalLink, HealthBadge, Loading, PageHeader, Section, StatusBadge } from '../../components/ui.tsx';
import { formatDate, formatRelative, githubRepoUrl } from '../../lib/format.ts';
import { healthSummary, runTone, sortByHealth } from '../../lib/dashboard.ts';
import { Link } from '../../router.tsx';
import { Activity, CircleCheck, Clock, OctagonAlert, Package, RefreshCw, TriangleAlert } from '../../components/icons.tsx';

export function Status() {
  const { api, t, lang } = useApp();
  useDocumentTitle(t('admin.status'));
  const st = useAsync(() => api.status(), []);
  const d = st.data;
  const sum = d ? healthSummary(d.modules) : null;
  return (
    <div class="page">
      <PageHeader
        title={t('admin.status')}
        subtitle={d?.generatedAt ? t('dash.generated', { date: formatDate(d.generatedAt, lang) }) : t('dash.subtitle')}
        actions={
          <button type="button" class="btn" onClick={st.reload} disabled={st.loading}>
            <RefreshCw size={16} /> {t('common.refresh')}
          </button>
        }
      />
      {st.loading && !d && <Loading />}
      <ErrorBox error={st.error} onRetry={st.reload} />
      {d && sum && (
        <>
          <section aria-label={t('dash.summary')} class="cards">
            <Stat icon={<Package size={17} />} label={t('dash.total')} value={sum.total} />
            <Stat tone="success" icon={<CircleCheck size={17} />} label={t('health.ok')} value={sum.ok} />
            <Stat tone="warning" icon={<Clock size={17} />} label={t('health.stale')} value={sum.stale} />
            <Stat tone="danger" icon={<OctagonAlert size={17} />} label={t('health.error')} value={sum.error} />
            <Stat tone="warning" icon={<TriangleAlert size={17} />} label={t('modules.installMissing')} value={sum.installMissing} />
          </section>
          {d.invalidFiles && Object.keys(d.invalidFiles).length > 0 && (
            <Alert tone="danger" title={t('dash.invalidFiles')}>
              <ul>
                {Object.entries(d.invalidFiles).map(([path, msg]) => (
                  <li key={path}>
                    <code>{path}</code>: {msg}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          <section class="card" aria-labelledby="st-runs">
            <h2 id="st-runs">
              <Activity size={16} /> {t('dash.runs')}
            </h2>
            <p class="small">
              {t('dash.lastSuccessfulRun')}:{' '}
              {d.lastSuccessfulRun ? (
                <ExternalLink href={d.lastSuccessfulRun.htmlUrl}>
                  <time dateTime={d.lastSuccessfulRun.createdAt} title={formatDate(d.lastSuccessfulRun.createdAt, lang)}>
                    {formatRelative(d.lastSuccessfulRun.createdAt, lang)}
                  </time>
                </ExternalLink>
              ) : (
                t('dash.never')
              )}
              {d.newestSuccessAt !== undefined && (
                <>
                  {' · '}
                  {t('dash.newestSuccess')}: {d.newestSuccessAt ? formatRelative(d.newestSuccessAt, lang) : t('dash.never')}
                </>
              )}
            </p>
            {d.runs.length === 0 ? (
              <p class="muted">{t('dash.noRuns')}</p>
            ) : (
              <ul class="runs">
                {d.runs.map((r) => (
                  <li key={r.id}>
                    <Badge tone={runTone(r)}>{r.conclusion ?? r.status}</Badge>{' '}
                    <ExternalLink href={r.htmlUrl}>{r.displayTitle ?? `#${r.id}`}</ExternalLink> <span class="muted small">
                      {r.event ? `${r.event} · ` : ''}
                      <time dateTime={r.createdAt} title={formatDate(r.createdAt, lang)}>{formatRelative(r.createdAt, lang)}</time>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {d.dataCommit && (
              <p class="small muted">
                {t('dash.dataCommit')}: <code>{d.dataCommit.slice(0, 12)}</code>
              </p>
            )}
          </section>
          <Section id="st-mods" title={t('dash.modules')}>
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th scope="col">{t('manifest.id')}</th>
                    <th scope="col">{t('common.status')}</th>
                    <th scope="col">{t('modules.syncHealth')}</th>
                    <th scope="col">{t('modules.stable')}</th>
                    <th scope="col">{t('modules.lastSync')}</th>
                    <th scope="col">{t('modules.maxVersionCode')}</th>
                    <th scope="col">{t('check.title')}</th>
                    <th scope="col">{t('modules.healthMessage')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortByHealth(d.modules).map((m) => (
                    <tr key={m.id}>
                      <td>
                        <code>{m.id}</code>
                        <ExternalLink class="sub" href={githubRepoUrl(m.fullName)}>
                          {m.fullName}
                        </ExternalLink>
                      </td>
                      <td>{m.status ? <StatusBadge status={m.status} /> : '—'}</td>
                      <td>
                        <span class="badges">
                          <HealthBadge health={m.health} installation={m.installation} />
                          {m.installation === 'missing' && <Badge tone="danger">{t('modules.installMissing')}</Badge>}
                        </span>
                      </td>
                      <td>{m.stable ? `${m.stable.version} (${m.stable.versionCode})` : '—'}</td>
                      <td class="nowrap">
                        <time dateTime={m.lastSuccessAt ?? undefined} title={formatDate(m.lastSuccessAt, lang)}>
                          {formatRelative(m.lastSuccessAt, lang)}
                        </time>
                      </td>
                      <td>{m.maxVersionCode ?? '—'}</td>
                      <td>
                        {m.request ? (
                          <Link href={`/admin/requests/${m.request.submissionId}`}>
                            <Badge tone={m.request.ok ? 'success' : 'danger'}>{t(m.request.ok ? 'check.passed' : 'check.failed')}</Badge>
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td class="small">
                        {m.message ?? ''}
                        {m.status === 'listed' && (
                          <>
                            {' '}
                            <Link href={`/admin/modules?id=${encodeURIComponent(m.id)}`}>{t('admin.moderation')}</Link>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

function Stat({ icon, label, value, tone }: { icon: ComponentChildren; label: string; value: number; tone?: 'success' | 'warning' | 'danger' }) {
  return (
    <div class={`card stat${tone ? ` ${tone}` : ''}`}>
      <div class="label">
        {icon} {label}
      </div>
      <div class="value">{value}</div>
    </div>
  );
}
