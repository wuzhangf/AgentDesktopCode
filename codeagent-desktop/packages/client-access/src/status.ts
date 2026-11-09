/**
 * Connection status shared by main and the renderer.
 *
 * Deliberately secret-free: it reports whether a token is held and whether it
 * is persisted with OS encryption, never the token itself, never a header.
 */
export interface PersonalAccessManifestView {
  protocolVersion: string;
  storeId: string;
  authorizationRevision: string | null;
  features: { conversationCreate: boolean; replyContent: boolean };
}

export interface PersonalAccessStatus {
  configured: boolean;
  connected: boolean;
  origin?: string;
  basePath?: string;
  caPinned: boolean;
  encryptionAvailable: boolean;
  tokenPersisted: boolean;
  hasToken: boolean;
  manifest?: PersonalAccessManifestView;
}
