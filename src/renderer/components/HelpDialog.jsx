import React, { useEffect } from 'react';

// Keyboard-shortcut reference (F1, or the “?” in the status bar). Esc / click
// outside closes. Grouped by area; mirrors the bindings wired in App / SourceView.
const SECTIONS = [
  {
    title: 'General',
    rows: [
      ['Ctrl', 'S', 'Save document'],
      ['Ctrl', 'E', 'Toggle Read / Source'],
      ['', 'F1', 'This shortcut list'],
    ],
  },
  {
    title: 'Search & replace',
    rows: [
      ['Ctrl', 'F', 'Find — current file (Read) / in-editor (Source)'],
      ['Ctrl+Shift', 'F', 'Search all folders'],
      ['Ctrl', 'H', 'Find & replace'],
      ['', 'F3 / Shift+F3', 'Next / previous match (Source find)'],
    ],
  },
  {
    title: 'Navigation',
    rows: [
      ['Ctrl', 'G', 'Go to line'],
      ['', 'Mouse ◀ / ▶', 'Back / forward through visited docs'],
    ],
  },
  {
    title: 'Tabs',
    rows: [
      ['Ctrl', 'W', 'Close tab (returns to most-recent)'],
      ['Ctrl', 'Tab', 'Next tab'],
      ['Ctrl+Shift', 'Tab', 'Previous tab'],
    ],
  },
  {
    title: 'Editing (Source)',
    rows: [
      ['Ctrl', 'B / I', 'Bold / italic'],
      ['Ctrl', 'K', 'Insert link'],
      ['Ctrl', 'L', 'Select line'],
      ['', 'Tab / Shift+Tab', 'Indent / outdent list'],
      ['', 'Enter', 'Continue list'],
      ['', 'Right-click ▾', 'UPPER / lower / Title / Sentence case'],
    ],
  },
];

export default function HelpDialog({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="help-overlay" onMouseDown={onClose}>
      <div className="help-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="help-head">
          <span>Keyboard shortcuts</span>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>×</button>
        </div>
        <div className="help-grid">
          {SECTIONS.map((sec) => (
            <div className="help-section" key={sec.title}>
              <div className="help-section-title">{sec.title}</div>
              {sec.rows.map((r, i) => (
                <div className="help-row" key={i}>
                  <span className="help-keys">
                    {r[0] && <span className="help-mod">{r[0]}</span>}
                    <kbd>{r[1]}</kbd>
                  </span>
                  <span className="help-desc">{r[2]}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
