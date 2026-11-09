import { IPC_CHANNELS } from './channels';
import { validPersonalOperation, type PersonalOperation } from '../../../packages/protocol/src/personal';
import type { IpcDefinition, IpcRegistry } from './registry';

/**
 * PAE P8 — personal management channel (writable-collaboration precedent).
 * The channel admits only the P0-frozen PersonalOperation whitelist
 * (validPersonalOperation); the handler dispatches to
 * ServiceClient.personalOperation which substitutes registered ids and
 * mirrors requestKey into the Idempotency-Key header. No arbitrary
 * URL/method/header ever crosses this boundary.
 */
export const personalDefinition: IpcDefinition<PersonalOperation> = {
  channel: IPC_CHANNELS.personal,
  validate: payload => validPersonalOperation(payload)
    ? { ok: true, value: payload }
    : { ok: false, reason: 'Invalid bounded personal gateway operation' },
};

export function createPersonalHandler(
  registry: IpcRegistry,
  execute: (operation: PersonalOperation) => Promise<unknown>,
): (senderUrl: string | undefined, payload: unknown) => Promise<unknown> {
  return async (senderUrl, payload) => {
    const admission = registry.admit(IPC_CHANNELS.personal, senderUrl, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return execute(admission.value as PersonalOperation);
  };
}
