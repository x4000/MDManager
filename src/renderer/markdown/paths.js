// Small path helpers for the renderer (no Node `path` available here).
// All operate on forward-slashed strings.

export function normSlashes(p) {
  return (p || '').replace(/\\/g, '/');
}

export function dirOf(absPath) {
  const p = normSlashes(absPath);
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : p;
}

export function basenameOf(p) {
  const s = normSlashes(p);
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// Resolve `rel` against `baseDir`, collapsing '.' and '..'. Drive letters
// (e.g. "D:") survive as the first segment. Surplus '..' is clamped at the
// root: it can never pop the leading drive/root segment or escape past it
// (which would otherwise drop the drive letter and yield a corrupt path).
export function resolveRelative(baseDir, rel) {
  const combined = `${normSlashes(baseDir)}/${normSlashes(rel)}`;
  const segs = combined.split('/').filter((s) => s !== '' && s !== '.');
  const out = [];
  for (const s of segs) {
    if (s === '..') {
      if (out.length > 1) out.pop();
    } else {
      out.push(s);
    }
  }
  return out.join('/');
}

export function toFileUrl(absPath) {
  return encodeURI(`file:///${normSlashes(absPath)}`);
}

// True for bare relative refs (no scheme, not protocol-relative, not anchor).
export function isRelativeRef(ref) {
  if (!ref) return false;
  if (ref.startsWith('#')) return false;
  if (ref.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(ref);
}

export function isExternalRef(ref) {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith('file:');
}

// Split "path#frag" / "path?q" into [pathPart, fragment].
export function splitHash(ref) {
  const h = ref.indexOf('#');
  if (h < 0) return [ref, ''];
  return [ref.slice(0, h), ref.slice(h + 1)];
}
