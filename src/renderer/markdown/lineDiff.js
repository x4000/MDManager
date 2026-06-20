// Line-level diff: which lines of `currentText` differ from `savedText`.
// Ported from AXE's seqDiff — LCS with O(NM) DP, but with common prefix/suffix
// stripped first so typical edits only diff the changed middle. Returns a Set of
// 0-based line indices in the current text. Used to mark edited lines in the
// scrollbar overview.

function seqDiff(savedLines, currentLines) {
  const changed = new Set();
  const n = savedLines.length;
  const m = currentLines.length;

  if (n === 0) { for (let i = 0; i < m; i++) changed.add(i); return changed; }
  if (m === 0) return changed;

  let prefix = 0;
  while (prefix < n && prefix < m && savedLines[prefix] === currentLines[prefix]) prefix++;

  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix &&
         savedLines[n - 1 - suffix] === currentLines[m - 1 - suffix]) suffix++;

  const sn = n - prefix - suffix;
  const sm = m - prefix - suffix;

  if (sn === 0 && sm === 0) return changed;        // identical
  if (sn === 0) { for (let i = prefix; i < prefix + sm; i++) changed.add(i); return changed; } // pure insertion
  if (sm === 0) return changed;                     // pure deletion (nothing to mark)

  // Very large middles: greedy sequential match instead of full DP.
  if (sn * sm > 25000000) {
    const savedMap = new Map();
    for (let i = 0; i < sn; i++) {
      const line = savedLines[prefix + i];
      if (!savedMap.has(line)) savedMap.set(line, []);
      savedMap.get(line).push(i);
    }
    let lastMatch = -1;
    const matched = new Set();
    for (let ci = 0; ci < sm; ci++) {
      const positions = savedMap.get(currentLines[prefix + ci]);
      if (positions) {
        for (const si of positions) { if (si > lastMatch) { matched.add(ci); lastMatch = si; break; } }
      }
    }
    for (let ci = 0; ci < sm; ci++) if (!matched.has(ci)) changed.add(prefix + ci);
    return changed;
  }

  // DP LCS over the differing middle, then backtrack for the kept lines.
  const dp = [];
  for (let si = 0; si <= sn; si++) dp[si] = new Uint16Array(sm + 1);
  for (let si = 1; si <= sn; si++) {
    for (let ci = 1; ci <= sm; ci++) {
      if (savedLines[prefix + si - 1] === currentLines[prefix + ci - 1]) dp[si][ci] = dp[si - 1][ci - 1] + 1;
      else dp[si][ci] = Math.max(dp[si - 1][ci], dp[si][ci - 1]);
    }
  }
  const inLCS = new Set();
  let si = sn, ci = sm;
  while (si > 0 && ci > 0) {
    if (savedLines[prefix + si - 1] === currentLines[prefix + ci - 1]) { inLCS.add(prefix + ci - 1); si--; ci--; }
    else if (dp[si - 1][ci] >= dp[si][ci - 1]) si--;
    else ci--;
  }
  for (let i = 0; i < sm; i++) if (!inLCS.has(prefix + i)) changed.add(prefix + i);
  return changed;
}

// Public entry: returns a Set of 0-based changed line indices, or an empty Set
// when there's no baseline or nothing changed.
export function changedLineSet(savedText, currentText) {
  if (currentText == null) return new Set();
  if (savedText == null || savedText === currentText) return new Set();
  return seqDiff(savedText.split('\n'), currentText.split('\n'));
}
