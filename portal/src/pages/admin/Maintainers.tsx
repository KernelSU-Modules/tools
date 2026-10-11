import { useEffect, useRef, useState } from 'preact/hooks';
import { useAction, useApp, useAsync, useDocumentTitle } from '../../context.tsx';
import { Alert, Avatar, Badge, ErrorBox, ExternalLink, Field, Loading, PageHeader, Section } from '../../components/ui.tsx';
import { ChevronRight, Trash2, UserPlus, X } from '../../components/icons.tsx';
import type { MaintainerView } from '../../api/types.ts';
import { WHOAMI_COMMAND, parseLogin, parseTelegramId, telegramOwner } from '../../lib/admin.ts';
import { githubUserUrl } from '../../lib/format.ts';

export function Maintainers() {
  const { api, t, me } = useApp();
  useDocumentTitle(t('admin.maintainers'));
  const list = useAsync(() => api.maintainers(), []);
  const [editing, setEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [login, setLogin] = useState('');
  const [loginTouched, setLoginTouched] = useState(false);
  const add = useAction((l: string) => api.addMaintainer(l));
  const maintainers = list.data?.maintainers ?? [];
  const current = maintainers.find((m) => m.githubId === editing) ?? null;
  const parsedLogin = parseLogin(login);
  const loginError = loginTouched && login.trim() !== '' && !parsedLogin;

  const done = (msg: string) => {
    setNotice(msg);
    setEditing(null);
    list.reload();
  };

  return (
    <div class="page">
      <PageHeader title={t('admin.maintainers')} subtitle={t('maint.subtitle')} />
      {notice && <Alert tone="success">{notice}</Alert>}

      <Section id="maint-list" title={t('maint.list')}>
        {list.loading && !list.data && <Loading />}
        <ErrorBox error={list.error} onRetry={list.reload} />
        {maintainers.length > 0 && (
          <div class="table-wrap">
            <table class="table maint-table">
              <thead>
                <tr>
                  <th scope="col">{t('maint.user')}</th>
                  <th scope="col">{t('maint.telegram')}</th>
                  <th scope="col">
                    <span class="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {maintainers.map((m) => (
                  // The whole row is a mouse target; the Edit button is the keyboard / screen-reader control.
                  <tr key={m.githubId} class="clickable" onClick={() => setEditing(m.githubId)}>
                    <td>
                      <div class="person">
                        <Avatar url={m.avatarUrl} login={m.login} />
                        <div class="person-text">
                          <span class="person-name">
                            {m.name || m.login}
                            {me?.user?.id === m.githubId && <Badge tone="info">{t('maint.you')}</Badge>}
                          </span>
                          <ExternalLink class="muted small" href={githubUserUrl(m.login)} onClick={(e) => e.stopPropagation()}>
                            @{m.login}
                          </ExternalLink>
                        </div>
                      </div>
                    </td>
                    <td>
                      {m.telegramId !== null ? (
                        <code>{m.telegramId}</code>
                      ) : (
                        <Badge tone="warning" title={t('maint.notBoundHint')}>
                          {t('maint.notBound')}
                        </Badge>
                      )}
                    </td>
                    <td class="cell-end">
                      <button
                        type="button"
                        class="icon-btn"
                        data-maint-edit={m.githubId}
                        aria-label={t('maint.edit', { login: m.login })}
                        title={t('maint.edit', { login: m.login })}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(m.githubId);
                        }}
                      >
                        <ChevronRight size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="maint-add" title={t('maint.addTitle')} subtitle={t('maint.addHint')}>
        <form
          class="card add-form"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            setLoginTouched(true);
            if (!parsedLogin) return;
            setNotice(null);
            const added = await add.run(parsedLogin);
            if (added) {
              setLogin('');
              setLoginTouched(false);
              done(t('maint.added', { login: added.login }));
            }
          }}
        >
          <Field label={t('maint.githubLogin')} id="maint-login" error={loginError ? t('maint.err.login') : null}>
            <input
              id="maint-login"
              placeholder="octocat"
              autoComplete="off"
              spellcheck={false}
              value={login}
              aria-invalid={loginError}
              onInput={(e) => setLogin((e.target as HTMLInputElement).value)}
              onBlur={() => setLoginTouched(true)}
            />
          </Field>
          <button type="submit" class="btn primary" disabled={!parsedLogin || add.pending}>
            <UserPlus size={16} /> {add.pending ? t('maint.adding') : t('maint.add')}
          </button>
        </form>
        <ErrorBox error={add.error} />
      </Section>

      {current && (
        <MaintainerDialog
          key={current.githubId}
          m={current}
          all={maintainers}
          isSelf={me?.user?.id === current.githubId}
          onClose={() => setEditing(null)}
          onDone={done}
        />
      )}
    </div>
  );
}

/**
 * Modal editor on a native <dialog> (showModal): focus moves into it and stays there, Esc closes it, and on close
 * focus returns to the row's Edit button.
 */
