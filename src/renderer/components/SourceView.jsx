import React, { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState, Compartment, Prec, StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { EditorView, lineNumbers, keymap, Decoration, ViewPlugin, gutter, GutterMarker } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess, selectLine } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { listContinuation } from '../markdown/editing';
import { buildSearchRegex } from '../markdown/searchHighlight';
import ContextMenu from './ContextMenu';

// ── Global-search match highlighting + jump flash (decorations) ──
// setSearchHits carries the active matcher (or null); setFlash carries the
// range to flash (or null to clear). Two fields keep the persistent highlight
// and the transient flash independent.
const setSearchHits = StateEffect.define();
const setFlash = StateEffect.define();
const searchHitMark = Decoration.mark({ class: 'cm-search-hit' });
const flashMark = Decoration.mark({ class: 'cm-search-flash' });

function computeHits(state, regex) {
  const builder = new RangeSetBuilder();
  if (regex) {
    const text = state.doc.toString();
    regex.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = regex.exec(text)) && guard < 50000) {
      guard++;
      if (m[0].length === 0) { regex.lastIndex++; continue; }
      builder.add(m.index, m.index + m[0].length, searchHitMark);
    }
  }
  return builder.finish();
}

const searchHitField = StateField.define({
  create() { return Decoration.none; },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSearchHits)) return computeHits(tr.state, e.value);
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashField = StateField.define({
  create() { return Decoration.none; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        if (!e.value || e.value.from === e.value.to) return Decoration.none;
        return Decoration.set([flashMark.range(e.value.from, e.value.to)]);
      }
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ── Scrollbar overview ruler ──
// changedLinesField holds the 0-based indices of edited lines (driven from
// React). The ruler reads it + searchHitField to draw ticks on the scrollbar:
// edited lines in a left lane, search matches in a right lane.
const setChangedLines = StateEffect.define();
const changedLinesField = StateField.define({
  create() { return []; },
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setChangedLines)) return e.value || [];
    return value;
  },
});

// Left-margin change bar: a yellow stripe on edited lines (source view only).
// A non-absolute spacer reserves the column's width; the real bar is absolute
// so it fills each line's full height regardless of wrapping.
class ChangeBarMarker extends GutterMarker {
  toDOM() { const d = document.createElement('div'); d.className = 'cm-change-bar'; return d; }
}
class ChangeSpacer extends GutterMarker {
  toDOM() { const d = document.createElement('div'); d.className = 'cm-change-spacer'; return d; }
}
const changeBarMarker = new ChangeBarMarker();
const changeSpacer = new ChangeSpacer();
const changeBarGutter = gutter({
  class: 'cm-change-gutter',
  markers(view) {
    const changed = view.state.field(changedLinesField, false) || [];
    const lines = view.state.doc.lines;
    const builder = new RangeSetBuilder();
    for (const idx of changed) { // already ascending → safe for the builder
      if (idx < 0 || idx >= lines) continue;
      const from = view.state.doc.line(idx + 1).from;
      builder.add(from, from, changeBarMarker);
    }
    return builder.finish();
  },
  initialSpacer: () => changeSpacer,
});

