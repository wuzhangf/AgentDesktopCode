/**
 * Settings Center IPC admission tests (settings design §10.3/§17.4).
 * Freezes the security properties of the new channels: allowlist, trusted
 * sender, schema admission, expectedRevision and typed no-payload reads.
 */
import { describe, expect, it } from 'vitest';
import {
  IpcRegistry,
  preferencesGetDefinition,
  preferencesUpdateDefinition,
  modelsCatalogDefinition,
  diagnosticsRevealDefinition,
  diagnosticsCopyDefinition,
  aboutGetDefinition
} from '../../electron/main/ipc/registry';
import { IPC_CHANNELS } from '../../electron/main/ipc/channels';

const TRUSTED = 'app://codeagent/index.html';
const UNTRUSTED = 'https://evil.example/index.html';

function registryWith(): IpcRegistry {
  const registry = new IpcRegistry();
  registry.register(preferencesGetDefinition);
  registry.register(preferencesUpdateDefinition);
  registry.register(modelsCatalogDefinition);
  registry.register(diagnosticsRevealDefinition);
  registry.register(diagnosticsCopyDefinition);
  registry.register(aboutGetDefinition);
  return registry;
}

describe('settings center IPC admission', () => {
  it('rejects untrusted senders and unknown channels before validation', () => {
    const registry = registryWith();
    expect(registry.admit(IPC_CHANNELS.preferencesGet, UNTRUSTED, {}).ok).toBe(false);
    expect(registry.admit('app/preferences/unknown', TRUSTED, {}).ok).toBe(false);
  });

  it('admits the no-payload reads', () => {
    const registry = registryWith();
    for (const channel of [IPC_CHANNELS.preferencesGet, IPC_CHANNELS.modelsCatalog]) {
      expect(registry.admit(channel, TRUSTED, {}).ok).toBe(true);
    }
    // Fixed-intent diagnostics/about channels take no payload at all.
    for (const channel of [
      IPC_CHANNELS.diagnosticsReveal,
      IPC_CHANNELS.diagnosticsCopy,
      IPC_CHANNELS.aboutGet
    ]) {
      expect(registry.admit(channel, TRUSTED, undefined).ok).toBe(true);
      expect(registry.admit(channel, TRUSTED, { unexpected: true }).ok).toBe(false);
    }
  });

  it('admits a valid preferences update', () => {
    const registry = registryWith();
    const admission = registry.admit(IPC_CHANNELS.preferencesUpdate, TRUSTED, {
      expectedRevision: 4,
      notificationsEnabled: false,
      sendShortcut: 'MOD_ENTER',
      uiScalePercent: 125,
      codeFontSizePx: 15,
      reduceMotion: 'ON',
      theme: 'DARK',
      density: 'SUMMARY',
      language: 'zh-CN',
      restoreLastSurface: true
    });
    expect(admission.ok).toBe(true);
  });

  it('rejects unknown fields, bad enums, bad revisions and non-object payloads', () => {
    const registry = registryWith();
    expect(registry.admit(IPC_CHANNELS.preferencesUpdate, TRUSTED, {
      expectedRevision: 1, token: 'secret'
    }).ok).toBe(false);
    expect(registry.admit(IPC_CHANNELS.preferencesUpdate, TRUSTED, {
      expectedRevision: 1, theme: 'NEON'
    }).ok).toBe(false);
    expect(registry.admit(IPC_CHANNELS.preferencesUpdate, TRUSTED, {
      expectedRevision: 0
    }).ok).toBe(false);
    expect(registry.admit(IPC_CHANNELS.preferencesUpdate, TRUSTED, 'not-an-object').ok).toBe(false);
    expect(registry.admit(IPC_CHANNELS.preferencesUpdate, TRUSTED, null).ok).toBe(false);
  });
});
