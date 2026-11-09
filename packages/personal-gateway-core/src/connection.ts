/**
 * Registry surface shared between the persistent management store and the
 * connection hub. Extracted so standalone gateways can depend on the hub
 * without the SQLite-backed store.
 */
export interface ConnectionRow {
  connectionId: string; kind: string; displayName?: string; baseUrl?: string;
  tokenRef?: string; envBaseUrl?: string; envTokenRef?: string;
  registeredAt: string; updatedAt: string; revision: number;
}
export interface ProjectRow {
  projectId: string; projectRef: string; connectionId: string; displayName?: string;
  notes?: string; registeredAt: string; updatedAt: string; revision: number;
}
/** Minimal registry surface ConnectionHub depends on; ManagementStore satisfies it structurally. */
export interface ConnectionRegistry {
  upsertConnection(input: { connectionId: string; kind: string; displayName?: string; baseUrl?: string; tokenRef?: string; envBaseUrl?: string; envTokenRef?: string }): ConnectionRow;
  getConnection(connectionId: string): ConnectionRow | undefined;
  listConnections(): ConnectionRow[];
  getProject(projectId: string): ProjectRow | undefined;
}
