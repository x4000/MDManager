// Markdown → sanitized HTML pipeline (markdown-it + GFM + highlighting).
//
// Mermaid fences are emitted as inert placeholders here and turned into SVG
// later by MarkdownView (post-insert), so the diagram source never goes
// through the HTML sanitizer as markup. Wide tables, image/link resolution,
// and mermaid rendering are all done on the live DOM by the view.

import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

const md = new MarkdownIt({
  html: true,        // allow inline HTML in docs (sanitized below)
  linkify: true,     // autolink bare URLs
  breaks: false,
  typographer: false,
  highlight(str, lang) {
    const language = (lang || '').toLowerCase();
    if (language && language !== 'mermaid' && hljs.getLanguage(language)) {
      try {
        const out = hljs.highlight(str, { language, ignoreIllegals: true }).value;
        return `<pre class="hljs"><code class="hljs language-${language}">${out}</code></pre>`;
      } catch (_) { /* fall through */ }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

md.use(anchor, { permalink: false, tabIndex: false });
md.use(taskLists, { enabled: true, label: true });

// Tag top-level block elements with their 1-based source line so search
// results can scroll the rendered view to the right place. DOMPurify keeps
// data-* attributes by default, so these survive sanitization.
md.core.ruler.push('inject_line_numbers', (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1) {
      token.attrSet('data-line', String(token.map[0] + 1));
    }
  }
});

// Mermaid fences → placeholder div; everything else uses the default fence
// renderer (which honors the `highlight` option above).
//
// markdown-it's default fence renderer returns the highlight() output verbatim
// (it starts with `<pre`), which means it never calls renderAttrs and silently
// drops the data-line attribute inject_line_numbers set on the token. We stamp
// data-line back onto the emitted markup so scroll-to-line works for matches
// inside code/mermaid fences.
const defaultFence = md.renderer.rules.fence.bind(md.renderer.rules);
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = (token.info || '').trim().split(/\s+/)[0].toLowerCase();
  const line = token.attrGet('data-line');
  const lineAttr = line ? ` data-line="${line}"` : '';
  if (info === 'mermaid') {
    return `<div class="mermaid-pending"${lineAttr}>${md.utils.escapeHtml(token.content)}</div>`;
  }
  const html = defaultFence(tokens, idx, options, env, self);
  return line ? html.replace(/^(\s*)<pre/, `$1<pre${lineAttr}`) : html;
};

// Open external links in a new context (handled by the click delegate in
// MarkdownView; target just marks intent and survives sanitization).
const defaultLinkOpen = md.renderer.rules.link_open
  || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') || '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:')) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Wiki-links: [[Doc Name]] and [[Doc Name|alias]] → an anchor carrying the
// target in data-wikilink (resolved/opened by MarkdownView's click handler).
md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x5B || state.src.charCodeAt(start + 1) !== 0x5B) return false;
  const m = /^\[\[([^\]\n]+?)\]\]/.exec(state.src.slice(start));
  if (!m) return false;
  if (!silent) {
    const inner = m[1];
    const pipe = inner.indexOf('|');
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    const label = (pipe >= 0 ? inner.slice(pipe + 1) : inner).trim() || target;
    let token = state.push('wikilink_open', 'a', 1);
    token.attrSet('class', 'wikilink');
    token.attrSet('data-wikilink', target);
    token = state.push('text', '', 0);
    token.content = label;
    state.push('wikilink_close', 'a', -1);
  }
  state.pos += m[0].length;
  return true;
});
md.renderer.rules.wikilink_open = (tokens, idx, options, env, self) => self.renderToken(tokens, idx, options);
md.renderer.rules.wikilink_close = (tokens, idx, options, env, self) => self.renderToken(tokens, idx, options);

// A leading `---` YAML block would otherwise render as stray horizontal rules.
// Pull it out and present it as a small collapsible key/value table instead.
function extractFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: null, body: text };
  return { fm: m[1], body: text.slice(m[0].length) };
}

function frontmatterHtml(fm) {
  const rows = fm.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
    const i = line.indexOf(':');
    if (i < 0) return `<tr><td colspan="2">${md.utils.escapeHtml(line)}</td></tr>`;
    const k = md.utils.escapeHtml(line.slice(0, i).trim());
    const v = md.utils.escapeHtml(line.slice(i + 1).trim());
    return `<tr><th>${k}</th><td>${v}</td></tr>`;
  }).join('');
  return `<details class="md-frontmatter"><summary>frontmatter</summary><table><tbody>${rows}</tbody></table></details>`;
}

export function renderMarkdown(text) {
  const { fm, body } = extractFrontmatter(text || '');
  const raw = (fm ? frontmatterHtml(fm) : '') + md.render(body);
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target', 'rel'],
    ADD_TAGS: ['details', 'summary'],
  });
}
