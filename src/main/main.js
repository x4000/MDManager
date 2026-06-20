// AMM Viewer — main process.
//
// Milestone 1 scope: frameless window chassis, central Arcen settings +
// session persistence, seeded roots, and the minimal IPC the renderer needs
// for theming / sidebar / roots. Tree walking, watching, detached windows,
// search, and markdown rendering arrive in later milestones.

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

// ── Central settings location ────────────────────────────────────────
// Mirrors AXE's `%APPDATA%/ArcenSettings/<App>/` convention so all Arcen
// tools cluster their config together. Cross-platform via getPath('appData').
function getSettingsDir() {
  try {
    return path.join(app.getPath('appData'), 'ArcenSettings', 'MDManager');
  } catch (_) {
    return null;
  }
}
function settingsFile() {
  const d = getSettingsDir();
  return d ? path.join(d, 'settings.json') : null;
}
function sessionFile() {
  const d = getSettingsDir();
  return d ? path.join(d, 'session.json') : null;
}

function ensureSettingsDir() {
  const d = getSettingsDir();
  if (d && !fs.existsSync(d)) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* ignore */ }
  }
}

// First-run seed roots. Each root is just a folder + a human nickname (the
// real folder is usually `docs`/`doc`, so the nickname carries the identity).
const DEFAULT_ROOTS = [
  { path: 'D:\\vclarge\\ArcenCentral\\docs', nickname: 'ArcenCentral' },
  { path: 'D:\\vclarge\\AI_War_2_Ultra\\docs', nickname: 'AIW2' },
  { path: 'D:\\vclarge\\Aisling\\doc', nickname: 'Aisling' },
  { path: 'D:\\vclarge\\HotMRoot\\docs', nickname: 'HotM' },
  { path: 'C:\\Users\\chris\\Documents\\Griffin', nickname: 'Griffin' },
];

const DEFAULT_SETTINGS = {
  roots: DEFAULT_ROOTS,
  theme: 'light',
  sidebarSide: 'left',
  sidebarWidth: 260,
};

