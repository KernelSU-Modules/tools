// Client script, bundled by Astro into an external hashed module (CSP: script-src 'self').
// Progressive enhancement only: every page works without JavaScript. Never uses innerHTML.
import Fuse from 'fuse.js';

interface Entry {
  id: string;
  name: string;
  summary: string;
  authors: string[];
  tags: string[];
  metamodule: boolean;
  version: string;
  updatedAt: string;
  url: string;
}

const PREF = 'kernelsu-locale';
const THEME = 'kernelsu-theme';
const body = document.body;

function store(v: string): void {
  try {
    localStorage.setItem(PREF, v);
  } catch {
    /* storage disabled */
  }
}

function load(): string | null {
  try {
    return localStorage.getItem(PREF);
  } catch {
    return null;
  }
}

for (const a of document.querySelectorAll<HTMLElement>('[data-set-locale]')) {
  a.addEventListener('click', () => store(a.dataset['setLocale'] ?? ''));
}

/** Home page: go to the preferred UI locale once (an explicit earlier choice wins). */
function autoLocale(): boolean {
  const auto = body.dataset['autoLocale'];
  if (!auto) return false;
  const supported = auto.split(' ');
  const pref = load();
  let target: string | null = pref && supported.includes(pref) ? pref : null;
  if (!target) {
    for (const lang of navigator.languages ?? [navigator.language]) {
      const l = String(lang).toLowerCase();
      target = supported.find((s) => l === s.toLowerCase()) ?? supported.find((s) => l.split('-')[0] === s.toLowerCase().split('-')[0]) ?? null;
      if (target) break;
    }
  }
  if (target && target !== body.dataset['locale']) {
    location.replace(`/${target}/${location.search}`);
    return true;
  }
  return false;
}

interface Search {
  fuse: Fuse<Entry>;
  entries: Entry[];
}

let fusePromise: Promise<Search | null> | null = null;

function index(): Promise<Search | null> {
  fusePromise ??= fetch(body.dataset['search'] ?? '', { credentials: 'same-origin' })
    .then((r) => {
      if (!r.ok) throw new Error(`search index ${r.status}`);
      return r.json() as Promise<{ modules?: Entry[] }>;
    })
    .then((d) => {
      const entries = d.modules ?? [];
      const fuse = new Fuse(entries, {
          keys: [
            { name: 'name', weight: 3 },
            { name: 'id', weight: 3 },
            { name: 'summary', weight: 1 },
            { name: 'authors', weight: 1 },
            { name: 'tags', weight: 1 },
          ],
          threshold: 0.4,
          ignoreLocation: true,
        });
      return { fuse, entries };
    })
    .catch(() => null);
  return fusePromise;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Header search: ARIA 1.2 combobox (input) controlling a listbox of the top matches. ArrowUp/ArrowDown move the
 * active option (aria-activedescendant), Enter opens it (or the first match), Escape closes.
 */
function headerSearch(): void {
  const input = document.getElementById('site-search') as HTMLInputElement | null;
  const popup = document.getElementById('site-search-results');
  const listbox = document.getElementById('site-search-listbox');
  const empty = document.getElementById('site-search-empty');
  const status = document.getElementById('site-search-status');
  if (!input || !popup || !listbox) return;
  let active = -1;
  const options = () => Array.from(listbox.querySelectorAll<HTMLAnchorElement>('[role="option"]'));
  const setActive = (i: number) => {
    const opts = options();
    active = opts.length ? (i + opts.length) % opts.length : -1;
    opts.forEach((o, j) => o.setAttribute('aria-selected', j === active ? 'true' : 'false'));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', opts[active]!.id);
      opts[active]!.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const hide = () => {
    popup.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    setActive(-1);
  };
  const show = (nodes: HTMLElement[], message: string) => {
    listbox.replaceChildren(...nodes);
    if (empty) {
      empty.textContent = nodes.length ? '' : message;
      empty.hidden = nodes.length > 0;
    }
    if (status) status.textContent = message;
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(-1);
  };
  input.addEventListener('focus', () => void index(), { once: true });
  input.addEventListener('input', async () => {
    const q = input.value.trim();
    if (!q) return hide();
    const s = await index();
    if (!s || input.value.trim() !== q) return;
    const hits = s.fuse.search(q, { limit: 6 });
    if (!hits.length) return show([], (body.dataset['noMatch'] ?? '').replace('{q}', q));
    show(
      hits.map(({ item }, i) => {
        const a = el('a', 'block p-3 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors group');
        a.href = `/${item.url}`;
        a.id = `site-search-option-${i}`;
        a.setAttribute('role', 'option');
        a.setAttribute('aria-selected', 'false');
        a.tabIndex = -1;
        const title = el('div', 'flex items-baseline justify-between gap-2');
        title.append(
          el('span', 'font-medium text-gray-900 dark:text-slate-200 group-hover:text-blue-600 dark:group-hover:text-blue-400 truncate', item.name),
          el('span', 'text-xs text-gray-400 dark:text-slate-500 flex-none', `v${item.version}`),
        );
        a.append(title, el('div', 'text-xs text-gray-500 dark:text-slate-500 line-clamp-1 mt-0.5', item.summary || item.id));
        return a;
      }),
      String(hits.length),
    );
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return hide();
    if (popup.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      const opts = options();
      const target = opts[active >= 0 ? active : 0];
      if (target) {
        e.preventDefault();
        target.click();
      }
    }
  });
  document.addEventListener('click', (e) => {
    if (e.target instanceof Node && !input.contains(e.target) && !popup.contains(e.target)) hide();
  });
}

/**
 * Theme toggle. Default (no stored choice) = prefers-color-scheme, handled by CSS alone; theme-init.js applies a
 * stored choice before first paint. Toggling back to the system preference clears the stored choice.
 */
function themeToggle(): void {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const root = document.documentElement;
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const system = () => (media?.matches ? 'dark' : 'light');
  const current = () => root.getAttribute('data-theme') ?? system();
  const sync = () => btn.setAttribute('aria-pressed', current() === 'dark' ? 'true' : 'false');
  btn.hidden = false;
  sync();
  media?.addEventListener?.('change', sync);
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    try {
      if (next === system()) localStorage.removeItem(THEME);
      else localStorage.setItem(THEME, next);
    } catch {
      /* storage disabled: still switch for this page */
    }
    if (next === system()) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);
    sync();
  });
}

