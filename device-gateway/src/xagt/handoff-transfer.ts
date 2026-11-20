/**
 * One-step cross-host work-handoff material importer.
 *
 * This is deliberately a small transport-independent driver.  The caller
 * supplies the already authenticated source and target callbacks; the module
 * never opens a peer connection and never receives a peer credential.  Every
 * mutation has a deterministic key, and every continuation starts with the
 * target's authoritative import view.  Consequently a lost response cannot
 * cause a second import, a duplicate chunk, or a second target start.
 *
 * The wire shapes are the PAC `work-handoff/1` protocol used by
 * `pac_work_handoffs.dart`:
 *   GET  /personal/v1/work-handoffs/{id}/materials
 *   GET  /personal/v1/work-handoffs/{id}/materials/{relName}/chunks
 *   POST /personal/v1/work-handoffs/imports
 *   GET  /personal/v1/work-handoffs/imports/{importId}
 *   POST /personal/v1/work-handoffs/imports/{importId}/materials
 *   POST /personal/v1/work-handoffs/imports/{importId}/start
 */
import { createHash } from 'node:crypto';
import { xfail } from './common.js';

export type HandoffJson = Record<string, unknown>;

export type HandoffPath = string[];
export type HandoffSourceGet =
  (tail: HandoffPath, query?: string) => Promise<HandoffJson>;
export type HandoffTargetCall =
  (method: 'GET' | 'POST', tail: HandoffPath, body?: HandoffJson, key?: string) => Promise<HandoffJson>;

export interface AdvancePeerImportInput {
  handoffId: string;
  /** The original source handoff request key, not a newly generated key. */
  requestKey: string;
  /** The source PAC identity pinned by the caller's peer binding. */
  sourceHostRef: string;
  sourceGet: HandoffSourceGet;
  targetCall: HandoffTargetCall;
}

export interface ImportBinding {
  importId: string;
  targetTaskRef: string;
  consumptionReport?: HandoffJson;
}

export interface AdvancePeerImportResult {
  /** PAC phase, or TAKEN_OVER only after a valid signed consumption report. */
  state: string;
  handoffId: string;
  requestKey: string;
  sourceHostRef: string;
  importId?: string;
  targetTaskRef?: string;
  phase?: string;
  relName?: string;
  offset?: number;
  nextOffset?: number;
  /** Present only when C returned an authenticated, complete report. */
  importBinding?: ImportBinding;
  /** The last authenticated target view/result, useful for reconciliation UI. */
  targetView?: HandoffJson;
}

const MAX_ITEMS = 512;
const MAX_REL_NAME = 128;
const MAX_CHUNK_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const PATH_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const object = (value: unknown, message: string): HandoffJson => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    xfail('SOURCE_UNAVAILABLE', message);
  }
  return value as HandoffJson;
};

const requiredText = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    xfail('SOURCE_UNAVAILABLE', `交接响应的 ${name} 无效。`);
  }
  return value;
};

const pathId = (value: string, name: string): string => {
  if (!PATH_ID.test(value)) xfail('INVALID_REQUEST', `${name} 无效。`);
  return value;
};

const safeInt = (value: unknown, name: string): number => {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[0-9]{1,18}$/.test(value)
      ? Number(value)
      : NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    xfail('SOURCE_UNAVAILABLE', `交接响应的 ${name} 无效。`);
  }
  return n;
};

const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const keyDigest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const importKeyFor = (input: AdvancePeerImportInput, manifest: HandoffJson): string => {
  // A continuation generation is part of the source material contract.  It
  // prevents an old target import from being reused after a source material
  // continuation while retaining idempotency across process restarts.
  const generation = typeof manifest.materialContinuationKey === 'string'
    ? manifest.materialContinuationKey
    : '';
  // Keep this derivation identical to the Dart PAC driver: the original
  // source request key (plus a continuation generation, when present) is the
  // durable parent key; the target import gets a legal, bounded idempotency
  // key derived from it.
  const parentKey = generation === '' ? input.requestKey : `${input.requestKey}:${generation}`;
  return `imp-${keyDigest(parentKey).slice(0, 24)}`;
};

const materialItems = (manifest: HandoffJson): HandoffJson[] => {
  if (!Array.isArray(manifest.items) || manifest.items.length === 0
      || manifest.items.length > MAX_ITEMS) {
    xfail('SOURCE_UNAVAILABLE', '交接材料清单无效或超过上限。');
  }
  const items: HandoffJson[] = [];
  const names = new Set<string>();
  for (const raw of manifest.items) {
    const item = object(raw, '交接材料项无效。');
    const relName = requiredText(item.relName, 'relName');
    if (relName.length > MAX_REL_NAME || relName.includes('..')
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(relName)) {
      xfail('SOURCE_UNAVAILABLE', '交接材料路径无效。');
    }
    if (names.has(relName)) xfail('SOURCE_UNAVAILABLE', '交接材料路径重复。');
    names.add(relName);
    const sizeBytes = safeInt(item.sizeBytes, `${relName}.sizeBytes`);
    const sha256 = requiredText(item.sha256, `${relName}.sha256`).toLowerCase();
    if (!SHA256.test(sha256)) xfail('SOURCE_UNAVAILABLE', '交接材料摘要无效。');
    items.push({ ...item, relName, sizeBytes, sha256 });
  }
  return items;
};