const overviewRuler = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.container = document.createElement('div');
      this.container.className = 'scroll-overview';
      view.dom.style.position = 'relative';
      view.dom.appendChild(this.container);
      this.timer = null;
      this.schedule();
    }

    update(u) {
      let dirty = u.docChanged || u.geometryChanged || u.viewportChanged;
      if (!dirty && u.startState.field(searchHitField, false) !== u.state.field(searchHitField, false)) dirty = true;
      if (!dirty && u.startState.field(changedLinesField, false) !== u.state.field(changedLinesField, false)) dirty = true;
      if (dirty) this.schedule();
    }

    schedule() {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; this.render(); }, 120);
    }

    render() {
      const view = this.view;
      const c = this.container;
      if (!c) return;
      const scroller = view.scrollDOM;
      const trackHeight = scroller.clientHeight;
      // Anchor to the live scroller box so ticks stay aligned when the search
      // panel opens above the scroller (search({top:true})).
      c.style.top = scroller.offsetTop + 'px';
      c.style.height = trackHeight + 'px';
      c.innerHTML = '';
      if (trackHeight <= 0) return;

      const contentHeight = view.contentHeight || trackHeight;
      const docLen = view.state.doc.length;
      const topForPos = (pos) => {
        if (pos > docLen) pos = docLen;
        if (pos < 0) pos = 0;
        let t;
        try { t = (view.lineBlockAt(pos).top / contentHeight) * trackHeight; } catch (_) { return -1; }
        if (t > trackHeight - 2) t = trackHeight - 2;
        if (t < 0) t = 0;
        return t;
      };
      const frag = document.createDocumentFragment();
      const addTick = (top, cls, seen) => {
        const key = Math.round(top);
        if (seen.has(key)) return;
        seen.add(key);
        const el = document.createElement('div');
        el.className = 'ov-tick ' + cls;
        el.style.top = key + 'px';
        frag.appendChild(el);
      };

      // Edited lines (left lane).
      const changed = view.state.field(changedLinesField, false) || [];
      const lines = view.state.doc.lines;
      const seenEdit = new Set();
      for (const idx of changed) {
        if (idx < 0 || idx >= lines) continue;
        const t = topForPos(view.state.doc.line(idx + 1).from);
        if (t >= 0) addTick(t, 'ov-edit', seenEdit);
      }

      // Search matches (right lane).
      const hits = view.state.field(searchHitField, false);
      if (hits && hits.size) {
        const seenHit = new Set();
        const iter = hits.iter();
        let count = 0;
        while (iter.value) {
          const t = topForPos(iter.from);
          if (t >= 0) addTick(t, 'ov-search', seenHit);
          iter.next();
          if (++count > 50000) break;
        }
      }

      c.appendChild(frag);
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer);
      if (this.container && this.container.parentNode) this.container.remove();
    }
  }
);

// Controlled markdown source editor. Content comes from the `text` prop and
// edits are pushed up via `onChange`, so the buffer lives in the parent and
// survives Read⇄Source switches. `editable` toggles editing (the reference
// pane is read-only).

const lightHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold', color: '#6f42c1' },
  { tag: tags.strong, fontWeight: 'bold', color: '#24292f' },
  { tag: tags.emphasis, fontStyle: 'italic', color: '#24292f' },
  { tag: [tags.link, tags.url], color: '#0969da' },
  { tag: tags.monospace, color: '#0550ae' },
  { tag: tags.quote, color: '#6a737d', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.list], color: '#cf222e' },
  { tag: tags.comment, color: '#6a737d' },
  { tag: tags.contentSeparator, color: '#6a737d', fontWeight: 'bold' },
]);

const darkHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: 'bold', color: '#d2a8ff' },
  { tag: tags.strong, fontWeight: 'bold', color: '#e6edf3' },
  { tag: tags.emphasis, fontStyle: 'italic', color: '#e6edf3' },
  { tag: [tags.link, tags.url], color: '#79c0ff' },
  { tag: tags.monospace, color: '#a5d6ff' },
  { tag: tags.quote, color: '#8b949e', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.list], color: '#ff7b72' },
  { tag: tags.comment, color: '#8b949e' },
  { tag: tags.contentSeparator, color: '#8b949e', fontWeight: 'bold' },
]);

const baseTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: "'JetBrains Mono','Fira Code','Consolas',monospace", lineHeight: '1.6' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-dim)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-panels': { backgroundColor: 'var(--search-bg)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panel.cm-search input': { background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)' },
  '.cm-panel.cm-search button': { background: 'var(--tab-bg)', color: '#fff', border: 'none', borderRadius: '3px' },
});

const hlExt = (theme) => syntaxHighlighting(theme === 'dark' ? darkHighlight : lightHighlight);
const fontTheme = (scale) => {
  const px = (13 * (scale || 100) / 100) + 'px';
  return EditorView.theme({ '.cm-content': { fontSize: px }, '.cm-gutters': { fontSize: px } });
};
const editableExt = (editable) => [EditorState.readOnly.of(!editable), EditorView.editable.of(!!editable)];

