// @vitest-environment happy-dom
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api/client.ts';
import { App } from '../src/app.tsx';
import { createState, handle, type Persona } from '../src/mock/server.ts';

// Don't let happy-dom load iframe documents / stylesheets (no server in tests).
const hd = (window as unknown as { happyDOM?: { settings: Record<string, unknown> } }).happyDOM;
if (hd) Object.assign(hd.settings, { disableIframePageLoading: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true });

function mount(persona: Persona, path: string, tweak?: (s: ReturnType<typeof createState>) => void) {
  history.replaceState(null, '', path);
  const state = createState(persona);
  tweak?.(state);
  const api = new ApiClient({
    fetch: async (input, init = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      return handle(state, (init.method ?? 'GET').toUpperCase(), new URL(input, location.href), new Headers(init.headers), body);
    },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<App api={api} />, root);
  return root;
}

async function settle(root: HTMLElement) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10));
    if (!root.querySelector('.loading') && i > 5) return;
  }
}

afterEach(() => {
  document.body.innerHTML = '';
});

const ROUTES: [string, string][] = [
  ['/', 'alice/toolbox'],
  ['/repos', 'alice/zygisk-assistant'],
  ['/repos/100002/precheck', 'Zygisk Assistant'],
  ['/repos/100003/precheck', 'release-not-immutable'],
  ['/repos/100005/precheck', 'manifest-missing'],
  ['/repos/100002/submit', 'zygisk-assistant'],
  ['/repos/100001/preview', 'Preview'],
  ['/transfer?id=demo.toolbox', 'Transfer'],
  ['/modules', 'demo.toolbox'],
  ['/modules/demo.toolbox', '1.4.2'],
  ['/modules/net.stale', 'Highest versionCode'],
  ['/modules/pending.mod', 'release-not-immutable'],
  ['/modules/move.me', 'Passed'],
  ['/modules/spam.thing', 'too generic'],
  ['/modules/suspended.mod', 'bootloops'],
  ['/modules/old.mod', 'No longer maintained'],
  ['/admin', 'cool.module'],
  ['/admin/requests/c00lm0dul3', 'dave/cool-module'],
  ['/admin/requests/zzzzzzzzzz', 'no longer open'],
  ['/admin/modules', 'zygisk_next'],
  ['/admin/maintainers', 'kernelsu-maintainer'],
  ['/admin/banned', 'spammer'],
  ['/admin/status', 'sync: cron'],
  ['/nope', 'Not found'],
];

describe('smoke: every page renders against the mock API', () => {
  for (const [path, expected] of ROUTES) {
    it(path, async () => {
      const root = mount('maintainer', path);
      await settle(root);
      const text = root.textContent ?? '';
      expect(text).toContain(expected);
      expect(root.querySelector('.alert-danger[role="alert"] .error-code')).toBeNull();
    });
  }
  it('signed out shows the landing page with GitHub sign-in', async () => {
    const root = mount('signed-out', '/');
    await settle(root);
    expect(root.textContent).toContain('Sign in with GitHub');
    expect(root.querySelector('a[href^="/auth/login"]')).not.toBeNull();
  });
  it('developers do not see the admin area', async () => {
    const root = mount('developer', '/admin');
    await settle(root);
    expect(root.textContent).toContain('only available to KernelSU Modules maintainers');
    expect(root.querySelector('a[href="/admin"]')).toBeNull();
  });
  it('preview uses a sandboxed iframe without allow-scripts', async () => {
    const root = mount('developer', '/repos/100001/preview');
    await settle(root);
    const f = root.querySelector('iframe')!;
    expect(f).not.toBeNull();
    expect(f.getAttribute('sandbox')).toBe('');
    const doc = f.getAttribute('srcdoc') ?? (f as HTMLIFrameElement).srcdoc;
    expect(doc).toContain('Content-Security-Policy');
    // rendered in the browser from the raw Markdown, through the site sanitizer
    expect(doc).toContain('<strong>sample</strong>');
    expect(doc).not.toMatch(/<script/i);
    expect(doc).toContain('https://raw.githubusercontent.com/alice/toolbox/');
  });
  it('repos page warns when the list was truncated', async () => {
    const root = mount('developer', '/repos', (s) => (s.reposTruncated = true));
    await settle(root);
    expect(root.textContent).toContain('Repository list is incomplete');
    const plain = mount('developer', '/repos');
    await settle(plain);
    expect(plain.textContent).not.toContain('Repository list is incomplete');
  });
  it('a pending submission offers Sync now (re-runs the sync check)', async () => {
    const root = mount('developer', '/modules/pending.mod');
    await settle(root);
    expect(root.textContent).toContain('Sync now');
  });
});
