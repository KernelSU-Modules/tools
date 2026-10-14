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
  ['/repos/100003/precheck', 'Script (one-shot, runs action.sh)'],
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

describe('maintainers page', () => {
  const input = (el: HTMLInputElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement;

  it('lists avatar, name, @login, the current user and Telegram bindings; edits in a dialog', async () => {
    let state!: ReturnType<typeof createState>;
    const root = mount('maintainer', '/admin/maintainers', (s) => (state = s));
    await settle(root);
    const rows = root.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('KernelSU Maintainer');
    expect(rows[0]!.querySelector('a[href="https://github.com/kernelsu-maintainer"]')?.textContent).toBe('@kernelsu-maintainer');
    expect(rows[0]!.textContent).toContain('you');
    expect(rows[0]!.textContent).toContain('555000111');
    expect(rows[1]!.textContent).toContain('Not bound');
    expect(root.textContent).not.toMatch(/telegram username/i);

    // click the row -> dialog with the Telegram id field focused and the /whoami hint
    (rows[1] as HTMLElement).click();
    await settle(root);
    const dialog = root.querySelector('dialog')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('/whoami@ksudevbot');
    const field = dialog.querySelector<HTMLInputElement>('#maint-tg')!;
    expect(document.activeElement).toBe(field);
    // removing the last-but-one is allowed, yourself is not (see below)
    expect(button(dialog, 'Remove @second-maintainer').disabled).toBe(false);

    input(field, '@someone');
    await settle(root);
    expect(dialog.textContent).toContain('Enter the numeric Telegram user ID');
    expect(button(dialog, 'Save').disabled).toBe(true);
    input(field, '555000111');
    await settle(root);
    expect(dialog.textContent).toContain('already bound to @kernelsu-maintainer');
    input(field, '424242');
    await settle(root);
    button(dialog, 'Save').click();
    await settle(root);
    expect(root.querySelector('dialog')).toBeNull();
    expect(state.maintainers[1]!.telegram).toEqual({ id: 424242 });
    expect(root.textContent).toContain('Saved the Telegram user ID of @second-maintainer');

    // Esc closes the dialog
    (root.querySelector('[data-maint-edit="2001"]') as HTMLButtonElement).click();
    await settle(root);
    const d2 = root.querySelector('dialog')!;
    expect(button(d2, 'Remove @kernelsu-maintainer').disabled).toBe(true);
    expect(d2.textContent).toContain('You cannot remove yourself');
    d2.dispatchEvent(new Event('cancel', { cancelable: true }));
    await settle(root);
    expect(root.querySelector('dialog')).toBeNull();
  });

  it('adds a maintainer by GitHub username and shows API errors', async () => {
    let state!: ReturnType<typeof createState>;
    const root = mount('maintainer', '/admin/maintainers', (s) => (state = s));
    await settle(root);
    const login = root.querySelector<HTMLInputElement>('#maint-login')!;
    input(login, 'github');
    await settle(root);
    login.form!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(root);
    expect(root.textContent).toContain('only personal accounts');
    input(login, 'https://github.com/octocat');
    await settle(root);
    login.form!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(root);
    expect(state.maintainers.map((m) => m.github.login)).toContain('octocat');
    expect(root.textContent).toContain('Added @octocat');
    expect(root.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(root.textContent).toContain('The Octocat');
  });
});
