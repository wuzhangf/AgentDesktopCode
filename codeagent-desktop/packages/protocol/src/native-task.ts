/** Mac adoption is explicit. Unknown engines remain unsupported, never Codex fallbacks. */
export type NativeEngineId = 'pi' | 'codex' | 'macos' | 'codep';
export function supportedNativeEngine(value: unknown): value is NativeEngineId {
  return typeof value === 'string' && ['pi', 'codex', 'macos', 'codep'].includes(value);
}
export function nativeTaskCore(value: unknown): 'PI' | 'CODEX' | 'MACOS' | 'CODEP' | 'UNSUPPORTED' {
  switch (value) { case 'pi': return 'PI'; case 'codex': return 'CODEX'; case 'macos': return 'MACOS'; case 'codep': return 'CODEP'; default: return 'UNSUPPORTED'; }
}
export function supportedNativeProfile(engine: unknown, value: {profileId?: unknown;profileHome?: unknown;loadsUserExtensions?: unknown}): boolean {
  if (!supportedNativeEngine(engine)) return false;
  if (engine === 'macos') return value.profileId === 'MAC_MANAGED' && value.profileHome == null && value.loadsUserExtensions === false;
  return ['USER_PROFILE', 'MANAGED'].includes(String(value.profileId));
}

/** Ordinary native task facts. They are never ACS run/checkpoint receipts. */
export interface NativeBinding {
  kind: 'WORKER_LOCAL'; connectionId: string; storeId: string;
  localTaskId?: string; engineId: NativeEngineId; engineVersion: string;
  /** Present only for a discovered worker-host/1 source; legacy hosts stay unchanged. */
  authorityId?: string; workerId?: string;
}
export interface NativeHostCapability {
  schemaVersion?: 'worker-capability/1'; id: string;
  implementation: string; qualification: string; availability: string;
  semantics?: string; reasonCode?: string | null; evidenceRef?: string | null;
}
export interface NativeHostDiscovery {
  manifest: {schemaVersion: 'worker-host/1'; authorityId: string; storeId: string; workerId: string; bootId: string;
    engine: {id: NativeEngineId; version: string}; contracts: string[]; supportedPaths: string[]};
  capabilities: NativeHostCapability[];
}
export type PersonalExecutionBinding = NativeBinding | {
  kind: 'ACS_SESSION'; connectionId: string; storeId: string; sessionId: string; initialRunId?: string;
};
export interface NativeTaskDetail {
  taskId: string; engineId: string; engineVersion: string; state: string;
  generation?: string; nativeSessionId?: string | null; nativeTurnId?: string | null;
  currentCommandId?: string;
  workspace?: string; workingDirectory?: string; baseCommit?: string; configuredModel?: string;
  executionOptions?: {model?:string;accessMode?:string}; executionKernel?:string;
  deadlineEpochMillis?: string; deadlineMs?: number; reasonCode?: string; quiescent?: boolean;
  launchState?: string; createdAt?: string;
  queue?: {ordinal?: number; position?: number; activeTasks?: number; maxActiveTasks?: number};
  /** Durable-event spine high-water facts for stall detection: when the last
   * event landed and what it was. Absent until the first recorded event. */
  lastEventAt?: string | null; lastEventKind?: string | null;
  localQuiescent?: boolean; remoteStopConfirmed?: boolean; segmentId?: string; ownerEpoch?: string;
  recipeID?: string; projectId?: string; intakeClosed?: boolean;
  graphicsProfile?: NativeGraphicsProfile; graphicsObservationRevision?: string; graphicsObservationValid?: boolean;
  graphicsAccess?: {protocolVersion:'mac-graphics/1';observe:boolean;capture:boolean;act:boolean};
  capabilities?: {stop: boolean; steer: boolean; followUp: boolean; pause: boolean; resume: boolean};
  turns?: Record<string, {state: string; nativeTurnId?: string}>;
  /** Engine-reported cumulative usage for the status summary. */
  usage?: {input?: number; output?: number; cacheRead?: number; cacheWrite?: number};
  endedAt?: string; completedAt?: string;
}
export interface NativeGuard { generation: string; nativeSessionId: string; nativeTurnId?: string; targetCommandId: string }
export interface NativeStopGuard { generation: string; nativeSessionId: string | null; nativeTurnId?: string | null; targetCommandId: string }
export type NativeInput = (NativeGuard & {requestKey: string} & (
  {kind: 'NATIVE_STEER' | 'NATIVE_FOLLOW_UP'; content: string} |
  {kind: 'INPUT_RESPONSE'; inputRequestId: string; response: {confirmed?: boolean; value?: string; decision?: string}}
)) | (NativeGuard & {requestKey:string;kind:'PAUSE'|'RESUME'}) | (NativeStopGuard & {requestKey: string; kind: 'STOP'});
export interface NativeInputRequest extends NativeGuard {
  inputRequestId: string; method: string; title?: string; options?: string[]; state: string;
  scope?: Record<string,string>;
}
export interface NativePreflight {
  projectId: string; engineId: NativeEngineId; engineVersion: string; optionsRevision: string;
  profileId: 'USER_PROFILE' | 'MANAGED' | 'MAC_MANAGED'; profileHome: string | null; loadsUserExtensions: boolean;
  headRevision: string | null; treeRevision?: string | null; registryDigest?:string; hasUncommittedChanges: boolean; workingCopyPolicy: 'COMMITTED_BASE_ONLY'|'REGISTERED_TARGET_ONLY'|'OWNED_WORKSPACE_ONLY';
  macProfile?: {modelRepair?:{profile:string;availability:string;models:{model:string;displayName:string;provider?:string}[];policyDigest:string;runtimeDigest:string|null};productProfile?:string;availability?:string;reasonCode?:string|null;[key:string]:unknown};
}
export interface NativeRequestView {
  kind: 'WORKER_LOCAL'; requestKey: string; state: 'UNKNOWN' | 'OBSERVED' | 'REJECTED';
  request: NativeInput; source?: Record<string, unknown>; sourceError?: string;
}
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
export function validNativeInput(v: unknown): v is NativeInput {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  if (!id(b.requestKey) || !id(b.generation) || !id(b.targetCommandId)) return false;
  const stopping = b.kind === 'STOP';
  if (!(stopping && b.nativeSessionId === null) && (typeof b.nativeSessionId !== 'string' || !b.nativeSessionId || b.nativeSessionId.length > 1024)) return false;
  if (b.nativeTurnId !== undefined && !(stopping && b.nativeTurnId === null) && (typeof b.nativeTurnId !== 'string' || b.nativeTurnId.length > 256)) return false;
  const keys = ['requestKey','generation','nativeSessionId','nativeTurnId','targetCommandId','kind'];
  if (b.kind === 'NATIVE_STEER' || b.kind === 'NATIVE_FOLLOW_UP') {
    keys.push('content'); if (typeof b.content !== 'string' || !b.content.trim() || new TextEncoder().encode(b.content).length > 16384) return false;
  } else if (b.kind === 'INPUT_RESPONSE') {
    keys.push('inputRequestId','response'); if (!id(b.inputRequestId) || !b.response || typeof b.response !== 'object' || Array.isArray(b.response)) return false;
    const r = b.response as Record<string, unknown>; if (Object.keys(r).length !== 1 || !Object.entries(r).every(([k,x]) => k === 'confirmed' ? typeof x === 'boolean' : ['value','decision'].includes(k) && typeof x === 'string' && x.length <= 16384)) return false;
  } else if (!['STOP','PAUSE','RESUME'].includes(String(b.kind))) return false;
  return Object.keys(b).every(k => keys.includes(k));
}

