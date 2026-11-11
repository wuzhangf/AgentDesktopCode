import { describe, expect, it } from 'vitest';
import {
  toCanonicalSessionContract,
  validateSessionForm,
  type SessionCreateForm
} from '../../src/renderer/app/sessionContract';

const baseForm: SessionCreateForm = {
  intent: 'ASK',
  title: 'Explain auth',
  goal: 'Trace the authentication callback',
  autonomy: 'LOW',
  verification: 'NONE',
  workspaceAlias: 'sample'
};

describe('session contract mapper', () => {
  it('maps Ask to a read-only ACT contract', () => {
    expect(toCanonicalSessionContract(baseForm)).toEqual({
      title: 'Explain auth',
      workspaceAlias: 'sample',
      interactionMode: 'ACT',
      executionMode: 'INSPECT',
      autonomyLevel: 'OFF',
      verificationLevel: 'NONE',
      writeAllow: [],
      writeForbid: [],
      workspacePolicy: {
        mode: 'READ_ONLY_SNAPSHOT',
        startPolicy: 'CLEAN_HEAD'
      }
    });
  });

  it('maps workspace-free Ask to the lightweight ordinary-chat contract', () => {
    expect(toCanonicalSessionContract({
      ...baseForm,
      workspaceAlias: ''
    })).toEqual({
      title: 'Explain auth',
      interactionMode: 'ACT',
      executionMode: 'INSPECT',
      autonomyLevel: 'OFF',
      verificationLevel: 'NONE',
      writeAllow: [],
      writeForbid: []
    });
  });

  it('maps Code to a bounded write contract and upgrades unspecified verification', () => {
    expect(toCanonicalSessionContract({
      ...baseForm,
      intent: 'CODE',
      autonomy: 'MEDIUM',
      writeAllow: [' src ', '', 'tests/']
    })).toMatchObject({
      interactionMode: 'ACT',
      executionMode: 'MODIFY',
      autonomyLevel: 'MEDIUM',
      verificationLevel: 'VERIFY',
      writeAllow: ['src', 'tests/']
    });
    expect(toCanonicalSessionContract({
      ...baseForm,
      intent: 'CODE',
      autonomy: 'MEDIUM',
      writeAllow: ['src'],
      workspaceFingerprint: 'snapshot-1',
      preflightRevision: 'preflight-2'
    }).workspacePolicy).toEqual({
      mode: 'LOCAL_CHECKOUT',
      startPolicy: 'USER_WIP_SNAPSHOT',
      baseSnapshotFingerprint: 'snapshot-1',
      preflightRevision: 'preflight-2'
    });
  });

  it('fails closed for gated intents and invalid write scope', () => {
    expect(validateSessionForm({ ...baseForm, intent: 'PLAN' }, { ask: true, code: true, plan: false, mission: false }).valid).toBe(false);
    expect(validateSessionForm({ ...baseForm, intent: 'CODE', writeAllow: [] }).valid).toBe(false);
    expect(validateSessionForm({ ...baseForm, writeAllow: ['src'] }).valid).toBe(false);
  });
});
