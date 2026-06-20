import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { renderMarkdown } from '../markdown/render';
import { buildSearchRegex, applyDomHighlights, clearDomHighlights } from '../markdown/searchHighlight';
import {
  normSlashes, dirOf, basenameOf, resolveRelative, toFileUrl,
  isRelativeRef, isExternalRef, splitHash,
} from '../markdown/paths';

function absFor(rootPath, relPath) {
  return normSlashes(rootPath).replace(/\/+$/, '') + '/' + normSlashes(relPath);
}

let mermaidTheme = null;

// decodeURIComponent throws on a malformed % (e.g. a raw-HTML <img src="100%.png">).
// Fall back to the raw string so a bad path can't abort the whole render effect.
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return s; }
}

function ensureMermaid(theme) {
  const want = theme === 'dark' ? 'dark' : 'default';
  if (mermaidTheme !== want) {
    mermaid.initialize({ startOnLoad: false, theme: want, securityLevel: 'strict', fontFamily: 'inherit' });
    mermaidTheme = want;
  }
}

// Scroll a rendered view to the block whose source line is closest at/above
// the target line (blocks carry data-line from the render pipeline).
function scrollToSourceLine(scrollEl, bodyEl, line) {
  if (!bodyEl) return;
  const nodes = bodyEl.querySelectorAll('[data-line]');
  let target = null;
  for (const n of nodes) {
    const ln = parseInt(n.getAttribute('data-line'), 10);
    if (Number.isNaN(ln)) continue;
    if (ln <= line) target = n; else break;
  }
  if (target) target.scrollIntoView({ block: 'start', behavior: 'auto' });
  else if (scrollEl) scrollEl.scrollTop = 0;
}

