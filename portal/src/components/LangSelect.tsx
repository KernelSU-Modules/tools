import { useApp } from '../context.tsx';
import { type Lang, LANG_NAMES, LANGS } from '../i18n/index.ts';
import { Languages } from './icons.tsx';

/** UI language switch (sidebar user box / sign-in card). */
export function LangSelect() {
  const { t, lang, setLang } = useApp();
  return (
    <div class="lang">
      <Languages size={16} />
      <label class="sr-only" for="lang-select">
        {t('nav.language')}
      </label>
      <select id="lang-select" class="select sm" value={lang} onChange={(e) => setLang((e.target as HTMLSelectElement).value as Lang)}>
        {LANGS.map((l) => (
          <option key={l} value={l}>
            {LANG_NAMES[l]}
          </option>
        ))}
      </select>
    </div>
  );
}
