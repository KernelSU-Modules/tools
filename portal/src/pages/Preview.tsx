import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link } from '../router.tsx';
import { useAction, useApp, useAsync, useDocumentTitle } from '../context.tsx';
import { Alert, ErrorBox, Loading, PageHeader } from '../components/ui.tsx';
import { SandboxFrame } from '../components/SandboxFrame.tsx';
import { buildPreviewDoc, renderPreview } from '../lib/preview.ts';
import { getRepo } from '../store.ts';
import { FolderGit2, ListChecks, RefreshCw } from '../components/icons.tsx';
import type { PreviewResponse } from '../api/types.ts';

function prefersDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Preview of the module's single description document (module.yaml `description`). */
export function Preview({ repositoryId, repoName }: { repositoryId: number; repoName?: string | null }) {
  const { api, t } = useApp();
  const repo = useAsync(() => getRepo(api, repositoryId), [repositoryId]);
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [dark, setDark] = useState(prefersDark());
  const action = useAction(() => api.preview({ repositoryId }));
  const name = repo.data?.fullName ?? repoName ?? `#${repositoryId}`;
  useDocumentTitle(`${t('action.preview')} · ${name}`);

  const render = async () => {
    const r = await action.run();
    if (!r) return;
    setRenderError(null);
    try {
      // Rendered in the browser (same renderer + sanitizer as the site build); the Worker only returns Markdown.
      const out = await renderPreview(r);
      setResult(r);
      setHtml(out);
    } catch (e) {
      setRenderError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void render();
  }, [repositoryId]);

  const srcdoc = useMemo(() => (html !== null ? buildPreviewDoc(html, { origin: location.origin, dark }) : ''), [html, dark]);

  return (
    <div class="page">
      <PageHeader title={t('preview.title', { repo: name })} subtitle={t('preview.subtitle')} />
      <form
        class="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void render();
        }}
      >
        <label class="check">
          <input type="checkbox" checked={dark} onChange={(e) => setDark((e.target as HTMLInputElement).checked)} />
          <span>{t('preview.dark')}</span>
        </label>
        <button type="submit" class="btn primary" disabled={action.pending} aria-busy={action.pending}>
          <RefreshCw size={16} /> {t('preview.render')}
        </button>
      </form>
      {action.pending && <Loading label={t('preview.rendering')} />}
      <ErrorBox error={action.error} />
      {renderError && <Alert tone="danger" title={t('preview.renderFailed')}>{renderError}</Alert>}
      {result && html !== null && (
        <>
          <p class="hint">
            {t('preview.rendered', { path: result.ctx.docPath, commit: result.ctx.commit.slice(0, 7) })} · {t('preview.sandboxNote')}
          </p>
          <SandboxFrame title={t('preview.frameTitle', { repo: name })} srcdoc={srcdoc} />
        </>
      )}
      <div class="links">
        <Link class="back" href={`/repos/${repositoryId}/precheck`}>
          <ListChecks size={16} /> {t('action.precheck')}
        </Link>
        <Link class="back" href="/repos">
          <FolderGit2 size={16} /> {t('nav.repos')}
        </Link>
      </div>
    </div>
  );
}
