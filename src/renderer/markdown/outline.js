// Extract a document outline (heading tree) from Markdown source text.
// Returns [{ level, text, line }] with 1-based source line numbers that match
// the rendered view's data-line anchors and the CodeMirror line numbers, so a
// click can reuse the existing go-to-line machinery in both Read and Source.

// Strip the most common inline Markdown so heading labels read as plain text.
function plainText(s) {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1') // [[wiki|alias]] → wiki
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')          // [text](url) → text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')         // image alt
    .trim();
}

// Turn raw headings into the displayed outline:
//  - drop a single document title (the unique shallowest heading, when deeper
//    headings exist) so it doesn't indent everything beneath it;
//  - re-baseline indentation to the new shallowest level;
//  - if `depth` > 0, keep only headings within that many relative levels.
// Each returned heading gains an `indent` (0-based relative depth).
export function buildOutline(headings, depth) {
  if (!headings || !headings.length) return [];
  let list = headings;
  const minLevel = Math.min(...list.map((h) => h.level));
  const atMin = list.filter((h) => h.level === minLevel);
  const hasDeeper = list.some((h) => h.level > minLevel);
  if (atMin.length === 1 && hasDeeper) {
    const titleLine = atMin[0].line;
    list = list.filter((h) => h.line !== titleLine);
  }
  if (!list.length) return [];
  const base = Math.min(...list.map((h) => h.level));
  let out = list.map((h) => ({ ...h, indent: h.level - base }));
  if (depth && depth > 0) out = out.filter((h) => h.indent < depth);
  return out;
}

export function extractHeadings(text) {
  if (!text) return [];
  const lines = text.split(/\r\n?|\n/);
  const out = [];
  let inFence = false;
  let fenceChar = '';
  let i = 0;

  // Skip a leading YAML frontmatter block (rendered separately, not headings).
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    let j = 1;
    while (j < lines.length && !/^---\s*$/.test(lines[j])) j++;
    i = j < lines.length ? j + 1 : lines.length;
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    // Track fenced code blocks so a `#` comment inside one isn't a heading.
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) { inFence = true; fenceChar = ch; }
      else if (ch === fenceChar) { inFence = false; fenceChar = ''; }
      continue;
    }
    if (inFence) continue;

    // ATX heading: 1–6 `#`, a space, the text, optional trailing `#`s.
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      const txt = plainText(m[2]);
      if (txt) out.push({ level: m[1].length, text: txt, line: i + 1 });
    }
  }
  return out;
}
