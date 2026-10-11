/// <reference path="./emoji-data.d.ts" />
import MarkdownItCtor, { type MarkdownIt, type StateCore, type Token } from 'markdown-it';
import EMOJI from 'markdown-it-emoji/lib/data/full.mjs';
import footnote from 'markdown-it-footnote';

/** GitHub-compatible heading slug (without the user-content- prefix; the sanitizer adds it). */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

function inlineText(tok: Token | undefined): string {
  if (!tok?.children) return tok?.content ?? '';
  return tok.children
    .filter((c) => c.type === 'text' || c.type === 'code_inline')
    .map((c) => c.content)
    .join('');
}

function headingIds(md: MarkdownIt): void {
  md.core.ruler.push('heading_ids', (state: StateCore) => {
    const seen = new Map<string, number>();
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.type !== 'heading_open') continue;
      const base = slugify(inlineText(toks[i + 1])) || 'section';
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      t.attrSet('id', n === 0 ? base : `${base}-${n}`);
    }
  });
}

/** GitHub task lists: "- [ ] foo" / "- [x] foo". */
function taskLists(md: MarkdownIt): void {
  md.core.ruler.push('task_lists', (state: StateCore) => {
    const toks = state.tokens;
    for (let i = 2; i < toks.length; i++) {
      const inline = toks[i]!;
      if (inline.type !== 'inline' || toks[i - 1]!.type !== 'paragraph_open' || toks[i - 2]!.type !== 'list_item_open')
        continue;
      const first = inline.children?.[0];
      if (!first || first.type !== 'text') continue;
      const m = /^\[([ xX])\][ \t]/.exec(first.content);
      if (!m) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" class="task-list-item-checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
      inline.children!.unshift(box);
      toks[i - 2]!.attrJoin('class', 'task-list-item');
      for (let j = i - 3; j >= 0; j--) {
        const t = toks[j]!;
        if ((t.type === 'bullet_list_open' || t.type === 'ordered_list_open') && t.level === toks[i - 2]!.level - 1) {
          if (!String(t.attrGet('class') ?? '').includes('contains-task-list')) t.attrJoin('class', 'contains-task-list');
          break;
        }
      }
    }
  });
}

const ALERTS: Record<string, string> = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };

/** GitHub alerts: "> [!NOTE]" blockquotes. */
function alerts(md: MarkdownIt): void {
  md.core.ruler.push('gh_alerts', (state: StateCore) => {
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      const open = toks[i]!;
      if (open.type !== 'blockquote_open' || toks[i + 1]?.type !== 'paragraph_open') continue;
      const inline = toks[i + 2];
      const first = inline?.children?.[0];
      if (!inline || !first || first.type !== 'text') continue;
      const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(first.content);
      if (!m) continue;
      const kind = m[1]!.toUpperCase();
      // Drop the marker (and the following soft/hard break) from the first paragraph.
      const rest = inline.children!.slice(1);
      if (rest[0]?.type === 'softbreak' || rest[0]?.type === 'hardbreak') rest.shift();
      inline.children = rest;
      open.tag = 'div';
      open.attrSet('class', `markdown-alert markdown-alert-${kind.toLowerCase()}`);
      // Find the matching close.
      let depth = 0;
      for (let j = i; j < toks.length; j++) {
        if (toks[j]!.type === 'blockquote_open') depth++;
        else if (toks[j]!.type === 'blockquote_close' && --depth === 0) {
          toks[j]!.tag = 'div';
          break;
        }
      }
      const title = new state.Token('html_block', '', 0);
      title.content = `<p class="markdown-alert-title">${ALERTS[kind]}</p>\n`;
      toks.splice(i + 1, 0, title);
      if (rest.length === 0) {
        // Marker was alone in its paragraph: remove the now-empty paragraph.
        const p = i + 2;
        if (toks[p]?.type === 'paragraph_open' && toks[p + 2]?.type === 'paragraph_close') toks.splice(p, 3);
      }
    }
  });
}

/**
 * GitHub ":shortcode:" emoji. A map lookup instead of markdown-it-emoji's generated alternation
 * regex (which costs ~20 ms CPU to compile on first use; too much for a Workers Free request).
 */
function emoji(md: MarkdownIt): void {
  const map = EMOJI as Record<string, string>;
  md.core.ruler.push('gh_emoji', (state: StateCore) => {
    for (const blk of state.tokens) {
      if (blk.type !== 'inline' || !blk.children) continue;
      for (const t of blk.children) {
        if (t.type !== 'text' || !t.content.includes(':')) continue;
        t.content = t.content.replace(/:([a-z0-9_+-]{1,48}):/g, (m, name: string) =>
          Object.prototype.hasOwnProperty.call(map, name) ? map[name]! : m,
        );
      }
    }
  });
}

export function createMarkdown(opts: { breaks: boolean; headingIds: boolean }): MarkdownIt {
  const md = new MarkdownItCtor('default', { html: true, linkify: true, typographer: false, breaks: opts.breaks });
  md.use(footnote as unknown as (md: MarkdownIt) => void).use(taskLists).use(alerts).use(emoji);
  if (opts.headingIds) md.use(headingIds);
  return md;
}