// Renders one markdown document (read-only). Remembers its scroll position via
// onScrollCapture, and restores from initialScrollTop on mount.
export default function MarkdownView({
  rootPath, relPath, theme, scale, text,
  scrollKey, initialScrollTop, onScrollCapture, onCurrentLine, onOpenAbsPath, gotoLine, gotoSeq, showBacklinks, search, changedLines,
}) {
  const docAbs = normSlashes(rootPath).replace(/\/+$/, '') + '/' + normSlashes(relPath);
  const scrollRef = useRef(null);
  const bodyRef = useRef(null);
  const overviewRef = useRef(null);
  const lastScrollRef = useRef(initialScrollTop || 0);
  const didRestoreRef = useRef(false);
  const noticeTimer = useRef(null);
  const mermaidSeqRef = useRef(0); // per-instance mermaid cancellation token
  const onCurrentLineRef = useRef(onCurrentLine);
  const lastReportedLineRef = useRef(null);
  const [backlinks, setBacklinks] = useState(null); // null | { loading, list }
  const [notice, setNotice] = useState(null);
  useEffect(() => { onCurrentLineRef.current = onCurrentLine; }, [onCurrentLine]);

  // Report the source line of the top-most block currently scrolled into view,
  // so the outline can highlight the section being read.
  const reportCurrentLine = useCallback(() => {
    const cb = onCurrentLineRef.current;
    const el = scrollRef.current;
    const body = bodyRef.current;
    if (!cb || !el || !body) return;
    const nodes = body.querySelectorAll('[data-line]');
    if (!nodes.length) return;
    const threshold = el.getBoundingClientRect().top + 8;
    let line = parseInt(nodes[0].getAttribute('data-line'), 10) || 1;
    for (const n of nodes) {
      if (n.getBoundingClientRect().top <= threshold) {
        const v = parseInt(n.getAttribute('data-line'), 10);
        if (!Number.isNaN(v)) line = v;
      } else break;
    }
    if (line !== lastReportedLineRef.current) { lastReportedLineRef.current = line; cb(line); }
  }, []);

  const flashNotice = (msg) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2600);
  };

  // Content is supplied (and edited) by the parent, so the preview renders live
  // and survives Read⇄Source switches.
  const html = useMemo(() => (text == null ? '' : renderMarkdown(text)), [text]);

  // Matcher for the active global search (null when search is closed/empty).
  const searchRe = useMemo(
    () => buildSearchRegex(search),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search && search.query, search && search.regex, search && search.caseSensitive, search && search.wholeWord],
  );

  // Briefly flash the block (and the search hit within it) the jump landed on,
  // so the eye catches where it went. Mirrors AXE's editor flash, adapted to the
  // rendered view.
  const flashAt = useCallback((line) => {
    const body = bodyRef.current;
    if (!body) return;
    let block = null;
    for (const n of body.querySelectorAll('[data-line]')) {
      const ln = parseInt(n.getAttribute('data-line'), 10);
      if (Number.isNaN(ln)) continue;
      if (ln <= line) block = n; else break;
    }
    if (!block) return;
    const target = block.querySelector('mark.md-search-hit') || block;
    target.classList.remove('md-flash'); // restart the animation if it's still running
    void target.offsetWidth; // reflow so re-adding the class re-triggers the keyframes
    target.classList.add('md-flash');
    setTimeout(() => target.classList.remove('md-flash'), 1600);
  }, []);

  // Scrollbar overview ruler: ticks for search matches (right lane, from the
  // highlighted marks) and edited lines (left lane, mapped from changed source
  // lines to the nearest rendered block). Positions are measured against the
  // scroll content so zoom doesn't throw them off.
  const buildOverview = useCallback(() => {
    const host = overviewRef.current;
    const scrollEl = scrollRef.current;
    const body = bodyRef.current;
    if (!host || !scrollEl) return;
    host.textContent = '';
    const total = scrollEl.scrollHeight;
    const track = scrollEl.clientHeight;
    if (total <= 0 || track <= 0 || !body) return;
    const scRect = scrollEl.getBoundingClientRect();
    const yFor = (el) => {
      const r = el.getBoundingClientRect();
      const contentTop = (r.top - scRect.top) + scrollEl.scrollTop;
      let y = (contentTop / total) * track;
      if (y < 0) y = 0;
      if (y > track - 2) y = track - 2;
      return Math.round(y);
    };
    const frag = document.createDocumentFragment();
    const addTick = (y, cls, seen) => {
      if (seen.has(y)) return;
      seen.add(y);
      const el = document.createElement('div');
      el.className = 'ov-tick ' + cls;
      el.style.top = y + 'px';
      frag.appendChild(el);
    };

    // Edited lines → nearest block at/above the line. Both lists are ascending,
    // so a single advancing pointer maps them in one pass.
    if (changedLines && changedLines.length) {
      const arr = [];
      for (const n of body.querySelectorAll('[data-line]')) {
        const ln = parseInt(n.getAttribute('data-line'), 10);
        if (!Number.isNaN(ln)) arr.push({ ln, el: n });
      }
      if (arr.length) {
        const seen = new Set();
        let bi = 0;
        let lastEl = arr[0].el;
        for (const idx of changedLines) {
          const line = idx + 1;
          while (bi < arr.length && arr[bi].ln <= line) { lastEl = arr[bi].el; bi++; }
          addTick(yFor(lastEl), 'ov-edit', seen);
        }
      }
    }

    // Search matches → the highlighted marks themselves.
    const marks = body.querySelectorAll('mark.md-search-hit');
    if (marks.length) {
      const seen = new Set();
      for (const mk of marks) addTick(yFor(mk), 'ov-search', seen);
    }

    host.appendChild(frag);
  }, [changedLines]);

  // Rebuild the overview after layout settles, and whenever the inputs change.
  useEffect(() => {
    const r = requestAnimationFrame(buildOverview);
    const t1 = setTimeout(buildOverview, 140);
    const t2 = setTimeout(buildOverview, 700); // catch late image/mermaid reflow
    return () => { cancelAnimationFrame(r); clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, theme, scale, searchRe, changedLines]);

  // Rebuild when the viewport or content height changes (resize, reflow).
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const body = bodyRef.current;
    if (typeof ResizeObserver === 'undefined' || (!scrollEl && !body)) return;
    let raf = null;
    const ro = new ResizeObserver(() => {
      if (raf == null) raf = requestAnimationFrame(() => { raf = null; buildOverview(); });
    });
    if (scrollEl) ro.observe(scrollEl);
    if (body) ro.observe(body);
    return () => { ro.disconnect(); if (raf != null) cancelAnimationFrame(raf); };
  }, [buildOverview]);

  // Insert HTML + post-process. Restores scroll once (after first render).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || text == null) return;
    el.innerHTML = html;

    el.querySelectorAll('table').forEach((t) => {
      if (t.parentElement && t.parentElement.classList.contains('md-table-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'md-table-wrap';
      t.parentNode.insertBefore(wrap, t);
      wrap.appendChild(t);
    });

    const docDir = dirOf(docAbs);
    el.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (isRelativeRef(src)) {
        const [p] = splitHash(src);
        img.setAttribute('src', toFileUrl(resolveRelative(docDir, safeDecode(p))));
      }
    });

    const pending = el.querySelectorAll('.mermaid-pending');
    if (pending.length) {
      ensureMermaid(theme);
      const myRun = ++mermaidSeqRef.current;
      (async () => {
        for (const node of pending) {
          if (myRun !== mermaidSeqRef.current) return;
          const code = node.textContent || '';
          const id = `mmd-${myRun}-${Math.floor(Math.random() * 1e9)}`;
          try {
            const { svg } = await mermaid.render(id, code);
            node.innerHTML = svg;
            node.classList.remove('mermaid-pending');
            node.classList.add('mermaid');
          } catch (e) {
            node.classList.remove('mermaid-pending');
            node.classList.add('mermaid-error');
            node.textContent = `Mermaid error: ${e && e.message ? e.message : e}`;
          }
        }
      })();
    }

    if (!didRestoreRef.current) {
      didRestoreRef.current = true;
      if (gotoLine) {
        const go = () => scrollToSourceLine(scrollRef.current, bodyRef.current, gotoLine);
        go();
        requestAnimationFrame(go);
        setTimeout(go, 80);
      } else {
        const top = initialScrollTop || 0;
        if (top && scrollRef.current) {
          const apply = () => { if (scrollRef.current) scrollRef.current.scrollTop = top; };
          apply();
          requestAnimationFrame(apply);
          setTimeout(apply, 60);
        }
      }
    }
    // Seed the outline's active-section highlight once content + layout exist.
    requestAnimationFrame(reportCurrentLine);
    setTimeout(reportCurrentLine, 80);
  }, [html, theme, docAbs]);

  // Highlight every global-search match in the rendered doc. Runs after the
  // render effect re-inserts the HTML (so marks survive a content change) and
  // whenever the active query changes.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || text == null) return;
    clearDomHighlights(el);
    if (searchRe) applyDomHighlights(el, searchRe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, theme, docAbs, searchRe]);

  // Jump to a source line when a search result targets this already-open view,
  // then flash where we landed.
  useEffect(() => {
    if (gotoLine && bodyRef.current && bodyRef.current.childNodes.length) {
      const go = () => scrollToSourceLine(scrollRef.current, bodyRef.current, gotoLine);
      go();
      requestAnimationFrame(go);
      setTimeout(() => flashAt(gotoLine), 120);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoSeq]);

  // Track + persist scroll position; capture final position on unmount.
  useEffect(() => {
    if (text == null) return;
    const el = scrollRef.current;
    if (!el) return;
    let timer = null;
    let raf = null;
    const onScroll = () => {
      lastScrollRef.current = el.scrollTop;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => onScrollCapture && onScrollCapture(scrollKey, lastScrollRef.current), 250);
      if (raf == null) raf = requestAnimationFrame(() => { raf = null; reportCurrentLine(); });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
      if (raf != null) cancelAnimationFrame(raf);
      if (onScrollCapture) onScrollCapture(scrollKey, lastScrollRef.current);
    };
  }, [text, scrollKey, onScrollCapture, reportCurrentLine]);

  // Backlinks: documents that link to this one (Read mode, main view only).
  useEffect(() => {
    if (!showBacklinks) { setBacklinks(null); return; }
    let cancelled = false;
    setBacklinks({ loading: true, list: [] });
    const name = basenameOf(relPath).replace(/\.md$/i, '');
    window.arcenApi.getBacklinks(name, { rootPath, relPath }).then((list) => {
      if (!cancelled) setBacklinks({ loading: false, list: Array.isArray(list) ? list : [] });
    });
    return () => { cancelled = true; };
  }, [docAbs, showBacklinks]);

  const handleClick = (e) => {
    const wl = e.target.closest && e.target.closest('a.wikilink');
    if (wl) {
      e.preventDefault();
      const name = wl.getAttribute('data-wikilink');
      window.arcenApi.resolveWiki(name).then((res) => {
        if (res && res.rootPath) onOpenAbsPath(absFor(res.rootPath, res.relPath));
        else flashNotice(`No document named "${name}"`);
      });
      return;
    }

    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;

    if (href.startsWith('#')) {
      e.preventDefault();
      const id = safeDecode(href.slice(1));
      const target = bodyRef.current && (bodyRef.current.querySelector(`#${CSS.escape(id)}`) || document.getElementById(id));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (isExternalRef(href)) {
      e.preventDefault();
      window.arcenApi.openExternal(href);
      return;
    }
    if (isRelativeRef(href)) {
      e.preventDefault();
      const [p] = splitHash(href);
      const abs = resolveRelative(dirOf(docAbs), safeDecode(p));
      if (abs.toLowerCase().endsWith('.md')) onOpenAbsPath(abs);
      else window.arcenApi.openPath(abs);
    }
  };

  // Scale the document as a whole (text AND layout width) so the reading
  // column widens with the zoom and tables aren't squeezed. `zoom` is a
  // unitless CSS property in React, so 1.2 renders the doc at 120%.
  const zoom = (scale || 100) / 100;

  if (text == null) return <div className="md-scroll" ref={scrollRef}><div className="md-info">Loading…</div></div>;

  return (
    <div className="md-view-host">
      <div className="md-scroll" ref={scrollRef}>
      <div className="md-doc" style={{ zoom }}>
        <div className="md-body" ref={bodyRef} onClick={handleClick} />
        {showBacklinks && backlinks && (
          <div className="md-backlinks">
            <div className="md-backlinks-head">Backlinks{backlinks.loading ? '' : ` (${backlinks.list.length})`}</div>
            {backlinks.loading ? (
              <div className="md-bl-empty">Searching…</div>
            ) : backlinks.list.length === 0 ? (
              <div className="md-bl-empty">No documents link here.</div>
            ) : (
              backlinks.list.map((b) => (
                <div
                  key={`${b.rootPath}|${b.relPath}`}
                  className="md-bl-item"
                  title={b.relPath}
                  onClick={() => onOpenAbsPath(absFor(b.rootPath, b.relPath))}
                >
                  {b.relPath}
                </div>
              ))
            )}
          </div>
        )}
      </div>
      </div>
      <div className="scroll-overview" ref={overviewRef} />
      {notice && <div className="md-toast">{notice}</div>}
    </div>
  );
}
