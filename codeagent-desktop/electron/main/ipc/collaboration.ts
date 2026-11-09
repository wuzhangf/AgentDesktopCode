import { IPC_CHANNELS } from './channels';
import { validCollaborationOperation, type CollaborationOperation } from '../../../packages/protocol/src/collaboration';
import type { IpcDefinition } from './registry';

export const collaborationDefinition: IpcDefinition<CollaborationOperation> = {
  channel: IPC_CHANNELS.collaboration,
  validate: (payload) => validCollaborationOperation(payload)
    ? { ok: true, value: payload }
    : { ok: false, reason: 'Invalid bounded collaboration use case' }
};

/** Shared by Electron main and the real-candidate transport acceptance. */
export function createCollaborationHandler(registry: import('./registry').IpcRegistry,
  execute: (operation: CollaborationOperation) => Promise<unknown>): (senderUrl: string | undefined, payload: unknown) => Promise<unknown> {
  return async (senderUrl, payload) => {
    const admission = registry.admit(IPC_CHANNELS.collaboration, senderUrl, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return execute(admission.value as CollaborationOperation);
  };
}