export interface NativeGraphicsProfile {id:string;bundleID:string;windowTitle:string;allowedActions:string[];allowedElementIdentifiers:string[]}
export interface NativeGraphicsGuard {generation:string;nativeSessionId:string;segmentId:string;ownerEpoch:string}
export interface NativeGraphicsInput {requestKey:string;guard:NativeGraphicsGuard;observationRevision?:string;action?:'setValue'|'press';elementIdentifier?:string;value?:string}
export interface NativeGraphicsObservation extends NativeGraphicsGuard {schemaVersion:'mac-graphics-observation/1';taskId:string;revision:string;observedAt:string;target:{bundleID:string;windowID:number|string};elements:{identifier:string;role:string;value?:string;canSetValue:boolean;canPress:boolean}[]}
export interface NativeGraphicsArtifact {artifactId:string;taskId?:string;path:string;status:string;sha256:string;size?:number;sizeBytes?:string;mediaType?:string;capturedAt?:string;observationRevision?:string;segmentId?:string;ownerEpoch?:string;target?:{bundleID:string;windowID:number|string}}
export interface NativeGraphicsRequestView {kind:'WORKER_LOCAL';requestKey:string;request:NativeGraphicsInput;state:'UNKNOWN'|'OBSERVED'|'REJECTED';source?:{requestKey?:string;taskId?:string;state?:string;result?:{outcome?:string;reasonCode?:string}};sourceError?:string}
export function registeredGraphicsPreflight(value: NativePreflight): boolean {
  return value.engineId==='macos' && supportedNativeProfile('macos',value) && value.macProfile?.recipeID==='mac.app-workflow/1'
    && value.workingCopyPolicy==='REGISTERED_TARGET_ONLY' && value.headRevision===null && value.treeRevision==null
    && value.hasUncommittedChanges===false && typeof value.registryDigest==='string' && /^[a-f0-9]{64}$/.test(value.registryDigest)
    && typeof (value.macProfile?.graphicsProfile as NativeGraphicsProfile|undefined)?.bundleID==='string';
}
export function validNativePreflight(value: NativePreflight): boolean {
  if(!supportedNativeProfile(value.engineId,value))return false;
  if(value.engineId==='macos'&&value.macProfile?.recipeID!==undefined&&value.macProfile.recipeID!=='apple.verify-and-repair/1'&&value.macProfile.recipeID!=='mac.app-workflow/1'&&value.macProfile.recipeID!=='mac.local-work/1')return false;
  if(value.engineId==='macos'&&value.macProfile?.recipeID==='mac.local-work/1')return value.projectId==='this-mac'&&value.workingCopyPolicy==='OWNED_WORKSPACE_ONLY'&&value.headRevision===null&&value.treeRevision==null&&value.hasUncommittedChanges===false&&typeof value.registryDigest==='string'&&/^[a-f0-9]{64}$/.test(value.registryDigest);
  if(value.macProfile?.recipeID==='mac.app-workflow/1')return registeredGraphicsPreflight(value);
  return value.workingCopyPolicy==='COMMITTED_BASE_ONLY' && typeof value.headRevision==='string' && !!value.headRevision;
}
export function validNativeGraphicsInput(route:'observe'|'capture'|'actions',value:unknown):value is NativeGraphicsInput {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const b=value as NativeGraphicsInput,g=b.guard;
  if(!id(b.requestKey)||!g||typeof g!=='object'||Array.isArray(g)||Object.keys(g).sort().join(',')!=='generation,nativeSessionId,ownerEpoch,segmentId'||!Object.values(g).every(id))return false;
  const keys=['requestKey','guard'];
  if(route!=='observe'){keys.push('observationRevision');if(!id(b.observationRevision))return false;}
  if(route==='actions'){
    keys.push('action','elementIdentifier');if(!['setValue','press'].includes(b.action??'')||typeof b.elementIdentifier!=='string'||!b.elementIdentifier||new TextEncoder().encode(b.elementIdentifier).length>256)return false;
    if(b.action==='setValue'){keys.push('value');if(typeof b.value!=='string'||new TextEncoder().encode(b.value).length>4096)return false;}
  }
  return Object.keys(b).length===keys.length&&Object.keys(b).every(k=>keys.includes(k));
}

