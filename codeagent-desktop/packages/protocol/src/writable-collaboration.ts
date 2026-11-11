import type { components } from './openapi-schema.gen';
import { writableRequestSchemas } from './writable-request-schemas.gen';
type Schemas = components['schemas'];
export type WritableRecord = Schemas['WritableCollaborationRecord'];
export type WritableGraph = Schemas['WritableCollaborationGraph'];
export type WritableBudget = Schemas['WritableCollaborationBudget'];
export type WritableActivity = Schemas['CollaborationAttemptActivity'];
export type WritableResponse = WritableRecord | Schemas['WritableCollaborationPage'] | WritableActivity | Schemas['WritableCandidateFile'] | Schemas['WritablePreviewFile'];
export interface WritableRequests {
  CREATE: Schemas['WriteGroupCreateRequest']; AUTHORIZE: Schemas['WriteGroupAuthorizeRequest']; START: Schemas['WriteGroupStartRequest']; CANCEL_GROUP: Schemas['WriteActionRequest'];
  SELECT: Schemas['WriteSelectionRequest']; PREVIEW: Schemas['WritePreviewRequest']; REVISE: Schemas['WritePreviewRevisionRequest']; REVIEW: Schemas['WriteReviewRequest'];
  REPAIR: Schemas['WriteRepairRequest']; ADOPT: Schemas['WriteAdoptionRequest']; CANCEL_EXECUTION: Schemas['WriteActionRequest']; REWORK: Schemas['WriteActionRequest']; CANCEL_ADOPTION: Schemas['WriteActionRequest']; RECOVER_ADOPTION: Schemas['WriteActionRequest']; RECOVER_REPAIR: Schemas['WriteActionRequest'];
}
type Nested = 'REPAIR' | 'PREVIEW' | 'REVISE' | 'REVIEW' | 'CANCEL_EXECUTION' | 'REWORK' | 'CANCEL_ADOPTION' | 'RECOVER_ADOPTION' | 'RECOVER_REPAIR';
type Mutations = { [A in keyof WritableRequests]: { action: A; runId: string; key: string; body: WritableRequests[A] } & (A extends 'CREATE' ? object : { groupId: string }) & (A extends Nested ? { entityId: string } : object) }[keyof WritableRequests];
export type WritableOperation = Mutations | { action: 'LIST' | 'ACTIVITY'; runId: string } | { action: 'GROUP' | 'EXECUTIONS' | 'ADOPTIONS'; runId: string; groupId: string }
  | { action: 'EXECUTION' | 'CANDIDATE' | 'ADOPTION' | 'REVIEW_RESULT'; runId: string; groupId: string; entityId: string }
  | { action: 'CANDIDATE_FILES'; runId: string; groupId: string; entityId: string; path?: string; offset?: string; limit?: string }
  | { action: 'PREVIEW_FILES'; runId: string; groupId: string; entityId: string; side?: 'BASE' | 'CURRENT' | 'PROPOSED' | 'INTEGRATION'; unitId?: string; path?: string; offset?: string; limit?: string };