// Rename an unparseable file aside instead of letting it be silently
// discarded/overwritten, so the user's data is recoverable.
function backupCorrupt(file) {
  try {
    if (file && fs.existsSync(file)) {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}.bak`);
    }
  } catch (_) { /* ignore */ }
}

function readJson(file, fallback) {
  if (!file || !fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (_) {
    backupCorrupt(file);
    return fallback;
  }
}

function writeJson(file, obj) {
  if (!file) return;
  ensureSettingsDir();
  try {
    // Atomic write (temp file + rename): a crash mid-write leaves the previous
    // good file intact. A partial direct write was the original source of the
    // corrupt-settings → silent-reseed cycle.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (_) { /* ignore */ }
}

// Load settings, applying defaults for any missing key. On true first run
// (no file at all) we write the seeded defaults so the roots are visible.
function loadSettings() {
  const file = settingsFile();
  const existed = file && fs.existsSync(file);
  const raw = readJson(file, null);
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (!Array.isArray(merged.roots)) merged.roots = DEFAULT_ROOTS.slice();
  // Write seeded defaults on true first run, or after a corrupt file was backed
  // up (readJson renamed it aside, so raw is null with no good file left), so a
  // valid settings file always exists rather than being silently reseeded only
  // on the next save.
  if (!existed || raw === null) writeJson(file, merged);
  return merged;
}

function saveSettings(patch) {
  const current = loadSettings();
  const merged = { ...current, ...(patch || {}) };
  writeJson(settingsFile(), merged);
  return merged;
}

function loadSession() {
  return readJson(sessionFile(), {});
}

function saveSession(patch) {
  const current = loadSession();
  const merged = { ...current, ...(patch || {}) };
  writeJson(sessionFile(), merged);
  return merged;
}

// ── Recursive .md tree walk ──────────────────────────────────────────
// Returns { dirs:[{ name, relPath, dirs, files }], files:[{ name, relPath }] }.
// relPath is forward-slashed, relative to the root. Dirs that contain no .md
// anywhere beneath them are pruned, so the sidebar only shows useful folders.
const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.vs', 'bin', 'obj', 'dist']);

// Dirs we never descend into: known build/dep output, plus macOS .app bundles
// (whose internal symlinks/frameworks throw EPERM when statted on Windows).
function isIgnoredDirName(name) {
  return IGNORE_DIRS.has(name) || name.toLowerCase().endsWith('.app');
}

function buildTree(absRoot) {
  const collator = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  // Canonical paths already descended into, so an NTFS junction / symlink that
  // points back at an ancestor can't drive unbounded recursion.
  const visited = new Set();
  function walk(absDir, relPrefix) {
    let real;
    try { real = fs.realpathSync.native(absDir).toLowerCase(); } catch (_) { real = absDir.toLowerCase(); }
    if (visited.has(real)) return { dirs: [], files: [] };
    visited.add(real);
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch (_) { return { dirs: [], files: [] }; }
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isIgnoredDirName(e.name)) continue;
        const child = walk(path.join(absDir, e.name), rel);
        if (child.dirs.length || child.files.length) {
          dirs.push({ name: e.name, relPath: rel, dirs: child.dirs, files: child.files });
        }
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        files.push({ name: e.name, relPath: rel });
      }
    }
    dirs.sort(collator);
    files.sort(collator);
    return { dirs, files };
  }
  return walk(absRoot, '');
}

function buildSearchRegex(query, opts) {
  let src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) src = `\\b${src}\\b`;
  return new RegExp(src, opts.caseSensitive ? 'g' : 'gi');
}

// ── Search file walk ─────────────────────────────────────────────────
// Async recursive walk for .md files under a root. No caching: cold search is
// fast enough (parallel reads) that holding contents in memory isn't worth it.
async function walkMdAsync(absRoot) {
  const out = [];
  const visited = new Set(); // canonical dirs, to break junction/symlink cycles
  async function walk(absDir, rel) {
    let real;
    try { real = (await fs.promises.realpath(absDir)).toLowerCase(); } catch (_) { real = absDir.toLowerCase(); }
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try { entries = await fs.promises.readdir(absDir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isIgnoredDirName(e.name)) continue;
        await walk(path.join(absDir, e.name), r);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push({ relPath: r, abs: path.join(absDir, e.name) });
      }
    }
  }
  await walk(absRoot, '');
  return out;
}

// ── File-tree watcher ────────────────────────────────────────────────
// One recursive watcher across every configured root. On any .md or folder
// add/remove it debounces a `tree-changed` broadcast (carrying the affected
// root path when known) so renderers can refetch just that root's tree.
let watcher = null;
let treeChangeTimer = null;
const pendingTreeRoots = new Set();

function broadcastAll(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

function existingRootPaths() {
  return loadSettings().roots
    .map((r) => r.path)
    .filter((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
}

function flushTreeChanges() {
  const roots = [...pendingTreeRoots];
  pendingTreeRoots.clear();
  for (const r of roots) broadcastAll('tree-changed', r);
}

function setupWatcher() {
  try { if (watcher) { watcher.close(); watcher = null; } } catch (_) { /* ignore */ }
  const paths = existingRootPaths();
  if (!paths.length) return;
  // Normalize to lowercase forward-slashes with no trailing separator so the
  // prefix test can be anchored at a path boundary — otherwise a change under
  // a longer root (…/docs) would match a shorter prefix-sibling root (…/doc).
  const norm = (p) => (p || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  const lowerRoots = paths.map(norm);
  const noteChange = (changedPath) => {
    const lp = norm(changedPath);
    const idx = lowerRoots.findIndex((rp) => lp === rp || lp.startsWith(rp + '/'));
    pendingTreeRoots.add(idx >= 0 ? paths[idx] : null);
    if (treeChangeTimer) clearTimeout(treeChangeTimer);
    treeChangeTimer = setTimeout(flushTreeChanges, 200);
  };
  // Map a changed absolute path back to its (rootPath, relPath). relPath keeps
  // its on-disk casing (sliced from the original, not the lowercased path) so it
  // matches the open tab's key.
  const toDocRef = (changedPath) => {
    const lp = norm(changedPath);
    const idx = lowerRoots.findIndex((rp) => lp === rp || lp.startsWith(rp + '/'));
    if (idx < 0) return null;
    const rootFwd = (paths[idx] || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const relPath = (changedPath || '').replace(/\\/g, '/').slice(rootFwd.length).replace(/^\/+/, '');
    return { rootPath: paths[idx], relPath };
  };
  // An external edit to an open file → tell the windows holding it to reload.
  // The renderer ignores the reload when it has unsaved edits or when the disk
  // content already matches, so this never clobbers edits or bounces our saves.
  const reloadOpenDoc = (changedPath) => {
    if (!changedPath || !changedPath.toLowerCase().endsWith('.md')) return;
    const ref = toDocRef(changedPath);
    if (ref) notifyReload(ref.rootPath, ref.relPath);
  };
  watcher = chokidar.watch(paths, {
    ignored: (p) => {
      const base = path.basename(p);
      if (base.startsWith('.')) return true;
      return isIgnoredDirName(base);
    },
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });
  // 'change' = in-place edit. 'add' = file (re)created — many editors save
  // atomically (write a temp file then rename over the original), which surfaces
  // as add rather than change, so an open doc must reload on both. noteChange
  // additionally refreshes the sidebar tree on add/unlink.
  watcher.on('change', reloadOpenDoc);
  watcher.on('add', (p) => { if (p.toLowerCase().endsWith('.md')) { noteChange(p); reloadOpenDoc(p); } });
  watcher.on('unlink', (p) => { if (p.toLowerCase().endsWith('.md')) noteChange(p); });
  watcher.on('addDir', noteChange);
  watcher.on('unlinkDir', noteChange);
  // A broad root (e.g. a whole repo dir) can surface EPERM/ENOENT on odd files
  // mid-scan. Swallow them here so they don't bubble up as unhandled rejections.
  watcher.on('error', (err) => {
    try { console.warn('[watcher]', err && err.message ? err.message : err); } catch (_) { /* ignore */ }
  });
}

// ── Window ───────────────────────────────────────────────────────────
let mainWindow = null;
let appQuitting = false;
let mainReady = false; // main window's renderer has finished loading
const pendingExternalFiles = []; // OS-association files to open once the renderer is ready

// If saved bounds fall entirely off every connected display (e.g. a monitor was
// unplugged since last run), reset to the primary display so a frameless window
// can't open somewhere the user can't drag it back from.
function ensureBoundsOnScreen(bounds) {
  if (!bounds || bounds.x == null || bounds.y == null) return bounds;
  try {
    const displays = screen.getAllDisplays();
    const visible = displays.some((d) => {
      const b = d.bounds;
      return bounds.x >= b.x - 100 && bounds.x < b.x + b.width &&
             bounds.y >= b.y - 50 && bounds.y < b.y + b.height;
    });
    if (!visible) {
      const primary = screen.getPrimaryDisplay().bounds;
      return { ...bounds, x: primary.x + 100, y: primary.y + 100 };
    }
  } catch (_) { /* screen not ready / no displays — leave bounds as-is */ }
  return bounds;
}

function createMainWindow() {
  const session = loadSession();
  const b = ensureBoundsOnScreen(session.window || {});
  mainWindow = new BrowserWindow({
    x: Number.isInteger(b.x) ? b.x : undefined,
    y: Number.isInteger(b.y) ? b.y : undefined,
    width: Number.isInteger(b.width) ? b.width : 1280,
    height: Number.isInteger(b.height) ? b.height : 820,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, '..', '..', 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (session.windowMaximized) mainWindow.maximize();

  // Persist window bounds on resize/move (debounced) and on close. While
  // maximized, store the *normal* (restore) bounds + a maximized flag, so next
  // launch comes back maximized instead of filling the screen un-maximized.
  let boundsTimer = null;
  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const maximized = mainWindow.isMaximized();
    const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => saveSession({ window: bounds, windowMaximized: maximized }), 250);
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);
  mainWindow.on('close', (e) => {
    // Closing the main window force-closes every detached window too, so confirm
    // first if anything (here or in a detached window) has unsaved edits.
    if (!appQuitting) {
      let dirtyCount = Array.isArray(mainDirty) ? mainDirty.length : 0;
      for (const [, ent] of detachedWindows) {
        if (!ent.win.isDestroyed() && Array.isArray(ent.dirty)) dirtyCount += ent.dirty.length;
      }
      if (dirtyCount > 0) {
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'warning', buttons: ['Discard & Close', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
          title: 'Unsaved changes',
          message: `${dirtyCount} open document${dirtyCount !== 1 ? 's have' : ' has'} unsaved changes that will be lost. Close anyway?`,
        });
        if (choice !== 0) { e.preventDefault(); return; }
      }
    }
    appQuitting = true;
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
      const maximized = mainWindow.isMaximized();
      saveSession({ window: maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds(), windowMaximized: maximized });
    }
    // Keep the current detached set in the session, then close them with the
    // main window so the app exits cleanly (they're restored next launch).
    persistDetached();
    for (const [, ent] of detachedWindows) {
      try { if (!ent.win.isDestroyed()) ent.win.close(); } catch (_) { /* ignore */ }
    }
  });
  mainWindow.webContents.on('did-finish-load', () => { mainReady = true; });
  mainWindow.on('closed', () => { mainWindow = null; mainReady = false; });
}

// ── Detached windows ─────────────────────────────────────────────────
// Each holds its own set of document tabs. They name themselves after their
// content, persist across restarts, and sync theme/scale with every window.
const detachedWindows = new Map(); // windowId -> { win, tabs, activeTab, displayNum }
let detachedCounter = 0;
let restoringDetached = false;
let mainTabs = []; // the main window's open tabs, for cross-window dedup
let mainDirty = []; // the main window's unsaved doc keys
let lastReplaceSnapshot = null; // [{ abs, rootPath, relPath, oldContent }] for one undo

function persistDetached() {
  if (restoringDetached) return;
  // Persist tab identity only — a tear-off may briefly carry an unsaved buffer
  // in ent.tabs for the new window to seed from, and that text must never reach
  // session.json.
  const strip = (t) => ({ rootPath: t.rootPath, relPath: t.relPath, name: t.name });
  const list = [];
  for (const [, e] of detachedWindows) {
    if (e.win.isDestroyed()) continue;
    list.push({ tabs: (e.tabs || []).map(strip), activeTab: e.activeTab, bounds: e.win.getBounds() });
  }
  saveSession({ detachedWindows: list });
}

function renumberDetached() {
  let i = 0;
  for (const [, e] of detachedWindows) {
    if (e.win.isDestroyed()) continue;
    e.displayNum = ++i;
    try { e.win.webContents.send('detached-display-num', i); } catch (_) { /* ignore */ }
  }
}

function createDetachedWindow(windowId, tabs, bounds) {
  const b = ensureBoundsOnScreen(bounds || {});
  const win = new BrowserWindow({
    x: Number.isInteger(b.x) ? b.x : undefined,
    y: Number.isInteger(b.y) ? b.y : undefined,
    width: Number.isInteger(b.width) ? b.width : 900,
    height: Number.isInteger(b.height) ? b.height : 700,
    minWidth: 480,
    minHeight: 360,
    frame: false,
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, '..', '..', 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { mode: 'detached', windowId } });
  detachedWindows.set(windowId, { win, tabs: tabs || [], activeTab: 0 });

  let bt = null;
  const pb = () => { if (win.isDestroyed() || win.isMinimized()) return; if (bt) clearTimeout(bt); bt = setTimeout(persistDetached, 250); };
  win.on('resize', pb);
  win.on('move', pb);
  win.on('close', (e) => {
    // Confirm before discarding this window's unsaved edits when the user closes
    // it directly. (When the main window is force-closing us on quit, appQuitting
    // is set and it has already confirmed for everything.)
    if (appQuitting) return;
    const ent = detachedWindows.get(windowId);
    const n = ent && Array.isArray(ent.dirty) ? ent.dirty.length : 0;
    if (n > 0) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['Discard & Close', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
        title: 'Unsaved changes',
        message: `${n} document${n !== 1 ? 's have' : ' has'} unsaved changes that will be lost. Close anyway?`,
      });
      if (choice !== 0) { e.preventDefault(); }
    }
  });
  win.on('closed', () => {
    detachedWindows.delete(windowId);
    if (!appQuitting) { renumberDetached(); persistDetached(); }
  });
  renumberDetached();
  persistDetached();
  return win;
}

function pointInWindow(win, x, y) {
  if (!win || win.isDestroyed() || win.isMinimized()) return false;
  const b = win.getBounds();
  // Half-open so two windows sharing an edge don't both claim the boundary pixel.
  return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height;
}

function findWindowAt(x, y) {
  // First (registry-order) window whose bounds contain the point: detached
  // windows before the main window (the common tear-off target). Electron
  // doesn't expose true OS z-order, so overlapping windows fall back to this
  // order rather than guessing — but pointInWindow now uses half-open bounds and
  // skips minimized/destroyed windows, which fixes the concrete mis-routes
  // (shared-edge double-claim, minimized windows stealing the drop). We avoid a
  // focused-window preference here: during a tear-off drag the SOURCE window is
  // the focused one, so preferring it would mis-route a drop back to the source.
  for (const [id, e] of detachedWindows) {
    if (pointInWindow(e.win, x, y)) return { kind: 'detached', id, entry: e };
  }
  if (mainWindow && pointInWindow(mainWindow, x, y)) return { kind: 'main' };
  return null;
}

function restoreDetachedWindows() {
  const session = loadSession();
  const list = Array.isArray(session.detachedWindows) ? session.detachedWindows : [];
  if (!list.length) return;
  restoringDetached = true;
  for (const dw of list) {
    if (!dw.tabs || !dw.tabs.length) continue;
    const id = 'det_' + (++detachedCounter);
    createDetachedWindow(id, dw.tabs, dw.bounds);
    const ent = detachedWindows.get(id);
    if (ent) ent.activeTab = Number.isInteger(dw.activeTab) ? dw.activeTab : 0;
  }
  restoringDetached = false;
  renumberDetached();
  persistDetached();
}

// Drop a dragged-out tab: onto another detached window → add there; onto the
// main window → open it there; over empty space → new detached window.
ipcMain.handle('detach-tab-at-position', (e, tab, x, y) => {
  if (!tab || !tab.rootPath || !tab.relPath) return;
  // Synchronously drop the moved tab from the SOURCE window's registry so a
  // concurrent request-open-doc can't focus a window that no longer holds it
  // (the source renderer's own re-registration lags by a frame).
  const sender = e.sender;
  const isMoved = (t) => t.rootPath === tab.rootPath && t.relPath === tab.relPath;
  if (mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents) {
    mainTabs = mainTabs.filter((t) => !isMoved(t));
  } else {
    for (const [, ent] of detachedWindows) {
      if (!ent.win.isDestroyed() && ent.win.webContents === sender) { ent.tabs = ent.tabs.filter((t) => !isMoved(t)); break; }
    }
  }
  const target = findWindowAt(Math.round(x), Math.round(y));
  if (target && target.kind === 'detached') {
    const ent = target.entry;
    // Registry holds identity only; the full tab (with any unsaved buffer) goes
    // to the renderer via tab-added so the move is lossless.
    if (!ent.tabs.some((t) => t.rootPath === tab.rootPath && t.relPath === tab.relPath)) {
      ent.tabs.push({ rootPath: tab.rootPath, relPath: tab.relPath, name: tab.name });
    }
    try { ent.win.webContents.send('tab-added', tab); ent.win.focus(); } catch (_) { /* ignore */ }
    persistDetached();
    return;
  }
  if (target && target.kind === 'main') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('open-file', tab); mainWindow.focus(); } catch (_) { /* ignore */ }
    }
    return;
  }
  const id = 'det_' + (++detachedCounter);
  createDetachedWindow(id, [tab], { x: Math.round(x - 120), y: Math.round(y - 20), width: 900, height: 700 });
});

ipcMain.handle('get-detached-session', (e) => {
  for (const [, ent] of detachedWindows) {
    if (ent.win.webContents === e.sender) return { tabs: ent.tabs, activeTab: ent.activeTab };
  }
  return { tabs: [], activeTab: 0 };
});

ipcMain.handle('get-detached-display-num', (e) => {
  for (const [, ent] of detachedWindows) {
    if (ent.win.webContents === e.sender) return ent.displayNum || null;
  }
  return null;
});

ipcMain.on('register-window-tabs', (e, tabs, activeTab, dirty) => {
  if (mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents) {
    mainTabs = Array.isArray(tabs) ? tabs : [];
    mainDirty = Array.isArray(dirty) ? dirty : [];
    return;
  }
  for (const [, ent] of detachedWindows) {
    if (ent.win.webContents === e.sender) {
      ent.tabs = Array.isArray(tabs) ? tabs : [];
      ent.activeTab = Number.isInteger(activeTab) ? activeTab : 0;
      ent.dirty = Array.isArray(dirty) ? dirty : [];
      persistDetached();
      return;
    }
  }
});

// If a document is already open in ANOTHER window, focus that window + tab (and
// jump to a line) instead of opening a duplicate. Returns { handled } so the
// requester opens locally only when it isn't open anywhere else.
function focusDocInWindow(win, payload) {
  try {
    if (win.isMinimized()) win.restore();
    win.webContents.send('focus-doc', payload);
    win.focus();
  } catch (_) { /* ignore */ }
}
ipcMain.handle('request-open-doc', (e, payload) => {
  if (!payload || !payload.rootPath || !payload.relPath) return { handled: false };
  const sender = e.sender;
  const matches = (t) => t.rootPath === payload.rootPath && t.relPath === payload.relPath;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents !== sender && mainTabs.some(matches)) {
    focusDocInWindow(mainWindow, payload);
    return { handled: true };
  }
  for (const [, ent] of detachedWindows) {
    if (ent.win.isDestroyed() || ent.win.webContents === sender) continue;
    if (ent.tabs.some(matches)) { focusDocInWindow(ent.win, payload); return { handled: true }; }
  }
  return { handled: false };
});

// ── IPC: window controls ─────────────────────────────────────────────
ipcMain.handle('window-minimize', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize();
});
ipcMain.handle('window-maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
});
ipcMain.handle('window-close', (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});

// ── IPC: settings / session ──────────────────────────────────────────
ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('save-settings', (_e, patch) => saveSettings(patch));
ipcMain.handle('get-session', () => loadSession());
ipcMain.handle('save-session', (_e, patch) => saveSession(patch));

// ── IPC: roots ───────────────────────────────────────────────────────
function normPath(p) { return (p || '').replace(/[\\/]+$/, ''); }

ipcMain.handle('add-root', async (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(w, {
    title: 'Add a folder of Markdown documents',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) {
    return loadSettings().roots;
  }
  const dir = res.filePaths[0];
  const settings = loadSettings();
  const roots = settings.roots.slice();
  if (!roots.some((r) => normPath(r.path).toLowerCase() === normPath(dir).toLowerCase())) {
    roots.push({ path: dir, nickname: path.basename(dir) || dir });
  }
  saveSettings({ roots });
  setupWatcher();
  return roots;
});

ipcMain.handle('remove-root', (_e, rootPath) => {
  const settings = loadSettings();
  const roots = settings.roots.filter(
    (r) => normPath(r.path).toLowerCase() !== normPath(rootPath).toLowerCase()
  );
  saveSettings({ roots });
  setupWatcher();
  return roots;
});

// Persist a new root order (the renderer hands us the desired path order).
// Robust to missing/extra entries: known paths are placed in the given order,
// any unmentioned roots keep their relative order at the end.
ipcMain.handle('reorder-roots', (_e, orderedPaths) => {
  const settings = loadSettings();
  const cur = Array.isArray(settings.roots) ? settings.roots : [];
  const byKey = new Map(cur.map((r) => [normPath(r.path).toLowerCase(), r]));
  const seen = new Set();
  const next = [];
  for (const p of (Array.isArray(orderedPaths) ? orderedPaths : [])) {
    const key = normPath(p).toLowerCase();
    const r = byKey.get(key);
    if (r && !seen.has(key)) { next.push(r); seen.add(key); }
  }
  for (const r of cur) {
    const key = normPath(r.path).toLowerCase();
    if (!seen.has(key)) { next.push(r); seen.add(key); }
  }
  saveSettings({ roots: next });
  return next;
});

ipcMain.handle('set-root-nickname', (_e, rootPath, nickname) => {
  const settings = loadSettings();
  const roots = settings.roots.map((r) =>
    normPath(r.path).toLowerCase() === normPath(rootPath).toLowerCase()
      ? { ...r, nickname: (nickname || '').trim() || path.basename(r.path) }
      : r
  );
  saveSettings({ roots });
  return roots;
});

// ── IPC: file tree ───────────────────────────────────────────────────
ipcMain.handle('list-tree', (_e, rootPath) => {
  try {
    if (!rootPath || !fs.existsSync(rootPath)) return { ok: false, error: 'not-found' };
    return { ok: true, tree: buildTree(rootPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: global search across roots (find-only) ──────────────────────
const SEARCH_MAX_MATCHES = 2000;
const SEARCH_MAX_PER_FILE = 50;

async function collectSearchFiles(o) {
  if (o.scope === 'current-file' && o.currentRoot && o.currentRel) {
    return [{ rootPath: o.currentRoot, relPath: o.currentRel, abs: path.join(o.currentRoot, o.currentRel) }];
  }
  let roots = loadSettings().roots;
  if (o.scope === 'current-root' && o.currentRoot) roots = roots.filter((r) => r.path === o.currentRoot);
  const existing = roots.filter((r) => { try { return fs.existsSync(r.path); } catch (_) { return false; } });
  const lists = await Promise.all(existing.map((r) =>
    walkMdAsync(r.path).then((list) => list.map((f) => ({ rootPath: r.path, relPath: f.relPath, abs: f.abs })))
  ));
  return lists.flat();
}

ipcMain.handle('search-all', async (_e, opts) => {
  const o = opts || {};
  if (!o.query) return { results: [], fileCount: 0, matchCount: 0, truncated: false };
  let re;
  try { re = buildSearchRegex(o.query, o); }
  catch (err) { return { error: 'Invalid pattern: ' + err.message, results: [], fileCount: 0, matchCount: 0, truncated: false }; }

  const files = await collectSearchFiles(o);

  const results = [];
  let matchCount = 0;
  let truncated = false;
  let idx = 0;
  const CONCURRENCY = 24;
  // The per-file match loop is synchronous, so workers only interleave at the
  // read await — sharing `re` is safe.
  async function worker() {
    while (idx < files.length && matchCount < SEARCH_MAX_MATCHES) {
      const f = files[idx++];
      let content;
      try { content = await fs.promises.readFile(f.abs, 'utf-8'); } catch (_) { continue; }
      const lines = content.split(/\r\n?|\n/);
      const fileMatches = [];
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          fileMatches.push({ line: i + 1, text: lines[i].trim().slice(0, 400) });
          if (fileMatches.length >= SEARCH_MAX_PER_FILE) break;
        }
      }
      if (fileMatches.length) {
        results.push({ rootPath: f.rootPath, relPath: f.relPath, matches: fileMatches });
        matchCount += fileMatches.length;
        if (matchCount >= SEARCH_MAX_MATCHES) truncated = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length || 1) }, () => worker()));
  results.sort((a, b) => (a.rootPath === b.rootPath ? a.relPath.localeCompare(b.relPath) : a.rootPath.localeCompare(b.rootPath)));
  return { results, fileCount: results.length, matchCount, truncated };
});

// ── IPC: replace-to-disk ─────────────────────────────────────────────
function allDirtyKeys() {
  const s = new Set(mainDirty || []);
  for (const [, ent] of detachedWindows) for (const k of (ent.dirty || [])) s.add(k);
  return s;
}
function notifyReload(rootPath, relPath) {
  const has = (tabs) => Array.isArray(tabs) && tabs.some((t) => t.rootPath === rootPath && t.relPath === relPath);
  if (mainWindow && !mainWindow.isDestroyed() && has(mainTabs)) {
    try { mainWindow.webContents.send('reload-doc', { rootPath, relPath }); } catch (_) { /* ignore */ }
  }
  for (const [, ent] of detachedWindows) {
    if (!ent.win.isDestroyed() && has(ent.tabs)) { try { ent.win.webContents.send('reload-doc', { rootPath, relPath }); } catch (_) { /* ignore */ } }
  }
}
function buildReplacement(o) {
  // In regex mode allow $1 backrefs; otherwise treat the replacement literally.
  const r = o.replace || '';
  return o.regex ? r : r.replace(/\$/g, '$$$$');
}
// True if the pattern can match the empty string (e.g. `a*`, `x?`, `(foo)?`).
// A global replace of such a pattern splices the replacement between every
// character and corrupts the whole file, while still reporting "matches" — so
// we refuse it rather than relying on the match/diff checks it slips past.
function matchesEmpty(re) {
  try { return new RegExp(re.source, re.flags.replace('g', '')).test(''); }
  catch (_) { return false; }
}
async function performReplace(files, re, replacement) {
  if (matchesEmpty(re)) {
    return { error: 'Pattern can match an empty string — refusing to replace (it would corrupt files).', filesChanged: 0, replacements: 0, skippedDirty: 0, canUndo: false };
  }
  const dirty = allDirtyKeys();
  const snapshot = [];
  let filesChanged = 0;
  let replacements = 0;
  let skippedDirty = 0;
  for (const f of files) {
    if (dirty.has(`${f.rootPath}|${f.relPath}`)) { skippedDirty++; continue; }
    let content;
    try { content = await fs.promises.readFile(f.abs, 'utf-8'); } catch (_) { continue; }
    re.lastIndex = 0;
    const matches = content.match(re);
    if (!matches || !matches.length) continue;
    const next = content.replace(re, replacement);
    if (next === content) continue;
    snapshot.push({ abs: f.abs, rootPath: f.rootPath, relPath: f.relPath, oldContent: content });
    try { await fs.promises.writeFile(f.abs, next, 'utf-8'); }
    catch (_) { snapshot.pop(); continue; }
    filesChanged++;
    replacements += matches.length;
    notifyReload(f.rootPath, f.relPath);
  }
  lastReplaceSnapshot = snapshot.length ? snapshot : null;
  return { filesChanged, replacements, skippedDirty, canUndo: !!lastReplaceSnapshot };
}

ipcMain.handle('replace-all', async (_e, opts) => {
  const o = opts || {};
  if (!o.query) return { filesChanged: 0, replacements: 0, skippedDirty: 0, canUndo: false };
  let re; try { re = buildSearchRegex(o.query, o); } catch (err) { return { error: 'Invalid pattern: ' + err.message }; }
  const files = await collectSearchFiles(o);
  return performReplace(files, re, buildReplacement(o));
});

ipcMain.handle('replace-in-file', async (_e, opts, rootPath, relPath) => {
  const o = opts || {};
  if (!o.query || !rootPath || !relPath) return { filesChanged: 0, replacements: 0, skippedDirty: 0, canUndo: false };
  let re; try { re = buildSearchRegex(o.query, o); } catch (err) { return { error: 'Invalid pattern: ' + err.message }; }
  return performReplace([{ rootPath, relPath, abs: path.join(rootPath, relPath) }], re, buildReplacement(o));
});

ipcMain.handle('undo-replace', async () => {
  if (!lastReplaceSnapshot) return { ok: false, files: 0 };
  let n = 0;
  for (const s of lastReplaceSnapshot) {
    try { await fs.promises.writeFile(s.abs, s.oldContent, 'utf-8'); notifyReload(s.rootPath, s.relPath); n++; } catch (_) { /* ignore */ }
  }
  lastReplaceSnapshot = null;
  return { ok: true, files: n };
});

// ── IPC: wiki-links + backlinks ──────────────────────────────────────
function existingRoots() {
  return loadSettings().roots.filter((r) => { try { return fs.existsSync(r.path); } catch (_) { return false; } });
}
function wikiBasename(relPath) {
  return relPath.split('/').pop().replace(/\.md$/i, '');
}

// Resolve [[name]] to a document. A name with a slash matches by relative path;
// otherwise by filename (both case-insensitive, .md optional).
ipcMain.handle('resolve-wiki', async (_e, name) => {
  if (!name) return null;
  const target = String(name).replace(/\.md$/i, '').trim().toLowerCase();
  if (!target) return null;
  const hasSlash = target.includes('/');
  for (const r of existingRoots()) {
    const files = await walkMdAsync(r.path);
    for (const f of files) {
      if (hasSlash) {
        const rel = f.relPath.replace(/\.md$/i, '').toLowerCase();
        if (rel === target || rel.endsWith('/' + target)) return { rootPath: r.path, relPath: f.relPath, name: f.relPath.split('/').pop() };
      } else if (wikiBasename(f.relPath).toLowerCase() === target) {
        return { rootPath: r.path, relPath: f.relPath, name: f.relPath.split('/').pop() };
      }
    }
  }
  return null;
});

// Documents that contain a [[name]] (optionally path-qualified or aliased)
// referring to the given name. Content scan, parallelized, capped.
ipcMain.handle('get-backlinks', async (_e, name, source) => {
  const base = String(name || '').replace(/\.md$/i, '').trim();
  if (!base) return [];
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\[\\[\\s*(?:[^\\]\\n|]*\\/)?' + esc + '\\s*(?:\\|[^\\]\\n]*)?\\]\\]', 'i');
  // The source document itself can contain a self-[[link]]; exclude it so it
  // doesn't list itself as a backlink (and inflate the count).
  const srcRoot = source && source.rootPath;
  const srcRel = source && source.relPath;
  const out = [];
  let count = 0;
  for (const r of existingRoots()) {
    const files = await walkMdAsync(r.path);
    let idx = 0;
    const worker = async () => {
      while (idx < files.length && count < 500) {
        const f = files[idx++];
        if (r.path === srcRoot && f.relPath === srcRel) continue;
        let content;
        try { content = await fs.promises.readFile(f.abs, 'utf-8'); } catch (_) { continue; }
        if (re.test(content)) { out.push({ rootPath: r.path, relPath: f.relPath, name: f.relPath.split('/').pop() }); count++; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(24, files.length || 1) }, () => worker()));
  }
  out.sort((a, b) => (a.rootPath === b.rootPath ? a.relPath.localeCompare(b.relPath) : a.rootPath.localeCompare(b.rootPath)));
  return out;
});

// ── IPC: file I/O ────────────────────────────────────────────────────
ipcMain.handle('read-file', async (_e, absPath) => {
  try {
    return fs.readFileSync(absPath, 'utf-8').replace(/\r\n?/g, '\n');
  } catch (err) {
    throw new Error(`Could not read ${absPath}: ${err.message}`);
  }
});

// Detect CRLF by reading only the file's head, so save doesn't synchronously
// read the entire file (O(n) in size) just to sniff the line-ending style.
function fileUsesCrlf(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes('\r\n');
  } catch (_) {
    return false; // new/unreadable file → default to LF
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

ipcMain.handle('write-file', async (_e, absPath, content) => {
  try {
    // Preserve the file's existing line-ending style so saves don't churn CRLF
    // files into LF (and vice versa). New files default to LF.
    const eol = fileUsesCrlf(absPath) ? '\r\n' : '\n';
    fs.writeFileSync(absPath, String(content).replace(/\r\n?|\n/g, eol), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('show-in-folder', (_e, absPath) => {
  try { shell.showItemInFolder(absPath); } catch (_) { /* ignore */ }
});

ipcMain.handle('open-external', (_e, url) => {
  try {
    // Only allow web/mail schemes out to the OS browser; never arbitrary schemes.
    if (/^(https?|mailto):/i.test(url || '')) shell.openExternal(url);
  } catch (_) { /* ignore */ }
});

ipcMain.handle('open-path', (_e, absPath) => {
  try { shell.openPath(absPath); } catch (_) { /* ignore */ }
});

// ── IPC: tree file operations (create / rename / delete) ─────────────
// All confined to a configured root, and deletes go to the Recycle Bin
// (recoverable), never a hard delete.
function sanitizeName(name) {
  const n = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '');
  if (!n || n === '.' || n === '..') return null;
  return n;
}
function isUnderRoot(abs) {
  const norm = (p) => (p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const a = norm(abs);
  return existingRootPaths().some((r) => { const rp = norm(r); return a === rp || a.startsWith(rp + '/'); });
}

ipcMain.handle('create-file', (_e, absDir, name) => {
  try {
    if (!isUnderRoot(absDir)) return { ok: false, error: 'Outside a configured folder' };
    const safe = sanitizeName(name);
    if (!safe) return { ok: false, error: 'Invalid name' };
    const fname = /\.md$/i.test(safe) ? safe : safe + '.md';
    const target = path.join(absDir, fname);
    if (fs.existsSync(target)) return { ok: false, error: 'A file with that name already exists' };
    fs.writeFileSync(target, '', 'utf-8');
    return { ok: true, path: target, name: fname };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('create-folder', (_e, absDir, name) => {
  try {
    if (!isUnderRoot(absDir)) return { ok: false, error: 'Outside a configured folder' };
    const safe = sanitizeName(name);
    if (!safe) return { ok: false, error: 'Invalid name' };
    const target = path.join(absDir, safe);
    if (fs.existsSync(target)) return { ok: false, error: 'A folder with that name already exists' };
    fs.mkdirSync(target);
    return { ok: true, path: target, name: safe };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('rename-path', (_e, absOld, newName, isFile) => {
  try {
    if (!isUnderRoot(absOld)) return { ok: false, error: 'Outside a configured folder' };
    const safe = sanitizeName(newName);
    if (!safe) return { ok: false, error: 'Invalid name' };
    let fname = safe;
    if (isFile && /\.md$/i.test(absOld) && !/\.md$/i.test(fname)) fname += '.md';
    const target = path.join(path.dirname(absOld), fname);
    if (target === absOld) return { ok: true, path: target, name: fname };
    if (fs.existsSync(target) && target.toLowerCase() !== absOld.toLowerCase()) return { ok: false, error: 'A file or folder with that name already exists' };
    fs.renameSync(absOld, target);
    return { ok: true, path: target, name: fname };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Locate an absolute path within the configured roots → { rootPath, relPath }
// (rootPath is the configured root.path so it matches the tree/tab keys).
function locateInRoots(abs) {
  const a = (abs || '').replace(/\\/g, '/');
  for (const r of existingRootPaths()) {
    const rp = r.replace(/\\/g, '/').replace(/\/+$/, '');
    if (a.toLowerCase() === rp.toLowerCase() || a.toLowerCase().startsWith(rp.toLowerCase() + '/')) {
      return { rootPath: r, relPath: a.slice(rp.length + 1) };
    }
  }
  return { rootPath: null, relPath: null };
}

ipcMain.handle('move-path', (_e, absSrc, absDestDir) => {
  try {
    if (!isUnderRoot(absSrc) || !isUnderRoot(absDestDir)) return { ok: false, error: 'Outside a configured folder' };
    let dst;
    try { dst = fs.statSync(absDestDir); } catch (_) { return { ok: false, error: 'Destination folder not found' }; }
    if (!dst.isDirectory()) return { ok: false, error: 'Destination is not a folder' };
    const srcR = path.resolve(absSrc);
    const dstR = path.resolve(absDestDir);
    // No-op (already in this folder), and never move a folder into itself/descendant.
    if (path.dirname(srcR) === dstR) return { ok: false, sameDir: true };
    if (dstR === srcR || dstR.startsWith(srcR + path.sep)) return { ok: false, error: "Can't move a folder into itself" };
    const target = path.join(absDestDir, path.basename(absSrc));
    if (fs.existsSync(target)) return { ok: false, error: 'A file or folder with that name already exists there' };
    try {
      fs.renameSync(absSrc, target);
    } catch (err) {
      if (err.code === 'EXDEV') { // across drives — copy then remove the source
        fs.cpSync(absSrc, target, { recursive: true });
        fs.rmSync(absSrc, { recursive: true, force: true });
      } else { throw err; }
    }
    const loc = locateInRoots(target);
    return { ok: true, path: target, rootPath: loc.rootPath, relPath: loc.relPath };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('delete-path', async (e, absPath) => {
  try {
    if (!isUnderRoot(absPath)) return { ok: false, error: 'Outside a configured folder' };
    const win = BrowserWindow.fromWebContents(e.sender);
    let isDir = false;
    try { isDir = fs.statSync(absPath).isDirectory(); } catch (_) { /* ignore */ }
    const name = path.basename(absPath);
    const message = isDir
      ? `Move the folder "${name}" and everything inside it to the Recycle Bin?`
      : `Move "${name}" to the Recycle Bin?`;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Move to Recycle Bin', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      title: 'Delete', message,
    });
    if (response !== 0) return { ok: false, canceled: true };
    await shell.trashItem(absPath);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Show the native OS shell context menu for a folder (the real Explorer menu,
// incl. shell extensions like TortoiseSVN/TortoiseGit). This is Windows-only and
// needs a native helper that Electron doesn't provide; we resolve `handled`
// truthfully so the renderer falls back to its own cross-platform menu whenever
// the native menu can't be shown (non-Windows, no helper, or any failure).
// Path to the native helper exe once located/built (null until ready or if the
// platform/toolchain can't provide it).
let shellHelperExe = null;

function findCsc() {
  const win = process.env.WINDIR || 'C:\\Windows';
  return [
    path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

// Prepare the native shell-menu helper in the background at startup: prefer a
// prebuilt exe (env/bundled), else compile the bundled AmmShellMenu.cs once with
// the system csc.exe and cache it in the settings dir (rebuilt only if the source
// changes). Any failure just leaves shellHelperExe null → the renderer falls back.
function prepareShellHelper() {
  if (process.platform !== 'win32') return;
  try {
    const prebuilt = [process.env.AMM_SHELL_MENU_HELPER, path.join(process.resourcesPath || '', 'AmmShellMenu.exe')]
      .filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
    if (prebuilt) { shellHelperExe = prebuilt; startWarmHelper(); return; }
    const csc = findCsc();
    if (!csc) return;
    const code = fs.readFileSync(path.join(__dirname, 'AmmShellMenu.cs'), 'utf-8');
    ensureSettingsDir();
    const dir = getSettingsDir();
    const outCs = path.join(dir, 'AmmShellMenu.cs');
    const outExe = path.join(dir, 'AmmShellMenu.exe');
    let sameSrc = false;
    try { sameSrc = fs.existsSync(outCs) && fs.readFileSync(outCs, 'utf-8') === code; } catch (_) { /* ignore */ }
    if (sameSrc && fs.existsSync(outExe)) { shellHelperExe = outExe; startWarmHelper(); return; }
    fs.writeFileSync(outCs, code, 'utf-8');
    require('child_process').execFile(
      csc, ['/nologo', '/target:winexe', `/out:${outExe}`, outCs], { windowsHide: true, timeout: 30000 },
      (err) => { if (!err && fs.existsSync(outExe)) { shellHelperExe = outExe; startWarmHelper(); } },
    );
  } catch (_) { /* ignore — fall back to the cross-platform menu */ }
}

// One long-lived helper process in --serve mode keeps the CLR and the loaded
// shell-extension DLLs warm, so repeated right-clicks are ~4-5x faster than
// spawning a fresh process each time. Requests are one line on stdin; replies
// are "DONE <code>" on stdout (code 0 = menu shown).
const helper = { proc: null, buf: '', pending: [] };

function spawnHelper() {
  if (helper.proc) return helper.proc;
  const exe = shellHelperExe;
  if (!exe || !fs.existsSync(exe)) return null;
  let cp;
  try { cp = require('child_process').spawn(exe, ['--serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (_) { return null; }
  cp.stdout.setEncoding('utf8');
  cp.stdout.on('data', (d) => {
    helper.buf += d;
    let i;
    while ((i = helper.buf.indexOf('\n')) >= 0) {
      const line = helper.buf.slice(0, i); helper.buf = helper.buf.slice(i + 1);
      if (line.indexOf('DONE') === 0) {
        const code = parseInt(line.slice(4).trim(), 10);
        const p = helper.pending.shift();
        if (p) { clearTimeout(p.timer); p.resolve(code === 0); }
      }
    }
  });
  const onDead = () => {
    if (helper.proc === cp) helper.proc = null;
    helper.buf = '';
    const ps = helper.pending.splice(0);
    for (const p of ps) { clearTimeout(p.timer); p.resolve(false); }
  };
  cp.on('exit', onDead);
  cp.on('error', onDead);
  helper.proc = cp;
  return cp;
}

function sendHelperCommand(line) {
  return new Promise((resolve) => {
    const cp = spawnHelper();
    if (!cp) { resolve(false); return; }
    const entry = { resolve, timer: null };
    entry.timer = setTimeout(() => {
      const idx = helper.pending.indexOf(entry);
      if (idx >= 0) helper.pending.splice(idx, 1);
      resolve(false);
    }, 120000);
    helper.pending.push(entry);
    try { cp.stdin.write(line + '\n'); }
    catch (_) {
      const idx = helper.pending.indexOf(entry);
      if (idx >= 0) helper.pending.splice(idx, 1);
      clearTimeout(entry.timer);
      resolve(false);
    }
  });
}

// Spawn the warm helper and pre-build (no popup) one root's menu so the shell
// extensions load now, making even the first real right-click fast.
function startWarmHelper() {
  if (process.platform !== 'win32' || !shellHelperExe) return;
  if (!spawnHelper()) return;
  try {
    const root = existingRootPaths()[0];
    if (root) sendHelperCommand('0\t0\t' + String(root).replace(/\//g, '\\') + '\tprobe').catch(() => {});
  } catch (_) { /* ignore */ }
}

async function showWindowsShellMenu(absPath, x, y) {
  return sendHelperCommand(x + '\t' + y + '\t' + absPath);
}

ipcMain.handle('show-folder-shell-menu', async (_e, absPath, x, y) => {
  if (process.platform !== 'win32' || !absPath) return { handled: false };
  try {
    // The shell APIs reject forward slashes (E_INVALIDARG), and the renderer
    // joins root + relPath with '/', so normalize to backslashes first.
    const winPath = String(absPath).replace(/\//g, '\\');
    const ok = await showWindowsShellMenu(winPath, Math.round(x || 0), Math.round(y || 0));
    return { handled: !!ok };
  } catch (_) { return { handled: false }; }
});

// ── IPC: cross-window relays (theme + document scale) ────────────────
ipcMain.on('theme-change', (e, theme) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents !== e.sender) w.webContents.send('theme-change', theme);
  }
});
ipcMain.on('doc-scale-change', (e, scale) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents !== e.sender) w.webContents.send('doc-scale-change', scale);
  }
});

// Detached windows have no search panel; forward the request to the main
// window (carrying the originating document for current-file/-folder scopes).
ipcMain.on('open-global-search', (_e, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.webContents.send('open-global-search', payload || {});
    mainWindow.focus();
  }
});

ipcMain.on('log-to-terminal', (_e, msg) => { try { console.log('[renderer]', msg); } catch (_) {} });

// ── App lifecycle ────────────────────────────────────────────────────
// ── OS file association: open .md files the OS hands us (when AMM is the
// default handler for .md). Not required to be the default — this just makes
// double-click / "Open with" work without launching a duplicate instance. ──

// Pull the first real .md file path out of an argv array (the exe, `.`, and
// flags are skipped). Used for both cold launch and the second-instance relay.
function findMdArg(argv) {
  for (const a of (argv || []).slice(1)) {
    if (typeof a !== 'string' || !a || a === '.' || a.startsWith('-')) continue;
    if (!/\.md$/i.test(a)) continue;
    try { if (fs.existsSync(a) && fs.statSync(a).isFile()) return path.resolve(a); } catch (_) { /* ignore */ }
  }
  return null;
}

// Open (or focus, if already open) an .md file given by absolute path. If the
// file sits under a configured root we open it as a normal tree tab; otherwise
// we open it ad-hoc keyed by its own directory so dedup + read/write still work.
// When the renderer is already up we push it directly; on a cold launch (renderer
// not ready yet) we queue it and the renderer drains the queue once it mounts.
function openExternalFile(absPath) {
  let abs;
  try { abs = path.resolve(absPath); } catch (_) { return; }
  if (!/\.md$/i.test(abs)) return;
  try { if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return; } catch (_) { return; }
  const loc = locateInRoots(abs);
  const name = path.basename(abs);
  const ref = (loc && loc.rootPath)
    ? { rootPath: loc.rootPath, relPath: loc.relPath, name }
    : { rootPath: path.dirname(abs), relPath: name, name };
  const alive = mainWindow && !mainWindow.isDestroyed();
  if (alive) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (mainReady && alive) {
    try { mainWindow.webContents.send('open-external-file', ref); }
    catch (_) { pendingExternalFiles.push(ref); }
  } else {
    pendingExternalFiles.push(ref);
  }
}

// The renderer drains this on mount to pick up files queued before it was ready.
ipcMain.handle('take-pending-external-files', () => pendingExternalFiles.splice(0, pendingExternalFiles.length));

// Single-instance lock: a second launch (e.g. double-clicking another .md while
// AMM is already running) forwards its argv to us via `second-instance` rather
// than spinning up a duplicate app. Detached windows are separate windows in
// this one process, so they're unaffected.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

app.on('second-instance', (_e, argv) => {
  const md = findMdArg(argv);
  if (md) {
    openExternalFile(md);
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// macOS delivers file-open requests via this event (can fire before ready).
app.on('open-file', (e, p) => { e.preventDefault(); openExternalFile(p); });

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  ensureSettingsDir();
  createMainWindow();
  setupWatcher();
  restoreDetachedWindows();
  prepareShellHelper(); // build the native folder-shell-menu helper in the background (Windows)
  const coldMd = findMdArg(process.argv); // launched by double-clicking an .md (cold start)
  if (coldMd) openExternalFile(coldMd);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Tear down the warm shell-menu helper process on exit.
app.on('will-quit', () => { try { if (helper.proc) helper.proc.kill(); } catch (_) { /* ignore */ } });
