/**
 * Fixed IPC channel names and payload validation (design 6.3 / ADR-E002).
 * No generic channel proxy: every channel is named and validated here.
 */

import { isAllowedExternalUrl } from '../security/navigation';
import type { DesktopBootstrap } from '../../shared/api-types';

export type { DesktopBootstrap };

export const IPC_CHANNELS = {
  collaboration: 'app/collaboration',
  writableCollaboration: 'app/writable-collaboration',
  // PAE P8: bounded /api/personal/v1 operations (P0 frozen whitelist; the
  // renderer submits PersonalOperation objects, never raw HTTP).
  personal: 'app/personal',
  // UCA-001 C4: client-access/1 personal access server (PAC) surface. Bounded
  // operations only — the renderer never supplies a URL, method or header.
  personalAccess: 'app/personal-access',
  bootstrap: 'app/bootstrap',
  // Native window controls are intentionally a fixed action enum. Renderer
  // code never receives a general-purpose IPC channel.
  windowControl: 'app/window/control',
  windowStatePush: 'app/window/state',
  openExternalHttps: 'app/openExternalHttps',
  serviceRestart: 'app/service/restart',
  serviceStatus: 'app/service/status',
  chooseAndRegister: 'app/projects/chooseAndRegister',
  chooseDirectory: 'app/dialog/chooseDirectory',
  diagnostics: 'app/diagnostics',
  saveConversationExport: 'app/export/save',
  // data proxy channels (fixed per use case; renderer never fetches directly)
  projectsList: 'app/projects/list',
  projectSessionPreflight: 'app/projects/session-preflight',
  // build-plan surface (design 2026-09-26 §7.2): dry-run plan view,
  // validated override upsert, side-effect-free preview.
  projectBuildPlan: 'app/projects/build-plan',
  projectBuildPlanOverride: 'app/projects/build-plan-override',
  projectBuildPlanPreview: 'app/projects/build-plan-preview',
  // verification-profile surface (design 2026-09-26 §7.4/§10.2)
  projectVerificationProfiles: 'app/projects/verification-profiles',
  projectVerificationProfilePut: 'app/projects/verification-profile-put',
  sessionsList: 'app/sessions/list',
  // 2026-09-05 history pagination channels (design §5.1)
  sessionSummariesList: 'app/sessions/summaries',
  sessionSummaryGet: 'app/sessions/summary',
  sessionMetadataGet: 'app/sessions/metadata',
  sessionMessagesPage: 'app/sessions/messages-page',
  sessionMessageContent: 'app/sessions/message-content',
  sessionsGet: 'app/sessions/get',
  sessionsCreate: 'app/sessions/create',
  sessionsPatch: 'app/sessions/patch',
  sessionsMessage: 'app/sessions/message',
  sessionsAttachmentContent: 'app/sessions/attachment-content',
  sessionsAttachmentBytes: 'app/sessions/attachment-bytes',
  sessionsFork: 'app/sessions/fork',
  sessionsArchive: 'app/sessions/archive',
  runsList: 'app/runs/list',
  attentionList: 'app/attention/list',
  terminalSessionsList: 'app/terminal-sessions/list',
  terminalSessionCreate: 'app/terminal-sessions/create',
  terminalSessionGet: 'app/terminal-sessions/get',
  terminalOutputGet: 'app/terminal-sessions/output',
  terminalInputWrite: 'app/terminal-sessions/input',
  terminalSessionResize: 'app/terminal-sessions/resize',
  terminalSessionSignal: 'app/terminal-sessions/signal',
  terminalSessionClose: 'app/terminal-sessions/close',
  terminalControlAcquire: 'app/terminal-sessions/control/acquire',
  terminalControlRenew: 'app/terminal-sessions/control/renew',
  terminalControlRelease: 'app/terminal-sessions/control/release',
  specsCreate: 'app/specs/create',
  specsGet: 'app/specs/get',
  specsRevise: 'app/specs/revise',
  specsDecide: 'app/specs/decide',
  specsConvert: 'app/specs/convert',
  commandApproval: 'app/approvals/command',
  sandboxApproval: 'app/approvals/sandbox',
  sandboxApprovalPending: 'app/approvals/sandbox/pending',
  terminalApproval: 'app/approvals/terminal',
  terminalApprovalPending: 'app/approvals/terminal/pending',
  budgetApproval: 'app/approvals/budget',
  writeApproval: 'app/approvals/write',
  writeApprovalPending: 'app/approvals/write/pending',
  executionPolicyGet: 'app/execution-policy/get',
  executionPolicyUpdate: 'app/execution-policy/update',
  executionPolicyDefaultsGet: 'app/execution-policy/defaults/get',
  executionPolicyDefaultsUpdate: 'app/execution-policy/defaults/update',
  executionPolicyMyDefaultsGet: 'app/execution-policy/my-defaults/get',
  executionPolicyMyDefaultsUpdate: 'app/execution-policy/my-defaults/update',
  automationControlGet: 'app/automation-controls/get',
  automationControlUpdate: 'app/automation-controls/update',
  approvalsList: 'app/approvals/v2/list',
  approvalGet: 'app/approvals/v2/get',
  approvalDecide: 'app/approvals/v2/decide',
  approvalAdvance: 'app/approvals/v2/advance',
  approvalControl: 'app/approvals/v2/control',
  runInterrupt: 'app/runs/interrupt',
  runControl: 'app/runs/control',
  runContinue: 'app/runs/continue',
  runCancel: 'app/runs/cancel',
  runDiff: 'app/runs/diff',
  runReview: 'app/runs/review',
  runEvidence: 'app/runs/evidence',
  runActivities: 'app/runs/activities',
  runReasoning: 'app/runs/reasoning',
  runOutput: 'app/runs/output',
  // Session execution-evidence reads (design 2026-09-26 §10.2)
  sessionExecutions: 'app/sessions/executions/list',
  sessionExecution: 'app/sessions/executions/get',
  sessionExecutionArtifact: 'app/sessions/executions/artifact',
  workspaceConflictsList: 'app/workspace-conflicts/list',
  workspaceConflictsFiltered: 'app/workspace-conflicts/list-filtered',
  workspaceConflictGet: 'app/workspace-conflicts/get',
  workspaceConflictResolve: 'app/workspace-conflicts/resolve',
  workspaceConflictAutoMerge: 'app/workspace-conflicts/auto-merge',
  workspaceConflictDismiss: 'app/workspace-conflicts/dismiss',
  workspaceConflictProposalSubmit: 'app/workspace-conflicts/proposals/submit',
  workspaceConflictProposalPoll: 'app/workspace-conflicts/proposals/poll',
  workspaceConflictsResolveBatch: 'app/workspace-conflicts/resolve-batch',
  workspaceContentGet: 'app/workspace-contents/get',
  workspaceContentPut: 'app/workspace-contents/put',
  readProjectFile: 'app/projects/read-file',
  createFixTask: 'app/findings/fix-task',
  revealProjectFile: 'app/projects/reveal-file',
  // service-owned workspace executions (EW7)
  workspaceExecutionsList: 'app/workspace-executions/list',
  workspaceExecutionCreate: 'app/workspace-executions/create',
  workspaceExecutionHandoff: 'app/workspace-executions/handoff',
  workspaceExecutionReclaim: 'app/workspace-executions/reclaim',
  workspaceLaneCreate: 'app/workspace-lanes/create',
  workspaceLaneGet: 'app/workspace-lanes/get',
  workspaceLaneBind: 'app/workspace-lanes/bind',
  workspaceLaneReopen: 'app/workspace-lanes/reopen',
  workspaceLaneRelease: 'app/workspace-lanes/release',
  deliveryCreate: 'app/deliveries/create',
  deliveryGet: 'app/deliveries/get',
  deliveryChanges: 'app/deliveries/changes',
  deliveryPrepare: 'app/deliveries/prepare',
  deliveryDecide: 'app/deliveries/decide',
  deliveryApply: 'app/deliveries/apply',
  deliveryReconcile: 'app/deliveries/reconcile',
  deliveryRebase: 'app/deliveries/rebase',
  deliveryList: 'app/deliveries/list',
  // mission control (EW8)
  missionsList: 'app/missions/list',
  missionsGet: 'app/missions/get',
  missionsCreate: 'app/missions/create',
  missionsDecide: 'app/missions/decide',
  missionsStart: 'app/missions/start',
  missionsPause: 'app/missions/pause',
  missionsResume: 'app/missions/resume',
  missionsCancel: 'app/missions/cancel',
  // product governance (EW9)
  policyLayersList: 'app/policies/layers',
  policyLayerUpdate: 'app/policies/update',
  settingsGet: 'app/settings/get',
  settingsUpdate: 'app/settings/update',
  knowledgeList: 'app/knowledge/list',
  knowledgeSuggest: 'app/knowledge/suggest',
  knowledgeConfirm: 'app/knowledge/confirm',
  // settings center (SET-2/SET-3): main-owned preferences + model catalog proxy
  preferencesGet: 'app/preferences/get',
  preferencesUpdate: 'app/preferences/update',
  modelsCatalog: 'app/models/catalog',
  agentProfilesList: 'app/agent-profiles/list',
  diagnosticsReveal: 'app/diagnostics/reveal',
  diagnosticsCopy: 'app/diagnostics/copy',
  aboutGet: 'app/about/get',
  // approval attention ping: renderer asks main to flash the taskbar when a
  // new approval waits while the window is not focused. No payload, no data.
  approvalPing: 'app/approvals/ping',
  // read-only external sources (EW10.2)
  sourcesFetch: 'app/sources/fetch',
  // read-only MCP sources (EW10.3)
  mcpServersList: 'app/mcp/servers',
  mcpResourcesList: 'app/mcp/resources',
  mcpResourceRead: 'app/mcp/resource/read',
  // skill catalog (EW10.5) + typed hooks health (EW10.6)
  skillsRegister: 'app/skills/register',
  skillsList: 'app/skills/list',
  skillStatus: 'app/skills/status',
  hooksList: 'app/hooks/list',
  hooksExecutions: 'app/hooks/executions',
  // governed extension surface (capability uplift WU07): configuration and
  // evidence only — the renderer never executes MCP calls or skill code.
  mcpServersGoverned: 'app/mcp/servers-governed',
  mcpServerCreate: 'app/mcp/server-create',
  mcpServerGet: 'app/mcp/server-get',
  mcpServerUpdate: 'app/mcp/server-update',
  mcpServerStatus: 'app/mcp/server-status',
  mcpConnectionAction: 'app/mcp/connection-action',
  mcpOperationGet: 'app/mcp/operation',
  mcpToolsList: 'app/mcp/tools',
  mcpCatalogRefresh: 'app/mcp/catalog-refresh',
  // WU08: OAuth consent flow (START returns a loginUrl the main process
  // opens externally — tokens never cross IPC) and capability-gated
  // discovery reads.
  mcpAuthAction: 'app/mcp/auth-action',
  mcpPromptsList: 'app/mcp/prompts',
  mcpPromptResolve: 'app/mcp/prompt-resolve',
  mcpResourceTemplates: 'app/mcp/resource-templates',
  // WU01 (uplift design §5): Hub association — fixed base URL + credential
  // slot records, typed probes, and managed-server materialization. The
  // Hub /mcp endpoint itself is governed through the mcp/* channels.
  hubConnectionsList: 'app/hub/connections',
  hubConnectionCreate: 'app/hub/connection-create',
  hubConnectionGet: 'app/hub/connection-get',
  hubConnectionUpdate: 'app/hub/connection-update',
  hubConnectionAction: 'app/hub/connection-action',
  hubRegisterServer: 'app/hub/register-server',
  hubCapabilities: 'app/hub/capabilities',
  // W3 resource sessions: occupancy view + lease ops, proxied through the
  // service to Hub /api/v2/resources*. Session ids are Hub-owned strings.
  hubResources: 'app/hub/resources',
  hubSessionsList: 'app/hub/sessions',
  hubSessionAcquire: 'app/hub/session-acquire',
  hubSessionControl: 'app/hub/session-control',
  // skill import: the pick channel opens the main-process directory dialog
  // itself — the renderer receives only an opaque sourceHandle.
  skillsGoverned: 'app/skills/governed',
  skillImportPick: 'app/skills/import-pick',
  skillImportPreview: 'app/skills/import-preview',
  skillImport: 'app/skills/import',
  skillVersionsList: 'app/skills/versions',
  skillVersionSelect: 'app/skills/version-select',
  executionExtensions: 'app/executions/extensions',
  extensionInvocations: 'app/executions/extension-invocations',
  // WU08: operator actions on a durable invocation row (CANCEL /
  // RESUME_INPUT / RECONCILE) and the governed debug execution.
  extensionInvocationAction: 'app/executions/extension-invocation-action',
  extensionTestExecution: 'app/executions/extension-test',
  skillManifest: 'app/skills/manifest',
  // environment feature surface (settings design): capability cards +
  // desired-state writes, plus the managed two-level model catalog.
  environmentFeatures: 'app/environment/features',
  environmentFeatureUpdate: 'app/environment/feature-update',
  environmentFeaturePreflight: 'app/environment/feature-preflight',
  modelProviders: 'app/model-providers/list',
  modelProviderRemoteModels: 'app/model-providers/remote-models',
  modelProviderUpsert: 'app/model-providers/upsert',
  modelProviderDelete: 'app/model-providers/delete',
  modelProviderModelUpsert: 'app/model-providers/model-upsert',
  modelProviderModelDelete: 'app/model-providers/model-delete',
  // web-search record surface (V026): multi-record desired state with a
  // single enabled profile; secret material is write-only.
  webSearchProviders: 'app/web-search-providers/list',
  webSearchProviderUpsert: 'app/web-search-providers/upsert',
  webSearchProviderDelete: 'app/web-search-providers/delete',
  // main -> renderer push channels
  durableEventsPush: 'app/events/durable',
  nativeEventsPush: 'app/events/native',
  eventStatusPush: 'app/events/status'
} as const;

export function validateBootstrapPayload(payload: unknown): boolean {
  return payload === undefined || payload === null || (typeof payload === 'object' && !Array.isArray(payload));
}

export interface OpenExternalPayload {
  url: string;
}

export function validateOpenExternalPayload(payload: unknown): payload is OpenExternalPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const url = (payload as Record<string, unknown>).url;
  return typeof url === 'string' && isAllowedExternalUrl(url);
}
