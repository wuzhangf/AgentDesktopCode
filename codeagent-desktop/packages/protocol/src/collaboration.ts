import type { components } from './openapi-schema.gen';

export type CollaborationResource = components['schemas']['CollaborationResource'];
export type ContextPackageRequest = components['schemas']['ContextPackageRequest'];
export type AuxiliarySessionRequest = components['schemas']['AuxiliarySessionRequest'];
export type AuxiliaryTurnRequest = components['schemas']['AuxiliaryTurnRequest'];
export type BoundaryInputRequest = components['schemas']['BoundaryInputRequest'];
export type AssignmentTransitionRequest = components['schemas']['AssignmentTransitionRequest'];

/** Fixed use cases, never an arbitrary HTTP URL/method/header proxy. */
export type CollaborationOperation =
  | { action: 'FOUNDATION' | 'SEGMENTS' | 'AUX_LIST' | 'TURN_LIST' | 'BOUNDARIES' | 'HANDOFFS'; subjectId: string }
  | { action: 'FREEZE_SNAPSHOT'; subjectId: string; key: string; body: Record<string, never> }
  | { action: 'CREATE_PACKAGE'; subjectId: string; key: string; body: ContextPackageRequest }
  | { action: 'PACKAGE'; subjectId: string; entityId: string }
  | { action: 'CREATE_AUX'; subjectId: string; key: string; body: AuxiliarySessionRequest }
  | { action: 'TURN'; subjectId: string; key: string; body: AuxiliaryTurnRequest }
  | { action: 'TURN_RESULT' | 'BOUNDARY_RESULT' | 'HANDOFF_RESULT'; subjectId: string; entityId: string }
  | { action: 'CANCEL_TURN' | 'CANCEL_BOUNDARY' | 'CANCEL_HANDOFF'; subjectId: string; entityId: string; key: string }
  | { action: 'BOUNDARY'; subjectId: string; key: string; body: BoundaryInputRequest }
  | { action: 'PREFLIGHT'; subjectId: string; body: AssignmentTransitionRequest }
  | { action: 'HANDOFF'; subjectId: string; key: string; body: AssignmentTransitionRequest };

const ACTIONS = new Set(['FOUNDATION', 'SEGMENTS', 'AUX_LIST', 'TURN_LIST', 'BOUNDARIES', 'HANDOFFS', 'FREEZE_SNAPSHOT', 'CREATE_PACKAGE', 'PACKAGE', 'CREATE_AUX', 'TURN', 'TURN_RESULT',
  'BOUNDARY_RESULT', 'HANDOFF_RESULT', 'CANCEL_TURN', 'CANCEL_BOUNDARY', 'CANCEL_HANDOFF', 'BOUNDARY', 'PREFLIGHT', 'HANDOFF']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function validCollaborationOperation(input: unknown): input is CollaborationOperation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['action', 'subjectId', 'entityId', 'key', 'body'].includes(key))) return false;
  if (typeof value.action !== 'string' || !ACTIONS.has(value.action) || typeof value.subjectId !== 'string' || !ID.test(value.subjectId)) return false;
  if (value.entityId !== undefined && (typeof value.entityId !== 'string' || !ID.test(value.entityId))) return false;
  if (value.key !== undefined && (typeof value.key !== 'string' || !ID.test(value.key))) return false;
  const bodyActions = new Set(['FREEZE_SNAPSHOT', 'CREATE_PACKAGE', 'CREATE_AUX', 'TURN', 'BOUNDARY', 'PREFLIGHT', 'HANDOFF']);
  if (bodyActions.has(value.action) && (!value.body || typeof value.body !== 'object' || Array.isArray(value.body))) return false;
  if (bodyActions.has(value.action) && value.action !== 'PREFLIGHT' && typeof value.key !== 'string') return false;
  if (['PACKAGE', 'TURN_RESULT', 'BOUNDARY_RESULT', 'HANDOFF_RESULT', 'CANCEL_TURN', 'CANCEL_BOUNDARY', 'CANCEL_HANDOFF'].includes(value.action) && typeof value.entityId !== 'string') return false;
  if (['CANCEL_TURN', 'CANCEL_BOUNDARY', 'CANCEL_HANDOFF'].includes(value.action) && typeof value.key !== 'string') return false;
  if (!bodyActions.has(value.action) && value.body !== undefined) return false;
  if (!['PACKAGE', 'TURN_RESULT', 'BOUNDARY_RESULT', 'HANDOFF_RESULT', 'CANCEL_TURN', 'CANCEL_BOUNDARY', 'CANCEL_HANDOFF'].includes(value.action) && value.entityId !== undefined) return false;
  if (['FOUNDATION', 'SEGMENTS', 'AUX_LIST', 'TURN_LIST', 'BOUNDARIES', 'HANDOFFS', 'PACKAGE', 'TURN_RESULT', 'BOUNDARY_RESULT', 'HANDOFF_RESULT', 'PREFLIGHT'].includes(value.action) && value.key !== undefined) return false;
  try { return JSON.stringify(value).length <= 32768; } catch { return false; }
}
