import React from 'react';

// Bottom status bar: active-file label on the left; theme toggle and
// sidebar-side toggle on the right. The toggle icons preview the
// destination state (the dark-mode icon shows when you're in light mode),
// matching AXE's "shows what you'll get" convention.
export default function StatusBar({ theme, onToggleTheme, sidebarSide, onToggleSidebarSide, activeFile, stats, onShowHelp }) {
  return (
    <div className="status-bar">
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {activeFile || 'No document open'}
      </span>
      {stats && (
        <span className="status-stats" title="Lines · words · characters">
          {stats.lines.toLocaleString()} ln · {stats.words.toLocaleString()} words · {stats.chars.toLocaleString()} chars
        </span>
      )}
      {onShowHelp && (
        <span
          className="status-help"
          style={{ cursor: 'pointer', marginRight: 10, opacity: 0.9 }}
          onClick={onShowHelp}
          title="Keyboard shortcuts (F1)"
        >
          ?
        </span>
      )}
      <img
        src={theme === 'light' ? '../../icons/dark-mode.png' : '../../icons/light-mode.png'}
        style={{ cursor: 'pointer', marginRight: 10, width: 16, height: 16, verticalAlign: 'middle', opacity: 0.9 }}
        onClick={onToggleTheme}
        title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      />
      {onToggleSidebarSide && (
        <span
          style={{
            cursor: 'pointer', width: 16, height: 16,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            opacity: 0.9, verticalAlign: 'middle', fontSize: 16, lineHeight: 1,
          }}
          onClick={onToggleSidebarSide}
          title={sidebarSide === 'right' ? 'Move sidebar to left' : 'Move sidebar to right'}
        >
          {sidebarSide === 'right' ? '◧' : '◨'}
        </span>
      )}
    </div>
  );
}
