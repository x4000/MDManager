import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownView from './MarkdownView';
import SourceView from './SourceView';
import ScaleControl from './ScaleControl';
import OutlinePanel from './OutlinePanel';
import { extractHeadings, buildOutline } from '../markdown/outline';
import { changedLineSet } from '../markdown/lineDiff';

// Wraps the active document: the optional same-file Reference Panel (on top),
// the main view, the Read/Source + reference + outline toggles, the optional
// resizable outline rail (right), and the scale chip.
export default function DocumentArea({
  doc, mode, scale, theme, refPanel, scrollMapRef, gotoLine, gotoSeq, text, savedText, onChange,
  onScrollCapture, onOpenAbsPath, onSetMode, onToggleRef, onCommitRefHeight, onChangeScale,
  outlineOpen, onToggleOutline, onGotoLine, outlineWidth, onResizeOutline, outlineDepth, onSetOutlineDepth, search,
}) {
  const docKey = `${doc.rootPath}|${doc.relPath}`;
  // Scroll memory is per (doc, mode, pane) so Read and Source remember
  // independent positions and the reference pane keeps its own spot.
  const mainKey = `${docKey}::${mode}`;
  const refKey = `${docKey}::${mode}::ref`;
  const areaRef = useRef(null);
  const [refHeight, setRefHeight] = useState((refPanel && refPanel.height) || 260);

  // Edited lines (differ from the last-saved content) for the scrollbar overview.
  // Debounced so diffing stays off the keystroke path.
  const [changedLines, setChangedLinesState] = useState(() => new Set());
  useEffect(() => {
    const t = setTimeout(() => setChangedLinesState(changedLineSet(savedText, text)), 200);
    return () => clearTimeout(t);
  }, [text, savedText]);
  const changedArr = useMemo(() => Array.from(changedLines).sort((a, b) => a - b), [changedLines]);

  const headings = useMemo(() => extractHeadings(text), [text]);
  const outline = useMemo(() => buildOutline(headings, outlineDepth), [headings, outlineDepth]);

  // The active outline item = the last shown heading at/above the line currently
  // at the top of the view (reported by the main view as the user scrolls).
  const [currentLine, setCurrentLine] = useState(0);
  const onCurrentLine = useCallback((l) => setCurrentLine(l), []);
  const activeLine = useMemo(() => {
    let a = null;
    for (const h of outline) { if (h.line <= currentLine) a = h.line; else break; }
    return a;
  }, [outline, currentLine]);

  // Drag the rail's left edge to resize (it's docked right, so moving left grows it).
  const startOutlineResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = outlineWidth || 220;
    let latest = startWidth;
    const onMove = (ev) => {
      latest = Math.max(140, Math.min(520, startWidth - (ev.clientX - startX)));
      onResizeOutline(latest, false);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onResizeOutline(latest, true);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const renderView = (vkey, withGoto) => {
    const common = {
      rootPath: doc.rootPath, relPath: doc.relPath, theme, scale, text,
      scrollKey: vkey, initialScrollTop: scrollMapRef.current[vkey], onScrollCapture,
    };
    if (mode === 'source') {
      return <SourceView {...common} editable={withGoto} onChange={withGoto ? onChange : undefined} onCurrentLine={withGoto ? onCurrentLine : undefined} gotoLine={withGoto ? gotoLine : null} gotoSeq={withGoto ? gotoSeq : 0} search={withGoto ? search : undefined} changedLines={withGoto ? changedArr : undefined} />;
    }
    return <MarkdownView {...common} onOpenAbsPath={onOpenAbsPath} onCurrentLine={withGoto ? onCurrentLine : undefined} gotoLine={withGoto ? gotoLine : null} gotoSeq={withGoto ? gotoSeq : 0} showBacklinks={withGoto} search={withGoto ? search : undefined} changedLines={withGoto ? changedArr : undefined} />;
  };

  // Reference panel sits on top; dragging the divider DOWN grows it.
  const startRefResize = (e) => {
    e.preventDefault();
    const area = areaRef.current;
    const startY = e.clientY;
    const startH = refHeight;
    let latest = startH;
    const onMove = (ev) => {
      const max = area ? area.clientHeight - 120 : 1000;
      latest = Math.max(100, Math.min(max, startH + (ev.clientY - startY)));
      setRefHeight(latest);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onCommitRefHeight(docKey, latest);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const open = !!(refPanel && refPanel.open);

  return (
    <div className="doc-area" ref={areaRef}>
      <div className="doc-content">
        {open && (
          <>
            <div className="ref-panel" style={{ height: refHeight }}>
              <div className="ref-panel-head">
                <span>Reference — same document</span>
                <button className="icon-btn" title="Close reference panel" onClick={() => onToggleRef(docKey)}>×</button>
              </div>
              <div className="ref-panel-body">{renderView(refKey, false)}</div>
            </div>
            <div className="ref-divider" onMouseDown={startRefResize} title="Drag to resize" />
          </>
        )}

        <div className="doc-main">
          <div className="doc-controls">
            <div className="seg">
              <button className={mode !== 'source' ? 'active' : ''} onClick={() => onSetMode(docKey, 'read')}>Read</button>
              <button className={mode === 'source' ? 'active' : ''} onClick={() => onSetMode(docKey, 'source')}>Source</button>
            </div>
            <button
              className={'doc-ctrl-btn' + (open ? ' active' : '')}
              title="Toggle reference panel (a second view of this document)"
              onClick={() => onToggleRef(docKey)}
            >
              ⊟
            </button>
            <button
              className={'doc-ctrl-btn' + (outlineOpen ? ' active' : '')}
              title="Toggle outline (document headings)"
              onClick={onToggleOutline}
            >
              ☰
            </button>
          </div>
          {renderView(mainKey, true)}
        </div>
      </div>

      {outlineOpen && (
        <>
          <div className="outline-resize-handle" onMouseDown={startOutlineResize} title="Drag to resize" />
          <OutlinePanel
            headings={outline}
            activeLine={activeLine}
            depth={outlineDepth}
            width={outlineWidth || 220}
            onSelect={(line) => { if (onGotoLine) onGotoLine(line); }}
            onSetDepth={onSetOutlineDepth}
            onClose={onToggleOutline}
          />
        </>
      )}

      <ScaleControl scale={scale} onChange={onChangeScale} />
    </div>
  );
}
