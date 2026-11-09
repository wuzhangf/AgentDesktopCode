import type {BoundaryInputRequest, AssignmentTransitionRequest, CollaborationResource} from './collaboration';
import type {ApprovalDecisionRequest} from './index';
export type TaskEngagementRequest = {requestKey: string; targetRunId: string} & (
  | {kind: 'BOUNDARY'; source: BoundaryInputRequest}
  | {kind: 'SIDE_QUESTION'; question: string; researchCount?: number; textOnlyResearch?: boolean}
  | {kind: 'PREFLIGHT'; source: AssignmentTransitionRequest}
  | {kind: 'HANDOFF'; preflightKey: string}
  | {kind: 'APPROVAL_DECISION'; approvalId: string; source: ApprovalDecisionRequest}
  | {kind: 'CANCEL_BOUNDARY'; resourceId: string}
  | {kind: 'CANCEL_HANDOFF'; resourceId: string}
);
export interface TaskEngagementView {
  taskId: string; request: TaskEngagementRequest;
  binding: {sessionId: string; storeId: string; runId: string};
  createdAt: string; result?: CollaborationResource; steps?: Record<string, CollaborationResource>;
  sourceError?: {code: string; message: string};
  sourceRejection?: {code: string; message: string};
}
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const obj = (v: unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string,unknown>, keys: string[]) => Object.keys(v).every(k=>keys.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) && new TextEncoder().encode(v).length <= max;
const decimal = (v: unknown) => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v);
export function validTaskEngagement(input: unknown): input is TaskEngagementRequest {
  if (!obj(input) || !id(input.requestKey) || !id(input.targetRunId)) return false;
  const base = ['requestKey','targetRunId','kind'];
  switch(input.kind) {
    case 'BOUNDARY': {
      if (!only(input,[...base,'source']) || !obj(input.source)) return false;
      const s=input.source;
      return only(s,['schemaVersion','requestId','kind','expectedExecutionEpoch','text','sourceRefs']) && s.schemaVersion==='run-boundary-request/1' && s.requestId===input.requestKey
        && ['CONTEXT_ADVICE','REQUEST_REPORT'].includes(String(s.kind)) && decimal(s.expectedExecutionEpoch) && text(s.text,8192)
        && (s.sourceRefs===undefined || Array.isArray(s.sourceRefs) && s.sourceRefs.length<=8 && s.sourceRefs.every(v=>text(v,512)));
    }
    case 'SIDE_QUESTION': return only(input,[...base,'question','researchCount','textOnlyResearch']) && text(input.question,8192)
      && (input.researchCount===undefined || Number.isInteger(input.researchCount) && Number(input.researchCount)>=0 && Number(input.researchCount)<=3)
      && (!(Number(input.researchCount)>0) || String(input.question).length<=1200)
      && (input.textOnlyResearch===undefined || typeof input.textOnlyResearch==='boolean');
    case 'PREFLIGHT': {
      if (!only(input,[...base,'source']) || !obj(input.source)) return false;
      const s=input.source, t=s.target;
      if (!only(s,['schemaVersion','target','pendingInputPolicy']) || s.schemaVersion!=='assignment-transition-request/1' || !['CANCEL_PENDING','RETAIN_PENDING'].includes(String(s.pendingInputPolicy)) || !obj(t)) return false;
      if (!only(t,['harnessId','agentProfileId','agentProfileRevision','modelSelection']) || t.harnessId!=='product-code' || !id(t.agentProfileId) || !text(t.agentProfileRevision,256)) return false;
      const m=t.modelSelection;
      return m===undefined || obj(m) && only(m,['mode','settings']) && (m.mode==='KEEP_EFFECTIVE' && m.settings===undefined
        || m.mode==='EXPLICIT' && obj(m.settings) && only(m.settings,['providerId','modelAlias']) && text(m.settings.modelAlias,256) && (m.settings.providerId===undefined || id(m.settings.providerId)));
    }
    case 'HANDOFF': return only(input,[...base,'preflightKey']) && id(input.preflightKey);
    case 'CANCEL_BOUNDARY': case 'CANCEL_HANDOFF': return only(input,[...base,'resourceId']) && id(input.resourceId);
    case 'APPROVAL_DECISION': {
      if (!only(input,[...base,'approvalId','source']) || !id(input.approvalId) || !obj(input.source)) return false;
      const s=input.source;
      return only(s,['expectedVersion','fingerprint','requestFingerprint','decision']) && Number.isSafeInteger(s.expectedVersion) && Number(s.expectedVersion)>=0
        && (s.fingerprint==null||s.requestFingerprint==null||s.fingerprint===s.requestFingerprint)
        && text(s.fingerprint ?? s.requestFingerprint,256) && ['APPROVE','DENY','REJECT','CANCEL','EXECUTE'].includes(String(s.decision));
    }
    default: return false;
  }
}
