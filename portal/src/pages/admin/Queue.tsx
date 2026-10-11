import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Link, navigate } from '../../router.tsx';
import { useAction, useApp, useAsync, useDocumentTitle } from '../../context.tsx';
import { Alert, Badge, DL, Empty, ErrorBox, ExternalLink, Field, Loading, PageHeader, IssueList, RequestCheckView, StatusBadge } from '../../components/ui.tsx';
import { formatDate, formatRelative, githubRepoUrl, githubUserUrl } from '../../lib/format.ts';
import { REASON_CODES, rejectNeedsText } from '../../lib/admin.ts';
import type { QueueItem, ReasonCode } from '../../api/types.ts';
import type { MessageKey } from '../../i18n/index.ts';
import { ArrowLeft, Check, ExternalLinkIcon, Eye, Inbox, RefreshCw, X } from '../../components/icons.tsx';

export function Queue() {
  const { api, t, lang } = useApp();
  useDocumentTitle(t('admin.queue'));
  const q = useAsync(() => api.queue(), []);
  return (
    <div class="page">
      <PageHeader
        title={t('admin.queue')}
        subtitle={t('admin.queueSubtitle')}
        actions={
          <button type="button" class="btn" onClick={q.reload} disabled={q.loading}>
            <RefreshCw size={16} /> {t('common.refresh')}
          </button>
        }
      />
      {q.loading && !q.data && <Loading />}
      <ErrorBox error={q.error} onRetry={q.reload} />
      {q.data && q.data.length === 0 && <Empty icon={<Inbox size={28} />}>{t('admin.queueEmpty')}</Empty>}
      {q.data && q.data.length > 0 && (
        <div class="table-wrap">
          <table class="table">
            <caption class="sr-only">{t('admin.queue')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('admin.kind')}</th>
                <th scope="col">{t('manifest.id')}</th>
                <th scope="col">{t('modules.repo')}</th>
                <th scope="col">{t('admin.submitter')}</th>
                <th scope="col">{t('admin.submitted')}</th>
                <th scope="col">{t('check.title')}</th>
                <th scope="col">
                  <span class="sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((it) => (
                <tr key={it.request.submissionId}>
                  <td>
                    <Badge tone="info">{t(`kind.${it.request.kind}` as MessageKey)}</Badge>
                  </td>
                  <td>
                    <code>{it.id}</code>
                  </td>
                  <td>
                    <ExternalLink href={githubRepoUrl(it.request.source.fullName)}>{it.request.source.fullName}</ExternalLink>
                  </td>
                  <td>{it.request.submittedByLogin ? <ExternalLink href={githubUserUrl(it.request.submittedByLogin)}>@{it.request.submittedByLogin}</ExternalLink> : `#${it.request.submittedBy}`}</td>
                  <td class="nowrap">
                    <time dateTime={it.request.submittedAt} title={formatDate(it.request.submittedAt, lang)}>
                      {formatRelative(it.request.submittedAt, lang)}
                    </time>
                  </td>
                  <td>{it.check ? <Badge tone={it.check.ok ? 'success' : 'danger'}>{t(it.check.ok ? 'check.passed' : 'check.failed')}</Badge> : <span class="small muted">{t('check.pending')}</span>}</td>
                  <td>
                    <Link class="btn sm" href={`/admin/requests/${it.request.submissionId}`}>
                      {t('admin.review')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Deep link target (also used from Telegram "View in Portal"). */
export function RequestDetail({ submissionId }: { submissionId: string }) {
  const { api, t, lang } = useApp();
  useDocumentTitle(`${t('admin.request')} ${submissionId}`);
  const q = useAsync(() => api.queue(), [submissionId]);
  const [decided, setDecided] = useState<'approved' | 'rejected' | null>(null);
  const [reasonCode, setReasonCode] = useState<ReasonCode | ''>('');
  const [reason, setReason] = useState('');
  const approve = useAction(() => api.approve(submissionId));
  const reject = useAction(() => api.reject(submissionId, reason.trim() ? { reasonCode: reasonCode as ReasonCode, reason: reason.trim() } : { reasonCode: reasonCode as ReasonCode }));

  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  const item: QueueItem | undefined = q.data?.find((x) => x.request.submissionId === submissionId);

  if (decided) {
    return (
      <div class="page">
        <PageHeader title={`${t('admin.request')} ${submissionId}`} />
        <Alert tone={decided === 'approved' ? 'success' : 'warning'} title={t(decided === 'approved' ? 'admin.approvedDone' : 'admin.rejectedDone')}>
          {item && <code>{item.id}</code>}
        </Alert>
        <div class="row-actions">
          <Link class="btn primary" href="/admin">
            <Inbox size={16} /> {t('admin.backToQueue')}
          </Link>
        </div>
      </div>
    );
  }
  if (!item) {
    return (
      <div class="page">
        <PageHeader title={`${t('admin.request')} ${submissionId}`} />
        <Alert tone="warning" title={t('admin.requestGone')}>
          {t('admin.requestGoneBody')}
        </Alert>
        <div class="row-actions">
          <Link class="btn" href="/admin">
            <Inbox size={16} /> {t('admin.backToQueue')}
          </Link>
        </div>
      </div>
    );
  }
  const r = item.request;
  const needsText = rejectNeedsText(reasonCode || undefined);
  const canReject = !!reasonCode && (!needsText || reason.trim().length > 0) && reason.length <= 500;
  const busy = approve.pending || reject.pending;
  return (
    <div class="page">
      <PageHeader
        title={
          <>
            {t(`kind.${r.kind}` as MessageKey)}: <code class="title-code">{item.id}</code>
          </>
        }
        subtitle={<>{t('admin.request')} <code>{submissionId}</code></>}
      />
      <section class="card" aria-labelledby="rq-info">
        <h2 id="rq-info">{t('admin.details')}</h2>
        <DL
          items={[
            [t('admin.kind'), t(`kind.${r.kind}` as MessageKey)],
            [t('common.status'), <StatusBadge status={item.status} />],
            [t('admin.requestedRepo'), <ExternalLink href={githubRepoUrl(r.source.fullName)}>{r.source.fullName}</ExternalLink>],
            ...(item.source ? ([[t('admin.currentRepo'), <ExternalLink href={githubRepoUrl(item.source.fullName)}>{item.source.fullName}</ExternalLink>]] as [string, ComponentChildren][]) : []),
            [
              t('admin.submitter'),
              r.submittedByLogin ? (
                <ExternalLink href={githubUserUrl(r.submittedByLogin)}>
                  @{r.submittedByLogin} (#{r.submittedBy})
                </ExternalLink>
              ) : (
                `#${r.submittedBy}`
              ),
            ],
            [t('admin.submitted'), formatDate(r.submittedAt, lang)],
          ]}
        />
        <div class="row-actions">
          <Link class="btn sm" href={`/repos/${r.source.repositoryId}/preview?repo=${encodeURIComponent(r.source.fullName)}`}>
            <Eye size={14} /> {t('action.preview')}
          </Link>
          <ExternalLink class="btn sm" href={`${githubRepoUrl(r.source.fullName)}/releases`}>
            <ExternalLinkIcon size={14} /> {t('admin.releases')}
          </ExternalLink>
        </div>
      </section>
      <section class="card" aria-labelledby="rq-sync-check">
        <h2 id="rq-sync-check">{t('check.title')}</h2>
        <RequestCheckView check={item.check} />
      </section>
      {item.precheck && (
        <section class="card" aria-labelledby="rq-checks">
          <h2 id="rq-checks">{t('precheck.issues')}</h2>
          <IssueList issues={item.precheck.issues} />
        </section>
      )}
      <section class="card" aria-labelledby="rq-decide">
        <h2 id="rq-decide">{t('admin.decide')}</h2>
        <ErrorBox error={approve.error ?? reject.error} />
        <div class="decide">
          <div>
            <button
              type="button"
              class="btn primary"
              disabled={busy}
              onClick={async () => {
                if (!confirm(t('admin.confirmApprove', { id: item.id }))) return;
                if ((await approve.run()) !== undefined) setDecided('approved');
              }}
            >
              <Check size={16} /> {t('admin.approve')}
            </button>
          </div>
          <form
            class="form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!canReject) return;
              if ((await reject.run()) !== undefined) setDecided('rejected');
            }}
          >
            <Field label={t('admin.reasonCode')} id="rq-code">
              <select id="rq-code" value={reasonCode} onChange={(e) => setReasonCode((e.target as HTMLSelectElement).value as ReasonCode)} required>
                <option value="">{t('common.choose')}</option>
                {REASON_CODES.map((c) => (
                  <option key={c} value={c}>
                    {t(`reason.${c}` as MessageKey)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={needsText ? t('admin.reasonRequired') : t('admin.reasonOptional')} id="rq-reason" hint={t('admin.reasonHint')}>
              <textarea id="rq-reason" rows={3} maxLength={500} value={reason} onInput={(e) => setReason((e.target as HTMLTextAreaElement).value)} required={needsText} />
            </Field>
            <button type="submit" class="btn danger" disabled={!canReject || busy}>
              <X size={16} /> {t('admin.reject')}
            </button>
          </form>
        </div>
      </section>
      <a
        class="back"
        href="/admin"
        onClick={(e) => {
          e.preventDefault();
          navigate('/admin');
        }}
      >
        <ArrowLeft size={16} /> {t('admin.backToQueue')}
      </a>
    </div>
  );
}
