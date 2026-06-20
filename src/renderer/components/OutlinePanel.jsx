import React, { useEffect, useRef } from 'react';

// Right-side document outline: the active doc's heading tree (already processed
// by buildOutline — title dropped, depth-filtered, each item carries `indent`).
// Clicking a heading jumps the view to its source line (onSelect), reusing the
// go-to-line machinery so it works in both Read and Source. The depth control
// trims how many heading levels show; `width` is the rail's persisted width.
const DEPTHS = [
  { v: 1, label: '1', title: 'Top level only' },
  { v: 2, label: '2', title: 'Show 2 levels' },
  { v: 3, label: '3', title: 'Show 3 levels' },
  { v: 0, label: '∞', title: 'Show all levels' },
];

export default function OutlinePanel({ headings, activeLine, depth, onSelect, onClose, onSetDepth, width }) {
  // Keep the active item visible as you scroll (only nudges if it's off-screen).
  const activeRef = useRef(null);
  useEffect(() => {
    if (activeRef.current) activeRef.current.scrollIntoView({ block: 'nearest' });
  }, [activeLine]);
  return (
    <div className="outline-rail" style={{ width }}>
      <div className="outline-head">
        <span className="outline-title">Outline</span>
        <div className="outline-depth">
          {DEPTHS.map((d) => (
            <button
              key={d.v}
              className={(depth || 0) === d.v ? 'active' : ''}
              title={d.title}
              onClick={() => onSetDepth(d.v)}
            >
              {d.label}
            </button>
          ))}
        </div>
        {onClose && <button className="icon-btn" title="Hide outline" onClick={onClose}>×</button>}
      </div>
      {headings.length === 0 ? (
        <div className="outline-empty">No headings in this document.</div>
      ) : (
        <div className="outline-list">
          {headings.map((h, i) => (
            <div
              key={`${h.line}:${i}`}
              ref={h.line === activeLine ? activeRef : null}
              className={'outline-item' + (h.line === activeLine ? ' active' : '')}
              style={{ paddingLeft: 10 + (h.indent || 0) * 12 }}
              title={h.text}
              onClick={() => onSelect(h.line)}
            >
              {h.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
