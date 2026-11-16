import { useState } from 'preact/hooks';
import { useApp, useDocumentTitle } from '../../context.tsx';
import { Alert, PageHeader, Section } from '../../components/ui.tsx';
import { Check, Copy } from '../../components/icons.tsx';
import { claudeCommand, jsonConfig, MCP_SERVER_NAME } from '../../lib/mcp.ts';

/** Absolute lifetime of a Portal login (worker SESSION_MAX_LIFETIME_MS); MCP grants end with it. */
const LOGIN_DAYS = 30;

function CopyButton({ text }: { text: string }) {
  const { t } = useApp();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      class="btn sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the text is selectable */
        }
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? t('mcp.copied') : t('mcp.copy')}
    </button>
  );
}

function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div class="snippet">
      <div class="snippet-head">
        <span class="muted small">{label}</span>
        <CopyButton text={text} />
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

export function Mcp() {
  const { t } = useApp();
  useDocumentTitle(t('admin.mcp'));
  const url = `${location.origin}/mcp`;
  return (
    <div class="page">
      <PageHeader title={t('admin.mcp')} subtitle={t('mcp.subtitle')} />
      <Section id="mcp-connect" title={t('mcp.connect')}>
        <p>{t('mcp.connectHint')}</p>
        <Snippet label={t('mcp.endpoint')} text={url} />
        <Snippet label="Claude Code" text={claudeCommand(url)} />
        <Snippet label={t('mcp.jsonConfig')} text={jsonConfig(url)} />
        <p class="muted small">
          {t('mcp.skill')} <a href="/SKILL.md">/SKILL.md</a> · {t('mcp.serverName')} <code>{MCP_SERVER_NAME}</code>
        </p>
      </Section>
      <Alert tone="info">{t('mcp.lifetime', { days: LOGIN_DAYS })}</Alert>
    </div>
  );
}
