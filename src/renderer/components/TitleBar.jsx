import React, { useEffect } from 'react';

// Frameless custom title bar: app icon, back/forward navigation, the window
// title (which names itself after the open document), and min/max/close.
// Ported from AXE's TitleBar, stripped of the VCS pips and project-name IPC.

const APP_NAME = 'AMM Viewer';

function navBtnStyle(enabled) {
  return {
    background: 'transparent',
    border: 'none',
    color: enabled ? '#fff' : 'rgba(255,255,255,0.3)',
    cursor: enabled ? 'pointer' : 'default',
    width: 28,
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    WebkitAppRegion: 'no-drag',
  };
}

export default function TitleBar({ navState, onBack, onForward, mode, activeFileName, detachedNum }) {
  // With a doc open the window names itself after the content. Empty: just the
  // app name, or "AMM Viewer (N)" for an empty detached window.
  const windowTitle = activeFileName
    ? `${activeFileName} — ${APP_NAME}`
    : (mode === 'detached' && detachedNum ? `${APP_NAME} (${detachedNum})` : APP_NAME);

  useEffect(() => { document.title = windowTitle; }, [windowTitle]);

  const canBack = !!navState?.canBack;
  const canForward = !!navState?.canForward;

  return (
    <div className="title-bar">
      <img src="../../icons/icon.png" alt="" />
      <span
        style={navBtnStyle(canBack)}
        onClick={() => canBack && onBack?.()}
        title="Back"
      >
        <svg width="12" height="12" viewBox="0 0 12 12"><polyline points="8,1 3,6 8,11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </span>
      <span
        style={navBtnStyle(canForward)}
        onClick={() => canForward && onForward?.()}
        title="Forward"
      >
        <svg width="12" height="12" viewBox="0 0 12 12"><polyline points="4,1 9,6 4,11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </span>
      <div className="title-middle">
        <span className="title-text" title={windowTitle}>{windowTitle}</span>
      </div>
      <div className="window-controls">
        <button onClick={() => window.arcenApi.windowMinimize()} title="Minimize">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button onClick={() => window.arcenApi.windowMaximize()} title="Maximize">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
        </button>
        <button className="close-window" onClick={() => window.arcenApi.windowClose()} title="Close">
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
      </div>
    </div>
  );
}
