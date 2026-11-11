/**
 * Context handed from the workbench into the Settings Center (settings
 * design SET-1: App only passes current project/session context; the
 * Settings business state stays inside this directory).
 */

import type { DesktopCapabilities } from '../../../../electron/shared/api-types';
import type { SettingsRoute } from './settingsRoutes';
import type { ProjectLike, SessionLike } from '../queries';

export interface ActiveRunSummary {
  runId: string;
  state: string;
  primaryReason?: string | null;
}

export interface SettingsPageContext {
  capabilities?: DesktopCapabilities;
  protocolVersion?: string | null;
  connection: string;
  session?: SessionLike | null;
  projects: ProjectLike[];
  /** Active/queued run of the current session, for mutation guards. */
  sessionActiveRun?: ActiveRunSummary | null;
  onOpenExtensions: () => void;
  /** Deep-link into another settings route (feature-card OPEN_SURFACE actions). */
  onOpenSettingsRoute?: (route: SettingsRoute) => void;
}

export const EMPTY_SETTINGS_CONTEXT: SettingsPageContext = {
  projects: [],
  connection: 'UNKNOWN',
  onOpenExtensions: () => undefined
};

/**
 * Capability gate for a Service operation (settings design §9.5).
 * A missing handshake cannot verify operations, so it never blocks here —
 * the Service-offline states cover that path. A present handshake with a
 * missing / not-AVAILABLE operation fails closed.
 */
export function operationGateAllows(capabilities: DesktopCapabilities | undefined, operationId: string): boolean {
  if (!capabilities) return true;
  const operation = (capabilities.operations ?? []).find((candidate) => candidate.id === operationId);
  return operation?.availability === 'AVAILABLE';
}