/** Module list: fuzzy filter, metamodule filter and sort over the statically rendered cards. */
function listFilter(): void {
  const input = document.getElementById('filter') as HTMLInputElement | null;
  const list = document.getElementById('modules');
  if (!input || !list) return;
  const meta = document.getElementById('filter-meta') as HTMLInputElement | null;
  const sort = document.getElementById('sort') as HTMLSelectElement | null;
  const count = document.getElementById('count');
  const empty = document.getElementById('no-results');
  const cards = new Map<string, HTMLElement>();
  for (const li of Array.from(list.children) as HTMLElement[]) cards.set(li.dataset['id'] ?? '', li);
  let entries: Entry[] = [];
  let fuse: Fuse<Entry> | null = null;

  const update = () => {
    const q = input.value.trim();
    let rows = q && fuse ? fuse.search(q).map((r) => r.item) : [...entries];
    if (meta?.checked) rows = rows.filter((e) => e.metamodule);
    if (!q) {
      rows.sort(
        sort?.value === 'name'
          ? (a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)
          : (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1),
      );
    }
    const shown = new Set<string>();
    for (const e of rows) {
      const li = cards.get(e.id);
      if (!li) continue;
      li.hidden = false;
      list.appendChild(li);
      shown.add(e.id);
    }
    for (const [id, li] of cards) if (!shown.has(id)) li.hidden = true;
    const n = shown.size;
    if (count) count.textContent = n === 1 ? (count.dataset['one'] ?? '1') : (count.dataset['many'] ?? '{n}').replace('{n}', String(n));
    if (empty) empty.hidden = n !== 0;
    try {
      const url = new URL(location.href);
      if (q) url.searchParams.set('q', q);
      else url.searchParams.delete('q');
      history.replaceState(null, '', url);
    } catch {
      /* ignore */
    }
  };

  void index().then((s) => {
    if (!s?.entries.length) return;
    fuse = s.fuse;
    entries = s.entries;
    const q = new URLSearchParams(location.search).get('q');
    if (q) input.value = q;
    input.addEventListener('input', update);
    meta?.addEventListener('change', update);
    sort?.addEventListener('change', update);
    if (q) update();
  });
}

if (!autoLocale()) {
  themeToggle();
  headerSearch();
  listFilter();
}
