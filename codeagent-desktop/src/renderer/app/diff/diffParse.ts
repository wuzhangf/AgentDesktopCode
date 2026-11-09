/**
 * Minimal unified-diff parser (ui-polish-plan-2026-10 §8.1). Pure text
 * transform — no dependencies — so the view can render old/new line numbers
 * instead of a flat colored blob.
 */

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'ctx' | 'file' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number in the old file; null outside hunks / for add lines. */
  oldNo: number | null;
  /** 1-based line number in the new file; null outside hunks / for del lines. */
  newNo: number | null;
  sign: string;
  /** Content without the leading +/-/space marker. */
  text: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedPatch(patch: string): DiffLine[] {
  const rows: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', oldNo: null, newNo: null, sign: '', text: line });
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      rows.push({ kind: 'file', oldNo: null, newNo: null, sign: '', text: line });
      continue;
    }
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" — a note on the previous line; it does
      // not consume a line number itself.
      rows.push({ kind: 'meta', oldNo: null, newNo: null, sign: '', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', oldNo: null, newNo: inHunk ? newNo++ : null, sign: '+', text: line.slice(1) });
      continue;
    }
    if (line.startsWith('-')) {
      rows.push({ kind: 'del', oldNo: inHunk ? oldNo++ : null, newNo: null, sign: '-', text: line.slice(1) });
      continue;
    }
    if (!inHunk) {
      // Prologue before the first hunk (diff --git, index, …).
      rows.push({ kind: 'meta', oldNo: null, newNo: null, sign: '', text: line });
      continue;
    }
    const text = line.startsWith(' ') ? line.slice(1) : line;
    rows.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, sign: '', text });
  }
  return rows;
}
