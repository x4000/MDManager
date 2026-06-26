import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import TitleBar from './TitleBar';
import StatusBar from './StatusBar';
import Sidebar from './Sidebar';
import TabBar from './TabBar';
import DocumentArea from './DocumentArea';
import GlobalSearch from './GlobalSearch';
import ContextMenu from './ContextMenu';
import GoToLineDialog from './GoToLineDialog';
import HelpDialog from './HelpDialog';
import { favoriteMenuItems } from './favMenu';
import { normSlashes, basenameOf } from '../markdown/paths';

const NAV_CAP = 50;

// Folder keys (rootPath|relPath) for every ancestor directory of a file, so the
// sidebar can expand the path down to it.
function ancestorFolderKeys(rootPath, relPath) {
  const parts = relPath.split('/');
  parts.pop();
  const keys = [];
  let acc = '';
  for (const p of parts) { acc = acc ? `${acc}/${p}` : p; keys.push(`${rootPath}|${acc}`); }
  return keys;
}

export default function App({ mode = 'main' }) {
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState('light');
  const [sidebarSide, setSidebarSide] = useState('left');
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [docScale, setDocScale] = useState(100);
  const [showDocx, setShowDocx] = useState(false);
  const [roots, setRoots] = useState([]);
  const [expandedRoots, setExpandedRoots] = useState(() => new Set());
  const [expandedFolders, setExpandedFolders] = useState(() => new Set());
  const [trees, setTrees] = useState({});
  const [tabs, setTabs] = useState([]);
  const [activeTabIndex, setActiveTabIndex] = useState(-1);
  const [navState, setNavState] = useState({ canBack: false, canForward: false });
  const [docModes, setDocModes] = useState({}); // docKey -> 'read' | 'source'
  const [refPanels, setRefPanels] = useState({}); // docKey -> { open, height }
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchInit, setSearchInit] = useState(null);
  const [searchCurrentDoc, setSearchCurrentDoc] = useState(null); // override for forwarded searches
  const [activeSearch, setActiveSearch] = useState(null); // committed query (for in-doc highlighting)
  const [globalSearchHeight, setGlobalSearchHeight] = useState(300);
  const [pendingGoto, setPendingGoto] = useState(null); // { key, line, seq }
  const [favorites, setFavorites] = useState([]); // [{ name, files: [{ rootPath, relPath, name }] }]
  const [sidebarTab, setSidebarTab] = useState('folders'); // 'folders' | 'favorites'
  const [outlineOpen, setOutlineOpen] = useState(false); // right-side outline rail
  const [gotoLineOpen, setGotoLineOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [outlineWidth, setOutlineWidth] = useState(220);
  const [outlineDepths, setOutlineDepths] = useState({}); // docKey -> max depth (0 = all)
  const [revealTarget, setRevealTarget] = useState(null); // { rootPath, relPath, seq }
  const [tabMenu, setTabMenu] = useState(null);
  const [docs, setDocs] = useState({}); // key -> { text, saved }
  const docsRef = useRef(docs);
  const activeDocRef = useRef(null);
  useEffect(() => { docsRef.current = docs; }, [docs]);

  const readyRef = useRef(false);
  const expandedRootsRef = useRef(expandedRoots);
  const treesRef = useRef(trees);
  const rootsRef = useRef(roots);
  const tabsRef = useRef(tabs);
  const activeKeyRef = useRef(null);
  const activeTabIndexRef = useRef(-1);
  const mruRef = useRef([]); // doc keys in most-recently-active order (oldest→newest)
  const docModesRef = useRef(docModes);
  const favoritesRef = useRef(favorites);
  const openFileRef = useRef(null);
  useEffect(() => { expandedRootsRef.current = expandedRoots; }, [expandedRoots]);
  useEffect(() => { treesRef.current = trees; }, [trees]);
  useEffect(() => { rootsRef.current = roots; }, [roots]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeTabIndexRef.current = activeTabIndex; }, [activeTabIndex]);
  useEffect(() => { docModesRef.current = docModes; }, [docModes]);
  useEffect(() => { favoritesRef.current = favorites; }, [favorites]);

  // Navigation history + per-doc scroll memory.
  const navRef = useRef({ list: [], pos: -1 });
  const navSkipRef = useRef(false);
  const scrollMapRef = useRef({});
  const scrollSaveTimer = useRef(null);

  const fetchTree = useCallback(async (rootPath) => {
    setTrees((prev) => ({ ...prev, [rootPath]: { ...(prev[rootPath] || {}), loading: true } }));
    const res = await window.arcenApi.listTree(rootPath);
    setTrees((prev) => ({
      ...prev,
      [rootPath]: res && res.ok ? { tree: res.tree } : { error: (res && res.error) || 'error' },
    }));
  }, []);

  // ── Initial load ───────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    (async () => {
      const settings = await window.arcenApi.getSettings();
      const session = await window.arcenApi.getSession();
      if (!mounted) return;
      if (settings.theme === 'dark' || settings.theme === 'light') setTheme(settings.theme);
      if (settings.sidebarSide === 'left' || settings.sidebarSide === 'right') setSidebarSide(settings.sidebarSide);
      if (Number.isFinite(settings.sidebarWidth)) setSidebarWidth(settings.sidebarWidth);
      if (Number.isFinite(settings.docScale)) setDocScale(settings.docScale);
      if (typeof settings.showDocx === 'boolean') setShowDocx(settings.showDocx);
      if (Number.isFinite(settings.globalSearchHeight)) setGlobalSearchHeight(settings.globalSearchHeight);
      const loadedRoots = Array.isArray(settings.roots) ? settings.roots : [];
      setRoots(loadedRoots);
      const expRoots = Array.isArray(session.expandedRoots) ? session.expandedRoots : [];
      setExpandedRoots(new Set(expRoots));
      setExpandedFolders(new Set(Array.isArray(session.expandedFolders) ? session.expandedFolders : []));
      if (session.fileScroll && typeof session.fileScroll === 'object') scrollMapRef.current = { ...session.fileScroll };

      const savedTabs = (Array.isArray(session.tabs) ? session.tabs : [])
        .filter((t) => t && t.rootPath && t.relPath)
        .map((t) => ({ rootPath: t.rootPath, relPath: t.relPath, name: t.name || basenameOf(t.relPath) }));
      setTabs(savedTabs);
      if (savedTabs.length) {
        const ai = Number.isInteger(session.activeTab) ? session.activeTab : 0;
        setActiveTabIndex(Math.max(0, Math.min(ai, savedTabs.length - 1)));
      }

      if (session.docModes && typeof session.docModes === 'object') setDocModes(session.docModes);
      if (session.refPanels && typeof session.refPanels === 'object') setRefPanels(session.refPanels);
      if (Array.isArray(session.favorites)) setFavorites(session.favorites);
      if (session.sidebarTab === 'favorites' || session.sidebarTab === 'folders') setSidebarTab(session.sidebarTab);
      if (typeof session.outlineOpen === 'boolean') setOutlineOpen(session.outlineOpen);
      if (Number.isFinite(session.outlineWidth)) setOutlineWidth(session.outlineWidth);
      if (session.outlineDepths && typeof session.outlineDepths === 'object') setOutlineDepths(session.outlineDepths);

      readyRef.current = true;
      setReady(true);
      const knownPaths = new Set(loadedRoots.map((r) => r.path));
      for (const p of expRoots) if (knownPaths.has(p)) fetchTree(p);
    })();
    return () => { mounted = false; };
  }, [fetchTree]);

  // ── Theme ────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    if (readyRef.current) window.arcenApi.sendTheme(theme);
  }, [theme]);
  useEffect(() => {
    window.arcenApi.onThemeChange((t) => { if (t === 'light' || t === 'dark') setTheme(t); });
    window.arcenApi.onDocScaleChange((s) => { if (Number.isFinite(s)) setDocScale(s); });
  }, []);

  // A tab dragged from a detached window onto the main window opens here. If the
  // tear-off carried an unsaved buffer, seed it first so the move is lossless.
  useEffect(() => {
    window.arcenApi.onOpenFile((tab) => {
      if (!tab || !tab.rootPath || !tab.relPath) return;
      if (typeof tab.text === 'string') {
        const key = `${tab.rootPath}|${tab.relPath}`;
        setDocs((prev) => (prev[key] ? prev : { ...prev, [key]: { text: tab.text, saved: typeof tab.saved === 'string' ? tab.saved : tab.text } }));
      }
      openFileRef.current(tab.rootPath, tab.relPath, tab.name);
    });
  }, []);

  // ── Live tree refresh ────────────────────────────────────────────────
  useEffect(() => {
    window.arcenApi.onTreeChanged((changedRoot) => {
      const targets = changedRoot ? [changedRoot] : Object.keys(treesRef.current);
      for (const r of targets) if (expandedRootsRef.current.has(r)) fetchTree(r);
    });
  }, [fetchTree]);

  // Safety net for the file watcher: some folders (network/virtual drives) don't
  // deliver reliable change events, so a newly-added folder could otherwise stay
  // invisible until restart. Re-walk every expanded root whenever the window
  // regains focus, so switching back to AMM always shows the current tree.
  useEffect(() => {
    const onFocus = () => {
      for (const r of rootsRef.current) if (expandedRootsRef.current.has(r.path)) fetchTree(r.path);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [fetchTree]);

  // Explicit tree refresh (e.g. right after creating a folder), independent of
  // the watcher so the new item appears immediately.
  const refreshTree = useCallback((rootPath) => { if (rootPath) fetchTree(rootPath); }, [fetchTree]);

  // ── Toggles ──────────────────────────────────────────────────────────
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === 'light' ? 'dark' : 'light';
      window.arcenApi.saveSettings({ theme: next });
      return next;
    });
  }, []);
  const toggleSidebarSide = useCallback(() => {
    setSidebarSide((s) => {
      const next = s === 'left' ? 'right' : 'left';
      window.arcenApi.saveSettings({ sidebarSide: next });
      return next;
    });
  }, []);
  const changeDocScale = useCallback((val) => {
    setDocScale(val);
    window.arcenApi.saveSettings({ docScale: val });
    window.arcenApi.sendDocScale(val);
  }, []);
  const toggleDocx = useCallback(() => {
    setShowDocx((v) => {
      const next = !v;
      window.arcenApi.saveSettings({ showDocx: next });
      return next;
    });
  }, []);

  // ── Read/Source mode + reference panel (per document) ────────────────
  const setMode = useCallback((key, m) => {
    setDocModes((prev) => {
      const next = { ...prev, [key]: m };
      window.arcenApi.saveSession({ docModes: next });
      return next;
    });
  }, []);

  const toggleRef = useCallback((key) => {
    setRefPanels((prev) => {
      const cur = prev[key] || { open: false, height: 260 };
      const next = { ...prev, [key]: { open: !cur.open, height: cur.height || 260 } };
      window.arcenApi.saveSession({ refPanels: next });
      return next;
    });
  }, []);

  const commitRefHeight = useCallback((key, height) => {
    setRefPanels((prev) => {
      const next = { ...prev, [key]: { open: true, height } };
      window.arcenApi.saveSession({ refPanels: next });
      return next;
    });
  }, []);

  // ── Sidebar resize ───────────────────────────────────────────────────
  const handleSidebarDragStart = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const dirSign = sidebarSide === 'right' ? -1 : 1;
    let latest = startWidth;
    const onMove = (ev) => {
      latest = Math.max(150, Math.min(600, startWidth + dirSign * (ev.clientX - startX)));
      setSidebarWidth(latest);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.arcenApi.saveSettings({ sidebarWidth: latest });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth, sidebarSide]);

  // ── Roots + expansion ────────────────────────────────────────────────
  const toggleRoot = useCallback((rootPath) => {
    setExpandedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rootPath)) {
        next.delete(rootPath);
      } else {
        next.add(rootPath);
        const ts = treesRef.current[rootPath];
        if (!ts || ts.error) fetchTree(rootPath);
      }
      window.arcenApi.saveSession({ expandedRoots: [...next] });
      return next;
    });
  }, [fetchTree]);

  const toggleFolder = useCallback((folderKey) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderKey)) next.delete(folderKey); else next.add(folderKey);
      window.arcenApi.saveSession({ expandedFolders: [...next] });
      return next;
    });
  }, []);

  const addRoot = useCallback(async () => {
    const updated = await window.arcenApi.addRoot();
    if (Array.isArray(updated)) setRoots(updated);
  }, []);

  // ── Tabs ─────────────────────────────────────────────────────────────
  const persistTabs = useCallback((nextTabs, nextActive) => {
    window.arcenApi.saveSession({
      tabs: nextTabs.map((t) => ({ rootPath: t.rootPath, relPath: t.relPath, name: t.name })),
      activeTab: nextActive,
    });
  }, []);

  // Open a document, deduping across ALL windows: if it's open in this window,
  // activate that tab; if it's open in another window, focus that window's tab;
  // otherwise open a new tab here. Optionally jump to a line / set the mode.
  const openDoc = useCallback(async ({ rootPath, relPath, name, line, mode }) => {
    const key = `${rootPath}|${relPath}`;
    const idx = tabsRef.current.findIndex((t) => t.rootPath === rootPath && t.relPath === relPath);
    if (idx < 0) {
      const r = await window.arcenApi.requestOpenDoc({ rootPath, relPath, name: name || basenameOf(relPath), line, mode });
      if (r && r.handled) return; // already open in another window — focused there
      setTabs((prev) => {
        const dup = prev.findIndex((t) => t.rootPath === rootPath && t.relPath === relPath);
        const base = dup >= 0 ? prev : [...prev, { rootPath, relPath, name: name || basenameOf(relPath) }];
        const ai = dup >= 0 ? dup : base.length - 1;
        setActiveTabIndex(ai);
        persistTabs(base, ai);
        return base;
      });
    } else {
      setActiveTabIndex(idx);
      window.arcenApi.saveSession({ activeTab: idx });
    }
    if (mode) setMode(key, mode);
    if (line) setPendingGoto({ key, line, seq: Date.now() });
  }, [persistTabs, setMode]);

  const openFile = useCallback((rootPath, relPath, name) => openDoc({ rootPath, relPath, name }), [openDoc]);

  // Resolve an absolute path to a tab ref: under a configured root → a tree tab;
  // otherwise an ad-hoc tab keyed by its own directory (same shape main uses for
  // OS-association opens). Used by the drag-files-onto-window handler.
  const refForAbs = useCallback((absPath) => {
    const a = (absPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    for (const r of rootsRef.current) {
      const rp = (r.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
      if (a.toLowerCase() === rp.toLowerCase() || a.toLowerCase().startsWith(rp.toLowerCase() + '/')) {
        return { rootPath: r.path, relPath: a.slice(rp.length + 1), name: basenameOf(a) };
      }
    }
    const i = a.lastIndexOf('/');
    return { rootPath: a.slice(0, i), relPath: a.slice(i + 1), name: a.slice(i + 1) };
  }, []);

  // Local-only add (a tab deliberately dropped onto this window) — bypasses the
  // cross-window dedup so it doesn't race the source window's de-registration.
  const addTabLocal = useCallback((rootPath, relPath, name) => {
    setTabs((prev) => {
      const dup = prev.findIndex((t) => t.rootPath === rootPath && t.relPath === relPath);
      const base = dup >= 0 ? prev : [...prev, { rootPath, relPath, name: name || basenameOf(relPath) }];
      const ai = dup >= 0 ? dup : base.length - 1;
      setActiveTabIndex(ai);
      persistTabs(base, ai);
      return base;
    });
  }, [persistTabs]);

  useEffect(() => { openFileRef.current = addTabLocal; }, [addTabLocal]);

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

  const activateTab = useCallback((index) => {
    setActiveTabIndex(index);
    window.arcenApi.saveSession({ activeTab: index });
  }, []);

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
        const fin = ni >= 0 ? ni : cur;
        persistTabs(next, fin);
        return fin;
      });
      return next;
    });
  }, [persistTabs]);

  // Remove a tab and free its buffer WITHOUT a discard prompt. Used both by
  // closeTab (after it confirms) and by detachTab (which transfers the buffer to
  // the target window, so there is nothing to discard).
  const removeTabAt = useCallback((index) => {
    const t = tabsRef.current[index];
    const closedKey = t ? `${t.rootPath}|${t.relPath}` : null;
    setTabs((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setActiveTabIndex((cur) => {
        let ai;
        if (next.length === 0) ai = -1;
        else if (index < cur) ai = cur - 1;       // a tab before the active one closed
        else if (index > cur) ai = cur;           // a tab after the active one closed
        else {
          // The active tab closed → jump to the most-recently-used remaining tab,
          // falling back to the neighbor that slid into this slot.
          ai = Math.min(index, next.length - 1);
          const mru = mruRef.current;
          for (let m = mru.length - 1; m >= 0; m--) {
            if (mru[m] === closedKey) continue;
            const idx = next.findIndex((x) => `${x.rootPath}|${x.relPath}` === mru[m]);
            if (idx >= 0) { ai = idx; break; }
          }
        }
        ai = next.length ? Math.max(0, ai) : -1;
        persistTabs(next, ai);
        return ai;
      });
      return next;
    });
    if (t) {
      const key = `${t.rootPath}|${t.relPath}`;
      const mi = mruRef.current.indexOf(key);
      if (mi >= 0) mruRef.current.splice(mi, 1);
      setDocs((prev) => { if (!(key in prev)) return prev; const nx = { ...prev }; delete nx[key]; return nx; });
      // Evict this file's persisted scroll positions (mode/ref-qualified keys)
      // so the fileScroll session map can't grow without bound.
      const prefix = `${key}::`;
      let pruned = false;
      for (const k of Object.keys(scrollMapRef.current)) if (k.startsWith(prefix)) { delete scrollMapRef.current[k]; pruned = true; }
      if (pruned) window.arcenApi.saveSession({ fileScroll: { ...scrollMapRef.current } });
    }
  }, [persistTabs]);

  const closeTab = useCallback((index) => {
    const t = tabsRef.current[index];
    if (t) {
      const key = `${t.rootPath}|${t.relPath}`;
      const d = docsRef.current[key];
      if (d && d.text !== d.saved && !window.confirm(`Discard unsaved changes to ${t.name}?`)) return;
    }
    removeTabAt(index);
  }, [removeTabAt]);

  // Tear a tab off into a detached window (or onto another window). The current
  // in-memory buffer (including unsaved edits) rides along in the IPC payload so
  // the target seeds from it instead of re-reading disk — no edits are lost.
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

  const removeRoot = useCallback(async (rootPath) => {
    if (!window.confirm(`Remove this folder from the sidebar?\n\n${rootPath}\n\nThe folder and its files are not deleted — this only stops showing it here.`)) return;
    const updated = await window.arcenApi.removeRoot(rootPath);
    if (Array.isArray(updated)) setRoots(updated);
    setExpandedRoots((prev) => {
      if (!prev.has(rootPath)) return prev;
      const next = new Set(prev);
      next.delete(rootPath);
      window.arcenApi.saveSession({ expandedRoots: [...next] });
      return next;
    });
    setTrees((prev) => {
      if (!(rootPath in prev)) return prev;
      const next = { ...prev };
      delete next[rootPath];
      return next;
    });
    setTabs((prev) => {
      const next = prev.filter((t) => t.rootPath !== rootPath);
      if (next.length === prev.length) return prev;
      setActiveTabIndex((cur) => {
        const ai = next.length ? Math.min(Math.max(0, cur), next.length - 1) : -1;
        persistTabs(next, ai);
        return ai;
      });
      return next;
    });
    // Drop this root's persisted scroll positions too.
    const prefix = `${rootPath}|`;
    let pruned = false;
    for (const k of Object.keys(scrollMapRef.current)) if (k.startsWith(prefix)) { delete scrollMapRef.current[k]; pruned = true; }
    if (pruned) window.arcenApi.saveSession({ fileScroll: { ...scrollMapRef.current } });
  }, [persistTabs]);

  const renameRoot = useCallback(async (rootPath, value) => {
    const updated = await window.arcenApi.setRootNickname(rootPath, value);
    if (Array.isArray(updated)) setRoots(updated);
  }, []);

  // Drag-reorder roots in the sidebar: move fromPath to before (or after) toPath.
  const reorderRoots = useCallback(async (fromPath, toPath, after) => {
    const order = rootsRef.current.map((r) => r.path);
    const fi = order.indexOf(fromPath);
    if (fi < 0 || fromPath === toPath) return;
    order.splice(fi, 1);
    let ti = order.indexOf(toPath);
    if (ti < 0) ti = order.length;
    else if (after) ti += 1;
    order.splice(ti, 0, fromPath);
    const updated = await window.arcenApi.reorderRoots(order);
    if (Array.isArray(updated)) setRoots(updated);
  }, []);

  // A file/folder was renamed on disk (from the tree): re-point any open tabs
  // (the file itself, or anything under a renamed folder) and re-key their docs.
  const onPathRenamed = useCallback((rootPath, oldRel, newRel) => {
    const oldKey = `${rootPath}|${oldRel}`;
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.rootPath !== rootPath) return t;
        if (t.relPath === oldRel) { changed = true; return { ...t, relPath: newRel, name: basenameOf(newRel) }; }
        if (t.relPath.startsWith(oldRel + '/')) { changed = true; return { ...t, relPath: newRel + t.relPath.slice(oldRel.length) }; }
        return t;
      });
      if (!changed) return prev;
      setActiveTabIndex((cur) => { persistTabs(next, cur); return cur; });
      return next;
    });
    setDocs((prev) => {
      let changed = false;
      const next = {};
      for (const k of Object.keys(prev)) {
        if (k === oldKey) { next[`${rootPath}|${newRel}`] = prev[k]; changed = true; }
        else if (k.startsWith(oldKey + '/')) { next[`${rootPath}|${newRel}${k.slice(oldKey.length)}`] = prev[k]; changed = true; }
        else next[k] = prev[k];
      }
      return changed ? next : prev;
    });
  }, [persistTabs]);

  // A file/folder was moved (dragged) to another folder, possibly in a different
  // root: re-key open tabs + docs (the file itself, or anything under a moved
  // folder) from (oldRoot, oldRel) to (newRoot, newRel).
  const onPathMoved = useCallback((oldRoot, oldRel, newRoot, newRel) => {
    const oldKey = `${oldRoot}|${oldRel}`;
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.rootPath !== oldRoot) return t;
        if (t.relPath === oldRel) { changed = true; return { ...t, rootPath: newRoot, relPath: newRel, name: basenameOf(newRel) }; }
        if (t.relPath.startsWith(oldRel + '/')) { changed = true; return { ...t, rootPath: newRoot, relPath: newRel + t.relPath.slice(oldRel.length) }; }
        return t;
      });
      if (!changed) return prev;
      setActiveTabIndex((cur) => { persistTabs(next, cur); return cur; });
      return next;
    });
    setDocs((prev) => {
      let changed = false;
      const next = {};
      for (const k of Object.keys(prev)) {
        if (k === oldKey) { next[`${newRoot}|${newRel}`] = prev[k]; changed = true; }
        else if (k.startsWith(oldKey + '/')) { next[`${newRoot}|${newRel}${k.slice(oldKey.length)}`] = prev[k]; changed = true; }
        else next[k] = prev[k];
      }
      return changed ? next : prev;
    });
  }, [persistTabs]);

  // A file/folder was deleted (to the Recycle Bin): close any affected tabs.
  const onPathDeleted = useCallback((rootPath, rel) => {
    setTabs((prev) => {
      const keep = prev.filter((t) => !(t.rootPath === rootPath && (t.relPath === rel || t.relPath.startsWith(rel + '/'))));
      if (keep.length === prev.length) return prev;
      setActiveTabIndex((cur) => { const ai = keep.length ? Math.min(Math.max(0, cur), keep.length - 1) : -1; persistTabs(keep, ai); return ai; });
      return keep;
    });
    const prefix = `${rootPath}|${rel}`;
    setDocs((prev) => {
      let changed = false;
      const next = {};
      for (const k of Object.keys(prev)) {
        if (k === prefix || k.startsWith(prefix + '/')) { changed = true; continue; }
        next[k] = prev[k];
      }
      return changed ? next : prev;
    });
  }, [persistTabs]);

  // ── Favorites ────────────────────────────────────────────────────────
  const updateFavorites = useCallback((next) => {
    setFavorites(next);
    window.arcenApi.saveSession({ favorites: next });
  }, []);

  const changeSidebarTab = useCallback((t) => {
    setSidebarTab(t);
    window.arcenApi.saveSession({ sidebarTab: t });
  }, []);

  const toggleOutline = useCallback(() => {
    setOutlineOpen((v) => { const next = !v; window.arcenApi.saveSession({ outlineOpen: next }); return next; });
  }, []);

  const onResizeOutline = useCallback((w, commit) => {
    setOutlineWidth(w);
    if (commit) window.arcenApi.saveSession({ outlineWidth: w });
  }, []);

  // Outline depth is remembered per document (0 = show all levels).
  const onSetOutlineDepth = useCallback((d) => {
    const k = activeKeyRef.current;
    if (!k) return;
    setOutlineDepths((prev) => { const next = { ...prev, [k]: d }; window.arcenApi.saveSession({ outlineDepths: next }); return next; });
  }, []);

  // Outline click → jump the active document's view to the heading's source line
  // (reuses the search go-to-line plumbing, so it works in Read and Source).
  const gotoLineInActive = useCallback((line) => {
    const k = activeKeyRef.current;
    if (k && line) setPendingGoto({ key: k, line, seq: Date.now() });
  }, []);

  // ── Sidebar reveal: open the folder a document lives in and scroll to it ─
  // expand=true opens the root + every ancestor folder down to the file (used
  // when a document is focused, or the explicit "Center in sidebar" action).
  // expand=false only scrolls to the file if it is already visible, so it never
  // re-opens a folder the user deliberately collapsed.
  const revealInSidebar = useCallback((rootPath, relPath, expand = true) => {
    if (expand) {
      setExpandedRoots((prev) => {
        if (prev.has(rootPath)) return prev;
        const next = new Set(prev);
        next.add(rootPath);
        const ts = treesRef.current[rootPath];
        if (!ts || ts.error) fetchTree(rootPath);
        window.arcenApi.saveSession({ expandedRoots: [...next] });
        return next;
      });
      const keys = ancestorFolderKeys(rootPath, relPath);
      if (keys.length) {
        setExpandedFolders((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const k of keys) if (!next.has(k)) { next.add(k); changed = true; }
          if (changed) window.arcenApi.saveSession({ expandedFolders: [...next] });
          return changed ? next : prev;
        });
      }
    }
    setRevealTarget({ rootPath, relPath, seq: Date.now() });
  }, [fetchTree]);

  // Used by the sidebar name-search so it can filter across roots not yet opened.
  const ensureAllTrees = useCallback(() => {
    for (const r of rootsRef.current) {
      const ts = treesRef.current[r.path];
      if (!ts || ts.error) fetchTree(r.path);
    }
  }, [fetchTree]);

  // ── Tab context menu (favorites, center, reveal, close/others/all) ────
  const closeOthers = useCallback((index) => {
    const keep = tabsRef.current[index];
    if (!keep) return;
    const dirtyOthers = tabsRef.current.some((t, i) => {
      if (i === index) return false;
      const d = docsRef.current[`${t.rootPath}|${t.relPath}`];
      return d && d.text !== d.saved;
    });
    if (dirtyOthers && !window.confirm('Discard unsaved changes in the other tabs?')) return;
    setTabs(() => { const next = [keep]; setActiveTabIndex(0); persistTabs(next, 0); return next; });
    setDocs((prev) => {
      const keepKey = `${keep.rootPath}|${keep.relPath}`;
      return prev[keepKey] ? { [keepKey]: prev[keepKey] } : {};
    });
  }, [persistTabs]);

  const closeAllTabs = useCallback(() => {
    const anyDirty = tabsRef.current.some((t) => {
      const d = docsRef.current[`${t.rootPath}|${t.relPath}`];
      return d && d.text !== d.saved;
    });
    if (anyDirty && !window.confirm('Discard all unsaved changes?')) return;
    setActiveTabIndex(-1);
    persistTabs([], -1);
    setTabs([]);
    setDocs({});
  }, [persistTabs]);

  const handleTabContextMenu = useCallback((index, x, y) => {
    const t = tabsRef.current[index];
    if (!t) return;
    const file = { rootPath: t.rootPath, relPath: t.relPath, name: t.name };
    const abs = normSlashes(t.rootPath).replace(/\/+$/, '') + '/' + t.relPath;
    const items = [
      ...favoriteMenuItems(file, favoritesRef.current, updateFavorites),
      { divider: true },
      { label: 'Center in sidebar', action: () => { changeSidebarTab('folders'); revealInSidebar(t.rootPath, t.relPath); } },
      { label: 'Reveal in Explorer', action: () => window.arcenApi.showInFolder(abs) },
      { label: 'Copy path', action: () => { try { navigator.clipboard.writeText(abs); } catch (_) { /* ignore */ } } },
      { divider: true },
      { label: 'Close', action: () => closeTab(index) },
      { label: 'Close others', action: () => closeOthers(index) },
      { label: 'Close all', action: () => closeAllTabs() },
    ];
    setTabMenu({ x, y, items });
  }, [updateFavorites, changeSidebarTab, revealInSidebar, closeTab, closeOthers, closeAllTabs]);

  const openAbsPath = useCallback((absPath) => {
    const abs = normSlashes(absPath);
    const absLower = abs.toLowerCase();
    const match = rootsRef.current.find((r) => {
      const rp = normSlashes(r.path).replace(/\/+$/, '').toLowerCase();
      return absLower === rp || absLower.startsWith(rp + '/');
    });
    if (match) {
      const rp = normSlashes(match.path).replace(/\/+$/, '');
      const relPath = abs.slice(rp.length + 1);
      openDoc({ rootPath: match.path, relPath, name: basenameOf(relPath) });
    } else {
      window.arcenApi.openPath(abs);
    }
  }, [openDoc]);

  // ── Global search ────────────────────────────────────────────────────
  const openSearch = useCallback((scope, doc, opts) => {
    setSearchCurrentDoc(doc || null);
    setSearchOpen(true);
    setSearchInit({ scope, query: '', seq: Date.now(), showReplace: !!(opts && opts.replace) });
  }, []);

  const onResizeSearch = useCallback((h, persist) => {
    setGlobalSearchHeight(h);
    if (persist) window.arcenApi.saveSettings({ globalSearchHeight: h });
  }, []);

  const openResult = useCallback((rootPath, relPath, line, toSource) => {
    openDoc({ rootPath, relPath, line, mode: toSource ? 'source' : 'read' });
  }, [openDoc]);

  // ── Scroll memory ────────────────────────────────────────────────────
  const onScrollCapture = useCallback((key, top) => {
    if (!key) return;
    scrollMapRef.current[key] = top;
    if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    scrollSaveTimer.current = setTimeout(() => {
      window.arcenApi.saveSession({ fileScroll: { ...scrollMapRef.current } });
    }, 600);
  }, []);

  // ── Navigation history ───────────────────────────────────────────────
  const activeDoc = activeTabIndex >= 0 && activeTabIndex < tabs.length ? tabs[activeTabIndex] : null;
  const activeKey = activeDoc ? `${activeDoc.rootPath}|${activeDoc.relPath}` : null;
  const activeMode = activeKey ? (docModes[activeKey] || 'read') : 'read';
  const dirtyKeys = useMemo(() => {
    const s = new Set();
    for (const k of Object.keys(docs)) if (docs[k].text !== docs[k].saved) s.add(k);
    return s;
  }, [docs]);
  // Line/word/char counts for the active document (status bar).
  const docStats = useMemo(() => {
    const d = activeKey ? docs[activeKey] : null;
    if (!d || d.text == null) return null;
    const text = d.text;
    return {
      lines: text.length ? text.split('\n').length : 0,
      words: (text.match(/\S+/g) || []).length,
      chars: text.length,
    };
  }, [activeKey, docs]);
  useEffect(() => { activeKeyRef.current = activeKey; }, [activeKey]);
  // Track most-recently-used order so closing the active tab returns to the tab
  // you were last on (not just the neighbor), and Ctrl+Tab can be index-stable.
  useEffect(() => {
    if (!activeKey) return;
    const mru = mruRef.current;
    const i = mru.indexOf(activeKey);
    if (i >= 0) mru.splice(i, 1);
    mru.push(activeKey);
    if (mru.length > 200) mru.shift();
  }, [activeKey]);

  // Reveal the active document in the tree: open its folder + bold it when the
  // focused document actually changes (the milestone-7 behavior), but only
  // scroll (no re-expand) when merely returning to the Folders tab — so a folder
  // the user deliberately collapsed stays collapsed.
  const lastRevealedKeyRef = useRef(null);
  useEffect(() => {
    if (!activeDoc || sidebarTab !== 'folders') return;
    const expand = lastRevealedKeyRef.current !== activeKey;
    lastRevealedKeyRef.current = activeKey;
    revealInSidebar(activeDoc.rootPath, activeDoc.relPath, expand);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, sidebarTab]);

  // Register this window's tabs (+ unsaved keys) so others can dedup / skip them.
  useEffect(() => {
    if (!ready) return;
    window.arcenApi.registerWindowTabs(tabs.map((t) => ({ rootPath: t.rootPath, relPath: t.relPath, name: t.name })), activeTabIndex, [...dirtyKeys]);
  }, [tabs, activeTabIndex, ready, dirtyKeys]);

  // A replace-on-disk touched an open doc; reload it if we have no unsaved edits.
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

  // Another window asked us to surface a document we already have open.
  useEffect(() => {
    window.arcenApi.onFocusDoc((payload) => {
      if (!payload) return;
      const key = `${payload.rootPath}|${payload.relPath}`;
      const idx = tabsRef.current.findIndex((t) => t.rootPath === payload.rootPath && t.relPath === payload.relPath);
      if (idx >= 0) { setActiveTabIndex(idx); window.arcenApi.saveSession({ activeTab: idx }); }
      if (payload.mode) setMode(key, payload.mode);
      if (payload.line) setPendingGoto({ key, line: payload.line, seq: Date.now() });
    });
  }, [setMode]);

  // OS file association: open (or focus) a tab for an .md file the OS handed us.
  // Gated on `ready` so session-restore has already populated the tabs — that way
  // openFile's dedup focuses an existing tab instead of opening a duplicate. We
  // also drain any files the main process queued before this renderer existed
  // (the cold-launch case, where the OS started AMM *with* the file).
  useEffect(() => {
    if (!ready) return;
    window.arcenApi.onOpenExternalFile((ref) => {
      if (ref && ref.rootPath && ref.relPath) openFile(ref.rootPath, ref.relPath, ref.name);
    });
    const takeFn = window.arcenApi.takePendingExternalFiles;
    if (takeFn) {
      takeFn().then((list) => {
        (list || []).forEach((ref) => { if (ref && ref.rootPath && ref.relPath) openFile(ref.rootPath, ref.relPath, ref.name); });
      }).catch(() => {});
    }
  }, [ready, openFile]);

  useEffect(() => { activeDocRef.current = activeDoc; }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load content for the active document (cached across switches; freed on close).
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

  // Ctrl/Cmd+S saves the active document.
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
      const key = nav.list[p];
      const idx = tabsRef.current.findIndex((t) => `${t.rootPath}|${t.relPath}` === key);
      if (idx >= 0) {
        nav.pos = p;
        navSkipRef.current = true;
        setActiveTabIndex(idx);
        window.arcenApi.saveSession({ activeTab: idx });
        setNavState({ canBack: p > 0, canForward: p < nav.list.length - 1 });
        return;
      }
      nav.list.splice(p, 1);
      if (nav.pos > p) nav.pos--;
      p--;
    }
  }, []);

  const navigateForward = useCallback(() => {
    const nav = navRef.current;
    if (nav.pos >= nav.list.length - 1) return;
    let p = nav.pos + 1;
    while (p < nav.list.length) {
      const key = nav.list[p];
      const idx = tabsRef.current.findIndex((t) => `${t.rootPath}|${t.relPath}` === key);
      if (idx >= 0) {
        nav.pos = p;
        navSkipRef.current = true;
        setActiveTabIndex(idx);
        window.arcenApi.saveSession({ activeTab: idx });
        setNavState({ canBack: p > 0, canForward: p < nav.list.length - 1 });
        return;
      }
      nav.list.splice(p, 1);
    }
    // No live forward target remained (entries were spliced out) — resync so the
    // forward button doesn't stay stale-enabled.
    setNavState({ canBack: nav.pos > 0, canForward: nav.pos < nav.list.length - 1 });
  }, []);

  // Mouse thumb buttons 4/5 → back/forward (button index 3/4 on mouseup).
  useEffect(() => {
    const handler = (e) => {
      if (e.button === 3) { e.preventDefault(); navigateBack(); }
      else if (e.button === 4) { e.preventDefault(); navigateForward(); }
    };
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
  }, [navigateBack, navigateForward]);

  // Ctrl/Cmd+E toggles the active document between Read and Source.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
        const key = activeKeyRef.current;
        if (!key) return;
        e.preventDefault();
        const cur = docModesRef.current[key] || 'read';
        setMode(key, cur === 'source' ? 'read' : 'source');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setMode]);

  // Search hotkeys: Ctrl/Cmd+Shift+F = all folders; Ctrl/Cmd+F in Read mode =
  // current file (in Source mode, CodeMirror's own find handles Ctrl+F).
  useEffect(() => {
    const onKey = (e) => {
      const isF = (e.key === 'f' || e.key === 'F');
      if (!isF || !(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey) {
        e.preventDefault();
        openSearch('all');
      } else {
        const key = activeKeyRef.current;
        const m = key ? (docModesRef.current[key] || 'read') : 'read';
        if (key && m === 'read') { e.preventDefault(); openSearch('current-file'); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);

  // Ctrl/Cmd+G → Go To Line (active document only).
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'g' || e.key === 'G')) {
        if (!activeKeyRef.current) return;
        e.preventDefault();
        setGotoLineOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // F1 toggles the keyboard-shortcut help.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'F1') { e.preventDefault(); setHelpOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Drag .md files from the OS onto the window to open them (open-or-focus). Only
  // engages for external file drags; the app's own drags use a mouse-based system.
  useEffect(() => {
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    const onDragOver = (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } };
    const onDrop = (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      const refs = [];
      for (const f of e.dataTransfer.files) {
        const p = window.arcenApi.getPathForFile ? window.arcenApi.getPathForFile(f) : '';
        if (p && /\.md$/i.test(p)) refs.push(refForAbs(p));
      }
      refs.forEach((r) => { if (r.rootPath && r.relPath) openFile(r.rootPath, r.relPath, r.name); });
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => { window.removeEventListener('dragover', onDragOver); window.removeEventListener('drop', onDrop); };
  }, [openFile, refForAbs]);

  // Ctrl/Cmd+H → find & replace. Read mode opens the global panel (current file)
  // with replace shown; Source mode is handled by CodeMirror's own panel (Mod-h).
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      if (e.key !== 'h' && e.key !== 'H') return;
      const key = activeKeyRef.current;
      const m = key ? (docModesRef.current[key] || 'read') : 'read';
      if (key && m === 'read') {
        e.preventDefault();
        openSearch('current-file', null, { replace: true });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openSearch]);

  // Tab accelerators: Ctrl/Cmd+W closes the active tab; Ctrl/Cmd+Tab and
  // Ctrl/Cmd+Shift+Tab cycle through the open tabs.
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

  // Search requests forwarded from detached windows (which carry their own doc).
  useEffect(() => {
    window.arcenApi.onOpenGlobalSearch((payload) => {
      if (!payload) return;
      openSearch(payload.scope || 'all', payload.doc || null);
    });
  }, [openSearch]);

  if (!ready) return <div className="app-root" />;

  const activeNickname = activeDoc ? (roots.find((r) => r.path === activeDoc.rootPath)?.nickname || '') : '';
  const statusLabel = activeDoc ? `${activeNickname}/${activeDoc.relPath}` : null;
  const gotoLine = pendingGoto && pendingGoto.key === activeKey ? pendingGoto.line : null;
  const gotoSeq = pendingGoto ? pendingGoto.seq : 0;

  return (
    <div className="app-root">
      <TitleBar
        mode={mode}
        navState={navState}
        onBack={navigateBack}
        onForward={navigateForward}
        activeFileName={activeDoc ? activeDoc.name : null}
      />
      <div className="app-container" style={{ flexDirection: sidebarSide === 'right' ? 'row-reverse' : 'row' }}>
        <div className="sidebar" style={{ width: sidebarWidth }}>
          <Sidebar
            tab={sidebarTab}
            onSetTab={changeSidebarTab}
            roots={roots}
            theme={theme}
            trees={trees}
            showDocx={showDocx}
            onToggleDocx={toggleDocx}
            onTreeRefresh={refreshTree}
            expandedRoots={expandedRoots}
            expandedFolders={expandedFolders}
            activeKey={activeKey}
            favorites={favorites}
            activeFile={activeDoc ? { rootPath: activeDoc.rootPath, relPath: activeDoc.relPath, name: activeDoc.name } : null}
            revealTarget={revealTarget}
            onToggleRoot={toggleRoot}
            onToggleFolder={toggleFolder}
            onAddRoot={addRoot}
            onRemoveRoot={removeRoot}
            onRenameRoot={renameRoot}
            onReorderRoots={reorderRoots}
            onOpenFile={openFile}
            onFavoritesChange={updateFavorites}
            onEnsureTrees={ensureAllTrees}
            onPathRenamed={onPathRenamed}
            onPathDeleted={onPathDeleted}
            onPathMoved={onPathMoved}
          />
        </div>
        <div className="sidebar-resize-handle" onMouseDown={handleSidebarDragStart} />
        <div className="main-area">
          <TabBar tabs={tabs} activeIndex={activeTabIndex} dirtyKeys={dirtyKeys} onActivate={activateTab} onClose={closeTab} onContextMenu={handleTabContextMenu} onReorder={reorderTabs} onDetach={detachTab} />
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
              savedText={docs[activeKey] ? docs[activeKey].saved : undefined}
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
              search={searchOpen ? activeSearch : null}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-title">AMM Viewer</div>
              <div>Select a document in the sidebar to view it.</div>
            </div>
          )}
          {searchOpen && (
            <GlobalSearch
              initial={searchInit}
              roots={roots}
              currentDoc={searchCurrentDoc || (activeDoc ? { rootPath: activeDoc.rootPath, relPath: activeDoc.relPath } : null)}
              height={globalSearchHeight}
              onResize={onResizeSearch}
              onClose={() => setSearchOpen(false)}
              onOpenResult={openResult}
              onActiveQuery={setActiveSearch}
            />
          )}
          <StatusBar
            theme={theme}
            onToggleTheme={toggleTheme}
            sidebarSide={sidebarSide}
            onToggleSidebarSide={toggleSidebarSide}
            activeFile={statusLabel}
            stats={docStats}
            onShowHelp={() => setHelpOpen(true)}
          />
        </div>
      </div>
      {tabMenu && <ContextMenu x={tabMenu.x} y={tabMenu.y} items={tabMenu.items} onClose={() => setTabMenu(null)} />}
      {gotoLineOpen && activeDoc && <GoToLineDialog onGo={gotoLineInActive} onClose={() => setGotoLineOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
