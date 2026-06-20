import React, { useState } from 'react';

// Floating "100%" chip in the lower-left that scales the whole document.
// Click to edit; Enter/blur commits (clamped 70–200%), Esc cancels.
// Ported from xmled's editor-scale indicator.
export default function ScaleControl({ scale, onChange }) {
  const [editing, setEditing] = useState(null); // null = display, string = editing

  const commit = (raw) => {
    const val = Math.max(70, Math.min(200, parseInt(raw, 10) || 100));
    onChange(val);
    setEditing(null);
  };

  return (
    <div
      className="scale-control"
      onClick={() => setEditing(String(scale || 100))}
      title="Click to set document scale"
    >
      {editing !== null ? (
        <input
          type="text"
          autoFocus
          value={editing}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setEditing(e.target.value.replace(/[^0-9]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(editing);
            else if (e.key === 'Escape') setEditing(null);
          }}
          onBlur={() => commit(editing)}
        />
      ) : (
        <span>{scale || 100}%</span>
      )}
    </div>
  );
}
