import { docsUrl } from '../lib/docs.ts';
import { loginUrl } from '../lib/login.ts';
import { useApp, useDocumentTitle } from '../context.tsx';
import { LangSelect } from '../components/LangSelect.tsx';
import { BookOpen, GithubIcon } from '../components/icons.tsx';

/** Signed-out start page: centered sign-in card; everything else lives in the docs. */
export function Landing({ required = false }: { required?: boolean }) {
  const { t, lang } = useApp();
  useDocumentTitle('');
  return (
    <div class="center">
      <main id="main" class="auth-stack">
        <section class="auth-card" aria-labelledby="landing-title">
          <img class="logo" src="/favicon.svg" alt="" width="52" height="52" />
          <p class="kicker">{t('brand.name')}</p>
          <h1 id="landing-title" tabIndex={-1}>
            {t('landing.title')}
          </h1>
          <p class="lead">{t('landing.lead')}</p>
          {required && (
            <p class="err warn" role="status">
              {t('auth.required')}
            </p>
          )}
          <a class="btn primary" href={loginUrl(location.pathname + location.search)}>
            <GithubIcon /> {t('auth.signInGithub')}
          </a>
          <a class="btn" href={docsUrl('/', lang)}>
            <BookOpen size={18} /> {t('landing.readDocs')}
          </a>
          <p class="fine">{t('landing.privacy')}</p>
          <div class="auth-foot">
            <LangSelect />
            <span aria-hidden="true">·</span>
            <a href={docsUrl('/checks', lang)}>{t('nav.checks')}</a>
          </div>
        </section>
      </main>
    </div>
  );
}
