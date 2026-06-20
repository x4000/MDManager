import React, { useState } from 'react';

// Small centered "Go to line" input (Ctrl/Cmd+G). Enter jumps the active
// document to the line; Escape (or a click outside) closes it.
export default function GoToLineDialog({ onGo, onClose }) {
  const [val, setVal] = useState('');
  const submit = () => {
    const n = parseInt(val, 10);
    if (n > 0) onGo(n);
    onClose();
  };
  return (
    <div className="goto-overlay" onMouseDown={onClose}>
      <div className="goto-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="goto-input"
          autoFocus
          type="text"
          inputMode="numeric"
          placeholder="Go to line…"
          value={val}
          onChange={(e) => setVal(e.target.value.replace(/[^\d]/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
      </div>
    </div>
  );
}