// ---------------------------------------------------------------------------
// native-messages/1 — Codex structured conversation, phase 1 (design
// 2026-10-29 §5.1/§5.3). The Host owns message identity, order and state; the
// management gateway and both clients only project it. `sequence`/`revision`
// are signed-64-bit decimal strings on the wire and are never converted to
// JavaScript numbers — compare with BigInt or decimal-string order.
// ---------------------------------------------------------------------------

/** Wire marker declared by a Host that persists structured public messages. */
export const NATIVE_MESSAGE_SCHEMA_VERSION = 'native-messages/1';
export type NativeMessageSchemaVersion = typeof NATIVE_MESSAGE_SCHEMA_VERSION;
/** Largest signed-64-bit sequence/revision value, as a decimal string. */
export const NATIVE_SEQUENCE_MAX = '9223372036854775807';
/**
 * Gateway-generated paging capability mark (design §8.3). A paging-capable
 * gateway adds it to the public projection only when the source response
 * actually declares `native-messages/1`; a source-supplied field of the same
 * name is never trusted. Old gateways pass new items through without this
 * mark, so clients never send `before` to them.
 */
export const NATIVE_MESSAGE_TRANSPORT_VERSION = 'native-messages-page/1';
export type NativeMessageTransportVersion = typeof NATIVE_MESSAGE_TRANSPORT_VERSION;

