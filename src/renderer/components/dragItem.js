// Mouse-based item drag (not HTML5 drag-and-drop). HTML5 DnD shows the OS
// "no-drop" cursor the moment the pointer leaves the window and can't hand a
// payload to another Electron window; tracking the mouse ourselves avoids both.
//
// startItemDrag(mouseDownEvent, {
//   onMove(clientX, clientY)  — during an active drag (for drop indicators)
//   onDrop({ screenX, screenY, clientX, clientY, inside, moved })
//   threshold                 — px before a press becomes a drag (default 5)
// })
export function startItemDrag(e, { onMove, onDrop, threshold = 5 } = {}) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;

  const move = (ev) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) <= threshold && Math.abs(ev.clientY - startY) <= threshold) return;
      dragging = true;
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
    }
    if (onMove) onMove(ev.clientX, ev.clientY);
  };

  const up = (ev) => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    if (dragging) {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Swallow the synthetic click the browser fires after mousedown→mouseup,
      // so a drag that ends over the original row doesn't also "click" it open.
      const swallow = (ce) => { ce.stopPropagation(); ce.preventDefault(); document.removeEventListener('click', swallow, true); };
      document.addEventListener('click', swallow, true);
      setTimeout(() => document.removeEventListener('click', swallow, true), 0);
    }
    const sx = ev.screenX;
    const sy = ev.screenY;
    const wx = window.screenX || 0;
    const wy = window.screenY || 0;
    const inside = sx >= wx && sx <= wx + window.outerWidth && sy >= wy && sy <= wy + window.outerHeight;
    if (onDrop) onDrop({ screenX: sx, screenY: sy, clientX: ev.clientX, clientY: ev.clientY, inside, moved: dragging });
  };

  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}
