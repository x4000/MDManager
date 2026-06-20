import React, { useLayoutEffect, useRef, useState } from 'react';

// Lightweight right-click menu. A full-screen backdrop intercepts the next
// click to dismiss. Items: { label, action } or { divider: true } or
// { label, disabled: true }.
export default function ContextMenu({ x, y, items, onClose }) {
  const menuRef = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Clamp inside the viewport so a menu opened near the right/bottom edge isn't
  // pushed off-window where its items would be clipped/unclickable.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const m = 6;
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - m) left = Math.max(m, window.innerWidth - r.width - m);
    if (top + r.height > window.innerHeight - m) top = Math.max(m, window.innerHeight - r.height - m);
    if (left !== pos.left || top !== pos.top) setPos({ left, top });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, items]);
  return (
    <div className="ctx-backdrop" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div className="ctx-menu" ref={menuRef} style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.stopPropagation()}>
        {items.map((it, i) => it.divider ? (
          <div key={i} className="ctx-div" />
        ) : (
          <div
            key={i}
            className={'ctx-item' + (it.disabled ? ' disabled' : '')}
            onClick={() => { if (!it.disabled && it.action) it.action(); onClose(); }}
          >
            {it.label}
          </div>
        ))}
      </div>
    </div>
  );
}
