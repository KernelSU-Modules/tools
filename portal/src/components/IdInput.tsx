import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ApiError } from '../api/client.ts';
import type { IdAvailability } from '../api/types.ts';
import { toApiError, useApp } from '../context.tsx';
import { idFormatError, MODULE_ID_MAX } from '../lib/ids.ts';
import { Field } from './ui.tsx';

export type IdCheck =
  | { state: 'idle' }
  | { state: 'invalid'; reason: 'empty' | 'tooShort' | 'tooLong' | 'pattern' }
  | { state: 'checking' }
  | { state: 'done'; result: IdAvailability }
  | { state: 'error'; error: ApiError };

/** Debounced live lookup of GET /api/ids/:id. */
export function useIdCheck(id: string, delay = 350): IdCheck {
  const { api } = useApp();
  const [check, setCheck] = useState<IdCheck>({ state: 'idle' });
  useEffect(() => {
    const fmt = idFormatError(id);
    if (fmt) {
      setCheck(fmt === 'empty' ? { state: 'idle' } : { state: 'invalid', reason: fmt });
      return;
    }
    setCheck({ state: 'checking' });
    let live = true;
    const timer = setTimeout(() => {
      api.checkId(id).then(
        (result) => live && setCheck({ state: 'done', result }),
        (e: unknown) => live && setCheck({ state: 'error', error: toApiError(e) }),
      );
    }, delay);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id]);
  return check;
}

export function IdInput({
  value,
  onInput,
  check,
}: {
  value: string;
  onInput(v: string): void;
  check: IdCheck;
}) {
  const { t } = useApp();
  let msg: ComponentChildren = null;
  let tone = '';
  switch (check.state) {
    case 'invalid':
      msg = t(`id.invalid.${check.reason}`, { max: MODULE_ID_MAX });
      tone = 'bad';
      break;
    case 'checking':
      msg = t('id.checking');
      break;
    case 'error':
      msg = t('id.checkFailed', { message: check.error.message });
      tone = 'bad';
      break;
    case 'done': {
      const r = check.result;
      if (r.available) {
        msg = t('id.available');
        tone = 'good';
      } else {
        msg = t('id.unavailable', { reason: r.reason ?? r.status ?? '' });
        tone = 'bad';
      }
    }
  }
  return (
    <Field label={t('id.label')} id="module-id" hint={t('id.hint')}>
      <input
        id="module-id"
        name="id"
        type="text"
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value.trim())}
        autoComplete="off"
        autoCapitalize="off"
        spellcheck={false}
        maxLength={MODULE_ID_MAX + 8}
        required
        aria-describedby="module-id-hint module-id-status"
        aria-invalid={tone === 'bad'}
      />
      <p id="module-id-status" class={`id-status ${tone}`} aria-live="polite">
        {msg}
      </p>
    </Field>
  );
}
