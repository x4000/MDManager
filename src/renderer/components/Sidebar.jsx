import React, { useState, useRef, useEffect } from 'react';
import VirtualList from './VirtualList';
import FavoritesList from './FavoritesList';
import ContextMenu from './ContextMenu';
import PromptDialog from './PromptDialog';
import { favoriteMenuItems } from './favMenu';
import { startItemDrag } from './dragItem';

const ROW_HEIGHT = 22;

// Folder icons track the theme: purple in light mode, yellow in dark mode.
function folderIcon(theme) {
  return theme === 'dark' ? '../../icons/folder-yellow.png' : '../../icons/folder-purple.png';
}

// When a folder name matches the search, keep its whole subtree; otherwise keep
// only matching descendants.
function filterTree(node, s, matchFiles, matchFolders) {
  const dirs = [];
  for (const d of node.dirs) {
    const nameHit = matchFolders && d.name.toLowerCase().includes(s);
    if (nameHit) {
      dirs.push({ name: d.name, relPath: d.relPath, dirs: d.dirs, files: d.files });
      continue;
    }
    const sub = filterTree(d, s, matchFiles, matchFolders);
    if (sub.dirs.length || sub.files.length) {
      dirs.push({ name: d.name, relPath: d.relPath, dirs: sub.dirs, files: sub.files });
    }
  }
  const files = [];
  for (const f of node.files) {
    if (matchFiles && f.name.toLowerCase().includes(s)) files.push(f);
  }
  return { dirs, files };
}

function buildRows({ roots, trees, expandedRoots, expandedFolders, search, matchFiles, matchFolders }) {
  const rows = [];
  const s = (search || '').trim().toLowerCase();
  const searching = !!s;

  // Force-expanded emit (used when searching).
  const emitOpen = (node, rootPath, depth) => {
    for (const d of node.dirs) {
      const folderKey = `${rootPath}|${d.relPath}`;
      rows.push({ kind: 'folder', key: `d:${folderKey}`, rootPath, name: d.name, depth, expanded: true, folderKey });
      emitOpen(d, rootPath, depth + 1);
    }
    for (const f of node.files) {
      const docKey = `${rootPath}|${f.relPath}`;
      rows.push({ kind: 'file', key: `f:${docKey}`, rootPath, relPath: f.relPath, name: f.name, depth, docKey });
    }
  };

  const emit = (node, rootPath, depth) => {
    for (const d of node.dirs) {
      const folderKey = `${rootPath}|${d.relPath}`;
      const expanded = expandedFolders.has(folderKey);
      rows.push({ kind: 'folder', key: `d:${folderKey}`, rootPath, name: d.name, depth, expanded, folderKey });
      if (expanded) emit(d, rootPath, depth + 1);
    }
    for (const f of node.files) {
      const docKey = `${rootPath}|${f.relPath}`;
      rows.push({ kind: 'file', key: `f:${docKey}`, rootPath, relPath: f.relPath, name: f.name, depth, docKey });
    }
  };

  for (const root of roots) {
    const ts = trees[root.path];
    if (searching) {
      rows.push({ kind: 'root', key: `r:${root.path}`, rootPath: root.path, nickname: root.nickname || root.path, expanded: true, depth: 0 });
      if (!ts || ts.loading) { rows.push({ kind: 'status', key: `s:${root.path}`, text: 'Loading…', depth: 1 }); continue; }
      if (ts.error) { rows.push({ kind: 'status', key: `s:${root.path}`, text: '(could not read folder)', depth: 1 }); continue; }
      const filtered = filterTree(ts.tree, s, matchFiles, matchFolders);
      if (!filtered.dirs.length && !filtered.files.length) { rows.push({ kind: 'status', key: `s:${root.path}`, text: '(no matches)', depth: 1 }); continue; }
      emitOpen(filtered, root.path, 1);
    } else {
      const expanded = expandedRoots.has(root.path);
      rows.push({ kind: 'root', key: `r:${root.path}`, rootPath: root.path, nickname: root.nickname || root.path, expanded, depth: 0 });
      if (!expanded) continue;
      if (!ts || ts.loading) rows.push({ kind: 'status', key: `s:${root.path}`, text: 'Loading…', depth: 1 });
      else if (ts.error) rows.push({ kind: 'status', key: `s:${root.path}`, text: ts.error === 'not-found' ? '(folder not found)' : '(could not read folder)', depth: 1 });
      else if (ts.tree) {
        if (!ts.tree.dirs.length && !ts.tree.files.length) rows.push({ kind: 'status', key: `s:${root.path}`, text: '(no .md files)', depth: 1 });
        else emit(ts.tree, root.path, 1);
      }
    }
  }
  return rows;
}

