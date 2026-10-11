/* MOCK-ONLY entry, loaded via dynamic import when `import.meta.env.MODE === 'mock'`. */
import { createState, handle, PERSONA_KEY, type Persona } from './server.ts';
import type { FetchLike } from '../api/client.ts';

function storedPersona(): Persona {
  try {
    const p = localStorage.getItem(PERSONA_KEY);
    if (p === 'signed-out' || p === 'developer' || p === 'maintainer') return p;
  } catch {
    /* ignore */
  }
  return 'maintainer';
}

function setPersona(p: Persona) {
  try {
    localStorage.setItem(PERSONA_KEY, p);
  } catch {
    /* ignore */
  }
}

const state = createState(storedPersona());

export const mockFetch: FetchLike = async (input, init = {}) => {
  const url = new URL(input, location.href);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 380));
  const res = await handle(state, method, url, headers, body);
  console.debug('[mock]', method, url.pathname, res.status);
  return res;
};

/** The real /auth/login is a Worker redirect; in mock mode "signing in" just switches persona. */
export function handleMockAuthPath() {
  if (location.pathname === '/auth/login') {
    const next = new URLSearchParams(location.search).get('next');
    if (state.persona === 'signed-out') {
      state.persona = 'developer';
      setPersona('developer');
    }
    history.replaceState(null, '', next && next.startsWith('/') && !next.startsWith('//') ? next : '/repos');
  }
}

export function MockBar() {
  return (
    <div class="mock-bar" role="region" aria-label="Mock API controls">
      <strong>MOCK API</strong>
      <label>
        <span class="sr-only">Persona</span>
        <select
          value={state.persona}
          onChange={(e) => {
            setPersona((e.target as HTMLSelectElement).value as Persona);
            location.reload();
          }}
        >
          <option value="signed-out">signed out</option>
          <option value="developer">developer (alice)</option>
          <option value="maintainer">maintainer</option>
        </select>
      </label>
      <button type="button" onClick={() => location.reload()} title="Reload resets all mock data">
        reset
      </button>
    </div>
  );
}
