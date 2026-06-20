import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import TitleBar from './TitleBar';
import StatusBar from './StatusBar';
import TabBar from './TabBar';
import DocumentArea from './DocumentArea';
import GoToLineDialog from './GoToLineDialog';
import HelpDialog from './HelpDialog';
import { normSlashes, basenameOf } from '../markdown/paths';

const NAV_CAP = 50;

// A detached document window: its own tabs + document view (read/source/ref/
// scale), no sidebar or global search. Names itself after its content; syncs
// theme/scale with every window; its tab set persists via the main registry.
export default function DetachedApp() {
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState('light');
  const [docScale, setDocScale] = useState(100);
  const [tabs, setTabs] = useState([]);
  const [activeTabIndex, setActiveTabIndex] = useState(-1);
  const [docModes, setDocModes] = useState({});
  const [refPanels, setRefPanels] = useState({});
  const [outlineOpen, setOutlineOpen] = useState(false); // right-side outline rail
  const [gotoLineOpen, setGotoLineOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [outlineWidth, setOutlineWidth] = useState(220);
  const [outlineDepths, setOutlineDepths] = useState({}); // docKey -> max depth (0 = all)
  const [navState, setNavState] = useState({ canBack: false, canForward: false });
  const [detachedNum, setDetachedNum] = useState(null);
  const [pendingGoto, setPendingGoto] = useState(null);
  const [docs, setDocs] = useState({}); // key -> { text, saved }

  const tabsRef = useRef(tabs);
  const activeKeyRef = useRef(null);
  const activeTabIndexRef = useRef(-1);
  const docModesRef = useRef(docModes);
  const addTabLocalRef = useRef(null);
  const navRef = useRef({ list: [], pos: -1 });
  const navSkipRef = useRef(false);
  const scrollMapRef = useRef({});
  const docsRef = useRef(docs);
  const activeDocRef = useRef(null);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeTabIndexRef.current = activeTabIndex; }, [activeTabIndex]);
  useEffect(() => { docModesRef.current = docModes; }, [docModes]);
  useEffect(() => { docsRef.current = docs; }, [docs]);

  const activeDoc = activeTabIndex >= 0 && activeTabIndex < tabs.length ? tabs[activeTabIndex] : null;
  const activeKey = activeDoc ? `${activeDoc.rootPath}|${activeDoc.relPath}` : null;
  const activeMode = activeKey ? (docModes[activeKey] || 'read') : 'read';
  const dirtyKeys = useMemo(() => {
    const s = new Set();
    for (const k of Object.keys(docs)) if (docs[k].text !== docs[k].saved) s.add(k);
    return s;
  }, [docs]);
  const docStats = useMemo(() => {
    const d = activeKey ? docs[activeKey] : null;
    if (!d || d.text == null) return null;
    const text = d.text;
    return { lines: text.length ? text.split('\n').length : 0, words: (text.match(/\S+/g) || []).length, chars: text.length };
  }, [activeKey, docs]);
  const gotoLine = pendingGoto && pendingGoto.key === activeKey ? pendingGoto.line : null;
  const gotoSeq = pendingGoto ? pendingGoto.seq : 0;

  // ── Load ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    (async () => {
      const settings = await window.arcenApi.getSettings();
      const sess = await window.arcenApi.getDetachedSession();
      const gsess = await window.arcenApi.getSession();
      if (!mounted) return;
      if (settings.theme === 'dark' || settings.theme === 'light') setTheme(settings.theme);
      if (Number.isFinite(settings.docScale)) setDocScale(settings.docScale);
      // Outline prefs live in the shared app session, so detached windows match.
      if (typeof gsess.outlineOpen === 'boolean') setOutlineOpen(gsess.outlineOpen);
      if (Number.isFinite(gsess.outlineWidth)) setOutlineWidth(gsess.outlineWidth);
      if (gsess.outlineDepths && typeof gsess.outlineDepths === 'object') setOutlineDepths(gsess.outlineDepths);
      const raw = (Array.isArray(sess.tabs) ? sess.tabs : []).filter((x) => x && x.rootPath && x.relPath);
      const t = raw.map((x) => ({ rootPath: x.rootPath, relPath: x.relPath, name: x.name || basenameOf(x.relPath) }));
      setTabs(t);
      // A window created by a tear-off receives the dragged tab's unsaved buffer
      // in its initial tab payload; seed it so the edits survive the move.
      const seed = {};
      for (const x of raw) {
        if (typeof x.text === 'string') seed[`${x.rootPath}|${x.relPath}`] = { text: x.text, saved: typeof x.saved === 'string' ? x.saved : x.text };
      }
      if (Object.keys(seed).length) setDocs((prev) => ({ ...prev, ...seed }));
      setActiveTabIndex(t.length ? Math.max(0, Math.min(sess.activeTab || 0, t.length - 1)) : -1);
      setReady(true);
    })();
    return () => { mounted = false; };
  }, []);

  // ── Theme / scale ─────────────────────────────────────────────────────
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme); }, [theme]);
  useEffect(() => {
    window.arcenApi.onThemeChange((t) => { if (t === 'light' || t === 'dark') setTheme(t); });
    window.arcenApi.onDocScaleChange((s) => { if (Number.isFinite(s)) setDocScale(s); });
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme((t) => { const next = t === 'light' ? 'dark' : 'light'; window.arcenApi.saveSettings({ theme: next }); window.arcenApi.sendTheme(next); return next; });
  }, []);
  const changeDocScale = useCallback((val) => {
    setDocScale(val); window.arcenApi.saveSettings({ docScale: val }); window.arcenApi.sendDocScale(val);
  }, []);

  useEffect(() => {
    let mounted = true;
    window.arcenApi.getDetachedDisplayNum().then((n) => { if (mounted && typeof n === 'number') setDetachedNum(n); });
    window.arcenApi.onDetachedDisplayNum((n) => { if (typeof n === 'number') setDetachedNum(n); });
    return () => { mounted = false; };
  }, []);

  // ── Tabs ──────────────────────────────────────────────────────────────
  const addTabLocal = useCallback((rootPath, relPath, name) => {
    setTabs((prev) => {
      const dup = prev.findIndex((t) => t.rootPath === rootPath && t.relPath === relPath);
      const base = dup >= 0 ? prev : [...prev, { rootPath, relPath, name: name || basenameOf(relPath) }];
      setActiveTabIndex(dup >= 0 ? dup : base.length - 1);
      return base;
    });
  }, []);
  useEffect(() => { addTabLocalRef.current = addTabLocal; }, [addTabLocal]);

  // A tab dragged onto this window from elsewhere (a deliberate move → local).
  // A tear-off may carry an unsaved buffer; seed it before activating the tab so
  // the lazy-load effect keeps it instead of re-reading disk.
  useEffect(() => {
    window.arcenApi.onTabAdded((tab) => {
      if (!tab || !tab.rootPath || !tab.relPath) return;
      if (typeof tab.text === 'string') {
        const key = `${tab.rootPath}|${tab.relPath}`;
        setDocs((prev) => (prev[key] ? prev : { ...prev, [key]: { text: tab.text, saved: typeof tab.saved === 'string' ? tab.saved : tab.text } }));
      }
      addTabLocalRef.current(tab.rootPath, tab.relPath, tab.name);
    });
  }, []);

  // Keep the main registry in step with this window's tabs (+ unsaved keys).
  useEffect(() => {
    if (!ready) return;
    window.arcenApi.registerWindowTabs(tabs.map((t) => ({ rootPath: t.rootPath, relPath: t.relPath, name: t.name })), activeTabIndex, [...dirtyKeys]);
  }, [tabs, activeTabIndex, ready, dirtyKeys]);

  useEffect(() => {
    window.arcenApi.onReloadDoc(({ rootPath, relPath }) => {
      const key = `${rootPath}|${relPath}`;
      const d = docsRef.current[key];
      if (!d || d.text !== d.saved) return; // not loaded, or has unsaved edits
      const abs = normSlashes(rootPath).replace(/\/+$/, '') + '/' + normSlashes(relPath);
      window.arcenApi.readFile(abs).then((text) => {
        setDocs((prev) => {
          const cur = prev[key];
          if (!cur || text === cur.text) return prev; // unchanged (e.g. our own save) → no-op
          return { ...prev, [key]: { text, saved: text } };
        });
      }).catch(() => {});
    });
  }, []);

  const activateTab = useCallback((index) => setActiveTabIndex(index), []);

  // Ctrl+Tab / Ctrl+Shift+Tab: step to the next/previous tab by position (wraps).
  const cycleTab = useCallback((dir) => {
    const list = tabsRef.current;
    if (list.length < 2) return;
    const cur = activeTabIndexRef.current >= 0 ? activeTabIndexRef.current : 0;
    activateTab((cur + dir + list.length) % list.length);
  }, [activateTab]);

  const reorderTabs = useCallback((from, to) => {
    setTabs((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      setActiveTabIndex((cur) => {
        const curDoc = prev[cur];
        const ni = curDoc ? next.findIndex((t) => t.rootPath === curDoc.rootPath && t.relPath === curDoc.relPath) : cur;
        return ni >= 0 ? ni : cur;
      });
      return next;
    });
  }, []);

  // Remove a tab and free its buffer WITHOUT a discard prompt (closes the window
  // on the last tab). Used by closeTab after it confirms, and by detachTab which
  // transfers the buffer to the target so there is nothing to discard.
  const removeTabAt = useCallback((index) => {
    const t = tabsRef.current[index];
    setTabs((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) { window.arcenApi.windowClose(); return prev; }
      setActiveTabIndex((cur) => {
        let ai = cur;
        if (index < cur) ai = cur - 1;
        else if (index === cur) ai = Math.min(cur, next.length - 1);
        return Math.max(0, ai);
      });
      return next;
    });
    if (t) {
      const key = `${t.rootPath}|${t.relPath}`;
      setDocs((prev) => { if (!(key in prev)) return prev; const nx = { ...prev }; delete nx[key]; return nx; });
    }
  }, []);

  const closeTab = useCallback((index) => {
    const t = tabsRef.current[index];
    if (t) {
      const key = `${t.rootPath}|${t.relPath}`;
      const d = docsRef.current[key];
      if (d && d.text !== d.saved && !window.confirm(`Discard unsaved changes to ${t.name}?`)) return;
    }
    removeTabAt(index);
  }, [removeTabAt]);

  // Tear-off carries the in-memory buffer (incl. unsaved edits) to the target,
  // which seeds from it instead of re-reading disk — no edits are lost.
  const detachTab = useCallback((index, x, y) => {
    const t = tabsRef.current[index];
    if (!t) return;
    const key = `${t.rootPath}|${t.relPath}`;
    const d = docsRef.current[key];
    const payload = { rootPath: t.rootPath, relPath: t.relPath, name: t.name };
    if (d) { payload.text = d.text; payload.saved = d.saved; }
    window.arcenApi.detachTabAtPosition(payload, x, y);
    removeTabAt(index);
  }, [removeTabAt]);

  // ── Mode / reference panel (local to this window) ─────────────────────
  const setMode = useCallback((key, m) => setDocModes((prev) => ({ ...prev, [key]: m })), []);
  const toggleRef = useCallback((key) => setRefPanels((prev) => {
    const cur = prev[key] || { open: false, height: 260 };
    return { ...prev, [key]: { open: !cur.open, height: cur.height || 260 } };
  }), []);
  const commitRefHeight = useCallback((key, height) => setRefPanels((prev) => ({ ...prev, [key]: { open: true, height } })), []);
  const onScrollCapture = useCallback((key, top) => { if (key) scrollMapRef.current[key] = top; }, []);
  const toggleOutline = useCallback(() => {
    setOutlineOpen((v) => { const next = !v; window.arcenApi.saveSession({ outlineOpen: next }); return next; });
  }, []);
  const onResizeOutline = useCallback((w, commit) => {
    setOutlineWidth(w);
    if (commit) window.arcenApi.saveSession({ outlineWidth: w });
  }, []);
  const onSetOutlineDepth = useCallback((d) => {
    const k = activeKeyRef.current;
    if (!k) return;
    setOutlineDepths((prev) => { const next = { ...prev, [k]: d }; window.arcenApi.saveSession({ outlineDepths: next }); return next; });
  }, []);
  // Outline click → jump the active document's view to the heading's source line.
  const gotoLineInActive = useCallback((line) => {
    const k = activeKeyRef.current;
    if (k && line) setPendingGoto({ key: k, line, seq: Date.now() });
  }, []);

  // Open a doc, deduping across all windows (see App.openDoc).
  const openDoc = useCallback(async ({ rootPath, relPath, name, line, mode }) => {
    const key = `${rootPath}|${relPath}`;
    const idx = tabsRef.current.findIndex((t) => t.rootPath === rootPath && t.relPath === relPath);
    if (idx < 0) {
      const r = await window.arcenApi.requestOpenDoc({ rootPath, relPath, name: name || basenameOf(relPath), line, mode });
      if (r && r.handled) return;
      setTabs((prev) => {
        const dup = prev.findIndex((t) => t.rootPath === rootPath && t.relPath === relPath);
        const base = dup >= 0 ? prev : [...prev, { rootPath, relPath, name: name || basenameOf(relPath) }];
        setActiveTabIndex(dup >= 0 ? dup : base.length - 1);
        return base;
      });
    } else {
      setActiveTabIndex(idx);
    }
    if (mode) setMode(key, mode);
    if (line) setPendingGoto({ key, line, seq: Date.now() });
  }, [setMode]);

  // Another window asked us to surface a doc we have open.
  useEffect(() => {
    window.arcenApi.onFocusDoc((payload) => {
      if (!payload) return;
      const key = `${payload.rootPath}|${payload.relPath}`;
      const idx = tabsRef.current.findIndex((t) => t.rootPath === payload.rootPath && t.relPath === payload.relPath);
      if (idx >= 0) setActiveTabIndex(idx);
      if (payload.mode) setMode(key, payload.mode);
      if (payload.line) setPendingGoto({ key, line: payload.line, seq: Date.now() });
    });
  }, [setMode]);

  // ── Editing: shared per-document content, dirty tracking, save ─────────
  const onDocChange = useCallback((key, text) => {
    setDocs((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], text } } : prev));
  }, []);
  const saveDoc = useCallback((rootPath, relPath) => {
    const key = `${rootPath}|${relPath}`;
    const d = docsRef.current[key];
    if (!d || d.text === d.saved) return;
    const abs = normSlashes(rootPath).replace(/\/+$/, '') + '/' + normSlashes(relPath);
    const text = d.text;
    window.arcenApi.writeFile(abs, text).then((res) => {
      if (res && res.ok) setDocs((prev) => (prev[key] ? { ...prev, [key]: { ...prev[key], saved: text } } : prev));
    });
  }, []);
  useEffect(() => { activeDocRef.current = activeDoc; }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!activeDoc || !activeKey || docsRef.current[activeKey]) return;
    const abs = normSlashes(activeDoc.rootPath).replace(/\/+$/, '') + '/' + normSlashes(activeDoc.relPath);
    let cancelled = false;
    window.arcenApi.readFile(abs).then((text) => {
      if (!cancelled) setDocs((prev) => (prev[activeKey] ? prev : { ...prev, [activeKey]: { text, saved: text } }));
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        const d = activeDocRef.current;
        if (d) saveDoc(d.rootPath, d.relPath);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveDoc]);

  useEffect(() => { activeKeyRef.current = activeKey; }, [activeKey]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
        const key = activeKeyRef.current;
        if (!key) return;
        e.preventDefault();
        const cur = docModesRef.current[key] || 'read';
        setMode(key, cur === 'source' ? 'read' : 'source');
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'g' || e.key === 'G')) {
        if (!activeKeyRef.current) return;
        e.preventDefault();
        setGotoLineOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setMode]);

  // Tab accelerators: Ctrl/Cmd+W closes the active tab; Ctrl/Cmd+Tab and
  // Ctrl/Cmd+Shift+Tab cycle through this window's tabs.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === 'w' || e.key === 'W') {
        const ai = activeTabIndexRef.current;
        if (ai < 0) return;
        e.preventDefault();
        closeTab(ai);
      } else if (e.key === 'Tab') {
        if (tabsRef.current.length < 2) return;
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeTab, cycleTab]);

  // F1 toggles the keyboard-shortcut help.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'F1') { e.preventDefault(); setHelpOpen((v) => !v); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // No search panel here — forward search hotkeys to the main window. The
  // in-file (Read-mode Ctrl+F) variant carries this window's current document
  // so the main window's pane scopes to it. (Source-mode Ctrl+F stays in CM.)
  useEffect(() => {
    const onKey = (e) => {
      const isF = (e.key === 'f' || e.key === 'F');
      if (!isF || !(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey) {
        e.preventDefault();
        window.arcenApi.openGlobalSearch({ scope: 'all' });
      } else {
        const key = activeKeyRef.current;
        const m = key ? (docModesRef.current[key] || 'read') : 'read';
        if (key && m === 'read') {
          e.preventDefault();
          const t = tabsRef.current.find((x) => `${x.rootPath}|${x.relPath}` === key);
          window.arcenApi.openGlobalSearch({ scope: 'current-file', doc: t ? { rootPath: t.rootPath, relPath: t.relPath } : null });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openAbsPath = useCallback((absPath) => {
    const abs = normSlashes(absPath);
    const lower = abs.toLowerCase();
    let match = null;
    for (const t of tabsRef.current) {
      const rp = normSlashes(t.rootPath).replace(/\/+$/, '').toLowerCase();
      if (lower === rp || lower.startsWith(rp + '/')) { match = t.rootPath; break; }
    }
    if (match) {
      const rp = normSlashes(match).replace(/\/+$/, '');
      const rel = abs.slice(rp.length + 1);
      openDoc({ rootPath: match, relPath: rel, name: basenameOf(rel) });
    } else {
      window.arcenApi.openPath(abs);
    }
  }, [openDoc]);

  // ── Navigation history (within this window's tabs) ────────────────────
  useEffect(() => {
    if (!ready) return;
    const nav = navRef.current;
    if (activeKey != null) {
      if (navSkipRef.current) {
        navSkipRef.current = false;
      } else {
        if (nav.pos < nav.list.length - 1) nav.list = nav.list.slice(0, nav.pos + 1);
        if (nav.list[nav.list.length - 1] !== activeKey) {
          nav.list.push(activeKey);
          if (nav.list.length > NAV_CAP) nav.list.shift();
        }
        nav.pos = nav.list.length - 1;
      }
    }
    setNavState({ canBack: nav.pos > 0, canForward: nav.pos < nav.list.length - 1 });
  }, [activeKey, ready]);

  const navigateBack = useCallback(() => {
    const nav = navRef.current;
    if (nav.pos <= 0) return;
    let p = nav.pos - 1;
    while (p >= 0) {
      const idx = tabsRef.current.findIndex((t) => `${t.rootPath}|${t.relPath}` === nav.list[p]);
      if (idx >= 0) { nav.pos = p; navSkipRef.current = true; setActiveTabIndex(idx); setNavState({ canBack: p > 0, canForward: p < nav.list.length - 1 }); return; }
      nav.list.splice(p, 1); if (nav.pos > p) nav.pos--; p--;
    }
  }, []);
  const navigateForward = useCallback(() => {
    const nav = navRef.current;
    if (nav.pos >= nav.list.length - 1) return;
    let p = nav.pos + 1;
    while (p < nav.list.length) {
      const idx = tabsRef.current.findIndex((t) => `${t.rootPath}|${t.relPath}` === nav.list[p]);
      if (idx >= 0) { nav.pos = p; navSkipRef.current = true; setActiveTabIndex(idx); setNavState({ canBack: p > 0, canForward: p < nav.list.length - 1 }); return; }
      nav.list.splice(p, 1);
    }
    // No live forward target remained (entries were spliced out) — resync so the
    // forward button doesn't stay stale-enabled.
    setNavState({ canBack: nav.pos > 0, canForward: nav.pos < nav.list.length - 1 });
  }, []);
  useEffect(() => {
    const handler = (e) => {
      if (e.button === 3) { e.preventDefault(); navigateBack(); }
      else if (e.button === 4) { e.preventDefault(); navigateForward(); }
    };
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, [navigateBack, navigateForward]);

  if (!ready) return <div className="app-root" />;

  return (
    <div className="app-root">
      <TitleBar
        mode="detached"
        navState={navState}
        onBack={navigateBack}
        onForward={navigateForward}
        activeFileName={activeDoc ? activeDoc.name : null}
        detachedNum={detachedNum}
      />
      <div className="app-container">
        <div className="main-area">
          <TabBar
            tabs={tabs}
            activeIndex={activeTabIndex}
            dirtyKeys={dirtyKeys}
            onActivate={activateTab}
            onClose={closeTab}
            onReorder={reorderTabs}
            onDetach={detachTab}
          />
          {activeDoc ? (
            <DocumentArea
              key={activeKey}
              doc={activeDoc}
              mode={activeMode}
              scale={docScale}
              theme={theme}
              refPanel={refPanels[activeKey]}
              scrollMapRef={scrollMapRef}
              gotoLine={gotoLine}
              gotoSeq={gotoSeq}
              text={docs[activeKey] ? docs[activeKey].text : undefined}
              onChange={(t) => onDocChange(activeKey, t)}
              onScrollCapture={onScrollCapture}
              onOpenAbsPath={openAbsPath}
              onSetMode={setMode}
              onToggleRef={toggleRef}
              onCommitRefHeight={commitRefHeight}
              onChangeScale={changeDocScale}
              outlineOpen={outlineOpen}
              onToggleOutline={toggleOutline}
              onGotoLine={gotoLineInActive}
              outlineWidth={outlineWidth}
              onResizeOutline={onResizeOutline}
              outlineDepth={activeKey ? (outlineDepths[activeKey] || 0) : 0}
              onSetOutlineDepth={onSetOutlineDepth}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-title">AMM Viewer</div>
              <div>This window has no open documents.</div>
            </div>
          )}
          <StatusBar
            theme={theme}
            onToggleTheme={toggleTheme}
            activeFile={activeDoc ? activeDoc.relPath : null}
            stats={docStats}
            onShowHelp={() => setHelpOpen(true)}
          />
        </div>
      </div>
      {gotoLineOpen && activeDoc && <GoToLineDialog onGo={gotoLineInActive} onClose={() => setGotoLineOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
