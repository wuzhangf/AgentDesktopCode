/**
 * Product-language to service-contract translation for the desktop session
 * sheet. The renderer owns labels and form state; the service remains the
 * authority for the resulting session and policy ceiling.
 */

export type SessionIntent = 'ASK' | 'CODE' | 'PLAN';
export type SessionAutonomy = 'LOW' | 'MEDIUM' | 'HIGH';
export type SessionVerification = 'NONE' | 'COMPILE' | 'TEST' | 'VERIFY';
export type SessionWorkspaceMode = 'AUTO' | 'ISOLATED_WORKTREE' | 'LOCAL_CHECKOUT' | 'READ_ONLY_SNAPSHOT';

export interface SessionWorkspacePolicy {
  mode: SessionWorkspaceMode;
  startPolicy: 'CLEAN_HEAD' | 'USER_WIP_SNAPSHOT' | 'APPROVED_DELIVERY' | 'FORK_SNAPSHOT';
  expectedBaseRevision?: string;
  preflightRevision?: string;
  pinLane?: boolean;
  baseSnapshotFingerprint?: string;
  baseSnapshotId?: string;
  wipAllowPrefixes?: string[];
}

export interface SessionCapabilities {
  ask: boolean;
  code: boolean;
  plan: boolean;
  mission: boolean;
}

export interface SessionCreateForm {
  intent: SessionIntent;
  title: string;
  goal: string;
  autonomy: SessionAutonomy;
  verification: SessionVerification;
  /** Empty means a lightweight ordinary chat with no workspace binding. */
  workspaceAlias?: string;
  writeAllow?: string[];
  writeForbid?: string[];
  policyFingerprint?: string;
  preflightRevision?: string;
  workspaceFingerprint?: string;
  workspacePolicy?: SessionWorkspacePolicy;
  /** Defaults to true for implementation sessions: reviewable edits start from current WIP. */
  includeCurrentUncommittedChanges?: boolean;
}

export interface CanonicalSessionCreateRequest {
  title?: string;
  workspaceAlias?: string;
  interactionMode: 'ACT' | 'SPEC' | 'MISSION';
  executionMode: 'INSPECT' | 'MODIFY';
  autonomyLevel: 'OFF' | SessionAutonomy;
  verificationLevel: SessionVerification;
  writeAllow: string[];
  writeForbid: string[];
  policyFingerprint?: string;
  preflightRevision?: string;
  workspaceFingerprint?: string;
  workspacePolicy?: SessionWorkspacePolicy;
}

export interface ContractValidation {
  valid: boolean;
  message?: string;
}

export const DEFAULT_SESSION_CAPABILITIES: SessionCapabilities = {
  ask: true,
  code: true,
  plan: false,
  mission: false
};

export function validateSessionForm(
  form: SessionCreateForm,
  capabilities: SessionCapabilities = DEFAULT_SESSION_CAPABILITIES
): ContractValidation {
  const workspaceAlias = form.workspaceAlias?.trim() ?? '';
  // Ordinary ASK conversations are intentionally workspace-free. Planning
  // and implementation still require an explicit project because their
  // contracts can inspect or mutate files.
  if (!workspaceAlias && form.intent !== 'ASK') return { valid: false, message: '请选择一个项目。' };
  if (form.intent === 'ASK' && !capabilities.ask) return { valid: false, message: '当前服务不支持问答会话。' };
  if (form.intent === 'CODE' && !capabilities.code) return { valid: false, message: '当前工作区不允许创建实现会话。' };
  if (form.intent === 'PLAN' && !capabilities.plan) return { valid: false, message: '当前服务未启用计划能力。' };
  if (form.intent === 'CODE' && !(form.writeAllow ?? []).some((entry) => entry.trim())) {
    return { valid: false, message: '实现会话必须至少有一个受控修改范围。' };
  }
  if (form.intent !== 'CODE' && (form.writeAllow ?? []).some((entry) => entry.trim())) {
    return { valid: false, message: '问答和计划会话不能携带修改范围。' };
  }
  return { valid: true };
}

/**
 * The currently shipped service accepts ACT + INSPECT for read-only work.
 * PLAN intentionally returns a SPEC contract, but is still gated by the
 * capability flag so the UI cannot create a fake Plan entry.
 */