function scrollToLine(view, line) {
  try {
    const ln = Math.max(1, Math.min(line, view.state.doc.lines));
    const pos = view.state.doc.line(ln).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  } catch (_) { /* ignore */ }
}

// Range to flash for a jump: the search hit on that line if there is one, else
// the whole line.
function flashRangeFor(view, line, regex) {
  const ln = Math.max(1, Math.min(line, view.state.doc.lines));
  const lineObj = view.state.doc.line(ln);
  if (regex) {
    regex.lastIndex = 0;
    const m = regex.exec(lineObj.text);
    if (m && m[0].length) return { from: lineObj.from + m.index, to: lineObj.from + m.index + m[0].length };
  }
  return { from: lineObj.from, to: lineObj.to };
}

// Flash a range, then clear it after a beat.
function flashRange(view, range) {
  if (!view || !range) return;
  view.dispatch({ effects: setFlash.of(range) });
  setTimeout(() => { try { view.dispatch({ effects: setFlash.of(null) }); } catch (_) { /* gone */ } }, 1600);
}

// ── Markdown authoring commands (Source mode only; no-ops in the read-only ref pane) ──
function insertListContinuation(view) {
  if (view.state.readOnly) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  const line = view.state.doc.lineAt(sel.from);
  if (sel.from !== line.to) return false; // only continue from the end of the line
  const cont = listContinuation(line.text);
  if (!cont) return false;
  if (cont.exit) {
    view.dispatch({ changes: { from: line.from, to: line.to, insert: '' }, selection: { anchor: line.from } });
    return true;
  }
  const insert = '\n' + cont.marker;
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, scrollIntoView: true });
  return true;
}
function wrapInline(before, after) {
  return (view) => {
    if (view.state.readOnly) return false;
    const sel = view.state.selection.main;
    const selected = view.state.sliceDoc(sel.from, sel.to);
    const insert = before + selected + after;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: selected
        ? { anchor: sel.from + before.length, head: sel.from + before.length + selected.length }
        : { anchor: sel.from + before.length },
    });
    return true;
  };
}
function insertLink(view) {
  if (view.state.readOnly) return false;
  const sel = view.state.selection.main;
  const selected = view.state.sliceDoc(sel.from, sel.to);
  const insert = `[${selected}]()`;
  // Place the caret inside the empty () so the user can type/paste the URL.
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + selected.length + 3 } });
  return true;
}

// ── Case transforms (Source-mode right-click menu) ──
function titleCase(text) {
  return text.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
function sentenceCase(text) {
  // Lowercase, then capitalize the first letter of each sentence.
  return text.toLowerCase().replace(/(^\s*|[.!?]\s+)([a-z])/g, (_, lead, ch) => lead + ch.toUpperCase());
}
function applyTransform(view, fn) {
  const sel = view.state.selection.main;
  if (sel.empty) { view.focus(); return; }
  const before = view.state.sliceDoc(sel.from, sel.to);
  const after = fn(before);
  if (after !== before) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: after },
      selection: { anchor: sel.from, head: sel.from + after.length },
    });
  }
  view.focus();
}

const isListLine = (text) => /^\s*([-*+]|\d+[.)])\s/.test(text);

// Tab/Shift+Tab indent/outdent list items (and multi-line selections); on a
// plain line with no selection, Tab inserts a soft 2-space tab.
function smartTab(view) {
  if (view.state.readOnly) return false;
  const sel = view.state.selection.main;
  const doc = view.state.doc;
  const multiLine = !sel.empty && doc.lineAt(sel.from).number !== doc.lineAt(sel.to).number;
  if (multiLine || isListLine(doc.lineAt(sel.from).text)) return indentMore(view);
  view.dispatch(view.state.replaceSelection('  '), { scrollIntoView: true });
  return true;
}
function smartShiftTab(view) {
  if (view.state.readOnly) return false;
  return indentLess(view);
}