const sourceMaterials = async (
  input: AdvancePeerImportInput,
): Promise<{ view: HandoffJson; manifest: HandoffJson; items: HandoffJson[] }> => {
  const view = object(
    await input.sourceGet([input.handoffId, 'materials']),
    '来源材料响应无效。',
  );
  const manifest = object(view.manifest, '来源未返回冻结签名清单。');
  if (manifest.schemaVersion !== 'work-handoff/1'
      || manifest.handoffId !== input.handoffId
      || manifest.requestKey !== input.requestKey) {
    xfail('MATERIAL_CHANGED', '来源清单与交接请求不一致。');
  }
  const materialDigest = requiredText(manifest.materialDigest, 'materialDigest').toLowerCase();
  if (!SHA256.test(materialDigest)) xfail('MATERIAL_CHANGED', '来源材料摘要无效。');
  const proof = object(view.sealProof, '来源未返回冻结材料签名证明。');
  if (proof.scheme !== 'RSA-SHA256-FROZEN-1'
      || typeof proof.signature !== 'string'
      || typeof proof.sourceKeyId !== 'string') {
    xfail('MATERIAL_CHANGED', '来源材料签名证明无效。');
  }
  return { view, manifest, items: materialItems(manifest) };
};

const importList = async (input: AdvancePeerImportInput, requestKey: string): Promise<HandoffJson | undefined> => {
  const list = object(await input.targetCall('GET', ['imports']), '目标导入列表响应无效。');
  if (!Array.isArray(list.items)) xfail('SOURCE_UNAVAILABLE', '目标导入列表无效。');
  for (const raw of list.items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as HandoffJson;
    if (row.requestKey === requestKey) return row;
  }
  return undefined;
};

const targetView = async (
  input: AdvancePeerImportInput,
  importId: string,
): Promise<HandoffJson> => object(
  await input.targetCall('GET', ['imports', pathId(importId, 'importId')]),
  '目标导入视图响应无效。',
);

const signedBinding = (
  input: AdvancePeerImportInput,
  view: HandoffJson,
  importId: string,
): ImportBinding | undefined => {
  const report = view.consumptionReport;
  const task = view.targetTaskRef;
  if (report === undefined || task === undefined) return undefined;
  const reportObject = object(report, '目标消费证明无效。');
  const targetTaskRef = requiredText(task, 'targetTaskRef');
  if (reportObject.scheme !== 'RSA-SHA256'
      || typeof reportObject.signature !== 'string'
      || typeof reportObject.sourceKeyId !== 'string'
      || reportObject.importId !== importId
      || reportObject.handoffId !== input.handoffId
      || reportObject.targetTaskRef !== targetTaskRef
      || !Number.isSafeInteger(reportObject.verifiedAt)) {
    xfail('SOURCE_UNAVAILABLE', '目标消费证明未通过绑定检查。');
  }
  return { importId, targetTaskRef, consumptionReport: reportObject };
};

const resultFor = (
  input: AdvancePeerImportInput,
  view: HandoffJson,
  importId: string,
  extra: Partial<AdvancePeerImportResult> = {},
): AdvancePeerImportResult => {
  const phase = typeof view.phase === 'string' ? view.phase : undefined;
  const binding = signedBinding(input, view, importId);
  return {
    state: binding ? 'TAKEN_OVER' : phase ?? 'UNKNOWN',
    handoffId: input.handoffId,
    requestKey: input.requestKey,
    sourceHostRef: input.sourceHostRef,
    importId,
    ...(typeof view.targetTaskRef === 'string' ? { targetTaskRef: view.targetTaskRef } : {}),
    ...(phase !== undefined ? { phase } : {}),
    ...(binding !== undefined ? { importBinding: binding } : {}),
    targetView: view,
    ...extra,
  };
};

/**
 * Advance exactly one bounded target mutation (create, one chunk, or start).
 * Reads may be repeated to reconcile a lost response; no local state is
 * required and no complete material is retained in this module.
 */
