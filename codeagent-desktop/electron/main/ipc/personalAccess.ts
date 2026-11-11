import { IPC_CHANNELS } from './channels';
import { validPersonalAccessOperation, type PersonalAccessOperation } from '../../../packages/client-access/src/operations';
import { AccessError } from '../../../packages/client-access/src/index';
import type { IpcDefinition, IpcRegistry } from './registry';

/**
 * UCA-001 C4 — `client-access/1` personal access channel.
 *
 * Same hardening shape as the PAE P8 personal channel: the channel admits only
 * the frozen operation whitelist, and main owns the connection binding, the
 * message/action binding and the idempotency identity. Errors come back as the
 * shared `{error, code, status}` proxy envelope so the renderer's `unwrap`
 * keeps the protocol code (for example `SOURCE_OUTCOME_UNCONFIRMED`) instead of
 * a generic IPC failure.
 */
export const personalAccessDefinition: IpcDefinition<PersonalAccessOperation> = {
  channel: IPC_CHANNELS.personalAccess,
  validate: (payload) => validPersonalAccessOperation(payload)
    ? { ok: true, value: payload }
    : { ok: false, reason: 'Invalid bounded personal access operation' }
};

export function createPersonalAccessHandler(
  registry: IpcRegistry,
  execute: (operation: PersonalAccessOperation) => Promise<unknown>
): (senderUrl: string | undefined, payload: unknown) => Promise<unknown> {
  return async (senderUrl, payload) => {
    const admission = registry.admit(IPC_CHANNELS.personalAccess, senderUrl, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    try {
      return await execute(admission.value as PersonalAccessOperation);
    } catch (error) {
      if (error instanceof AccessError) {
        return { error: error.code, code: error.code, status: error.status };
      }
      return {
        error: error instanceof Error ? error.message : 'personal access operation failed',
        code: 'PROXY_FAILED'
      };
    }
  };
}
