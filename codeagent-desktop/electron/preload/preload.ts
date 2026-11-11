/**
 * Sandbox-safe preload (design §6.3). Only fixed, minimal, named APIs are
 * exposed. No ipcRenderer.send, no shell, no fs, no arbitrary channels.
 * All service data flows through main (ADR-E002/E003); the renderer never
 * fetches directly.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DesktopApi, DesktopWindowState, DurableEventFrameLike, EventStatusLike, NativeTaskEventPush } from '../shared/api-types';

// Bootstrap starts the durable-event stream before the renderer subscribes.
// Keep only the latest status so a fast CONNECTED/RESYNCED transition is not
// lost during that listener-registration window.
const eventStatusListeners = new Set<(status: EventStatusLike) => void>();
let lastEventStatus: EventStatusLike | null = null;
ipcRenderer.on('app/events/status', (_event: IpcRendererEvent, status: EventStatusLike): void => {
  lastEventStatus = status;
  for (const listener of eventStatusListeners) listener(status);
});

const windowStateListeners = new Set<(state: DesktopWindowState) => void>();
let lastWindowState: DesktopWindowState | null = null;
ipcRenderer.on('app/window/state', (_event: IpcRendererEvent, state: DesktopWindowState): void => {
  lastWindowState = state;
  for (const listener of windowStateListeners) listener(state);
});

const api: DesktopApi = {
  writableCollaboration: request => ipcRenderer.invoke("app/writable-collaboration", request),
  collaboration: (request) => ipcRenderer.invoke("app/collaboration", request),
  // PAE P8: bounded /api/personal/v1 operations (whitelist-admitted in main).
  saveNativeArtifact: (request) => ipcRenderer.invoke('app/native-artifact/save',request),
  personalOperation: (request) => ipcRenderer.invoke("app/personal", request),
  // UCA-001 C4: bounded client-access/1 operations against the configured
  // personal access server (whitelist-admitted in main).
  personalAccess: (request) => ipcRenderer.invoke("app/personal-access", request),
  bootstrap: () => ipcRenderer.invoke('app/bootstrap'),
  controlWindow: (action) => ipcRenderer.invoke('app/window/control', { action }),
  onWindowState(listener) {
    windowStateListeners.add(listener);
    if (lastWindowState) {
      const state = lastWindowState;
      queueMicrotask(() => {
        if (windowStateListeners.has(listener)) listener(state);
      });
    }
    return () => windowStateListeners.delete(listener);
  },
  openExternalHttps: (url) => ipcRenderer.invoke('app/openExternalHttps', { url }),
  restartService: () => ipcRenderer.invoke('app/service/restart'),
  serviceStatus: () => ipcRenderer.invoke('app/service/status'),
  chooseAndRegisterProject: () => ipcRenderer.invoke('app/projects/chooseAndRegister'),
  chooseDirectory: () => ipcRenderer.invoke('app/dialog/chooseDirectory'),
  diagnostics: () => ipcRenderer.invoke('app/diagnostics'),
  saveConversationExport: (request) => ipcRenderer.invoke('app/export/save', request),

  // data proxy
  listProjects: () => ipcRenderer.invoke('app/projects/list'),
  listAgentProfiles: () => ipcRenderer.invoke('app/agent-profiles/list', {}),
  getProjectSessionPreflight: (projectId) => ipcRenderer.invoke('app/projects/session-preflight', { projectId }),
  // build-plan surface (design 2026-09-26 §7.2)
  getProjectBuildPlan: (projectId) => ipcRenderer.invoke('app/projects/build-plan', { projectId }),
  putProjectBuildPlanOverride: (projectId, body) => ipcRenderer.invoke('app/projects/build-plan-override', { projectId, ...(body ?? {}) }),
  previewProjectBuildPlan: (projectId, body) => ipcRenderer.invoke('app/projects/build-plan-preview', { projectId, ...(body ?? {}) }),
  // verification-profile surface (design 2026-09-26 §7.4/§10.2)
  getProjectVerificationProfiles: (projectId) => ipcRenderer.invoke('app/projects/verification-profiles', { projectId }),
  putProjectVerificationProfile: (projectId, profileId, body) => ipcRenderer.invoke('app/projects/verification-profile-put', { projectId, profileId, ...(body ?? {}) }),
  listSessions: () => ipcRenderer.invoke('app/sessions/list'),
  listSessionSummaries: (query) => ipcRenderer.invoke('app/sessions/summaries', query ?? {}),
  getSessionSummary: (sessionId, options) => ipcRenderer.invoke('app/sessions/summary', { sessionId, refreshEnvironment: options?.refreshEnvironment ?? null }),
  getSessionMetadata: (sessionId) => ipcRenderer.invoke('app/sessions/metadata', { sessionId }),
  pageSessionMessages: (sessionId, query) => ipcRenderer.invoke('app/sessions/messages-page', { sessionId, ...(query ?? {}) }),
  getMessageContentPage: (sessionId, messageId, query) => ipcRenderer.invoke('app/sessions/message-content', { sessionId, messageId, ...(query ?? {}) }),
  getSession: (sessionId) => ipcRenderer.invoke('app/sessions/get', { sessionId }),
  createSession: (body, idempotencyKey) => ipcRenderer.invoke('app/sessions/create', idempotencyKey === undefined ? body : { body, idempotencyKey }),
  patchSession: (sessionId, body) => ipcRenderer.invoke('app/sessions/patch', { sessionId, body }),
  sendSessionMessage: (sessionId, body, idempotencyKey) => ipcRenderer.invoke('app/sessions/message', idempotencyKey === undefined ? { sessionId, body } : { sessionId, body, idempotencyKey }),
  getSessionAttachmentContent: (sessionId, messageId, attachmentId) => ipcRenderer.invoke('app/sessions/attachment-content', { sessionId, messageId, attachmentId }),
  getSessionAttachmentBytes: (sessionId, messageId, attachmentId) => ipcRenderer.invoke('app/sessions/attachment-bytes', { sessionId, messageId, attachmentId }),
  forkSession: (sessionId, body) => ipcRenderer.invoke('app/sessions/fork', { sessionId, body }),
  archiveSession: (sessionId, body) => ipcRenderer.invoke('app/sessions/archive', { sessionId, body }),
  listRuns: (query) => ipcRenderer.invoke('app/runs/list', query),
  listAttention: () => ipcRenderer.invoke('app/attention/list'),
  listTerminalSessions: (businessSessionId) => ipcRenderer.invoke('app/terminal-sessions/list', { businessSessionId }),
  createTerminalSession: (businessSessionId, body) => ipcRenderer.invoke('app/terminal-sessions/create', { businessSessionId, body }),
  getTerminalSession: (terminalSessionId) => ipcRenderer.invoke('app/terminal-sessions/get', { terminalSessionId }),
  getTerminalOutput: (terminalSessionId, query) => ipcRenderer.invoke('app/terminal-sessions/output', { terminalSessionId, ...(query ?? {}) }),
  writeTerminalInput: (terminalSessionId, body) => ipcRenderer.invoke('app/terminal-sessions/input', { terminalSessionId, body }),
  resizeTerminalSession: (terminalSessionId, body) => ipcRenderer.invoke('app/terminal-sessions/resize', { terminalSessionId, body }),
  signalTerminalSession: (terminalSessionId, body) => ipcRenderer.invoke('app/terminal-sessions/signal', { terminalSessionId, body }),
  closeTerminalSession: (terminalSessionId, body) => ipcRenderer.invoke('app/terminal-sessions/close', { terminalSessionId, body }),
  acquireTerminalControl: (terminalSessionId, body) => ipcRenderer.invoke('app/terminal-sessions/control/acquire', { terminalSessionId, body }),
  renewTerminalControl: (terminalSessionId, body) => ipcRenderer.invoke('app/terminal-sessions/control/renew', { terminalSessionId, body }),
  releaseTerminalControl: (terminalSessionId, body) => ipcRenderer.invoke('app/terminal-sessions/control/release', { terminalSessionId, body }),

  // governance (EW5)
  createSpec: (sessionId, body) => ipcRenderer.invoke('app/specs/create', { sessionId, body }),
  getSpec: (specId) => ipcRenderer.invoke('app/specs/get', { specId }),
  reviseSpec: (specId, body) => ipcRenderer.invoke('app/specs/revise', { id: specId, body }),
  decideSpecApproval: (specId, approvalId, body) => ipcRenderer.invoke('app/specs/decide', { specId, approvalId, body }),
  convertSpecToAct: (specId, body) => ipcRenderer.invoke('app/specs/convert', { id: specId, body }),
  decideCommandApproval: (runId, body) => ipcRenderer.invoke('app/approvals/command', { id: runId, body }),
  decideSandboxApproval: (runId, body) => ipcRenderer.invoke('app/approvals/sandbox', { id: runId, body }),
  pendingSandboxApproval: (runId) => ipcRenderer.invoke('app/approvals/sandbox/pending', { id: runId }),
  decideTerminalApproval: (runId, body) => ipcRenderer.invoke('app/approvals/terminal', { id: runId, body }),
  pendingTerminalApproval: (runId) => ipcRenderer.invoke('app/approvals/terminal/pending', { id: runId }),
  decideBudgetApproval: (runId, body) => ipcRenderer.invoke('app/approvals/budget', { id: runId, body }),
  decideWriteApproval: (runId, body) => ipcRenderer.invoke('app/approvals/write', { id: runId, body }),
  pendingWriteApproval: (runId) => ipcRenderer.invoke('app/approvals/write/pending', { id: runId }),
  getExecutionPolicy: (sessionId, projectId) => ipcRenderer.invoke('app/execution-policy/get', { sessionId, projectId: projectId ?? null }),
  updateExecutionPolicy: (sessionId, body, projectId) => ipcRenderer.invoke('app/execution-policy/update', { id: sessionId, body, projectId: projectId ?? null }),
  getExecutionPolicyDefaults: (projectId) => ipcRenderer.invoke('app/execution-policy/defaults/get', { projectId }),
  updateExecutionPolicyDefaults: (projectId, body) => ipcRenderer.invoke('app/execution-policy/defaults/update', { id: projectId, body }),
  getMyExecutionPolicyDefaults: () => ipcRenderer.invoke('app/execution-policy/my-defaults/get'),
  updateMyExecutionPolicyDefaults: (body) => ipcRenderer.invoke('app/execution-policy/my-defaults/update', { body }),
  getAutomationControl: (sessionId) => ipcRenderer.invoke('app/automation-controls/get', { sessionId }),
  controlAutomation: (sessionId, body) => ipcRenderer.invoke('app/automation-controls/update', { id: sessionId, body }),
  listApprovals: (sessionId, query) => ipcRenderer.invoke('app/approvals/v2/list', { sessionId, ...(query ?? {}) }),
  getApproval: (approvalId) => ipcRenderer.invoke('app/approvals/v2/get', { approvalId }),
  decideApproval: (approvalId, body) => ipcRenderer.invoke('app/approvals/v2/decide', { id: approvalId, body }),
  advanceApproval: (approvalId, body) => ipcRenderer.invoke('app/approvals/v2/advance', { id: approvalId, body }),
  controlApproval: (approvalId, body) => ipcRenderer.invoke('app/approvals/v2/control', { id: approvalId, body }),
  cancelRun: (runId) => ipcRenderer.invoke('app/runs/cancel', { runId }),
  interruptRun: (runId, options) => ipcRenderer.invoke('app/runs/interrupt', { runId, expectedStateVersion: options.expectedStateVersion ?? null }),
  controlRun: (runId, body) => ipcRenderer.invoke('app/runs/control', { runId, body }),
  continueRun: (runId, options) => ipcRenderer.invoke('app/runs/continue', { runId, expectedStateVersion: options?.expectedStateVersion ?? null, message: options?.message ?? null }),

  // diff / review / evidence (EW6)
  getRunDiff: (runId, query) => ipcRenderer.invoke('app/runs/diff', { runId, ...query }),
  getRunActivities: (runId, query) => ipcRenderer.invoke('app/runs/activities', {
    runId,
    afterCursor: query?.afterCursor ?? 0,
    limit: query?.limit ?? 0
  }),
  getRunReasoning: (runId) => ipcRenderer.invoke('app/runs/reasoning', { runId }),
  getRunOutput: (runId) => ipcRenderer.invoke('app/runs/output', { runId }),
  // Session execution-evidence reads (design 2026-09-26 §10.2): bounded
  // artifact slices fetched on demand — never raw eager stdout/stderr.
  listSessionExecutions: (sessionId, query) => ipcRenderer.invoke(
    'app/sessions/executions/list', {
      sessionId,
      runId: query?.runId ?? null,
      limit: query?.limit ?? 0
    }),
  getSessionExecution: (sessionId, executionId) => ipcRenderer.invoke(
    'app/sessions/executions/get', { sessionId, executionId }),
  readSessionExecutionArtifact: (sessionId, executionId, path, query) => ipcRenderer.invoke(
    'app/sessions/executions/artifact', {
      sessionId,
      executionId,
      path,
      offset: query?.offset ?? 0,
      maxBytes: query?.maxBytes ?? 0
    }),
  listRunWorkspaceConflicts: (runId) => ipcRenderer.invoke('app/workspace-conflicts/list', { runId }),
  getWorkspaceConflict: (conflictId) => ipcRenderer.invoke('app/workspace-conflicts/get', { conflictId }),
  resolveWorkspaceConflict: (conflictId, body, idempotencyKey) => ipcRenderer.invoke(
    'app/workspace-conflicts/resolve', { conflictId, body, idempotencyKey }
  ),
  autoMergeWorkspaceConflict: (conflictId, idempotencyKey) => ipcRenderer.invoke(
    'app/workspace-conflicts/auto-merge', { conflictId, idempotencyKey }
  ),
  dismissWorkspaceConflict: (conflictId, idempotencyKey) => ipcRenderer.invoke(
    'app/workspace-conflicts/dismiss', { conflictId, idempotencyKey }
  ),
  resolveWorkspaceConflictsBatch: (body, idempotencyKey) => ipcRenderer.invoke(
    'app/workspace-conflicts/resolve-batch', { body, idempotencyKey }
  ),
  listWorkspaceConflicts: (filters) => ipcRenderer.invoke(
    'app/workspace-conflicts/list-filtered', filters ?? {}
  ),
  requestWorkspaceConflictProposal: (conflictId, idempotencyKey) => ipcRenderer.invoke(
    'app/workspace-conflicts/proposals/submit', { conflictId, idempotencyKey }
  ),
  pollWorkspaceConflictProposal: (proposalId) => ipcRenderer.invoke(
    'app/workspace-conflicts/proposals/poll', { proposalId }
  ),
  getWorkspaceContent: (ref, query) => ipcRenderer.invoke(
    'app/workspace-contents/get', { ref, ...(query ?? {}) }
  ),
  putWorkspaceContent: (contentBase64, idempotencyKey) => ipcRenderer.invoke(
    'app/workspace-contents/put', { contentBase64, idempotencyKey }
  ),
  readProjectFile: (projectId, fileRef, query) => ipcRenderer.invoke('app/projects/read-file', { projectId, fileRef, ...(query ?? {}) }),
  getRunReview: (runId) => ipcRenderer.invoke('app/runs/review', { runId }),
  getRunEvidence: (runId) => ipcRenderer.invoke('app/runs/evidence', { runId }),
  createFixTask: (findingId, body) => ipcRenderer.invoke('app/findings/fix-task', { id: findingId, body }),
  revealProjectFile: (projectId, fileRef) => ipcRenderer.invoke('app/projects/reveal-file', { projectId, fileRef }),

  // service-owned workspace executions (EW7)
  listWorkspaceExecutions: (projectId) => ipcRenderer.invoke('app/workspace-executions/list', { projectId }),
  createWorkspaceExecution: (body) => ipcRenderer.invoke('app/workspace-executions/create', body),
  handoffWorkspaceExecution: (workspaceExecutionId, expectedStateVersion) => ipcRenderer.invoke('app/workspace-executions/handoff', { workspaceExecutionId, expectedStateVersion: expectedStateVersion ?? null }),
  reclaimWorkspaceExecution: (workspaceExecutionId, expectedStateVersion) => ipcRenderer.invoke('app/workspace-executions/reclaim', { workspaceExecutionId, expectedStateVersion: expectedStateVersion ?? null }),
  createWorkspaceLane: (body) => ipcRenderer.invoke('app/workspace-lanes/create', body),
  getWorkspaceLane: (workspaceLaneId) => ipcRenderer.invoke('app/workspace-lanes/get', { workspaceLaneId }),
  bindWorkspaceLane: (workspaceLaneId, body) => ipcRenderer.invoke('app/workspace-lanes/bind', { workspaceLaneId, body }),
  reopenWorkspaceLane: (workspaceLaneId, body) => ipcRenderer.invoke('app/workspace-lanes/reopen', { workspaceLaneId, body }),
  releaseWorkspaceLane: (workspaceLaneId, body) => ipcRenderer.invoke('app/workspace-lanes/release', { workspaceLaneId, body }),
  createDelivery: (body) => ipcRenderer.invoke('app/deliveries/create', body),
  getDelivery: (deliveryId) => ipcRenderer.invoke('app/deliveries/get', { deliveryId }),
  getDeliveryChanges: (deliveryId) => ipcRenderer.invoke('app/deliveries/changes', { deliveryId }),
  prepareDelivery: (deliveryId, body) => ipcRenderer.invoke('app/deliveries/prepare', { deliveryId, body }),
  decideDelivery: (deliveryId, body) => ipcRenderer.invoke('app/deliveries/decide', { deliveryId, body }),
  applyDelivery: (deliveryId, body) => ipcRenderer.invoke('app/deliveries/apply', { deliveryId, body }),
  reconcileDelivery: (deliveryId, body) => ipcRenderer.invoke('app/deliveries/reconcile', { deliveryId, body }),
  rebaseDelivery: (deliveryId, body) => ipcRenderer.invoke('app/deliveries/rebase', { deliveryId, body }),
  listProjectDeliveries: (projectId, query) => ipcRenderer.invoke('app/deliveries/list', { projectId, ...(query ?? {}) }),

  // mission control (EW8)
  listMissions: (sessionId) => ipcRenderer.invoke('app/missions/list', { sessionId: sessionId ?? null }),
  getMission: (missionId) => ipcRenderer.invoke('app/missions/get', { missionId }),
  createMission: (sessionId, body) => ipcRenderer.invoke('app/missions/create', { sessionId, body }),
  decideMissionApproval: (missionId, approvalId, body) => ipcRenderer.invoke('app/missions/decide', { missionId, approvalId, body }),
  startMission: (missionId, expectedMissionVersion) => ipcRenderer.invoke('app/missions/start', { missionId, expectedMissionVersion }),
  pauseMission: (missionId, expectedMissionVersion) => ipcRenderer.invoke('app/missions/pause', { missionId, expectedMissionVersion }),
  resumeMission: (missionId, expectedMissionVersion) => ipcRenderer.invoke('app/missions/resume', { missionId, expectedMissionVersion }),
  cancelMission: (missionId, expectedMissionVersion) => ipcRenderer.invoke('app/missions/cancel', { missionId, expectedMissionVersion }),

  // product governance (EW9)
  listPolicyLayers: () => ipcRenderer.invoke('app/policies/layers', {}),
  updatePolicyLayer: (layer, maximumAutonomy, expectedRevision) => ipcRenderer.invoke('app/policies/update', { layer, maximumAutonomy, expectedRevision: expectedRevision ?? null }),
  getProductSettings: () => ipcRenderer.invoke('app/settings/get', {}),
  updateProductSettings: (body) => ipcRenderer.invoke('app/settings/update', {
    traceExportEnabled: body.traceExportEnabled ?? null,
    localOnly: body.localOnly ?? null,
    eventJournalRetentionDays: body.eventJournalRetentionDays ?? null,
    expectedRevision: body.expectedRevision ?? null
  }),
  listKnowledge: () => ipcRenderer.invoke('app/knowledge/list', {}),
  suggestKnowledge: (content, sourceRef) => ipcRenderer.invoke('app/knowledge/suggest', { content, sourceRef: sourceRef ?? null }),
  confirmKnowledge: (knowledgeId) => ipcRenderer.invoke('app/knowledge/confirm', { knowledgeId }),

  // settings center (SET-2/SET-3)
  getDesktopPreferences: () => ipcRenderer.invoke('app/preferences/get', {}),
  updateDesktopPreferences: (body) => ipcRenderer.invoke('app/preferences/update', body),
  getModelCatalog: () => ipcRenderer.invoke('app/models/catalog', {}),
  revealDiagnosticsFolder: () => ipcRenderer.invoke('app/diagnostics/reveal'),
  copyDiagnostics: () => ipcRenderer.invoke('app/diagnostics/copy'),
  getAboutInfo: () => ipcRenderer.invoke('app/about/get'),
  approvalPing: () => ipcRenderer.invoke('app/approvals/ping'),

  // read-only external sources (EW10.2); content is untrusted data
  fetchSource: (body) => ipcRenderer.invoke('app/sources/fetch', {
    sourceType: body.sourceType,
    uri: body.uri,
    maxBytes: body.maxBytes ?? null
  }),

  // read-only MCP sources (EW10.3); content is untrusted data
  listMcpServers: () => ipcRenderer.invoke('app/mcp/servers', {}),
  listMcpResources: (serverId) => ipcRenderer.invoke('app/mcp/resources', { serverId }),
  readMcpResource: (serverId, uri) => ipcRenderer.invoke('app/mcp/resource/read', { serverId, uri }),

  // skill catalog (EW10.5) / typed hooks health (EW10.6)
  registerSkill: (body) => ipcRenderer.invoke('app/skills/register', body),
  listSkills: () => ipcRenderer.invoke('app/skills/list', {}),
  changeSkillStatus: (skillId, body) => ipcRenderer.invoke('app/skills/status', { skillId, ...body }),
  listHooks: () => ipcRenderer.invoke('app/hooks/list', {}),
  listHookExecutions: () => ipcRenderer.invoke('app/hooks/executions', {}),

  // governed extension surface (capability uplift WU07): configuration and
  // evidence only — no renderer path into MCP execution or skill code.
  listMcpServersGoverned: () => ipcRenderer.invoke('app/mcp/servers-governed', {}),
  createMcpServer: (body) => ipcRenderer.invoke('app/mcp/server-create', body),
  getMcpServer: (serverId) => ipcRenderer.invoke('app/mcp/server-get', { serverId }),
  updateMcpServer: (serverId, body) => ipcRenderer.invoke('app/mcp/server-update', { serverId, ...body }),
  setMcpServerStatus: (serverId, body) => ipcRenderer.invoke('app/mcp/server-status', { serverId, ...body }),
  requestMcpConnectionAction: (serverId, action) => ipcRenderer.invoke('app/mcp/connection-action', { serverId, action }),
  getMcpOperation: (operationId) => ipcRenderer.invoke('app/mcp/operation', { operationId }),
  listMcpServerTools: (serverId, options) => ipcRenderer.invoke('app/mcp/tools', {
    serverId, cursor: options?.cursor ?? null, limit: options?.limit ?? null }),
  refreshMcpServerCatalog: (serverId) => ipcRenderer.invoke('app/mcp/catalog-refresh', { serverId }),
  // WU08: OAuth consent — the service returns a loginUrl; the renderer
  // hands it to openExternalHttps. Tokens never cross this boundary.
  requestMcpAuthAction: (serverId, action) => ipcRenderer.invoke('app/mcp/auth-action', { serverId, action }),
  listMcpPrompts: (serverId) => ipcRenderer.invoke('app/mcp/prompts', { serverId }),
  resolveMcpPrompt: (serverId, body) => ipcRenderer.invoke('app/mcp/prompt-resolve', { serverId, ...body }),
  listMcpResourceTemplates: (serverId) => ipcRenderer.invoke('app/mcp/resource-templates', { serverId }),
  // WU01: Hub association — the payload carries credential SLOT names
  // only; token material is created/held inside the service secret store.
  listHubConnections: () => ipcRenderer.invoke('app/hub/connections', {}),
  registerHubConnection: (body) => ipcRenderer.invoke('app/hub/connection-create', body),
  getHubConnection: (hubConnectionId) => ipcRenderer.invoke('app/hub/connection-get', { hubConnectionId }),
  updateHubConnection: (hubConnectionId, body) => ipcRenderer.invoke('app/hub/connection-update', { hubConnectionId, ...body }),
  requestHubConnectionAction: (hubConnectionId, action) => ipcRenderer.invoke('app/hub/connection-action', { hubConnectionId, action }),
  registerHubManagedServer: (hubConnectionId) => ipcRenderer.invoke('app/hub/register-server', { hubConnectionId }),
  getHubCapabilities: (hubConnectionId) => ipcRenderer.invoke('app/hub/capabilities', { hubConnectionId }),
  // W3 resource sessions: lease observe/control. No token or session
  // state lives in the renderer — the service receipt is authoritative.
  listHubResources: (hubConnectionId) => ipcRenderer.invoke('app/hub/resources', { hubConnectionId }),
  listHubSessions: (hubConnectionId) => ipcRenderer.invoke('app/hub/sessions', { hubConnectionId }),
  acquireHubSession: (hubConnectionId, body) => ipcRenderer.invoke('app/hub/session-acquire', { hubConnectionId, ...body }),
  controlHubSession: (hubConnectionId, sessionId, body) => ipcRenderer.invoke('app/hub/session-control', { hubConnectionId, sessionId, ...body }),
  listSkillsGoverned: () => ipcRenderer.invoke('app/skills/governed', {}),
  pickSkillImportSource: (displayName) => ipcRenderer.invoke('app/skills/import-pick', { displayName: displayName ?? null }),
  previewSkillImport: (sourceHandle) => ipcRenderer.invoke('app/skills/import-preview', { sourceHandle }),
  importSkillPackage: (body) => ipcRenderer.invoke('app/skills/import', body),
  listSkillVersions: (skillId) => ipcRenderer.invoke('app/skills/versions', { skillId }),
  selectSkillVersion: (skillId, body) => ipcRenderer.invoke('app/skills/version-select', { skillId, ...body }),
  getExecutionExtensions: (executionId) => ipcRenderer.invoke('app/executions/extensions', { executionId }),
  listExtensionInvocations: (executionId, options) => ipcRenderer.invoke('app/executions/extension-invocations', {
    executionId, cursor: options?.cursor ?? null, limit: options?.limit ?? null }),
  // WU08: operator actions (CANCEL/RESUME_INPUT/RECONCILE) and the governed
  // debug execution — evidence, approval and ownership stay server-side.
  requestExtensionInvocationAction: (executionId, invocationId, body) =>
    ipcRenderer.invoke('app/executions/extension-invocation-action', { executionId, invocationId, ...body }),
  createExtensionTestExecution: (body) => ipcRenderer.invoke('app/executions/extension-test', body),
  getSkillManifest: (skillId, versionDigest) => ipcRenderer.invoke('app/skills/manifest', { skillId, versionDigest }),

  // environment feature surface (settings design): capability cards, desired
  // state writes (restart to apply), managed provider/model catalog. apiKey
  // passes through once — it is write-only and never echoed back.
  getEnvironmentFeatures: () => ipcRenderer.invoke('app/environment/features', {}),
  updateEnvironmentFeature: (featureId, body) => ipcRenderer.invoke('app/environment/feature-update', {
    featureId,
    enabled: body.enabled ?? null,
    entries: body.entries ?? null,
    expectedRevision: body.expectedRevision ?? null
  }),
  preflightEnvironmentFeature: (featureId) => ipcRenderer.invoke('app/environment/feature-preflight', { featureId }),
  listManagedModelProviders: () => ipcRenderer.invoke('app/model-providers/list', {}),
  probeRemoteProviderModels: (body) => ipcRenderer.invoke('app/model-providers/remote-models', { body }),
  upsertModelProvider: (providerId, body) => ipcRenderer.invoke('app/model-providers/upsert', { providerId, body }),
  deleteModelProvider: (providerId, expectedRevision, replaceDefault) => ipcRenderer.invoke('app/model-providers/delete', { providerId, expectedRevision: expectedRevision ?? null, replaceDefault: replaceDefault ?? null }),
  upsertProviderModel: (providerId, modelId, body) => ipcRenderer.invoke('app/model-providers/model-upsert', { providerId, modelId, body }),
  deleteProviderModel: (providerId, modelId, expectedRevision, replaceDefault) => ipcRenderer.invoke('app/model-providers/model-delete', { providerId, modelId, expectedRevision: expectedRevision ?? null, replaceDefault: replaceDefault ?? null }),
  // web-search records (V026): multi-record profiles, one enabled; apiKey
  // is write-only secret material and is never echoed back.
  listWebSearchProviders: () => ipcRenderer.invoke('app/web-search-providers/list', {}),
  upsertWebSearchProvider: (providerId, body) => ipcRenderer.invoke('app/web-search-providers/upsert', { providerId, body }),
  deleteWebSearchProvider: (providerId, expectedRevision) => ipcRenderer.invoke('app/web-search-providers/delete', { providerId, expectedRevision: expectedRevision ?? null }),

  // main -> renderer push subscriptions
  onDurableEvents(listener) {
    const handler = (_event: IpcRendererEvent, frames: DurableEventFrameLike[]): void => listener(frames);
    ipcRenderer.on('app/events/durable', handler);
    return () => ipcRenderer.removeListener('app/events/durable', handler);
  },
  onNativeTaskEvents(listener) {
    const handler = (_event: IpcRendererEvent, push: NativeTaskEventPush): void => listener(push);
    ipcRenderer.on('app/events/native', handler);
    return () => ipcRenderer.removeListener('app/events/native', handler);
  },
  onEventStatus(listener) {
    eventStatusListeners.add(listener);
    if (lastEventStatus) {
      const status = lastEventStatus;
      queueMicrotask(() => {
        if (eventStatusListeners.has(listener)) listener(status);
      });
    }
    return () => eventStatusListeners.delete(listener);
  }
};

contextBridge.exposeInMainWorld('codeAgentDesktop', api);

export type CodeAgentDesktopApi = DesktopApi;