export async function advancePeerImport(
  input: AdvancePeerImportInput,
): Promise<AdvancePeerImportResult> {
  for (const [name, value] of [
    ['handoffId', input.handoffId],
    ['requestKey', input.requestKey],
    ['sourceHostRef', input.sourceHostRef],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
      xfail('INVALID_REQUEST', `${name} 无效。`);
    }
  }

  pathId(input.handoffId, 'handoffId');
  const { view: sourceView, manifest, items: sourceItems } = await sourceMaterials(input);
  const importRequestKey = importKeyFor(input, manifest);
  let row = await importList(input, importRequestKey);
  let importId = typeof row?.importId === 'string' ? pathId(row.importId, 'importId') : undefined;

  if (importId === undefined) {
    const inline = sourceItems
      .filter(item => item.sizeBytes === 0)
      .map(item => ({ relName: item.relName, dataBase64: '' }));
    const body: HandoffJson = {
      requestKey: importRequestKey,
      manifest,
      sealProof: object(sourceView.sealProof, '来源未返回冻结材料签名证明。'),
      sourceHostRef: input.sourceHostRef,
      ...(inline.length > 0 ? { materialsInline: inline } : {}),
    };
    const created = object(
      await input.targetCall('POST', ['imports'], body, importRequestKey),
      '目标导入创建响应无效。',
    );
    importId = requiredText(created.importId, 'importId');
    return resultFor(input, created, importId);
  }

  let view = await targetView(input, importId);
  const binding = signedBinding(input, view, importId);
  if (binding !== undefined || view.phase === 'STARTED') {
    // A STARTED import without a report remains reconcilable.  It must never
    // be reported as TAKEN_OVER merely because a target task id exists.
    return resultFor(input, view, importId);
  }
  const start = async (): Promise<AdvancePeerImportResult> => {
    const phaseKey = `handoff:${importRequestKey}:START`;
    const started = object(await input.targetCall('POST', ['imports', importId!, 'start'],
      { requestKey: phaseKey }, phaseKey), '目标启动响应无效。');
    return resultFor(input, started, importId!);
  };
  if (view.phase === 'STARTING') return start();
  if (view.phase !== 'STAGED') return resultFor(input, view, importId);

  if (!Array.isArray(view.materials)) xfail('SOURCE_UNAVAILABLE', '目标材料进度无效。');
  const targetItems = view.materials
    .filter((item): item is HandoffJson => !!item && typeof item === 'object' && !Array.isArray(item))
    .slice(0, MAX_ITEMS);
  if (targetItems.length !== sourceItems.length) {
    xfail('MATERIAL_CHANGED', '目标材料清单与来源不一致。');
  }
  const sourceByName = new Map(sourceItems.map(item => [item.relName as string, item]));
  const pending = targetItems.find(item => item.complete !== true);
  if (pending === undefined) return start();

  const relName = requiredText(pending.relName, 'relName');
  const sourceItem = sourceByName.get(relName);
  if (sourceItem === undefined
      || pending.sha256 !== sourceItem.sha256
      || safeInt(pending.sizeBytes, `${relName}.sizeBytes`) !== sourceItem.sizeBytes) {
    xfail('MATERIAL_CHANGED', '目标材料项与签名来源不一致。');
  }
  const offset = safeInt(pending.receivedBytes ?? 0, `${relName}.receivedBytes`);
  if (offset > sourceItem.sizeBytes) xfail('MATERIAL_CHANGED', '目标材料偏移超过声明大小。');
  if (offset === sourceItem.sizeBytes && pending.complete !== true) {
    xfail('SOURCE_UNAVAILABLE', '目标材料已到末尾但未确认完成。');
  }

  const digestValue = sourceItem.sha256 as string;
  const chunk = object(
    await input.sourceGet(
      [input.handoffId, 'materials', relName, 'chunks'],
      `digest=${encodeURIComponent(digestValue)}&offset=${offset}`,
    ),
    '来源材料块响应无效。',
  );
  if (chunk.relName !== relName
      || safeInt(chunk.offset, 'offset') !== offset
      || chunk.sha256 !== digestValue
      || safeInt(chunk.sizeBytes, 'sizeBytes') !== sourceItem.sizeBytes) {
    xfail('MATERIAL_CHANGED', '来源材料块与签名清单不一致。');
  }
  const base64 = chunk.bytes;
  if (typeof base64 !== 'string' || base64.length === 0 || base64.length > 4 * Math.ceil(MAX_CHUNK_BYTES / 3)) {
    xfail('SOURCE_UNAVAILABLE', '来源材料块不是 Base64。');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) xfail('SOURCE_UNAVAILABLE', '来源材料块不是规范 Base64。');
  if (bytes.length === 0 || bytes.length > MAX_CHUNK_BYTES
      || digest(bytes) !== requiredText(chunk.chunkSHA256, 'chunkSHA256')) {
    xfail('MATERIAL_CHANGED', '来源材料块摘要校验失败。');
  }
  const nextOffset = safeInt(chunk.nextOffset, 'nextOffset');
  if (nextOffset !== offset + bytes.length || nextOffset > sourceItem.sizeBytes) {
    xfail('MATERIAL_CHANGED', '来源材料块偏移不连续。');
  }
  const chunkDigest = chunk.chunkSHA256 as string;
  const chunkKey = `chunk-${keyDigest(`${importId}:${relName}:${offset}:${chunkDigest}`)}`;
  view = object(
    await input.targetCall(
      'POST', ['imports', importId, 'materials'],
      { relName, offset, chunkDigest, dataBase64: base64 }, chunkKey,
    ),
    '目标材料块响应无效。',
  );
  return resultFor(input, view, importId, { relName, offset, nextOffset });
}
