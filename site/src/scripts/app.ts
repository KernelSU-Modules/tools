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
  kind: 'module' | 'script';
  version: string;
  updatedAt: string;
  stars: number | null;
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
        const a = el('a', 'block border-b border-line-muted px-3 py-2.5 last:border-b-0 hover:bg-accent-subtle');
        a.href = `/${item.url}`;
        a.id = `site-search-option-${i}`;
        a.setAttribute('role', 'option');
        a.setAttribute('aria-selected', 'false');
        a.tabIndex = -1;
        const title = el('div', 'flex items-baseline justify-between gap-2');
        title.append(el('strong', 'truncate font-semibold text-fg', item.name), el('span', 'flex-none text-xs text-muted', item.version));
        a.append(title, el('div', 'mt-0.5 line-clamp-2 text-xs text-muted', item.summary || item.id));
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
  // "/" focuses the search box (as on GitHub) unless the user is typing somewhere.
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || t?.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    input.focus();
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
      const byUpdated = (a: Entry, b: Entry) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.id < b.id ? -1 : 1);
      rows.sort(
        sort?.value === 'name'
          ? (a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)
          : sort?.value === 'stars'
            ? (a, b) => (b.stars ?? 0) - (a.stars ?? 0) || byUpdated(a, b)
            : byUpdated,
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
    if (count) {
      count.textContent = String(n);
      count.title = n === 1 ? (count.dataset['one'] ?? '1') : (count.dataset['many'] ?? '{n}').replace('{n}', String(n));
    }
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
    const tools = document.getElementById('list-tools');
    if (tools) tools.hidden = false;
    const q = new URLSearchParams(location.search).get('q');
    if (q) input.value = q;
    input.addEventListener('input', update);
    meta?.addEventListener('change', update);
    sort?.addEventListener('change', update);
    if (q) update();
  });
}

/** "Updated 2026-10-02" -> "Updated 3 days ago" (the static date stays in the title). */
function relativeTimes(): void {
  if (typeof Intl === 'undefined' || !Intl.RelativeTimeFormat) return;
  const fmt = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const t of document.querySelectorAll<HTMLTimeElement>('time[data-relative]')) {
    const when = Date.parse(t.dateTime);
    if (Number.isNaN(when)) continue;
    const secs = Math.max(0, (Date.now() - when) / 1000);
    const unit = units.find(([, n]) => secs >= n);
    t.title = t.textContent ?? '';
    t.textContent = unit ? fmt.format(-Math.floor(secs / unit[1]), unit[0]) : fmt.format(0, 'minute');
  }
}

/** <details class="dropdown"> menus: close on outside click and on Escape (focus back to the toggle). */
function dropdowns(): void {
  const menus = Array.from(document.querySelectorAll<HTMLDetailsElement>('details.dropdown'));
  document.addEventListener('click', (e) => {
    for (const d of menus) if (d.open && e.target instanceof Node && !d.contains(e.target)) d.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const d of menus) {
      if (!d.open) continue;
      d.open = false;
      d.querySelector('summary')?.focus();
    }
  });
}

/**
 * Module page: the in-page links of #module-tabs become ARIA tabs (one panel at a time). Arrow keys / Home / End
 * move between tabs; the URL hash selects the tab holding its target. Without JS every panel stays visible.
 */
function moduleTabs(): void {
  const nav = document.getElementById('module-tabs');
  const box = document.getElementById('module-panels');
  if (!nav || !box) return;
  const tabs = Array.from(nav.querySelectorAll<HTMLAnchorElement>('a[data-tab]'));
  const panels = tabs.map((t) => document.getElementById(t.dataset['tab'] ?? ''));
  if (!tabs.length || panels.some((p) => !p)) return;
  nav.setAttribute('role', 'tablist');
  box.classList.add('tabs-ready');
  tabs.forEach((t, i) => {
    const p = panels[i]!;
    t.id = `tab-${p.id}`;
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-controls', p.id);
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labelledby', t.id);
  });
  const select = (i: number) => {
    tabs.forEach((t, j) => {
      t.setAttribute('aria-selected', i === j ? 'true' : 'false');
      t.tabIndex = i === j ? 0 : -1;
      panels[j]!.hidden = i !== j;
    });
  };
  const hashTarget = (): HTMLElement | null => {
    try {
      return location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    } catch {
      return null; // malformed hash
    }
  };
  /** Tab index for the current hash (a panel id or an anchor inside a panel), or -1. */
  const fromHash = () => {
    const target = hashTarget();
    return target ? panels.findIndex((p) => p!.contains(target)) : -1;
  };
  const go = (i: number, focus: boolean) => {
    select(i);
    if (focus) tabs[i]!.focus();
    history.replaceState(null, '', i === 0 ? location.pathname + location.search : `#${panels[i]!.id}`);
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', (e) => {
      e.preventDefault();
      go(i, false);
    });
    t.addEventListener('keydown', (e) => {
      const n = tabs.length;
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1 + n, Home: 0, End: n - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      go(next % n, true);
    });
  });
  // In-page links to a panel elsewhere on the page ("View all releases").
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-tab-link]')) {
    const i = panels.findIndex((p) => p!.id === a.dataset['tabLink']);
    if (i < 0) continue;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      go(i, false);
      panels[i]!.scrollIntoView();
      tabs[i]!.focus({ preventScroll: true });
    });
  }
  /** Select the tab holding the hash target and scroll to it (panels' scroll margin keeps the tab bar in view). */
  const onHash = () => {
    const i = fromHash();
    if (i < 0) return;
    select(i);
    hashTarget()?.scrollIntoView();
  };
  window.addEventListener('hashchange', onHash);
  select(0);
  onHash();
}

if (!autoLocale()) {
  themeToggle();
  dropdowns();
  headerSearch();
  listFilter();
  relativeTimes();
  moduleTabs();
}
