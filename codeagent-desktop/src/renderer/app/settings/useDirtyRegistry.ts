/**
 * Dirty-state registry for Settings navigation guard (settings design §7.4).
 *
 * Kept separate from SettingsCenter so section pages can report dirty state
 * without a circular import. The shell owns the registry; pages only call
 * useReportDirty, and leaving a dirty category asks for an inline confirm —
 * never a blocking window.confirm().
 */

import { createContext, useContext, useEffect } from 'react';
import type { SettingsRoute } from './settingsRoutes';

export interface SettingsDirtyRegistry {
  registerDirty: (route: SettingsRoute, dirty: boolean) => void;
}

export const SettingsDirtyContext = createContext<SettingsDirtyRegistry>({
  registerDirty: () => undefined
});

/** Hook for section pages: report the current dirty flag to the shell. */
export function useReportDirty(route: SettingsRoute, hasChanges: boolean): void {
  const { registerDirty } = useContext(SettingsDirtyContext);
  useEffect(() => {
    registerDirty(route, hasChanges);
    return () => registerDirty(route, false);
  }, [registerDirty, route, hasChanges]);
}
