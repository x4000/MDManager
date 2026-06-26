const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Exposed as window.arcenApi (same namespace as AXE, so ported components
// keep working). Milestone 1 surface only; grows with later milestones.
contextBridge.exposeInMainWorld('arcenApi', {
  platform: process.platform,

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),

  // Central settings (durable prefs) + session (workspace state)
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  getSession: () => ipcRenderer.invoke('get-session'),
  saveSession: (patch) => ipcRenderer.invoke('save-session', patch),

  // Roots
  addRoot: () => ipcRenderer.invoke('add-root'),
  removeRoot: (rootPath) => ipcRenderer.invoke('remove-root', rootPath),
  setRootNickname: (rootPath, nickname) => ipcRenderer.invoke('set-root-nickname', rootPath, nickname),
  reorderRoots: (orderedPaths) => ipcRenderer.invoke('reorder-roots', orderedPaths),

  // File tree
  listTree: (rootPath) => ipcRenderer.invoke('list-tree', rootPath),
  onTreeChanged: (cb) => ipcRenderer.on('tree-changed', (_e, rootPath) => cb(rootPath)),

  // Global search + replace
  searchAll: (opts) => ipcRenderer.invoke('search-all', opts),
  replaceAll: (opts) => ipcRenderer.invoke('replace-all', opts),
  replaceInFile: (opts, rootPath, relPath) => ipcRenderer.invoke('replace-in-file', opts, rootPath, relPath),
  undoReplace: () => ipcRenderer.invoke('undo-replace'),
  onReloadDoc: (cb) => { ipcRenderer.removeAllListeners('reload-doc'); ipcRenderer.on('reload-doc', (_e, payload) => cb(payload)); },

  // Wiki-links + backlinks
  resolveWiki: (name) => ipcRenderer.invoke('resolve-wiki', name),
  getBacklinks: (name, source) => ipcRenderer.invoke('get-backlinks', name, source),

  // Forward a search request to the main window (from detached windows).
  openGlobalSearch: (payload) => ipcRenderer.send('open-global-search', payload),
  onOpenGlobalSearch: (cb) => { ipcRenderer.removeAllListeners('open-global-search'); ipcRenderer.on('open-global-search', (_e, payload) => cb(payload)); },

  // File I/O
  readFile: (absPath) => ipcRenderer.invoke('read-file', absPath),
  writeFile: (absPath, content) => ipcRenderer.invoke('write-file', absPath, content),
  showInFolder: (absPath) => ipcRenderer.invoke('show-in-folder', absPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (absPath) => ipcRenderer.invoke('open-path', absPath),
  // Native OS shell context menu for a folder (Windows); { handled:false } when
  // unavailable so the renderer can fall back to its own menu.
  showFolderShellMenu: (absPath, x, y) => ipcRenderer.invoke('show-folder-shell-menu', absPath, x, y),

  // Tree file operations (create/rename/delete; deletes go to the Recycle Bin).
  createFile: (absDir, name) => ipcRenderer.invoke('create-file', absDir, name),
  createFolder: (absDir, name) => ipcRenderer.invoke('create-folder', absDir, name),
  renamePath: (absOld, newName, isFile) => ipcRenderer.invoke('rename-path', absOld, newName, isFile),
  deletePath: (absPath) => ipcRenderer.invoke('delete-path', absPath),
  movePath: (absSrc, absDestDir) => ipcRenderer.invoke('move-path', absSrc, absDestDir),
  // Convert a Markdown file to a .docx written next to it.
  convertToDocx: (absPath) => ipcRenderer.invoke('convert-to-docx', absPath),

  // Cross-window relays
  sendTheme: (theme) => ipcRenderer.send('theme-change', theme),
  onThemeChange: (cb) => ipcRenderer.on('theme-change', (_e, theme) => cb(theme)),
  sendDocScale: (scale) => ipcRenderer.send('doc-scale-change', scale),
  onDocScaleChange: (cb) => ipcRenderer.on('doc-scale-change', (_e, scale) => cb(scale)),

  // Detached windows
  detachTabAtPosition: (tab, x, y) => ipcRenderer.invoke('detach-tab-at-position', tab, x, y),
  getDetachedSession: () => ipcRenderer.invoke('get-detached-session'),
  getDetachedDisplayNum: () => ipcRenderer.invoke('get-detached-display-num'),
  registerWindowTabs: (tabs, activeTab, dirty) => ipcRenderer.send('register-window-tabs', tabs, activeTab, dirty),
  requestOpenDoc: (payload) => ipcRenderer.invoke('request-open-doc', payload),
  onFocusDoc: (cb) => { ipcRenderer.removeAllListeners('focus-doc'); ipcRenderer.on('focus-doc', (_e, payload) => cb(payload)); },
  onTabAdded: (cb) => { ipcRenderer.removeAllListeners('tab-added'); ipcRenderer.on('tab-added', (_e, tab) => cb(tab)); },
  onDetachedDisplayNum: (cb) => { ipcRenderer.removeAllListeners('detached-display-num'); ipcRenderer.on('detached-display-num', (_e, n) => cb(n)); },
  onOpenFile: (cb) => { ipcRenderer.removeAllListeners('open-file'); ipcRenderer.on('open-file', (_e, tab) => cb(tab)); },

  // OS file association: the main process forwards .md files double-clicked /
  // "opened with" AMM here, so the renderer can open-or-focus a tab for them.
  onOpenExternalFile: (cb) => { ipcRenderer.removeAllListeners('open-external-file'); ipcRenderer.on('open-external-file', (_e, ref) => cb(ref)); },
  takePendingExternalFiles: () => ipcRenderer.invoke('take-pending-external-files'),
  // Resolve a dropped File to its on-disk path (Electron 33 removed File.path).
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },

  logToTerminal: (msg) => ipcRenderer.send('log-to-terminal', msg),
});