interface Route { method: 'GET' | 'POST'; tail: string; schema?: keyof typeof writableRequestSchemas }
export const WRITABLE_ROUTES: Record<WritableOperation['action'], Route> = {
  LIST: { method: 'GET', tail: '' }, CREATE: { method: 'POST', tail: '', schema: 'WriteGroupCreateRequest' }, ACTIVITY: { method: 'GET', tail: '@activity' },
  GROUP: { method: 'GET', tail: '/{group}' }, AUTHORIZE: { method: 'POST', tail: '/{group}/authorizations', schema: 'WriteGroupAuthorizeRequest' }, START: { method: 'POST', tail: '/{group}/start', schema: 'WriteGroupStartRequest' }, CANCEL_GROUP: { method: 'POST', tail: '/{group}/cancel', schema: 'WriteActionRequest' },
  EXECUTIONS: { method: 'GET', tail: '/{group}/executions' }, EXECUTION: { method: 'GET', tail: '/{group}/executions/{entity}' }, CANCEL_EXECUTION: { method: 'POST', tail: '/{group}/executions/{entity}/cancel', schema: 'WriteActionRequest' }, REWORK: { method: 'POST', tail: '/{group}/executions/{entity}/rework', schema: 'WriteActionRequest' },
  PREVIEW_FILES: { method: 'GET', tail: '/{group}/previews/{entity}/files' }, CANDIDATE: { method: 'GET', tail: '/{group}/candidates/{entity}' }, CANDIDATE_FILES: { method: 'GET', tail: '/{group}/candidates/{entity}/files' }, SELECT: { method: 'POST', tail: '/{group}/selections', schema: 'WriteSelectionRequest' }, PREVIEW: { method: 'POST', tail: '/{group}/selections/{entity}/previews', schema: 'WritePreviewRequest' },
  REVISE: { method: 'POST', tail: '/{group}/previews/{entity}/revisions', schema: 'WritePreviewRevisionRequest' }, REVIEW: { method: 'POST', tail: '/{group}/previews/{entity}/reviews', schema: 'WriteReviewRequest' }, REVIEW_RESULT: { method: 'GET', tail: '/{group}/reviews/{entity}' },
  RECOVER_REPAIR: { method: 'POST', tail: '/{group}/repairs/{entity}/recover', schema: 'WriteActionRequest' },
  REPAIR: { method: 'POST', tail: '/{group}/adoptions/{entity}/repairs', schema: 'WriteRepairRequest' }, ADOPT: { method: 'POST', tail: '/{group}/adoptions', schema: 'WriteAdoptionRequest' }, ADOPTIONS: { method: 'GET', tail: '/{group}/adoptions' }, ADOPTION: { method: 'GET', tail: '/{group}/adoptions/{entity}' }, CANCEL_ADOPTION: { method: 'POST', tail: '/{group}/adoptions/{entity}/cancel', schema: 'WriteActionRequest' }, RECOVER_ADOPTION: { method: 'POST', tail: '/{group}/adoptions/{entity}/recover', schema: 'WriteActionRequest' }
};
interface Schema { $ref?: string; type?: string; properties?: Record<string, Schema>; required?: readonly string[]; enum?: readonly unknown[]; pattern?: string; maxLength?: number; minLength?: number; maximum?: number; minimum?: number; items?: Schema; maxItems?: number; minItems?: number; additionalProperties?: boolean; nullable?: boolean }
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
function schemaMatches(schema: Schema, value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (schema.$ref) { const name = schema.$ref.split('/').at(-1)!; const resolved = (writableRequestSchemas as Record<string, Schema>)[name]; return !!resolved && schemaMatches(resolved, value, depth + 1); }
  if (value === null) return schema.nullable === true;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'string') { if (typeof value !== 'string' || value.length > (schema.maxLength ?? 1048576) || value.length < (schema.minLength ?? 0) || (schema.pattern && !new RegExp(schema.pattern).test(value))) return false; return ![DECIMAL.source, '^[1-9][0-9]{0,18}$'].includes(schema.pattern ?? '') || BigInt(value) <= 9223372036854775807n; }
  if (schema.type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value) && value >= (schema.minimum ?? -Number.MAX_SAFE_INTEGER) && value <= (schema.maximum ?? Number.MAX_SAFE_INTEGER);
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'array') return Array.isArray(value) && value.length <= (schema.maxItems ?? 128) && value.length >= (schema.minItems ?? 0) && value.every(item => schemaMatches(schema.items!, item, depth + 1));
  if (schema.type === 'object') { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false; const object = value as Record<string, unknown>; return Object.keys(object).length <= 128 && (schema.required ?? []).every(key => object[key] !== undefined) && Object.keys(object).every(key => !!schema.properties?.[key] && schemaMatches(schema.properties[key]!, object[key], depth + 1)); }
  return false;
}
function relativePath(value: unknown, root = false): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 1024 && (root && value === '.' || !/[\\\\:\u0000-\u001f\u007f]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[. ]$/.test(part))); }
function relativeScopes(body: unknown): boolean {
  if (!body || typeof body !== 'object') return true;
  for (const [name, value] of Object.entries(body)) {
    if ((name === 'readScope' || name === 'writeScope') && (!Array.isArray(value) || !value.every(path => relativePath(path, true)))) return false;
    if (name === 'path' && !relativePath(value)) return false;
    if (Array.isArray(value)) { if (!value.every(relativeScopes)) return false; } else if (value && typeof value === 'object' && !relativeScopes(value)) return false;
  }
  return true;
}
export function validWritableOperation(input: unknown): input is WritableOperation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>; const action = value.action;
  if (typeof action !== 'string' || !Object.hasOwn(WRITABLE_ROUTES, action) || typeof value.runId !== 'string' || !ID.test(value.runId)) return false;
  const route = WRITABLE_ROUTES[action as WritableOperation['action']]; const keys = ['action', 'runId'];
  for (const [marker, field] of [['{group}', 'groupId'], ['{entity}', 'entityId']] as const) { if (route.tail.includes(marker)) { if (typeof value[field] !== 'string' || !ID.test(value[field])) return false; keys.push(field); } }
  if (route.method === 'POST') { if (typeof value.key !== 'string' || !ID.test(value.key) || !schemaMatches(writableRequestSchemas[route.schema!] as Schema, value.body)) return false; const body = value.body as Record<string, unknown>; const identity = ({ CREATE: 'requestId', AUTHORIZE: 'requestId', START: 'startId', SELECT: 'selectionId', PREVIEW: 'previewId', REVISE: 'revisionId', REVIEW: 'reviewId', ADOPT: 'adoptionId', REPAIR: 'repairId' } as Record<string, string>)[action] ?? 'requestId'; if (body[identity] !== value.key) return false; keys.push('key', 'body'); }
  if (action === 'PREVIEW_FILES') { keys.push('side', 'unitId'); if (value.side !== undefined && !['BASE', 'CURRENT', 'PROPOSED', 'INTEGRATION'].includes(value.side as string)) return false; if (value.unitId !== undefined && (typeof value.unitId !== 'string' || !ID.test(value.unitId))) return false; if (['BASE', 'PROPOSED'].includes(value.side as string) && value.unitId === undefined) return false; }
  if (action === 'CANDIDATE_FILES' || action === 'PREVIEW_FILES') { keys.push('path', 'offset', 'limit'); if (value.path !== undefined && (typeof value.path !== 'string' || value.path.length > 1024 || value.path.includes('\\') || value.path.includes(':') || value.path.split('/').some(part => !part || part === '.' || part === '..'))) return false; for (const field of ['offset', 'limit']) if (value[field] !== undefined && (typeof value[field] !== 'string' || !DECIMAL.test(value[field] as string) || BigInt(value[field] as string) > 9223372036854775807n)) return false; if (value.limit !== undefined && (BigInt(value.limit as string) < 1n || BigInt(value.limit as string) > 65536n)) return false; }
  if (Object.keys(value).some(key => !keys.includes(key)) || !relativeScopes(value.body) || (value.path !== undefined && !relativePath(value.path))) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).length <= 1024 * 1024; } catch { return false; }
}
export function mergeWritableRecord(previous: WritableRecord | undefined, next: WritableRecord): WritableRecord {
  if (!DECIMAL.test(next.revision)) throw new Error('Invalid collaboration object revision');
  if (previous && (previous.entityId !== next.entityId || previous.groupId !== next.groupId || previous.kind !== next.kind)) throw new Error('Collaboration object identity changed');
  return previous && BigInt(previous.revision) >= BigInt(next.revision) ? previous : next;
}

