import React, { useState } from 'react';

// Small centered text-prompt (new file/folder name, rename). Enter submits the
// trimmed value, Escape / click-outside cancels. On a rename, the name part
// (before the extension) is pre-selected.
export default function PromptDialog({ title, initial, onSubmit, onClose }) {
  const [val, setVal] = useState(initial || '');
  const submit = () => { const v = val.trim(); if (v) onSubmit(v); onClose(); };
  return (
    <div className="goto-overlay" onMouseDown={onClose}>
      <div className="prompt-box" onMouseDown={(e) => e.stopPropagation()}>
        {title && <div className="prompt-title">{title}</div>}
        <input
          className="goto-input"
          autoFocus
          value={val}
          onFocus={(e) => {
            const dot = (initial || '').lastIndexOf('.');
            e.target.setSelectionRange(0, dot > 0 ? dot : (initial || '').length);
          }}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
        />
      </div>
    </div>
  );
}