export type NativeMessageRole = 'user' | 'assistant' | (string & {});
/** user: ACCEPTED|CONSUMED|REJECTED|UNKNOWN; assistant: COMPLETED (§5.2). */
export type NativeMessageStatus = 'ACCEPTED' | 'CONSUMED' | 'REJECTED' | 'UNKNOWN' | 'COMPLETED' | (string & {});
export type NativeMessageHistoryMode = 'STRUCTURED_FROM_START' | 'LEGACY_PREFIX' | (string & {});

/** One structured public message row (design §5.1 record shape). */
export interface NativeMessageItem {
  /** Opaque stable id assigned once by the Host; never changes on rereads. */
  messageId: string;
  /** Task-scoped monotonic signed-64-bit decimal string (not a JS number). */
  sequence: string;
  /** Monotonic per-message version, decimal string; higher wins on merge. */
  revision: string;
  role: NativeMessageRole;
  text: string;
  status: NativeMessageStatus;
  /** Verifiable source request key on user rows — never a device-local key. */
  sourceRequestKey?: string | null;
  /** Binding at write time; never overwritten with the latest task detail. */
  commandId?: string | null;
  nativeTurnId?: string | null;
  generation?: string | null;
  segmentId?: string | null;
  /** Host first-persisted observation time (RFC-3339), not model time. */
  occurredAt?: string | null;
  updatedAt?: string | null;
  /** True only when the source body was actually clipped at a bound. */
  textTruncated?: boolean;
}

/** Frozen pre-phase-1 cumulative public output of a LEGACY_PREFIX task (§7.2). */
export interface NativeMessageLegacy {
  text: string;
  textTruncated?: boolean;
}

/**
 * Structured-message page on `GET /tasks/{id}/messages` (design §5.3). The
 * legacy `text`/`turns`/`coverage` members keep their original meaning and
 * are still served to old readers — `text` stays bounded cumulative
 * assistant output and never embeds user rows.
 */
export interface NativeMessagePage {
  messageSchemaVersion: NativeMessageSchemaVersion | (string & {});
  taskId?: string;
  storeId?: string;
  /** Bumped on every message insert or status update; decimal string. */
  transcriptRevision?: string;
  items?: NativeMessageItem[];
  /** First sequence in this page, decimal string; null on an empty page. */
  firstSequence?: string | null;
  /** Resume token for the next forward page; null at the range edge. */
  cursor?: string | null;
  /** Largest message sequence in this read snapshot, decimal string. */
  latestSequence?: string | null;
  /** More candidates exist in the current query direction. */
  hasMore?: boolean;
  /** Phase 1 keeps all history, so this stays false until retention exists. */
  cursorExpired?: boolean;
  historyMode?: NativeMessageHistoryMode;
  legacy?: NativeMessageLegacy | null;
  text?: string;
  turns?: unknown;
  coverage?: string;
  /** Present only when a paging-capable gateway projected this response. */
  messageTransportVersion?: NativeMessageTransportVersion | (string & {});
}

/** True when the payload declares the structured native-messages/1 format. */
export function nativeMessagePage(value: unknown): value is NativeMessagePage {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).messageSchemaVersion === NATIVE_MESSAGE_SCHEMA_VERSION;
}

/** Signed-64-bit canonical decimal sequence/revision string (§5.3). */
export function validNativeSequence(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value) <= BigInt(NATIVE_SEQUENCE_MAX);
}

/**
 * Decimal-string sequence order without JS numbers (§5.3). Both operands
 * must satisfy {@link validNativeSequence} — invalid input throws.
 */
export function compareNativeSequence(a: string, b: string): -1 | 0 | 1 {
  const x = BigInt(a), y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
