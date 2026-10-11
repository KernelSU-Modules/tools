import { loginUrl } from '../lib/login.ts';
import type { AccessibleAnchorHTMLAttributes, ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { ApiError } from '../api/client.ts';
import type { Issue, RequestCheck, SyncHealth } from '../api/types.ts';
import { useApp, useT } from '../context.tsx';
import type { MessageKey } from '../i18n/index.ts';
import { formatDate, formatWait } from '../lib/format.ts';
import { groupIssues, healthTone, statusKey, statusTone, type Tone } from '../lib/status.ts';
import { issueDocUrl } from '../lib/docs.ts';
import { CircleAlert, CircleCheck, Info, OctagonAlert, RefreshCw, TriangleAlert } from './icons.tsx';

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ComponentChildren; title?: string }) {
  return (
    <span class={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  return <Badge tone={statusTone(status)}>{t(statusKey(status))}</Badge>;
}

export function HealthBadge({ health, installation }: { health: SyncHealth | undefined | null; installation?: 'present' | 'missing' }) {
  const t = useT();
  if (!health) return <Badge>{t('health.none')}</Badge>;
  return <Badge tone={healthTone(health, installation)}>{t(`health.${health}` as MessageKey)}</Badge>;
}

/** /api/repos stopped paginating (Worker subrequest budget): tell the user the list is incomplete. */
export function TruncatedReposNotice({ truncated }: { truncated: boolean }) {
  const t = useT();
  if (!truncated) return null;
  return (
    <Alert tone="warning" title={t('repos.truncatedTitle')}>
      {t('repos.truncatedBody')}
    </Alert>
  );
}

/**
 * Result of the sync job's full validation (ZIP, module.prop, versions) of an open request's source.
 * `check` is null/undefined until the sync has looked at the request.
 */
export function RequestCheckView({ check }: { check: RequestCheck | null | undefined }) {
  const { t, lang } = useApp();
  if (!check) return <p class="small muted">{t('check.waiting')}</p>;
  const g = groupIssues(check.issues.map((i) => ({ ...i, message: '' })));
  return (
    <div class="request-check">
      <p>
        {check.ok ? <Badge tone="success">{t('check.passed')}</Badge> : <Badge tone="danger">{t('check.failed')}</Badge>}{' '}
        <span class="small muted">
          {check.latestTag ? (
            <>
              {t('check.latestTag')}: <code>{check.latestTag}</code> ·{' '}
            </>
          ) : (
            <>{t('check.noRelease')} · </>
          )}
          {t('check.checkedAt', { date: formatDate(check.checkedAt, lang) })}
        </span>
      </p>
      {check.issues.length > 0 && (
        <ul class="check-issues">
          {[...g.error, ...g.warning].map((i, n) => (
            <li key={n}>
              <Badge tone={i.severity === 'error' ? 'danger' : 'warning'}>{t(`severity.${i.severity}`)}</Badge>{' '}
              <a href={issueDocUrl(i.code, lang)} class="issue-code" target="_blank" rel="noopener">
                <code>{i.code}</code>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ComponentChildren; subtitle?: ComponentChildren; actions?: ComponentChildren }) {
  const ref = useRef<HTMLHeadingElement>(null);
  // Move focus to the page heading after client-side navigation (screen readers announce the new page).
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <header class="page-head">
      <div>
        <h1 tabIndex={-1} ref={ref}>
          {title}
        </h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div class="actions">{actions}</div>}
    </header>
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useT();
  return (
    <div class="loading" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true" /> {label ?? t('common.loading')}
    </div>
  );
}

const ALERT_ICON = { success: CircleCheck, warning: TriangleAlert, danger: OctagonAlert, info: Info, neutral: CircleAlert } as const;

export function Alert({ tone = 'info', children, title }: { tone?: Tone; children: ComponentChildren; title?: ComponentChildren }) {
  const Icon = ALERT_ICON[tone];
  return (
    <div class={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon class="alert-icon" size={18} />
      <div class="alert-body">
        {title && <strong class="alert-title">{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}

/** Renders an API error; 401 becomes a sign-in prompt, 429 shows the wait time. */
export function ErrorBox({ error, onRetry }: { error: ApiError | null; onRetry?: () => void }) {
  const t = useT();
  if (!error) return null;
  if (error.isUnauthorized) {
    return (
      <Alert tone="warning" title={t('error.unauthorized')}>
        <a class="btn sm" href={loginUrl(location.pathname + location.search)}>
          {t('auth.signIn')}
        </a>
      </Alert>
    );
  }
  let title: string;
  if (error.status === 429) title = t('error.rateLimited');
  else if (error.status === 403) title = t('error.forbidden');
  else if (error.status === 404) title = t('error.notFound');
  else if (error.status === 409) title = t('error.conflict');
  else if (error.status === 0) title = t('error.network');
  else title = t('error.generic');
  return (
    <Alert tone="danger" title={title}>
      <p>
        {error.message}
        {error.code && <code class="error-code">{error.code}</code>}
      </p>
      {error.retryAfter != null && <p>{t('error.retryIn', { time: formatWait(error.retryAfter) })}</p>}
      {onRetry && (
        <button type="button" class="btn sm" onClick={onRetry}>
          <RefreshCw size={14} /> {t('common.retry')}
        </button>
      )}
    </Alert>
  );
}

export function IssueList({ issues }: { issues: Issue[] }) {
  const { t, lang } = useApp();
  const g = groupIssues(issues);
  if (issues.length === 0)
    return (
      <p class="ok-text badges">
        <CircleCheck size={16} /> {t('precheck.noIssues')}
      </p>
    );
  return (
    <div class="issues">
      {(['error', 'warning'] as const).map((sev) =>
        g[sev].length ? (
          <section key={sev} class={`issue-group issue-${sev}`} aria-label={t(`severity.${sev}`)}>
            <h3>
              <Badge tone={sev === 'error' ? 'danger' : 'warning'}>{t(`severity.${sev}`)}</Badge> <span class="count">{g[sev].length}</span>
            </h3>
            <ul>
              {g[sev].map((i, n) => (
                <li key={n}>
                  <a href={issueDocUrl(i.code, lang)} class="issue-code" target="_blank" rel="noopener">
                    <code>{i.code}</code>
                  </a>{' '}
                  <span>{i.message}</span>
                  {i.path && (
                    <span class="muted">
                      {' '}
                      — <code>{i.path}</code>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

export function Field({
  label,
  id,
  hint,
  error,
  children,
}: {
  label: ComponentChildren;
  id: string;
  hint?: ComponentChildren;
  error?: ComponentChildren | null;
  children: ComponentChildren;
}) {
  return (
    <div class={`field${error ? ' has-error' : ''}`}>
      <label for={id}>{label}</label>
      {children}
      {hint && (
        <p class="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p class="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Empty({ children, icon }: { children: ComponentChildren; icon?: ComponentChildren }) {
  return (
    <div class="empty">
      {icon && <span class="empty-icon">{icon}</span>}
      {children}
    </div>
  );
}

/** Titled block inside a page (reference `.section` / `.section-head`). */
export function Section({
  id,
  title,
  subtitle,
  actions,
  children,
}: {
  id: string;
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
}) {
  return (
    <section class="section" aria-labelledby={id}>
      <div class="section-head">
        <div>
          <h2 id={id}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div class="row-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function DL({ items }: { items: [ComponentChildren, ComponentChildren][] }) {
  return (
    <dl class="dl">
      {items.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ExternalLink(props: AccessibleAnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a target="_blank" rel="noopener noreferrer" {...props} />;
}

export function Avatar({ url, login, size = 32 }: { url?: string | undefined; login: string; size?: number }) {
  const cls = `avatar${size < 32 ? ' sm' : size > 32 ? ' lg' : ''}`;
  if (!url || !url.startsWith('https://')) return <span class={`${cls} avatar-fallback`} aria-hidden="true">{login.slice(0, 1).toUpperCase()}</span>;
  return <img class={cls} src={url} alt="" width={size} height={size} loading="lazy" referrerpolicy="no-referrer" />;
}
