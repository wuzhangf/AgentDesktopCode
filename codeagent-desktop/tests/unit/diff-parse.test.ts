import { describe, expect, it } from 'vitest';
import { parseUnifiedPatch } from '../../src/renderer/app/diff/diffParse';

describe('parseUnifiedPatch (U4 §8.1)', () => {
  it('assigns old/new line numbers per line kind', () => {
    const patch = [
      '@@ -10,3 +10,4 @@ func main()',
      ' ctx-a',
      '-old',
      '+new',
      '+newer'
    ].join('\n');
    const rows = parseUnifiedPatch(patch);
    expect(rows[0]).toMatchObject({ kind: 'hunk' });
    expect(rows[1]).toMatchObject({ kind: 'ctx', oldNo: 10, newNo: 10 });
    expect(rows[2]).toMatchObject({ kind: 'del', oldNo: 11, newNo: null });
    expect(rows[3]).toMatchObject({ kind: 'add', oldNo: null, newNo: 11 });
    expect(rows[4]).toMatchObject({ kind: 'add', oldNo: null, newNo: 12 });
  });

  it('resets numbering at every hunk header', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '@@ -50,2 +48,2 @@',
      ' c',
      '+d'
    ].join('\n');
    const rows = parseUnifiedPatch(patch);
    expect(rows[3]).toMatchObject({ kind: 'hunk' });
    expect(rows[4]).toMatchObject({ kind: 'ctx', oldNo: 50, newNo: 48 });
    expect(rows[5]).toMatchObject({ kind: 'add', oldNo: null, newNo: 49 });
  });

  it('keeps "\\ No newline at end of file" unnumbered', () => {
    const patch = ['@@ -1,2 +1,1 @@', ' a', '-b', '\\ No newline at end of file'].join('\n');
    const rows = parseUnifiedPatch(patch);
    expect(rows[3]).toMatchObject({ kind: 'meta', oldNo: null, newNo: null });
  });

  it('numbers a delete-only file with new-side numbers empty', () => {
    const patch = ['@@ -1,2 +0,0 @@', '-x', '-y'].join('\n');
    const rows = parseUnifiedPatch(patch);
    expect(rows[1]).toMatchObject({ kind: 'del', oldNo: 1, newNo: null });
    expect(rows[2]).toMatchObject({ kind: 'del', oldNo: 2, newNo: null });
  });

  it('returns an empty list for an empty patch', () => {
    expect(parseUnifiedPatch('')).toEqual([{ kind: 'meta', oldNo: null, newNo: null, sign: '', text: '' }]);
  });

  it('marks file headers and prologue lines as unnumbered', () => {
    const patch = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n');
    const rows = parseUnifiedPatch(patch);
    expect(rows[0]?.kind).toBe('meta');
    expect(rows[1]?.kind).toBe('file');
    expect(rows[2]?.kind).toBe('file');
    expect(rows[4]).toMatchObject({ kind: 'del', oldNo: 1 });
  });
});