// Pasting a bare URL while text is selected wraps the selection as a link.
const linkOnPaste = EditorView.domEventHandlers({
  paste(event, view) {
    if (view.state.readOnly) return false;
    const sel = view.state.selection.main;
    if (sel.empty) return false;
    const data = event.clipboardData && event.clipboardData.getData('text/plain');
    if (!data) return false;
    const url = data.trim();
    if (/\s/.test(url) || !/^(https?:\/\/|mailto:)\S+$/i.test(url)) return false;
    const selected = view.state.sliceDoc(sel.from, sel.to);
    const insert = `[${selected}](${url})`;
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: 'input.paste' });
    event.preventDefault();
    return true;
  },
});

// Auto-close only the markdown-useful pairs — brackets and backtick, not quotes
// (which are just noise in prose).
const mdCloseBrackets = Prec.high(EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '`'] } }]));

export default function SourceView({ theme, scale, scrollKey, initialScrollTop, onScrollCapture, onCurrentLine, gotoLine, gotoSeq, text, editable, onChange, search: searchSpec, changedLines }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const themeComp = useRef(new Compartment());
  const fontComp = useRef(new Compartment());
  const editableComp = useRef(new Compartment());
  const settingExternally = useRef(false);
  const onChangeRef = useRef(onChange);
  const lastScrollRef = useRef(initialScrollTop || 0);
  const onCurrentLineRef = useRef(onCurrentLine);
  const lastReportedLineRef = useRef(null);
  const [ctxMenu, setCtxMenu] = useState(null); // case-transform menu on right-click
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onCurrentLineRef.current = onCurrentLine; }, [onCurrentLine]);

  // Matcher for the active global search (null when search is closed/empty). A
  // ref mirrors it so the jump effects can read it without re-subscribing.
  const searchRe = useMemo(
    () => buildSearchRegex(searchSpec),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchSpec && searchSpec.query, searchSpec && searchSpec.regex, searchSpec && searchSpec.caseSensitive, searchSpec && searchSpec.wholeWord],
  );
  const searchReRef = useRef(searchRe);
  useEffect(() => { searchReRef.current = searchRe; }, [searchRe]);

  // Report the line at the top of the viewport so the outline can highlight the
  // section currently in view.
  const reportCurrentLine = () => {
    const cb = onCurrentLineRef.current;
    const view = viewRef.current;
    if (!cb || !view) return;
    try {
      const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop + 4);
      const line = view.state.doc.lineAt(block.from).number;
      if (line !== lastReportedLineRef.current) { lastReportedLineRef.current = line; cb(line); }
    } catch (_) { /* ignore */ }
  };

  // Build the editor once content is available.
  useEffect(() => {
    if (text == null || viewRef.current || !hostRef.current) return;
    const startState = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        changeBarGutter,
        history(),
        EditorView.lineWrapping,
        markdown(),
        baseTheme,
        themeComp.current.of(hlExt(theme)),
        fontComp.current.of(fontTheme(scale)),
        editableComp.current.of(editableExt(editable)),
        mdCloseBrackets,
        closeBrackets(),
        linkOnPaste,
        searchHitField,
        flashField,
        changedLinesField,
        overviewRuler,
        // Markdown authoring keys take precedence over the defaults (Enter → list
        // continuation; Tab/Shift+Tab → list indent; Ctrl/Cmd+B/I/K → bold/italic/link).
        Prec.high(keymap.of([
          { key: 'Enter', run: insertListContinuation },
          { key: 'Tab', run: smartTab, shift: smartShiftTab },
          { key: 'Mod-b', run: wrapInline('**', '**'), preventDefault: true },
          { key: 'Mod-i', run: wrapInline('*', '*'), preventDefault: true },
          { key: 'Mod-k', run: insertLink, preventDefault: true },
          { key: 'Mod-l', run: selectLine, preventDefault: true },
          { key: 'Mod-h', run: openSearchPanel, preventDefault: true },
        ])),
        // Drop Ctrl/Cmd+G (find-next) so it's free for the app's Go To Line;
        // F3 / Shift+F3 still cycle search matches.
        keymap.of([...closeBracketsKeymap, ...historyKeymap, ...searchKeymap.filter((b) => b.key !== 'Mod-g' && b.key !== 'Mod-Shift-g'), ...defaultKeymap]),
        search({ top: true }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !settingExternally.current && onChangeRef.current) {
            onChangeRef.current(u.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state: startState, parent: hostRef.current });
    viewRef.current = view;

    if (searchReRef.current) view.dispatch({ effects: setSearchHits.of(searchReRef.current) });
    if (changedLines && changedLines.length) view.dispatch({ effects: setChangedLines.of(changedLines) });

    if (gotoLine) {
      scrollToLine(view, gotoLine);
      requestAnimationFrame(() => scrollToLine(view, gotoLine));
      setTimeout(() => flashRange(view, flashRangeFor(view, gotoLine, searchReRef.current)), 120);
    } else {
      const top = initialScrollTop || 0;
      if (top) { const a = () => { try { view.scrollDOM.scrollTop = top; } catch (_) {} }; a(); requestAnimationFrame(a); setTimeout(a, 60); }
    }
    requestAnimationFrame(reportCurrentLine);
    setTimeout(reportCurrentLine, 80);

    let timer = null;
    let raf = null;
    const onScroll = () => {
      lastScrollRef.current = view.scrollDOM.scrollTop;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => onScrollCapture && onScrollCapture(scrollKey, lastScrollRef.current), 250);
      if (raf == null) raf = requestAnimationFrame(() => { raf = null; reportCurrentLine(); });
    };
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    view._cleanup = () => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
      if (raf != null) cancelAnimationFrame(raf);
      if (onScrollCapture) onScrollCapture(scrollKey, lastScrollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Destroy on unmount.
  useEffect(() => () => {
    const view = viewRef.current;
    if (view) { try { view._cleanup && view._cleanup(); } catch (_) {} view.destroy(); viewRef.current = null; }
  }, []);

  // Reconcile external content changes (e.g. revert) without re-firing onChange.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || text == null) return;
    const cur = view.state.doc.toString();
    if (text !== cur) {
      settingExternally.current = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      settingExternally.current = false;
    }
  }, [text]);

  useEffect(() => { const v = viewRef.current; if (v) v.dispatch({ effects: themeComp.current.reconfigure(hlExt(theme)) }); }, [theme]);
  useEffect(() => { const v = viewRef.current; if (v) v.dispatch({ effects: fontComp.current.reconfigure(fontTheme(scale)) }); }, [scale]);
  useEffect(() => { const v = viewRef.current; if (v) v.dispatch({ effects: editableComp.current.reconfigure(editableExt(editable)) }); }, [editable]);
  // Refresh the persistent match highlight when the active query changes.
  useEffect(() => { const v = viewRef.current; if (v) v.dispatch({ effects: setSearchHits.of(searchRe || null) }); }, [searchRe]);
  // Push edited-line indices to the overview ruler.
  useEffect(() => { const v = viewRef.current; if (v) v.dispatch({ effects: setChangedLines.of(changedLines || []) }); }, [changedLines]);
  useEffect(() => {
    const v = viewRef.current;
    if (v && gotoLine) { scrollToLine(v, gotoLine); flashRange(v, flashRangeFor(v, gotoLine, searchReRef.current)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoSeq]);

  // Right-click a selection → case-transform menu (editable source only).
  const onContextMenu = (e) => {
    const view = viewRef.current;
    if (!view || view.state.readOnly) return; // reference pane / read-only → native menu
    const sel = view.state.selection.main;
    if (sel.empty) return; // no selection → leave the default menu
    e.preventDefault();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'UPPERCASE', action: () => applyTransform(view, (t) => t.toUpperCase()) },
        { label: 'lowercase', action: () => applyTransform(view, (t) => t.toLowerCase()) },
        { label: 'Title Case', action: () => applyTransform(view, titleCase) },
        { label: 'Sentence case', action: () => applyTransform(view, sentenceCase) },
      ],
    });
  };

  if (text == null) return <div className="md-scroll"><div className="md-info">Loading…</div></div>;
  return (
    <>
      <div className="source-view" ref={hostRef} onContextMenu={onContextMenu} />
      {ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />}
    </>
  );
}
