import { render, type ComponentChildren } from 'preact';
import './styles.css';
import { ApiClient, type FetchLike } from './api/client.ts';
import { App } from './app.tsx';

async function start() {
  let fetchImpl: FetchLike | undefined;
  let extra: ComponentChildren = null;
  // Statically false in production builds: the mock module and its fixtures are tree-shaken away
  // (verified by scripts/check-dist.mjs as part of `pnpm build`).
  if (import.meta.env.MODE === 'mock') {
    const mock = await import('./mock/index.tsx');
    mock.handleMockAuthPath();
    fetchImpl = mock.mockFetch;
    extra = <mock.MockBar />;
  }
  const api = new ApiClient(fetchImpl ? { fetch: fetchImpl } : {});
  render(<App api={api} extra={extra} />, document.getElementById('app')!);
}

void start();