export default function Sidebar({
  tab,
  onSetTab,
  roots,
  theme,
  trees,
  expandedRoots,
  expandedFolders,
  activeKey,
  favorites,
  activeFile,
  revealTarget,
  onToggleRoot,
  onToggleFolder,
  onAddRoot,
  onRemoveRoot,
  onRenameRoot,
  onReorderRoots,
  onOpenFile,
  onFavoritesChange,
  onEnsureTrees,
  onPathRenamed,
  onPathDeleted,
  onPathMoved,
}) {
  const [editing, setEditing] = useState(null); // rootPath being renamed
  const [renameValue, setRenameValue] = useState('');
  const [menu, setMenu] = useState(null);
  const [prompt, setPrompt] = useState(null); // { title, initial, onSubmit }
  const [dropDir, setDropDir] = useState(null); // data-drop-dir of the hovered folder while dragging a file
  const [dropRoot, setDropRoot] = useState(null); // { path, after } hovered while drag-reordering roots
  const rootDragRef = useRef(null);               // rootPath currently being drag-reordered
  const [search, setSearch] = useState('');
  const [matchFiles, setMatchFiles] = useState(true);
  const [matchFolders, setMatchFolders] = useState(true);
  const [reveal, setReveal] = useState({ index: -1, nonce: 0 });

  const startRename = (rootPath, current) => { setEditing(rootPath); setRenameValue(current); };
  const commitRename = () => {
    if (editing != null) onRenameRoot(editing, renameValue);
    setEditing(null);
  };

  const onSearchChange = (val) => {
    setSearch(val);
    if (val.trim() && onEnsureTrees) onEnsureTrees();
  };

  const rows = buildRows({ roots, trees, expandedRoots, expandedFolders, search, matchFiles, matchFolders });
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Scroll the active document into view in the tree (reveal-on-open). Retries
  // a few times since the target root's tree may still be loading; also re-runs
  // when the row set changes (rows.length), so a first-time root whose tree
  // loads AFTER the retry budget still gets revealed instead of giving up.
  const revealedSeqRef = useRef(null);
  useEffect(() => {
    if (!revealTarget || tab !== 'folders') return;
    if (revealedSeqRef.current === revealTarget.seq) return; // already revealed this request
    const targetKey = `${revealTarget.rootPath}|${revealTarget.relPath}`;
    let tries = 0;
    let cancelled = false;
    let timer = null;
    const attempt = () => {
      if (cancelled) return;
      const idx = rowsRef.current.findIndex((r) => r.kind === 'file' && r.docKey === targetKey);
      if (idx >= 0) { revealedSeqRef.current = revealTarget.seq; setReveal((s) => ({ index: idx, nonce: s.nonce + 1 })); return; }
      if (tries++ < 8) timer = setTimeout(attempt, 150);
    };
    timer = setTimeout(attempt, 30);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [revealTarget, tab, rows.length]);

  // ── Tree file operations (create / rename / delete) ──
  const parentRelOf = (rel) => (rel.indexOf('/') >= 0 ? rel.slice(0, rel.lastIndexOf('/')) : '');
  const relForFolderRow = (row) => (row.kind === 'root' ? '' : row.folderKey.slice(row.rootPath.length + 1));

  const newFileIn = (rootPath, absDir, parentRel) => setPrompt({
    title: 'New file', initial: '',
    onSubmit: async (name) => {
      const r = await window.arcenApi.createFile(absDir, name);
      if (r && r.ok) onOpenFile(rootPath, parentRel ? `${parentRel}/${r.name}` : r.name, r.name);
      else if (r && r.error) window.alert(r.error);
    },
  });
  const newFolderIn = (absDir) => setPrompt({
    title: 'New folder', initial: '',
    onSubmit: async (name) => { const r = await window.arcenApi.createFolder(absDir, name); if (r && r.error) window.alert(r.error); },
  });
  const renamePathRow = (rootPath, rel, abs, isFile) => setPrompt({
    title: isFile ? 'Rename file' : 'Rename folder', initial: abs.split('/').pop(),
    onSubmit: async (name) => {
      const r = await window.arcenApi.renamePath(abs, name, isFile);
      if (r && r.ok) { const parent = parentRelOf(rel); if (onPathRenamed) onPathRenamed(rootPath, rel, parent ? `${parent}/${r.name}` : r.name); }
      else if (r && r.error) window.alert(r.error);
    },
  });
  const deletePathRow = async (rootPath, rel, abs) => {
    const r = await window.arcenApi.deletePath(abs); // main process shows the Recycle Bin confirm
    if (r && r.ok && onPathDeleted) onPathDeleted(rootPath, rel);
    else if (r && r.error) window.alert(r.error);
  };

  // A "Windows shell menu…" item (the native Explorer menu with TortoiseSVN/Git
  // etc.) — Windows only. showFolderShellMenu works for files and folders alike.
  const winShellItem = (abs, sx, sy) => (
    window.arcenApi.platform === 'win32'
      ? { label: 'Windows shell menu…', action: () => { window.arcenApi.showFolderShellMenu(abs, sx, sy); } }
      : null
  );
  // Show the native shell menu; if it can't be shown, run the in-app fallback.
  const tryNativeMenu = (abs, sx, sy, fallback) => {
    window.arcenApi.showFolderShellMenu(abs, sx, sy)
      .then((r) => { if (!(r && r.handled)) fallback(); })
      .catch(() => fallback());
  };

  const buildFileMenu = (row, abs, dirAbs, parentRel, x, y, sx, sy) => {
    const file = { rootPath: row.rootPath, relPath: row.relPath, name: row.name };
    const ws = winShellItem(abs, sx, sy);
    setMenu({
      x, y,
      items: [
        ...favoriteMenuItems(file, favorites, onFavoritesChange),
        { divider: true },
        { label: 'New file…', action: () => newFileIn(row.rootPath, dirAbs, parentRel) },
        { label: 'New folder…', action: () => newFolderIn(dirAbs) },
        { label: 'Rename…', action: () => renamePathRow(row.rootPath, row.relPath, abs, true) },
        { label: 'Delete…', action: () => deletePathRow(row.rootPath, row.relPath, abs) },
        { divider: true },
        { label: 'Reveal in Explorer', action: () => window.arcenApi.showInFolder(abs) },
        { label: 'Copy path', action: () => { try { navigator.clipboard.writeText(abs); } catch (_) { /* ignore */ } } },
        ...(ws ? [{ divider: true }, ws] : []),
      ],
    });
  };
  // Normal right-click → in-app menu; Ctrl+right-click (Windows) → native shell menu.
  const openFileMenu = (e, row) => {
    e.preventDefault();
    const base = row.rootPath.replace(/[\\/]+$/, '');
    const abs = base + '/' + row.relPath;
    const parentRel = parentRelOf(row.relPath);
    const dirAbs = parentRel ? base + '/' + parentRel : base;
    const { clientX, clientY, screenX, screenY } = e;
    const show = () => buildFileMenu(row, abs, dirAbs, parentRel, clientX, clientY, screenX, screenY);
    if (e.ctrlKey && window.arcenApi.platform === 'win32') tryNativeMenu(abs, screenX, screenY, show);
    else show();
  };

  const absForFolderRow = (row) => {
    const base = row.rootPath.replace(/[\\/]+$/, '');
    if (row.kind === 'root') return base;
    const rel = row.folderKey.slice(row.rootPath.length + 1);
    return base + '/' + rel;
  };

  const buildFolderMenu = (row, abs, rel, x, y, sx, sy) => {
    const ws = winShellItem(abs, sx, sy);
    setMenu({
      x, y,
      items: [
        { label: 'New file…', action: () => newFileIn(row.rootPath, abs, rel) },
        { label: 'New folder…', action: () => newFolderIn(abs) },
        ...(row.kind !== 'root' ? [
          { label: 'Rename…', action: () => renamePathRow(row.rootPath, rel, abs, false) },
          { label: 'Delete…', action: () => deletePathRow(row.rootPath, rel, abs) },
        ] : []),
        { divider: true },
        { label: 'Reveal in File Explorer', action: () => window.arcenApi.showInFolder(abs) },
        { label: 'Open folder', action: () => window.arcenApi.openPath(abs) },
        { label: 'Copy path', action: () => { try { navigator.clipboard.writeText(abs); } catch (_) { /* ignore */ } } },
        ...(ws ? [{ divider: true }, ws] : []),
      ],
    });
  };
  // Normal right-click → in-app menu (with a "Windows shell menu…" item);
  // Ctrl+right-click (Windows) → straight to the native shell menu.
  const openFolderMenu = (e, row) => {
    e.preventDefault();
    const abs = absForFolderRow(row);
    const rel = relForFolderRow(row);
    const { clientX, clientY, screenX, screenY } = e;
    const show = () => buildFolderMenu(row, abs, rel, clientX, clientY, screenX, screenY);
    if (e.ctrlKey && window.arcenApi.platform === 'win32') tryNativeMenu(abs, screenX, screenY, show);
    else show();
  };

  // The folder that contains a root (one level up). Lives outside the configured
  // roots, so its menu only offers the read-only / shell actions (the create /
  // rename / delete handlers require an in-root target).
  const parentDirOf = (rootPath) => {
    const base = (rootPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const i = base.lastIndexOf('/');
    if (i <= 0) return base; // drive root / no parent → itself
    let parent = base.slice(0, i);
    if (/^[A-Za-z]:$/.test(parent)) parent += '/'; // a bare drive letter needs the slash
    return parent;
  };
  const buildParentMenu = (parentAbs, x, y, sx, sy) => {
    const ws = winShellItem(parentAbs, sx, sy);
    setMenu({
      x, y,
      items: [
        { label: 'Reveal in File Explorer', action: () => window.arcenApi.showInFolder(parentAbs) },
        { label: 'Open folder', action: () => window.arcenApi.openPath(parentAbs) },
        { label: 'Copy path', action: () => { try { navigator.clipboard.writeText(parentAbs); } catch (_) { /* ignore */ } } },
        ...(ws ? [{ divider: true }, ws] : []),
      ],
    });
  };
  // The parent-folder icon on a root row: left/right click → in-app parent menu;
  // Ctrl+click (Windows) → straight to the native shell menu for the parent.
  const openParentMenu = (e, row) => {
    e.preventDefault();
    e.stopPropagation();
    const parentAbs = parentDirOf(row.rootPath);
    const { clientX, clientY, screenX, screenY } = e;
    const show = () => buildParentMenu(parentAbs, clientX, clientY, screenX, screenY);
    if (e.ctrlKey && window.arcenApi.platform === 'win32') tryNativeMenu(parentAbs, screenX, screenY, show);
    else show();
  };

  // Drag a file out of the sidebar onto another window to open it there.
  // The folder a drag is currently over (a folder/root row's data-drop-dir),
  // unless it's the dragged file's own folder (a no-op).
  const dropDirAt = (clientX, clientY, srcAbs) => {
    const el = document.elementFromPoint(clientX, clientY);
    const rowEl = el && el.closest && el.closest('[data-drop-dir]');
    const abs = rowEl && rowEl.getAttribute('data-drop-dir');
    if (!abs) return null;
    const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const srcDir = srcAbs.slice(0, srcAbs.lastIndexOf('/'));
    if (norm(abs) === norm(srcDir)) return null;
    return abs;
  };

  const moveFileTo = async (row, destDirAbs) => {
    const srcAbs = row.rootPath.replace(/[\\/]+$/, '') + '/' + row.relPath;
    const r = await window.arcenApi.movePath(srcAbs, destDirAbs);
    if (r && r.ok && r.rootPath != null) { if (onPathMoved) onPathMoved(row.rootPath, row.relPath, r.rootPath, r.relPath); }
    else if (r && r.error) window.alert(r.error);
  };

  // Drag a file: onto a folder/root row → move it there; outside the window → tear off.
  const onFileMouseDown = (e, row) => {
    if (e.button !== 0) return;
    const srcAbs = row.rootPath.replace(/[\\/]+$/, '') + '/' + row.relPath;
    startItemDrag(e, {
      onMove: (cx, cy) => setDropDir(dropDirAt(cx, cy, srcAbs)),
      onDrop: ({ screenX, screenY, clientX, clientY, inside, moved }) => {
        setDropDir(null);
        if (!moved) return;
        const dest = dropDirAt(clientX, clientY, srcAbs);
        if (dest) moveFileTo(row, dest);
        else if (!inside) window.arcenApi.detachTabAtPosition({ rootPath: row.rootPath, relPath: row.relPath, name: row.name }, screenX, screenY);
      },
    });
  };

  const fIcon = folderIcon(theme);

  const renderRow = (row) => {
    const indent = 8 + row.depth * 14;

    if (row.kind === 'root') {
      return (
        <div
          className={'tree-row root' + (dropDir === row.rootPath ? ' drop-target' : '')
            + (dropRoot && dropRoot.path === row.rootPath ? (dropRoot.after ? ' root-drop-after' : ' root-drop-before') : '')}
          data-drop-dir={row.rootPath}
          style={{ paddingLeft: indent }}
          draggable={editing !== row.rootPath}
          onDragStart={(e) => { rootDragRef.current = row.rootPath; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', row.rootPath); } catch (_) { /* ignore */ } }}
          onDragOver={(e) => {
            if (!rootDragRef.current || rootDragRef.current === row.rootPath) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setDropRoot({ path: row.rootPath, after: e.clientY > r.top + r.height / 2 });
          }}
          onDragLeave={() => setDropRoot((p) => (p && p.path === row.rootPath ? null : p))}
          onDrop={(e) => {
            if (!rootDragRef.current) return; // not a root reorder → let OS file-drop etc. run
            e.preventDefault();
            e.stopPropagation();
            const from = rootDragRef.current;
            const r = e.currentTarget.getBoundingClientRect();
            const after = e.clientY > r.top + r.height / 2;
            rootDragRef.current = null;
            setDropRoot(null);
            if (from !== row.rootPath && onReorderRoots) onReorderRoots(from, row.rootPath, after);
          }}
          onDragEnd={() => { rootDragRef.current = null; setDropRoot(null); }}
          onClick={() => onToggleRoot(row.rootPath)}
          onContextMenu={(e) => openFolderMenu(e, row)}
          title={row.rootPath}
        >
          <span className="chevron">{row.expanded ? '▾' : '▸'}</span>
          <img src={fIcon} alt="" />
          {editing === row.rootPath ? (
            <input
              className="rename"
              autoFocus
              value={renameValue}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setEditing(null); }}
              onBlur={commitRename}
            />
          ) : (
            <span
              className="label"
              onDoubleClick={(e) => { e.stopPropagation(); startRename(row.rootPath, row.nickname); }}
              title="Double-click to rename"
            >
              {row.nickname}
            </span>
          )}
          <img
            className="parent-icon"
            src="../../icons/parent-folder.png"
            alt=""
            title="Parent folder menu — click for actions, Ctrl+click for the system menu"
            onClick={(e) => openParentMenu(e, row)}
            onContextMenu={(e) => openParentMenu(e, row)}
          />
          <span className="root-remove" title="Remove this folder from the sidebar" onClick={(e) => { e.stopPropagation(); onRemoveRoot(row.rootPath); }}>✕</span>
        </div>
      );
    }

    if (row.kind === 'folder') {
      const dAbs = absForFolderRow(row);
      return (
        <div className={'tree-row' + (dropDir === dAbs ? ' drop-target' : '')} data-drop-dir={dAbs} style={{ paddingLeft: indent }} onClick={() => onToggleFolder(row.folderKey)} onContextMenu={(e) => openFolderMenu(e, row)} title={row.name}>
          <span className="chevron">{row.expanded ? '▾' : '▸'}</span>
          <img src={fIcon} alt="" />
          <span className="label">{row.name}</span>
        </div>
      );
    }

    if (row.kind === 'file') {
      return (
        <div
          className={'tree-row' + (activeKey === row.docKey ? ' active' : '')}
          style={{ paddingLeft: indent }}
          onClick={() => onOpenFile(row.rootPath, row.relPath, row.name)}
          onMouseDown={(e) => onFileMouseDown(e, row)}
          onContextMenu={(e) => openFileMenu(e, row)}
          title={row.relPath}
        >
          <span className="spacer" />
          <img src="../../icons/md-file.png" alt="" />
          <span className="label">{row.name}</span>
        </div>
      );
    }

    return (
      <div className="tree-row" style={{ paddingLeft: indent, cursor: 'default' }}>
        <span className="spacer" />
        <span className="label row-status">{row.text}</span>
      </div>
    );
  };

  return (
    <>
      <div className="sidebar-tabs">
        <div className={'sidebar-tab' + (tab !== 'favorites' ? ' active' : '')} onClick={() => onSetTab('folders')}>Folders</div>
        <div className={'sidebar-tab' + (tab === 'favorites' ? ' active' : '')} onClick={() => onSetTab('favorites')}>Favorites</div>
      </div>

      {tab === 'favorites' ? (
        <FavoritesList
          favorites={favorites}
          activeKey={activeKey}
          activeFile={activeFile}
          onChange={onFavoritesChange}
          onOpenFile={(f) => onOpenFile(f.rootPath, f.relPath, f.name)}
        />
      ) : (
        <>
          <div className="sidebar-header">
            <span>Folders</span>
            <button className="icon-btn" title="Add a folder of Markdown documents" onClick={onAddRoot}>＋</button>
          </div>
          <div className="sidebar-search">
            <div className="ss-inputwrap">
              <input
                className="ss-input"
                type="text"
                placeholder="Search names…"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
              />
              {search && <span className="ss-clear" title="Clear search" onClick={() => onSearchChange('')}>✕</span>}
            </div>
            <button className={'ss-filter' + (matchFiles ? ' active' : '')} title="Match file names" onClick={() => setMatchFiles((v) => !v)}>≡</button>
            <button className={'ss-filter' + (matchFolders ? ' active' : '')} title="Match folder names" onClick={() => setMatchFolders((v) => !v)}>
              <img src={fIcon} alt="" style={{ width: 13, height: 13, opacity: matchFolders ? 1 : 0.4 }} />
            </button>
          </div>
          {(!roots || roots.length === 0) ? (
            <div className="sidebar-content">
              <div className="root-children" style={{ paddingLeft: 12 }}>
                No folders yet — click ＋ to add one.
              </div>
            </div>
          ) : (
            <VirtualList
              rows={rows}
              rowHeight={ROW_HEIGHT}
              renderRow={renderRow}
              getRowKey={(r) => r.key}
              revealIndex={reveal.index}
              revealNonce={reveal.nonce}
              style={{ flex: 1, minHeight: 0 }}
            />
          )}
        </>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog title={prompt.title} initial={prompt.initial} onSubmit={prompt.onSubmit} onClose={() => setPrompt(null)} />}
    </>
  );
}
