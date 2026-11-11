import { IPC_CHANNELS } from './channels';
import { validWritableOperation, type WritableOperation } from '../../../packages/protocol/src/writable-collaboration';
import type { IpcDefinition, IpcRegistry } from './registry';
export const writableCollaborationDefinition: IpcDefinition<WritableOperation> = { channel: IPC_CHANNELS.writableCollaboration, validate: payload => validWritableOperation(payload) ? { ok: true, value: payload } : { ok: false, reason: 'Invalid bounded writable collaboration use case' } };
export function createWritableCollaborationHandler(registry: IpcRegistry, execute: (operation: WritableOperation) => Promise<unknown>): (senderUrl: string | undefined, payload: unknown) => Promise<unknown> {
  return async (senderUrl, payload) => { const admission = registry.admit(IPC_CHANNELS.writableCollaboration, senderUrl, payload); if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' }; return execute(admission.value as WritableOperation); };
}
