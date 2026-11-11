/**
 * Section-level draft lifecycle for the Settings Center
 * (settings design §7.2/§7.3/§8.3).
 *
 * One hook per authoritative section (never a global form): the base is the
 * last authoritative response, the draft is the local edit, and save always
 * carries the base revision. External base updates replace a clean draft and
 * are flagged as REMOTE_CHANGED next to a dirty one — the draft is never
 * silently overwritten. Conflicts keep the draft; only an explicit reload
 * adopts the server state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type SettingsScope = 'MANAGED' | 'SERVICE_INSTANCE' | 'PROJECT' | 'USER' | 'SESSION';

export type DraftSaveState = 'CLEAN' | 'DIRTY' | 'SAVING' | 'CONFLICT' | 'ERROR';

export interface SettingsDraftHandle<T extends object> {
  /** null while the authoritative base has not arrived yet */
  draft: T | null;
  dirtyFields: ReadonlySet<string>;
  saveState: DraftSaveState;
  /** the authoritative base moved while a draft existed */
  remoteChanged: boolean;
  /** conflict projection: server revision vs the revision the edit was based on */
  conflict: { baseRevision: number | undefined } | null;
  errorMessage: string | null;
  /** true briefly after a successful save, for the §7.3 feedback line */
  saveSuccess: boolean;
  hasChanges: boolean;
  setField<K extends keyof T & string>(field: K, value: T[K]): void;
  discard(): void;
  save(): void;
  /** user accepted the server state after a conflict or remote change */
  adoptServerState(): void;
}

export interface SettingsDraftOptions<T extends object> {
  base: T | undefined;
  baseRevision?: number;
  /** performs the section mutation; resolves with the new authoritative value */
  onSave: (draft: T, baseRevision?: number) => Promise<T>;
  /**
   * Error fragments that identify a revision/ version conflict. Any other
   * error becomes a generic section error; the draft is kept either way.
   */
  conflictMarkers?: string[];
}

export function useSettingsDraft<T extends object>(
  options: SettingsDraftOptions<T>
): SettingsDraftHandle<T> {
  const { base, baseRevision, onSave, conflictMarkers = ['STATE_VERSION_CONFLICT', 'CONFLICT'] } = options;
  const [draft, setDraft] = useState<T | null>(base ?? null);
  const [dirtyFields, setDirtyFields] = useState<ReadonlySet<string>>(new Set());
  const [saveState, setSaveState] = useState<DraftSaveState>('CLEAN');
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [conflict, setConflict] = useState<{ baseRevision: number | undefined } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;
  const baseRef = useRef(base);
  const baseKeyRef = useRef<string>(JSON.stringify(base ?? null));
  const savingRef = useRef(false);

  // New authoritative base: adopt it when the draft is clean (or while an
  // error is shown); otherwise only flag remoteChanged over a kept draft.
  // Pages build the base object inline, so identity is unstable — compare
  // by content instead, or every render would look like a remote update.
  // The very first arrival (previously "no base at all") is always an
  // adoption: there is no draft to protect yet.
  const baseKey = JSON.stringify(base ?? null);
  useEffect(() => {
    if (base === undefined) return;
    const isFirstBase = baseKeyRef.current === 'null';
    if (baseKeyRef.current === baseKey) return;
    baseKeyRef.current = baseKey;
    baseRef.current = base;
    if (isFirstBase || saveStateRef.current === 'CLEAN' || saveStateRef.current === 'ERROR') {
      setDraft(base);
      setDirtyFields(new Set());
      setSaveState('CLEAN');
      setRemoteChanged(false);
      setConflict(null);
      setErrorMessage(null);
    } else {
      setRemoteChanged(true);
    }
  }, [base, baseKey]);

  const setField = useCallback(<K extends keyof T & string>(field: K, value: T[K]) => {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, [field]: value };
      setDirtyFields((fields) => {
        const updated = new Set(fields);
        if (!Object.is(next[field], baseRef.current?.[field])) {
          updated.add(field);
        } else {
          updated.delete(field);
        }
        if (updated.size === 0) {
          setSaveState('CLEAN');
        } else if (saveStateRef.current !== 'SAVING') {
          setSaveState('DIRTY');
        }
        return updated;
      });
      setSaveSuccess(false);
      setConflict(null);
      setErrorMessage(null);
      return next;
    });
  }, []);

  const discard = useCallback(() => {
    if (!baseRef.current) return;
    setDraft(baseRef.current);
    setDirtyFields(new Set());
    setSaveState('CLEAN');
    setRemoteChanged(false);
    setConflict(null);
    setErrorMessage(null);
    setSaveSuccess(false);
  }, []);

  const adoptServerState = useCallback(discard, [discard]);

  const save = useCallback(() => {
    if (!draft || savingRef.current || dirtyFields.size === 0) return;
    savingRef.current = true;
    setSaveState('SAVING');
    setErrorMessage(null);
    onSave(draft, baseRevision)
      .then((authoritative) => {
        savingRef.current = false;
        baseRef.current = authoritative;
        setDraft(authoritative);
        setDirtyFields(new Set());
        setSaveState('CLEAN');
        setRemoteChanged(false);
        setConflict(null);
        setSaveSuccess(true);
      })
      .catch((err: unknown) => {
        savingRef.current = false;
        const message = err instanceof Error ? err.message : String(err);
        const isConflict = conflictMarkers.some((marker) => message.includes(marker));
        if (isConflict) {
          setSaveState('CONFLICT');
          setConflict({ baseRevision });
        } else {
          setSaveState('ERROR');
          setErrorMessage(message);
        }
      });
  }, [draft, dirtyFields.size, onSave, baseRevision, conflictMarkers]);

  return {
    draft,
    dirtyFields,
    saveState,
    remoteChanged,
    conflict,
    errorMessage,
    saveSuccess,
    hasChanges: dirtyFields.size > 0,
    setField,
    discard,
    save,
    adoptServerState
  };
}