function MaintainerDialog({
  m,
  all,
  isSelf,
  onClose,
  onDone,
}: {
  m: MaintainerView;
  all: MaintainerView[];
  isSelf: boolean;
  onClose(): void;
  onDone(msg: string): void;
}) {
  const { api, t } = useApp();
  const ref = useRef<HTMLDialogElement>(null);
  const [tg, setTg] = useState(m.telegramId === null ? '' : String(m.telegramId));
  const save = useAction((v: number | null) => api.setMaintainerTelegram(m.githubId, v));
  const remove = useAction(() => api.removeMaintainer(m.githubId));
  const busy = save.pending || remove.pending;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const d = ref.current!;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    // Esc: keep the dialog open while a request is running; otherwise close it through the parent state.
    const onCancel = (e: Event) => {
      e.preventDefault();
      if (!busyRef.current) closeRef.current();
    };
    // Closed by the browser anyway (e.g. a repeated Esc): sync the parent state.
    const onNativeClose = () => closeRef.current();
    d.addEventListener('cancel', onCancel);
    d.addEventListener('close', onNativeClose);
    if (typeof d.showModal === 'function') {
      if (!d.open) d.showModal();
    } else d.setAttribute('open', '');
    d.querySelector<HTMLInputElement>('#maint-tg')?.focus();
    return () => {
      d.removeEventListener('cancel', onCancel);
      d.removeEventListener('close', onNativeClose);
      if (d.open && typeof d.close === 'function') d.close();
      const back = opener?.isConnected ? opener : document.querySelector<HTMLElement>(`[data-maint-edit="${m.githubId}"]`);
      back?.focus();
    };
  }, []);

  const parsed = parseTelegramId(tg);
  const owner = parsed === 'invalid' ? null : telegramOwner(all, m.githubId, parsed);
  const tgError = parsed === 'invalid' ? t('maint.err.telegramId') : owner ? t('maint.err.telegramTaken', { login: owner.login }) : null;
  const changed = parsed !== 'invalid' && parsed !== m.telegramId;
  const removeBlocked = isSelf ? t('maint.cannotRemoveSelf') : all.length <= 1 ? t('maint.cannotRemoveLast') : null;

  const submit = async (value: number | null) => {
    if ((await save.run(value)) !== undefined) onDone(t(value === null ? 'maint.telegramCleared' : 'maint.telegramSaved', { login: m.login }));
  };

  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby="maint-dialog-title"
      onClick={(e) => {
        // A click on the <dialog> box itself (not its content) is a click on the backdrop.
        if (e.target === ref.current && !busy) onClose();
      }}
    >
      <div class="dialog-body">
        <header class="dialog-head">
          <div class="person">
            <Avatar url={m.avatarUrl} login={m.login} size={40} />
            <div class="person-text">
              <h2 id="maint-dialog-title" class="person-name">
                {m.name || m.login}
                <span class="sr-only"> — {t('maint.dialogTitle')}</span>
              </h2>
              <span class="muted small">
                <ExternalLink href={githubUserUrl(m.login)}>@{m.login}</ExternalLink> · {t('maint.githubId')} <code>{m.githubId}</code>
              </span>
            </div>
          </div>
          <button type="button" class="icon-btn" aria-label={t('common.close')} title={t('common.close')} onClick={onClose} disabled={busy}>
            <X size={18} />
          </button>
        </header>

        <form
          class="form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (changed && !tgError && !busy) void submit(parsed as number | null);
          }}
        >
          <Field label={t('maint.telegramId')} id="maint-tg" hint={t('maint.telegramHint', { cmd: WHOAMI_COMMAND })} error={tgError}>
            <input
              id="maint-tg"
              inputMode="numeric"
              autoComplete="off"
              placeholder="123456789"
              value={tg}
              aria-invalid={!!tgError}
              aria-describedby={tgError ? 'maint-tg-hint maint-tg-error' : 'maint-tg-hint'}
              onInput={(e) => setTg((e.target as HTMLInputElement).value)}
            />
          </Field>
          <ErrorBox error={save.error} />
          <div class="row-actions">
            <button type="submit" class="btn primary" disabled={!changed || !!tgError || busy}>
              {save.pending ? t('common.saving') : t('common.save')}
            </button>
            {m.telegramId !== null && (
              <button type="button" class="btn" disabled={busy} onClick={() => void submit(null)}>
                {t('maint.unbind')}
              </button>
            )}
            <button type="button" class="btn" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </form>

        <section class="dialog-danger" aria-labelledby="maint-remove-title">
          <h3 id="maint-remove-title">{t('maint.removeTitle')}</h3>
          <p class="hint">{removeBlocked ?? t('maint.removeHint')}</p>
          <ErrorBox error={remove.error} />
          <button
            type="button"
            class="btn danger"
            disabled={!!removeBlocked || busy}
            onClick={async () => {
              if (!confirm(t('maint.confirmRemove', { login: m.login }))) return;
              if ((await remove.run()) !== undefined) onDone(t('maint.removed', { login: m.login }));
            }}
          >
            <Trash2 size={16} /> {t('maint.remove', { login: m.login })}
          </button>
        </section>
      </div>
    </dialog>
  );
}
