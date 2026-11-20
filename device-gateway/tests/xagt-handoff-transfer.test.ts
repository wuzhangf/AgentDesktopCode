import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { advancePeerImport, type HandoffJson } from '../src/xagt/handoff-transfer.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

function fixture() {
  const bytes = Buffer.from('handoff-material\n'.repeat(300), 'utf8');
  const relName = 'notes.txt';
  const item = { relName, type: 'text/plain', sizeBytes: bytes.length, sha256: sha(bytes.toString()) };
  const manifest: HandoffJson = {
    schemaVersion: 'work-handoff/1', handoffId: 'wh-transfer-1', requestKey: 'rk-source-1',
    sourceRef: { kind: 'WORKER_LOCAL', storeId: 'source-store', taskId: 'task-1' },
    targetAgentRef: { hostKey: 'target-host', kind: 'WORKER_LOCAL', storeId: 'target-store',
      projectRef: 'project-1', engineId: 'sage-pi' },
    materialRevision: 1, materialDigest: 'a'.repeat(64), items: [item],
  };
  const sourceView: HandoffJson = {
    schemaVersion: 'work-handoff-materials/1', handoffId: 'wh-transfer-1', manifest,
    sealProof: { scheme: 'RSA-SHA256-FROZEN-1', signature: 'sig', sourceKeyId: 'kid-1' },
  };
  let importId: string | undefined;
  let importRequestKey: string | undefined;
  let offset = 0;
  let phase = 'STAGED';
  let targetTaskRef: string | undefined;
  let report: HandoffJson | undefined;
  const sourceGet = async (tail: string[], query?: string): Promise<HandoffJson> => {
    if (tail.length === 2 && tail[1] === 'materials') return sourceView;
    if (tail.at(-1) === 'chunks') {
      expect(tail).toEqual(['wh-transfer-1', 'materials', relName, 'chunks']);
      expect(query).toBe(`digest=${item.sha256}&offset=${offset}`);
      return {
        relName, offset, sizeBytes: bytes.length, sha256: item.sha256,
        chunkSHA256: sha(bytes.toString()), bytes: bytes.toString('base64'), nextOffset: bytes.length,
      };
    }
    throw new Error(`unexpected source path ${tail.join('/')}`);
  };
  const targetCall = async (
    method: string, tail: string[], body?: HandoffJson, key?: string,
  ): Promise<HandoffJson> => {
    if (method === 'GET' && tail.length === 1 && tail[0] === 'imports') {
      return { items: importId === undefined ? [] : [{ importId, requestKey: importRequestKey, phase }] };
    }
    if (method === 'POST' && tail.length === 1 && tail[0] === 'imports') {
      expect(key).toMatch(/^imp-[a-f0-9]{24}$/);
      expect(body?.requestKey).toBe(key);
      importRequestKey = key;
      importId = 'imp-target-1';
      return { importId, requestKey: key, phase };
    }
    if (method === 'GET' && tail[0] === 'imports' && tail[1] === importId) {
      return {
        importId, requestKey: importRequestKey, phase, targetTaskRef,
        materials: [{ ...item, receivedBytes: offset, complete: offset === bytes.length }],
        ...(report === undefined ? {} : { consumptionReport: report }),
      };
    }
    if (method === 'POST' && tail.at(-1) === 'materials') {
      expect(key).toMatch(/^chunk-[a-f0-9]{64}$/);
      expect(body).toMatchObject({ relName, offset: 0, chunkDigest: sha(bytes.toString()) });
      offset = bytes.length;
      return {
        importId, requestKey: importRequestKey, phase,
        materials: [{ ...item, receivedBytes: offset, complete: true }],
      };
    }
    if (method === 'POST' && tail.at(-1) === 'start') {
      expect(key).toBe(`handoff:${importRequestKey}:START`);
      expect(body).toEqual({ requestKey: key });
      phase = 'STARTED';
      targetTaskRef = 'target-task-1';
      return { importId, requestKey: importRequestKey, phase, targetTaskRef };
    }
    throw new Error(`unexpected target call ${method} ${tail.join('/')}`);
  };
  return {
    input: { handoffId: 'wh-transfer-1', requestKey: 'rk-source-1', sourceHostRef: 'source-host', sourceGet, targetCall },
    size: bytes.length,
    complete: () => {
      report = {
        scheme: 'RSA-SHA256', sourceKeyId: 'target-kid', importId, handoffId: 'wh-transfer-1',
        targetTaskRef, evidenceDigest: 'b'.repeat(64), verifiedAt: Date.now(), signature: 'signed',
      };
    },
  };
}

describe('advancePeerImport', () => {
  it('creates, transfers one bounded chunk, starts, and only then returns TAKEN_OVER', async () => {
    const state = fixture();
    const created = await advancePeerImport(state.input);
    expect(created.state).toBe('STAGED');
    const transferred = await advancePeerImport(state.input);
    expect(transferred.nextOffset).toBe(state.size);
    const started = await advancePeerImport(state.input);
    expect(started.state).toBe('STARTED');
    expect(started.importBinding).toBeUndefined();
    state.complete();
    const takenOver = await advancePeerImport(state.input);
    expect(takenOver.state).toBe('TAKEN_OVER');
    expect(takenOver.importBinding?.targetTaskRef).toBe('target-task-1');
  });

  it('reconciles a lost create response by discovering the deterministic import key', async () => {
    const state = fixture();
    let first = true;
    const original = state.input.targetCall;
    state.input.targetCall = async (method, tail, body, key) => {
      const result = await original(method, tail, body, key);
      if (first && method === 'POST' && tail.length === 1) {
        first = false;
        throw new Error('reply lost after target committed');
      }
      return result;
    };
    await expect(advancePeerImport(state.input)).rejects.toThrow('reply lost');
    const recovered = await advancePeerImport(state.input);
    expect(recovered.state).toBe('STAGED');
  });
});
