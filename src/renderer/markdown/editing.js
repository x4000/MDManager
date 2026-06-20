// Pure helpers for Markdown authoring affordances in the Source editor.

// Given the text of the line the caret is on, decide what pressing Enter should
// do for list continuation:
//   - { exit: true }      → the item is empty; clear the marker (leave the list)
//   - { marker: string }  → start a new item with this leading marker
//   - null                → not a list line; use the editor's default Enter
// Handles unordered (-, *, +), task lists (- [ ]), and ordered (1. / 1)) lists,
// preserving indentation and incrementing the ordinal.
export function listContinuation(lineText) {
  const ul = /^(\s*)([-*+])(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(lineText);
  if (ul) {
    const [, indent, bullet, sp, check, content] = ul;
    if (!content.trim()) return { exit: true };
    return { marker: `${indent}${bullet}${sp}${check ? '[ ] ' : ''}` };
  }
  const ol = /^(\s*)(\d+)([.)])(\s+)(.*)$/.exec(lineText);
  if (ol) {
    const [, indent, num, delim, sp, content] = ol;
    if (!content.trim()) return { exit: true };
    return { marker: `${indent}${(parseInt(num, 10) || 0) + 1}${delim}${sp}` };
  }
  return null;
}
