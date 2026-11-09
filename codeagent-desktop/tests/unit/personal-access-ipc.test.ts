/**
 * UCA-001 C4: admission for the `app/personal-access` channel.
 *
 * The renderer may only submit the frozen operation shapes. Everything that
 * decides trust — origin, token, CA, message binding, action binding,
 * idempotency key — stays on the main side, so these rejections are part of
 * the security boundary and not just input hygiene.
 */
import { describe, expect, it } from 'vitest';
import { IpcRegistry } from '../../electron/main/ipc/registry';
import { IPC_CHANNELS } from '../../electron/main/ipc/channels';
import { createPersonalAccessHandler, personalAccessDefinition } from '../../electron/main/ipc/personalAccess';
import { validPersonalAccessOperation } from '../../packages/client-access/src/operations';

const AGENT = 'a1.agent';
const CONV = 'c1.conv';
const REPLY = 'r1.msg';
const SENDER = 'app://codeagent/index.html';

describe('personal access operation whitelist', () => {
  it('admits the frozen shapes', () => {
    const admitted: unknown[] = [
      { action: 'STATUS' },
      { action: 'CONNECT' },
      { action: 'DISCONNECT' },
      { action: 'AGENTS' },
      { action: 'CONFIGURE', origin: 'https://127.0.0.1:9443', basePath: '/personal/v1/client', caPemPath: 'C:/certs/pac.pem', token: 'tok' },
      { action: 'CONVERSATIONS', agentRef: AGENT },
      { action: 'CONVERSATION', conversationRef: CONV },
      { action: 'REPLIES', conversationRef: CONV, cursor: 'p1.abc' },
      { action: 'REPLIES', conversationRef: CONV, ifRevision: 'p1.abc' },
      { action: 'CONTENT', conversationRef: CONV, replyRef: REPLY, cursor: 'p1.abc' },
      { action: 'SEND', conversationRef: CONV, text: 'hello', requestId: 'req-1' },
      { action: 'ACTION', conversationRef: CONV, actionId: 'execution.stop', input: {}, requestId: 'req-2' },
      { action: 'ACTION', conversationRef: CONV, actionId: 'execution.supplement', input: { text: '补充' }, requestId: 'req-3' },
      { action: 'ACTION', conversationRef: CONV, actionId: 'input.respond', input: { decision: 'approve' }, requestId: 'req-4' },
      { action: 'LOOKUP', requestId: 'req-1' }
    ];
    for (const operation of admitted) {
      expect(validPersonalAccessOperation(operation), JSON.stringify(operation)).toBe(true);
    }
  });

  it('rejects anything outside the whitelist', () => {
    const rejected: unknown[] = [
      null,
      'STATUS',
      { action: 'FETCH', url: 'https://example.com' },
      { action: 'STATUS', extra: true },
      { action: 'CONFIGURE', origin: 'http://example.com' },
      { action: 'CONFIGURE', origin: 'https://user:pass@127.0.0.1' },
      { action: 'CONFIGURE', origin: 'https://127.0.0.1/path' },
      { action: 'CONFIGURE', origin: 'https://127.0.0.1', basePath: '/a//b' },
      { action: 'CONFIGURE', origin: 'https://127.0.0.1', token: 'bad\nheader' },
      { action: 'CONVERSATIONS', agentRef: 'not-a-ref' },
      { action: 'CONVERSATIONS', agentRef: `${AGENT}/../../admin` },
      { action: 'CONVERSATION', conversationRef: '' },
      { action: 'REPLIES', conversationRef: CONV, cursor: 'p1.a', ifRevision: 'p1.b' },
      { action: 'SEND', conversationRef: CONV, text: '   ', requestId: 'req-1' },
      { action: 'SEND', conversationRef: CONV, text: 'x'.repeat(8193), requestId: 'req-1' },
      { action: 'SEND', conversationRef: CONV, text: 'x', requestId: '../etc' },
      { action: 'SEND', conversationRef: CONV, text: 'x', requestId: 'req-1', binding: 'b1.forged' },
      { action: 'ACTION', conversationRef: CONV, actionId: 'shell.exec', input: {}, requestId: 'req-1' },
      { action: 'ACTION', conversationRef: CONV, actionId: 'execution.stop', input: { text: 'x' }, requestId: 'req-1' },
      { action: 'ACTION', conversationRef: CONV, actionId: 'execution.stop', input: {}, requestId: 'req-1', binding: 'b1.forged' },
      { action: 'ACTION', conversationRef: CONV, actionId: 'execution.supplement', input: { text: 'x', extra: 1 }, requestId: 'req-1' },
      { action: 'LOOKUP', requestId: 'bad id' }
    ];
    for (const operation of rejected) {
      expect(validPersonalAccessOperation(operation), JSON.stringify(operation)).toBe(false);
    }
  });
});

describe('personal access IPC handler', () => {
  function build(execute: (operation: unknown) => Promise<unknown>) {
    const registry = new IpcRegistry();
    registry.register(personalAccessDefinition);
    return createPersonalAccessHandler(registry, execute as never);
  }

  it('rejects an untrusted sender before the operation runs', async () => {
    let called = false;
    const handler = build(async () => { called = true; return {}; });
    const result = await handler('https://evil.example/index.html', { action: 'STATUS' });
    expect(result).toMatchObject({ code: 'IPC_REJECTED' });
    expect(called).toBe(false);
  });

  it('rejects an invalid payload before the operation runs', async () => {
    let called = false;
    const handler = build(async () => { called = true; return {}; });
    const result = await handler(SENDER, { action: 'SEND', conversationRef: CONV, text: 'x' });
    expect(result).toMatchObject({ code: 'IPC_REJECTED' });
    expect(called).toBe(false);
  });

  it('passes admitted operations through', async () => {
    const handler = build(async (operation) => ({ echo: operation }));
    const result = await handler(SENDER, { action: 'AGENTS' });
    expect(result).toEqual({ echo: { action: 'AGENTS' } });
  });

  it('maps protocol failures onto the shared proxy envelope', async () => {
    const handler = build(async () => {
      const { AccessError } = await import('../../packages/client-access/src/index');
      throw new AccessError('SOURCE_OUTCOME_UNCONFIRMED');
    });
    const result = await handler(SENDER, { action: 'AGENTS' });
    expect(result).toMatchObject({ code: 'SOURCE_OUTCOME_UNCONFIRMED', error: 'SOURCE_OUTCOME_UNCONFIRMED' });
  });

  it('keeps the channel name fixed', () => {
    expect(personalAccessDefinition.channel).toBe(IPC_CHANNELS.personalAccess);
    expect(IPC_CHANNELS.personalAccess).toBe('app/personal-access');
  });
});