export function toCanonicalSessionContract(
  form: SessionCreateForm,
  capabilities: SessionCapabilities = DEFAULT_SESSION_CAPABILITIES
): CanonicalSessionCreateRequest {
  const validation = validateSessionForm(form, capabilities);
  if (!validation.valid) throw new Error(validation.message ?? 'INVALID_SESSION_CONTRACT');

  const inspectOnly = form.intent === 'ASK' || form.intent === 'PLAN';
  const writeAllow = inspectOnly ? [] : (form.writeAllow ?? []).map((entry) => entry.trim()).filter(Boolean);
  const requestedWorkspacePolicy = form.workspacePolicy;
  return {
    ...(form.title.trim() ? { title: form.title.trim() } : {}),
    ...(form.workspaceAlias?.trim() ? { workspaceAlias: form.workspaceAlias.trim() } : {}),
    interactionMode: form.intent === 'PLAN' ? 'SPEC' : 'ACT',
    executionMode: inspectOnly ? 'INSPECT' : 'MODIFY',
    autonomyLevel: inspectOnly ? 'OFF' : form.autonomy,
    verificationLevel: inspectOnly ? 'NONE' : form.verification,
    writeAllow,
    writeForbid: (form.writeForbid ?? []).map((entry) => entry.trim()).filter(Boolean),
    ...(form.policyFingerprint?.trim() ? { policyFingerprint: form.policyFingerprint.trim() } : {}),
    ...(form.preflightRevision?.trim() ? { preflightRevision: form.preflightRevision.trim() } : {}),
    ...(form.workspaceFingerprint?.trim() ? { workspaceFingerprint: form.workspaceFingerprint.trim() } : {}),
    ...(form.workspaceAlias?.trim() ? { workspacePolicy: {
      mode: inspectOnly ? 'READ_ONLY_SNAPSHOT' : (requestedWorkspacePolicy?.mode
        ?? (form.includeCurrentUncommittedChanges === false ? 'ISOLATED_WORKTREE' : 'LOCAL_CHECKOUT')),
      startPolicy: requestedWorkspacePolicy?.startPolicy
        ?? (form.intent === 'CODE' && form.includeCurrentUncommittedChanges !== false
          ? 'USER_WIP_SNAPSHOT' : 'CLEAN_HEAD'),
      ...(requestedWorkspacePolicy?.expectedBaseRevision ? { expectedBaseRevision: requestedWorkspacePolicy.expectedBaseRevision } : {}),
      ...(requestedWorkspacePolicy?.pinLane !== undefined ? { pinLane: requestedWorkspacePolicy.pinLane } : {}),
      ...(requestedWorkspacePolicy?.baseSnapshotId ? { baseSnapshotId: requestedWorkspacePolicy.baseSnapshotId } : {}),
      ...(requestedWorkspacePolicy?.wipAllowPrefixes?.length ? { wipAllowPrefixes: requestedWorkspacePolicy.wipAllowPrefixes } : {}),
      ...(form.workspaceFingerprint?.trim() ? { baseSnapshotFingerprint: form.workspaceFingerprint.trim() } : {}),
      ...(form.preflightRevision?.trim() ? { preflightRevision: form.preflightRevision.trim() } : {})
    } } : {})
  };
}

export function intentLabel(intent: SessionIntent): string {
  switch (intent) {
    case 'ASK': return '问答';
    case 'PLAN': return '计划';
    case 'CODE': return '实现';
  }
}

export function intentDescription(intent: SessionIntent): string {
  switch (intent) {
    case 'ASK': return '读取项目、解释代码，不修改工作区';
    case 'PLAN': return '整理目标、范围和步骤，等待确认后再实施';
    case 'CODE': return '在受控范围内修改代码';
  }
}

export function autonomyLabel(autonomy: SessionAutonomy): string {
  switch (autonomy) {
    case 'LOW': return '谨慎推进';
    case 'MEDIUM': return '范围内推进';
    case 'HIGH': return '连续推进';
  }
}

export function verificationLabel(verification: SessionVerification): string {
  switch (verification) {
    case 'NONE': return '不主动验证';
    case 'COMPILE': return '编译检查';
    case 'TEST': return '运行测试';
    case 'VERIFY': return '完整验证';
  }
}
