import React, { useEffect, useRef, useState } from 'react';

// Manual favorites, organized into named groups. No auto-grouping.
// favorites: [{ name, files: [{ rootPath, relPath, name }] }]
export default function FavoritesList({ favorites, activeKey, activeFile, onChange, onOpenFile }) {
  const [expanded, setExpanded] = useState(() => new Set(favorites.map((g) => g.name)));
  const [editing, setEditing] = useState(null); // group name being renamed
  const [renameVal, setRenameVal] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const dragRef = useRef(null);              // { group, idx } of the file being dragged
  const [dropKey, setDropKey] = useState(null); // row currently hovered as a drop target

  // A group created externally (e.g. the tab-bar "Add to Favorites") should
  // default to open rather than collapsed — the mount-only seed misses it.
  useEffect(() => {
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const g of favorites) if (!next.has(g.name)) { next.add(g.name); changed = true; }
      return changed ? next : prev;
    });
  }, [favorites]);

  const toggle = (name) => setExpanded((p) => {
    const n = new Set(p);
    if (n.has(name)) n.delete(name); else n.add(name);
    return n;
  });

  const createGroup = () => {
    const nm = newName.trim();
    // Name collides with an existing group: keep the input open so the typed
    // name isn't silently discarded.
    if (nm && favorites.some((g) => g.name === nm)) return;
    if (nm) {
      onChange([...favorites, { name: nm, files: [] }]);
      setExpanded((p) => new Set(p).add(nm));
    }
    setAdding(false);
    setNewName('');
  };

  const commitRename = (oldName) => {
    const nm = renameVal.trim();
    // Collision with another group: keep the editor open (don't clear editing)
    // so the user can correct it instead of losing the typed name.
    if (nm && nm !== oldName && favorites.some((g) => g.name === nm)) return;
    if (nm && nm !== oldName) {
      onChange(favorites.map((g) => (g.name === oldName ? { ...g, name: nm } : g)));
      setExpanded((p) => { const n = new Set(p); if (n.has(oldName)) { n.delete(oldName); n.add(nm); } return n; });
    }
    setEditing(null);
  };

  const deleteGroup = (name) => onChange(favorites.filter((g) => g.name !== name));

  const addCurrent = (name) => {
    if (!activeFile) return;
    onChange(favorites.map((g) => {
      if (g.name !== name) return g;
      if (g.files.some((f) => f.rootPath === activeFile.rootPath && f.relPath === activeFile.relPath)) return g;
      return { ...g, files: [...g.files, activeFile] };
    }));
  };

  const removeFile = (name, file) => onChange(favorites.map((g) => (
    g.name === name
      ? { ...g, files: g.files.filter((f) => !(f.rootPath === file.rootPath && f.relPath === file.relPath)) }
      : g
  )));

  // Reorder a favorite within its group, or move it to another group at destIdx.
  const moveFile = (srcGroup, srcIdx, destGroup, destIdx) => {
    if (srcGroup === destGroup && srcIdx === destIdx) return;
    const next = favorites.map((g) => ({ ...g, files: g.files.slice() }));
    const sg = next.find((g) => g.name === srcGroup);
    const dg = next.find((g) => g.name === destGroup);
    if (!sg || !dg || srcIdx < 0 || srcIdx >= sg.files.length) return;
    const [moved] = sg.files.splice(srcIdx, 1);
    const dup = dg.files.some((f) => f.rootPath === moved.rootPath && f.relPath === moved.relPath);
    if (!dup) {
      // Removing src shifts later same-group indices down by one.
      let di = (srcGroup === destGroup && srcIdx < destIdx) ? destIdx - 1 : destIdx;
      di = Math.max(0, Math.min(di, dg.files.length));
      dg.files.splice(di, 0, moved);
    }
    onChange(next);
  };
  const onRowDrop = (destGroup, destIdx) => {
    const s = dragRef.current;
    dragRef.current = null;
    setDropKey(null);
    if (s) moveFile(s.group, s.idx, destGroup, destIdx);
  };

  return (
    <>
      <div className="fav-toolbar">
        {adding ? (
          <input
            className="fav-newgroup"
            autoFocus
            placeholder="Group name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') createGroup(); else if (e.key === 'Escape') { setAdding(false); setNewName(''); } }}
            onBlur={createGroup}
          />
        ) : (
          <button className="fav-newbtn" onClick={() => setAdding(true)}>＋ New group</button>
        )}
      </div>
      <div className="sidebar-content">
        {favorites.length === 0 && !adding && (
          <div className="root-children" style={{ paddingLeft: 12 }}>
            No favorites yet. Right-click a file → "Add to Favorites", or create a group.
          </div>
        )}
        {favorites.map((g) => {
          const isOpen = expanded.has(g.name);
          return (
            <div key={g.name}>
              <div
                className="fav-group-header"
                onClick={() => toggle(g.name)}
                onDragOver={(e) => { if (dragRef.current) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); onRowDrop(g.name, g.files.length); }}
              >
                <span className="chevron">{isOpen ? '▾' : '▸'}</span>
                {editing === g.name ? (
                  <input
                    className="rename"
                    autoFocus
                    value={renameVal}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(g.name); else if (e.key === 'Escape') setEditing(null); }}
                    onBlur={() => commitRename(g.name)}
                  />
                ) : (
                  <span
                    className="label"
                    onDoubleClick={(e) => { e.stopPropagation(); setEditing(g.name); setRenameVal(g.name); }}
                    title="Double-click to rename"
                  >
                    {g.name}
                  </span>
                )}
                <span className="fav-count">{g.files.length}</span>
                <button
                  className="fav-add"
                  title={activeFile ? 'Add the open document to this group' : 'Open a document first'}
                  disabled={!activeFile}
                  onClick={(e) => { e.stopPropagation(); addCurrent(g.name); }}
                >＋</button>
                <button className="fav-del" title="Delete group" onClick={(e) => { e.stopPropagation(); deleteGroup(g.name); }}>✕</button>
              </div>
              {isOpen && g.files.map((f, idx) => {
                const key = `${f.rootPath}|${f.relPath}`;
                const rowId = `${g.name}|${key}`;
                return (
                  <div
                    key={key}
                    className={'tree-row fav-file' + (activeKey === key ? ' active' : '') + (dropKey === rowId ? ' fav-drop' : '')}
                    draggable
                    onDragStart={(e) => { dragRef.current = { group: g.name, idx }; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', key); } catch (_) { /* ignore */ } }}
                    onDragOver={(e) => { if (dragRef.current) { e.preventDefault(); setDropKey(rowId); } }}
                    onDragLeave={() => setDropKey((k) => (k === rowId ? null : k))}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onRowDrop(g.name, idx); }}
                    onDragEnd={() => { dragRef.current = null; setDropKey(null); }}
                    onClick={() => onOpenFile(f)}
                    title={f.relPath}
                  >
                    <span className="spacer" />
                    <img src="../../icons/md-file.png" alt="" />
                    <span className="label">{f.name}</span>
                    <span className="fav-remove" title="Remove from group" onClick={(e) => { e.stopPropagation(); removeFile(g.name, f); }}>×</span>
                  </div>
                );
              })}
              {isOpen && g.files.length === 0 && (
                <div
                  className="root-children"
                  style={{ paddingLeft: 28 }}
                  onDragOver={(e) => { if (dragRef.current) e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); onRowDrop(g.name, 0); }}
                >(empty — use ＋ to add the open document, or drag one here)</div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
