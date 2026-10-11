import { useEffect, useRef } from 'preact/hooks';

/**
 * Sandboxed iframe for untrusted (already sanitized) HTML. The element is built
 * imperatively so that `sandbox=""` is guaranteed to be set before `srcdoc` and
 * before the frame is connected (the sandbox flags are fixed at navigation time).
 */
export function SandboxFrame({ srcdoc, title }: { srcdoc: string; title: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', '');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.setAttribute('loading', 'lazy');
    f.className = 'preview-frame';
    f.title = title;
    f.srcdoc = srcdoc;
    el.replaceChildren(f);
    return () => f.remove();
  }, [srcdoc, title]);
  return <div class="preview-host" ref={host} />;
}
