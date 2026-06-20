// Shared helpers for highlighting global-search matches in the document views.
// The read view (rendered HTML) uses the DOM helpers; both views use
// buildSearchRegex so what they highlight matches what the search actually found.

// Build a matcher mirroring the global-search semantics (plain/regex, case,
// whole-word). Returns a global RegExp, or null when there's nothing to match.
export function buildSearchRegex(spec) {
  if (!spec || !spec.query) return null;
  const q = String(spec.query);
  if (!q) return null;
  let src = spec.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (spec.wholeWord) src = `\\b(?:${src})\\b`;
  try {
    return new RegExp(src, 'g' + (spec.caseSensitive ? '' : 'i'));
  } catch (_) {
    return null; // an invalid user regex just means "no highlight", never a crash
  }
}

// Remove highlight wrappers previously added under `root`.
export function clearDomHighlights(root) {
  if (!root) return;
  const marks = root.querySelectorAll('mark.md-search-hit');
  if (!marks.length) return;
  marks.forEach((m) => { m.replaceWith(document.createTextNode(m.textContent || '')); });
  root.normalize(); // re-merge the split text nodes so a later pass matches cleanly
}

// Wrap each match of `regex` in <mark class="md-search-hit"> within text nodes
// under `root`. Scripts/styles are skipped so the DOM stays valid; matches that
// span element boundaries (e.g. across **bold**) are left alone by design.
export function applyDomHighlights(root, regex) {
  if (!root || !regex) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      if (p.classList && p.classList.contains('md-search-hit')) return NodeFilter.FILTER_REJECT;
      // Skip rendered diagrams — an HTML <mark> inside an <svg> wouldn't render.
      if (p.closest && p.closest('svg')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  // Snapshot the matching nodes first; we mutate the tree as we go.
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n);

  for (const node of targets) {
    const text = node.nodeValue;
    regex.lastIndex = 0;
    if (!regex.test(text)) continue;
    regex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    let any = false;
    while ((m = regex.exec(text))) {
      if (m[0].length === 0) { regex.lastIndex++; continue; } // never loop on empty matches
      const start = m.index;
      const end = start + m[0].length;
      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
      const mark = document.createElement('mark');
      mark.className = 'md-search-hit';
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = end;
      any = true;
    }
    if (!any) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}
