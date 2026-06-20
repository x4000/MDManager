import React, { useState } from 'react';
import { startItemDrag } from './dragItem';

// Open-document tabs. Click to activate, ×/middle-click to close, right-click
// for the context menu, drag to reorder or tear off into another window.
export default function TabBar({ tabs, activeIndex, dirtyKeys, onActivate, onClose, onContextMenu, onReorder, onDetach }) {
  const [dragIdx, setDragIdx] = useState(null);
  const [dropIdx, setDropIdx] = useState(null);

  if (!tabs.length) return null;

  const onTabMouseDown = (e, i) => {
    if (e.button === 1) { e.preventDefault(); onClose(i); return; }
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('.close-btn')) return; // let the × handle it
    let lastOver = null;
    startItemDrag(e, {
      onMove: (cx, cy) => {
        setDragIdx(i);
        const el = document.elementFromPoint(cx, cy);
        const tabEl = el && el.closest && el.closest('.tab');
        lastOver = tabEl && tabEl.dataset.index != null ? Number(tabEl.dataset.index) : null;
        setDropIdx(lastOver);
      },
      onDrop: ({ screenX, screenY, inside, moved }) => {
        setDragIdx(null);
        setDropIdx(null);
        if (!moved) return; // a plain click → onClick activates
        if (!inside) { if (onDetach) onDetach(i, screenX, screenY); }
        else if (lastOver != null && lastOver !== i && onReorder) onReorder(i, lastOver);
      },
    });
  };

  return (
    <div className="tab-bar">
      {tabs.map((t, i) => (
        <div
          key={`${t.rootPath}|${t.relPath}`}
          data-index={i}
          className={'tab' + (i === activeIndex ? ' active' : '')}
          title={t.relPath}
          onClick={() => onActivate(i)}
          onMouseDown={(e) => onTabMouseDown(e, i)}
          onContextMenu={(e) => { e.preventDefault(); onContextMenu && onContextMenu(i, e.clientX, e.clientY); }}
          style={{
            opacity: dragIdx === i ? 0.5 : 1,
            borderLeft: dropIdx === i && dragIdx !== i ? '2px solid var(--accent)' : undefined,
          }}
        >
          <span className="tab-label">{t.name}</span>
          {dirtyKeys && dirtyKeys.has(`${t.rootPath}|${t.relPath}`) && <span className="modified-dot" title="Unsaved changes" />}
          <span className="close-btn" title="Close" onClick={(e) => { e.stopPropagation(); onClose(i); }}>×</span>
        </div>
      ))}
    </div>
  );
}