/** A boolean false before dispatch is not a failed verification. Preserve the three source dimensions. */
export function writableAdoptionEffects(value: WritableRecord): {file:string;verification:string;context:string} {
  const file=['PARTIAL','PARTIALLY_APPLIED'].includes(value.effectState??'')?'部分写入':value.contentApplied===true?'已写入':value.effectState==='NOT_APPLIED'?'未应用':'应用结果待核对';
  const verification=value.verificationPassed===true?'通过':value.state==='VERIFICATION_FAILED'||value.state==='RECONCILIATION_REQUIRED'&&value.contentApplied===true&&value.verificationPassed===false?'失败':value.state==='WAITING_BOUNDARY'?'未运行':['DISPATCHING','CONTENT_APPLIED'].includes(value.state)?'执行中':'未知';
  const context=value.contextCommitted===true?'已提交':value.effectState==='NOT_APPLIED'||value.state==='WAITING_BOUNDARY'?'尚未提交':'未证明提交';
  return {file,verification,context};
}

/** Merge each authoritative object's version independently of the composite group H0 response. */
export function mergeWritableProjection(previous: WritableRecord | undefined, next: WritableRecord): WritableRecord {
  const result = { ...mergeWritableRecord(previous, next) };
  for (const field of ['children', 'candidates', 'selections', 'previews', 'adoptions', 'reviews', 'repairs'] as const) {
    const incoming = next[field]; if (!Array.isArray(incoming)) continue;
    const known = previous?.[field]; const records = new Map<string, WritableRecord>();
    if (Array.isArray(known)) for (const row of known) records.set(`${row.kind}:${row.entityId}`, row);
    for (const row of incoming) { const key = `${row.kind}:${row.entityId}`; records.set(key, mergeWritableProjection(records.get(key), row)); }
    Object.assign(result, { [field]: [...records.values()] });
  }
  for (const field of ['agentProfileId', 'profileRevision', 'modelPin'] as const) if (result[field] == null && typeof next[field] === 'string') Object.assign(result, { [field]: next[field] });
  for (const field of ['sharedBudget', 'childBudget'] as const) {
    const incomingBudget = next[field]; if (!incomingBudget || typeof incomingBudget !== 'object' || Array.isArray(incomingBudget)) continue;
    const merged = { ...(previous?.[field] as Record<string, Record<string, string>> | undefined) };
    for (const [dimension, value] of Object.entries(incomingBudget)) {
      const incoming = value as Record<string, string>; if (typeof incoming.revision !== 'string' || !DECIMAL.test(incoming.revision)) throw new Error('Invalid collaboration budget revision');
      const old = merged[dimension]; merged[dimension] = old?.revision && BigInt(old.revision) >= BigInt(incoming.revision) ? old : incoming;
    }
    Object.assign(result, { [field]: merged });
  }
  return result;
}
