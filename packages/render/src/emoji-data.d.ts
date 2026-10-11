declare module 'markdown-it-emoji/lib/data/full.mjs' {
  const defs: Record<string, string>;
  export default defs;
}

declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it';
  const footnote: (md: MarkdownIt) => void;
  export default footnote;
}
