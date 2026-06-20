import React, { useEffect, useMemo, useRef, useState } from 'react';
import VirtualList from './VirtualList';
import { basenameOf } from '../markdown/paths';
import { buildSearchRegex } from '../markdown/searchHighlight';

// Render a result line with the matched substrings wrapped in <mark>.
function renderMatchText(text, re) {
  if (!re) return text;
  re.lastIndex = 0;
  const out = [];
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<mark key={i++} className="gs-hit">{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Recall dropdown for prior find/replace entries. onMouseDown (not click) so it
// fires before the input blurs; a backdrop dismisses it.
function HistoryMenu({ items, onPick, onClose }) {
  if (!items.length) return null;
  return (
    <>
      <div className="gs-hist-backdrop" onMouseDown={onClose} />
      <div className="gs-hist">
        {items.map((it, i) => (
          <div key={i} className="gs-hist-item" title={it} onMouseDown={(e) => { e.preventDefault(); onPick(it); onClose(); }}>{it}</div>
        ))}
      </div>
    </>
  );
}

// Bottom panel: find text across all .md in the configured roots (find-only).
// Clicking a result opens that document in Source mode at the matching line.
export default function GlobalSearch({ initial, roots, currentDoc, height, onResize, onClose, onOpenResult, onActiveQuery }) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all'); // 'all' | 'current-root' | 'current-file'
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | searching | done | error
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [showReplace, setShowReplace] = useState(false);
  const [lastSpec, setLastSpec] = useState(null); // params of the committed search (for row highlighting)
  const [replaceText, setReplaceText] = useState('');
  const [replaceMsg, setReplaceMsg] = useState(null);
  const [canUndo, setCanUndo] = useState(false);
  const [findHistory, setFindHistory] = useState([]);
  const [replaceHistory, setReplaceHistory] = useState([]);
  const [histOpen, setHistOpen] = useState(null); // null | 'find' | 'replace'
  const inputRef = useRef(null);

  // Persisted find/replace history (most-recent-first, deduped, capped).
  useEffect(() => {
    let mounted = true;
    window.arcenApi.getSession().then((s) => {
      if (!mounted || !s) return;
      if (Array.isArray(s.searchFindHistory)) setFindHistory(s.searchFindHistory);
      if (Array.isArray(s.searchReplaceHistory)) setReplaceHistory(s.searchReplaceHistory);
    });
    return () => { mounted = false; };
  }, []);
  const pushHistory = (kind, value) => {
    const v = (value || '').trim();
    if (!v) return;
    const apply = (prev) => {
      const next = [v, ...prev.filter((x) => x !== v)].slice(0, 30);
      window.arcenApi.saveSession(kind === 'find' ? { searchFindHistory: next } : { searchReplaceHistory: next });
      return next;
    };
    if (kind === 'find') setFindHistory(apply); else setReplaceHistory(apply);
  };

  const scopeLabel = { all: 'all folders', 'current-root': 'current folder', 'current-file': 'current file' }[scope] || scope;
  const replaceOpts = () => ({
    query, replace: replaceText, regex, caseSensitive, wholeWord, scope,
    currentRoot: currentDoc ? currentDoc.rootPath : null,
    currentRel: currentDoc ? currentDoc.relPath : null,
  });

  const nickById = useMemo(() => {
    const m = new Map();
    for (const r of roots || []) m.set(r.path, r.nickname || r.path);
    return m;
  }, [roots]);

  const hitRe = useMemo(() => buildSearchRegex(lastSpec), [lastSpec]);

  const doSearch = async (over = {}) => {
    const useQuery = over.query !== undefined ? over.query : query;
    const useScope = over.scope !== undefined ? over.scope : scope;
    if (!useQuery.trim()) { setResults([]); setSummary(null); setStatus('idle'); setLastSpec(null); if (onActiveQuery) onActiveQuery(null); return; }
    // Publish the committed query so the views (and the result rows) can highlight matches.
    const spec = { query: useQuery, regex, caseSensitive, wholeWord };
    setLastSpec(spec);
    if (onActiveQuery) onActiveQuery(spec);
    pushHistory('find', useQuery);
    setStatus('searching');
    const res = await window.arcenApi.searchAll({
      query: useQuery, scope: useScope, regex, caseSensitive, wholeWord,
      currentRoot: currentDoc ? currentDoc.rootPath : null,
      currentRel: currentDoc ? currentDoc.relPath : null,
    });
    if (res && res.error) { setStatus('error'); setError(res.error); setResults([]); setSummary(null); return; }
    setError(null);
    setResults(res.results || []);
    setSummary({ files: res.fileCount, matches: res.matchCount, truncated: res.truncated });
    setStatus('done');
  };

  const afterReplace = (res) => {
    if (res && res.error) { setStatus('error'); setError(res.error); return; }
    setReplaceMsg(`Replaced ${res.replacements} occurrence${res.replacements !== 1 ? 's' : ''} in ${res.filesChanged} file${res.filesChanged !== 1 ? 's' : ''}${res.skippedDirty ? ` · ${res.skippedDirty} unsaved skipped` : ''}`);
    setCanUndo(!!res.canUndo);
    doSearch();
  };

  const doReplaceAll = async () => {
    if (!query.trim()) return;
    if (!window.confirm(`Replace all "${query}" with "${replaceText}" on disk (${scopeLabel})?`)) return;
    pushHistory('find', query); pushHistory('replace', replaceText);
    afterReplace(await window.arcenApi.replaceAll(replaceOpts()));
  };

  const doReplaceInFile = async (file) => {
    if (!query.trim()) return;
    if (!window.confirm(`Replace all "${query}" with "${replaceText}" in ${file.relPath}?`)) return;
    pushHistory('find', query); pushHistory('replace', replaceText);
    afterReplace(await window.arcenApi.replaceInFile(replaceOpts(), file.rootPath, file.relPath));
  };

  const doUndo = async () => {
    const res = await window.arcenApi.undoReplace();
    setCanUndo(false);
    setReplaceMsg(res && res.ok ? `Undone (${res.files} file${res.files !== 1 ? 's' : ''})` : 'Nothing to undo');
    doSearch();
  };

  // When (re)opened, sync scope/query and focus the input.
  useEffect(() => {
    if (!initial) return;
    if (initial.scope) setScope(initial.scope);
    if (initial.showReplace) setShowReplace(true);
    if (typeof initial.query === 'string') setQuery(initial.query);
    requestAnimationFrame(() => {
      if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
    });
    if (initial.query) doSearch({ query: initial.query, scope: initial.scope });
    else if (onActiveQuery) onActiveQuery(null); // fresh open with no query → no stale highlights
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial && initial.seq]);

  const startResize = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    let latest = startH;
    const onMove = (ev) => {
      latest = Math.max(120, Math.min(800, startH - (ev.clientY - startY)));
      onResize(latest, false);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onResize(latest, true);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const rows = useMemo(() => {
    const rs = [];
    for (const file of results) {
      rs.push({ kind: 'file', key: `f:${file.rootPath}|${file.relPath}`, file });
      for (const m of file.matches) {
        rs.push({ kind: 'match', key: `m:${file.rootPath}|${file.relPath}:${m.line}`, file, match: m });
      }
    }
    return rs;
  }, [results]);

  const renderRow = (row) => {
    if (row.kind === 'file') {
      const nick = nickById.get(row.file.rootPath) || basenameOf(row.file.rootPath);
      return (
        <div className="gs-file">
          <span className="gs-file-path">{nick} / {row.file.relPath}</span>
          {showReplace && <button className="gs-file-replace" title="Replace in this file" onClick={() => doReplaceInFile(row.file)}>Replace</button>}
          <span className="gs-file-count">{row.file.matches.length}</span>
        </div>
      );
    }
    return (
      <div
        className="gs-match"
        onClick={(e) => onOpenResult(row.file.rootPath, row.file.relPath, row.match.line, e.ctrlKey || e.metaKey)}
        title={`Line ${row.match.line} — click to open in the reading view, Ctrl+click for source`}
      >
        <span className="gs-line">{row.match.line}</span>
        <span className="gs-text">{renderMatchText(row.match.text, hitRe)}</span>
      </div>
    );
  };

  const optBtn = (label, on, set, title) => (
    <button className={'gs-opt' + (on ? ' active' : '')} title={title} onClick={() => { set(!on); }}>{label}</button>
  );

  return (
    <div className="global-search" style={{ height }}>
      <div className="gs-resize" onMouseDown={startResize} title="Drag to resize" />
      <div className="gs-header">
        <div className="gs-input-wrap">
          <input
            ref={inputRef}
            className="gs-input"
            placeholder="Find in documents…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { setHistOpen(null); doSearch(); }
              else if (e.key === 'Escape') { if (histOpen) setHistOpen(null); else onClose(); }
              else if (e.key === 'ArrowDown' && findHistory.length) { e.preventDefault(); setHistOpen('find'); }
            }}
          />
          {findHistory.length > 0 && (
            <button className="gs-hist-btn" title="Recent searches" tabIndex={-1}
              onMouseDown={(e) => { e.preventDefault(); setHistOpen((v) => (v === 'find' ? null : 'find')); }}>▾</button>
          )}
          {histOpen === 'find' && (
            <HistoryMenu items={findHistory} onClose={() => setHistOpen(null)}
              onPick={(v) => { setQuery(v); doSearch({ query: v }); if (inputRef.current) inputRef.current.focus(); }} />
          )}
        </div>
        {optBtn('Aa', caseSensitive, setCaseSensitive, 'Match case')}
        {optBtn('ab', wholeWord, setWholeWord, 'Whole word')}
        {optBtn('.*', regex, setRegex, 'Regular expression')}
        <button className={'gs-opt' + (showReplace ? ' active' : '')} title="Toggle replace" onClick={() => setShowReplace((v) => !v)}>⇄</button>
        <select className="gs-scope" value={scope} onChange={(e) => setScope(e.target.value)} title="Search scope">
          <option value="all">All folders</option>
          <option value="current-root" disabled={!currentDoc}>Current folder</option>
          <option value="current-file" disabled={!currentDoc}>Current file</option>
        </select>
        <button className="gs-go" onClick={() => doSearch()}>Search</button>
        <span className="gs-summary">
          {status === 'searching' && 'Searching…'}
          {status === 'error' && <span className="gs-err">{error}</span>}
          {status === 'done' && summary && (
            summary.matches === 0
              ? 'No matches'
              : `${summary.matches} match${summary.matches !== 1 ? 'es' : ''} in ${summary.files} file${summary.files !== 1 ? 's' : ''}${summary.truncated ? ' (truncated)' : ''}`
          )}
        </span>
        <button className="icon-btn gs-close" title="Close (Esc)" onClick={onClose}>×</button>
      </div>
      {showReplace && (
        <div className="gs-replace">
          <div className="gs-input-wrap">
            <input
              className="gs-input"
              placeholder="Replace with…"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { if (histOpen) setHistOpen(null); else onClose(); }
                else if (e.key === 'ArrowDown' && replaceHistory.length) { e.preventDefault(); setHistOpen('replace'); }
              }}
            />
            {replaceHistory.length > 0 && (
              <button className="gs-hist-btn" title="Recent replacements" tabIndex={-1}
                onMouseDown={(e) => { e.preventDefault(); setHistOpen((v) => (v === 'replace' ? null : 'replace')); }}>▾</button>
            )}
            {histOpen === 'replace' && (
              <HistoryMenu items={replaceHistory} onClose={() => setHistOpen(null)} onPick={(v) => setReplaceText(v)} />
            )}
          </div>
          <button className="gs-go" onClick={doReplaceAll}>Replace All</button>
          {canUndo && <button className="gs-go gs-undo" onClick={doUndo}>Undo</button>}
          {replaceMsg && <span className="gs-summary">{replaceMsg}</span>}
        </div>
      )}
      {rows.length > 0 ? (
        <VirtualList rows={rows} rowHeight={22} renderRow={renderRow} getRowKey={(r) => r.key} className="gs-results" />
      ) : (
        <div className="gs-results gs-empty">
          {status === 'done' ? 'No matches.' : 'Type a query and press Enter.'}
        </div>
      )}
    </div>
  );
}
