import {validNativeArtifactSave,decodeNativeArtifact} from './service/nativeArtifact';
import { personalGatewayClient } from './service/personalGateway';
import { writableCollaborationDefinition, createWritableCollaborationHandler } from './ipc/writable-collaboration';
import { collaborationDefinition, createCollaborationHandler } from './ipc/collaboration';
import { personalDefinition, createPersonalHandler } from './ipc/personal';
import { personalAccessDefinition, createPersonalAccessHandler } from './ipc/personalAccess';
import { PersonalAccessSession } from './personal-access/session';
/**
 * Electron main entry (EW2): secure shell + service supervisor wiring.
 * Thin assembly only — every security decision lives in tested modules
 * under security/, service/, bootstrap/ and ipc/.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, Notification, protocol, session, safeStorage, shell, type SaveDialogOptions } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  APP_SCHEME,
  CSP_HEADER,
  buildWebPreferences,
  privilegedSchemes
} from './security/windowSecurity';
import { isHttpsExternalUrl, navigationDecision } from './security/navigation';
import { resolveAppFilePath } from './security/appProtocol';
import { redactSecrets } from './security/redaction';
import { ServiceSupervisor, type AttachConfig, type BundledServiceConfig, type CapabilityHandshake } from './service/supervisor';
import { ConnectionCoordinator, buildElectronProfilePathPlan, buildSecondInstanceIntent, validateSecondInstanceIntent, type ConnectionTarget } from './service/connectionCoordinator';
import { resolveLaunchProfile, verifyLaunchProfileDirectory, verifyLaunchProfilePaths, type DesktopLaunchProfile } from './bootstrap/profileResolver';
import { loadOrCreateProfileManifest, type ProfileManifest } from './bootstrap/profileManifest';
import {
  IPC_CHANNELS,
  validateOpenExternalPayload
} from './ipc/channels';
import {
  IpcRegistry,
  attentionListDefinition,
  bootstrapDefinition,
  chooseDirectoryDefinition,
  chooseAndRegisterDefinition,
  diagnosticsDefinition,
  saveConversationExportDefinition,
  openExternalDefinition,
  projectsListDefinition,
  projectSessionPreflightDefinition,
  projectBuildPlanDefinition,
  projectBuildPlanOverrideDefinition,
  projectBuildPlanPreviewDefinition,
  projectVerificationProfilesDefinition,
  projectVerificationProfilePutDefinition,
  runsListDefinition,
  windowControlDefinition,
  terminalSessionsListDefinition,
  terminalSessionCreateDefinition,
  terminalSessionGetDefinition,
  terminalOutputGetDefinition,
  terminalInputWriteDefinition,
  terminalSessionResizeDefinition,
  terminalSessionSignalDefinition,
  terminalSessionCloseDefinition,
  terminalControlAcquireDefinition,
  terminalControlRenewDefinition,
  terminalControlReleaseDefinition,
  serviceRestartDefinition,
  serviceStatusDefinition,
  sessionsArchiveDefinition,
  sessionsCreateDefinition,
  sessionsForkDefinition,
  sessionsGetDefinition,
  sessionSummariesListDefinition,
  sessionSummaryGetDefinition,
  sessionMetadataGetDefinition,
  sessionMessagesPageDefinition,
  sessionMessageContentDefinition,
  sessionsListDefinition,
  sessionsAttachmentContentDefinition,
  sessionsAttachmentBytesDefinition,
  sessionsMessageDefinition,
  sessionsPatchDefinition,
  runCancelDefinition,
  runInterruptDefinition,
  runControlDefinition,
  runContinueDefinition,
  runDiffDefinition,
  runReviewDefinition,
  runEvidenceDefinition,
  runActivitiesDefinition,
  sessionExecutionsDefinition,
  sessionExecutionDefinition,
  sessionExecutionArtifactDefinition,
  runReasoningDefinition,
  runOutputDefinition,
  workspaceConflictsListDefinition,
  workspaceConflictGetDefinition,
  workspaceConflictResolveDefinition,
  workspaceConflictAutoMergeDefinition,
  workspaceConflictDismissDefinition,
  workspaceConflictProposalSubmitDefinition,
  workspaceConflictProposalPollDefinition,
  workspaceConflictsResolveBatchDefinition,
  workspaceConflictsFilteredDefinition,
  workspaceContentGetDefinition,
  workspaceContentPutDefinition,
  readProjectFileDefinition,
  createFixTaskDefinition,
  revealProjectFileDefinition,
  workspaceExecutionsListDefinition,
  workspaceExecutionCreateDefinition,
  workspaceExecutionHandoffDefinition,
  workspaceExecutionReclaimDefinition,
  workspaceLaneCreateDefinition,
  workspaceLaneGetDefinition,
  workspaceLaneBindDefinition,
  workspaceLaneReopenDefinition,
  workspaceLaneReleaseDefinition,
  deliveryCreateDefinition,
  deliveryGetDefinition,
  deliveryChangesDefinition,
  deliveryPrepareDefinition,
  deliveryDecideDefinition,
  deliveryApplyDefinition,
  deliveryReconcileDefinition,
  deliveryRebaseDefinition,
  deliveryListDefinition,
  missionsListDefinition,
  missionsGetDefinition,
  missionsCreateDefinition,
  missionsDecideDefinition,
  missionsStartDefinition,
  missionsPauseDefinition,
  missionsResumeDefinition,
  missionsCancelDefinition,
  policyLayersListDefinition,
  policyLayerUpdateDefinition,
  settingsGetDefinition,
  settingsUpdateDefinition,
  knowledgeListDefinition,
  knowledgeSuggestDefinition,
  knowledgeConfirmDefinition,
  preferencesGetDefinition,
  preferencesUpdateDefinition,
  modelsCatalogDefinition,
  agentProfilesListDefinition,
  diagnosticsRevealDefinition,
  diagnosticsCopyDefinition,
  aboutGetDefinition,
  approvalPingDefinition,
  sourcesFetchDefinition,
  mcpServersListDefinition,
  mcpResourcesListDefinition,
  mcpResourceReadDefinition,
  skillsRegisterDefinition,
  skillsListDefinition,
  skillStatusDefinition,
  hooksListDefinition,
  hooksExecutionsDefinition,
  mcpServersGovernedDefinition,
  mcpServerCreateDefinition,
  mcpServerGetDefinition,
  mcpServerUpdateDefinition,
  mcpServerStatusDefinition,
  mcpConnectionActionDefinition,
  mcpOperationGetDefinition,
  mcpToolsListDefinition,
  mcpCatalogRefreshDefinition,
  mcpAuthActionDefinition,
  mcpPromptsListDefinition,
  mcpPromptResolveDefinition,
  mcpResourceTemplatesDefinition,
  hubConnectionsListDefinition,
  hubConnectionCreateDefinition,
  hubConnectionGetDefinition,
  hubConnectionUpdateDefinition,
  hubConnectionActionDefinition,
  hubRegisterServerDefinition,
  hubCapabilitiesDefinition,
  hubResourcesDefinition,
  hubSessionsListDefinition,
  hubSessionAcquireDefinition,
  hubSessionControlDefinition,
  skillsGovernedDefinition,
  skillImportPickDefinition,
  skillImportPreviewDefinition,
  skillImportDefinition,
  skillVersionsListDefinition,
  skillVersionSelectDefinition,
  executionExtensionsDefinition,
  extensionInvocationsDefinition,
  extensionInvocationActionDefinition,
  extensionTestExecutionDefinition,
  skillManifestDefinition,
  environmentFeaturesDefinition,
  environmentFeatureUpdateDefinition,
  environmentFeaturePreflightDefinition,
  modelProvidersDefinition,
  modelProviderRemoteModelsDefinition,
  modelProviderUpsertDefinition,
  modelProviderDeleteDefinition,
  modelProviderModelUpsertDefinition,
  modelProviderModelDeleteDefinition,
  webSearchProvidersDefinition,
  webSearchProviderUpsertDefinition,
  webSearchProviderDeleteDefinition,
  specsCreateDefinition,
  specsGetDefinition,
  specsReviseDefinition,
  specsDecideDefinition,
  specsConvertDefinition,
  commandApprovalDefinition,
  sandboxApprovalDefinition,
  sandboxApprovalPendingDefinition,
  terminalApprovalDefinition,
  terminalApprovalPendingDefinition,
  budgetApprovalDefinition,
  writeApprovalDefinition,
  writeApprovalPendingDefinition,
  executionPolicyGetDefinition,
  executionPolicyUpdateDefinition,
  executionPolicyDefaultsGetDefinition,
  executionPolicyDefaultsUpdateDefinition,
  executionPolicyMyDefaultsGetDefinition,
  executionPolicyMyDefaultsUpdateDefinition,
  automationControlGetDefinition,
  automationControlUpdateDefinition,
  approvalsListDefinition,
  approvalGetDefinition,
  approvalDecideDefinition,
  approvalAdvanceDefinition,
  approvalControlDefinition,
  type ServiceStatusResult
} from './ipc/registry';
import { SecureConfigStore, type SecretStore, type DesktopConfig } from './bootstrap/secureConfig';
import { DesktopPreferencesStore } from './bootstrap/preferencesStore';
import { migrateLegacyPreferences } from './bootstrap/preferencesMigration';
import { NotificationCoordinator } from './native/notifications';
import { DurableEventClient, type DurableEventFrame } from './transport/durableEvents';
import { NativeTaskEventClient } from './transport/nativeTaskEvents';
import { ServiceClient, ServiceProblem, ProtocolIncompatible } from '../../packages/service-client/src/index.js';
import type { DesktopBootstrap, DesktopCapabilities, DesktopError, OperationCapability } from '../shared/api-types';
import type { JsonValue, McpServerUpdateRequest } from '../../packages/protocol/src/index.js';

// must be registered before app ready
protocol.registerSchemesAsPrivileged(privilegedSchemes());

// This checkout owns the dedicated Codex Business service on 8766.  The
// Enterprise/legacy service on 8765 must never be selected by fallback.
const DEFAULT_ATTACH_ENDPOINT = 'http://127.0.0.1:8766';

const launchProfile: DesktopLaunchProfile = resolveLaunchProfile({
  argv: process.argv,
  env: process.env,
  appRoot: app.getAppPath(),
  isPackaged: app.isPackaged,
  desktopProfilesRoot: process.env.CODEAGENT_DESKTOP_PROFILE_ROOT,
  repositoryGitDir: path.resolve(app.getAppPath(), '..', '..', '.git'),
  serviceStateDir: process.env.CODEAGENT_SERVICE_STATE_DIR
});
const profilePathPlan = buildElectronProfilePathPlan(launchProfile);
fs.mkdirSync(launchProfile.profileDir, { recursive: true });
verifyLaunchProfileDirectory(launchProfile);
for (const directory of [profilePathPlan.userData, profilePathPlan.sessionData,
  profilePathPlan.crashDumps, profilePathPlan.logs, launchProfile.diagnosticsDir]) {
  fs.mkdirSync(directory, { recursive: true });
}
verifyLaunchProfilePaths(launchProfile);
app.setPath('userData', profilePathPlan.userData);
app.setPath('sessionData', profilePathPlan.sessionData);
app.setPath('crashDumps', profilePathPlan.crashDumps);
app.setAppLogsPath(profilePathPlan.logs);

const startupConnectionEndpoint = process.env.CODEAGENT_SERVICE_ENDPOINT
  ?? readPrelockAttachEndpoint(launchProfile.userDataDir)
  ?? DEFAULT_ATTACH_ENDPOINT;
const gotLock = app.requestSingleInstanceLock(buildSecondInstanceIntent(process.env, {
  profileId: launchProfile.profileId,
  endpoint: startupConnectionEndpoint,
  buildId: app.getVersion()
}));
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const supervisor = new ServiceSupervisor({
  onOwnedExit: (info) => {
    LOG_ERROR(`owned service exited unexpectedly (pid ${info.pid}, code ${String(info.exitCode)})`);
    notifyServiceEvent('CodeAgent Service 已退出', `pid ${info.pid}，code ${String(info.exitCode)}。可在应用内重新启动。`);
    void refreshServiceStatus();
  }
});
const registry = new IpcRegistry();
let configStore: SecureConfigStore;
let profileManifest: ProfileManifest;
let preferencesStore: DesktopPreferencesStore;
let notifications: NotificationCoordinator;
/** Bearer HTTP base for main-proxied service calls; set on successful attach/start. */
let serviceHttp: { baseUrl: string; token: string } | null = null;
let clientSession: { id: string; token: string; bootId: string; storeId: string } | null = null;
let clientSessionHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let durableClient: DurableEventClient | null = null;
let durableResyncInFlight = false;
let durableResyncRetryTimer: ReturnType<typeof setTimeout> | null = null;
let durableResyncRetryAttempt = 0;
let activeConnectionGeneration = 0;
const connectionCoordinator = new ConnectionCoordinator({
  supervisor,
  onGenerationChanged: (generation) => {
    activeConnectionGeneration = generation;
    serviceHttp = null;
    clientSession = null;
    stopClientSessionHeartbeat();
    stopDurableStream();
    stopNativeEventStreams();
  }
});

function proxyClient(): ServiceClient | null {
  if (!serviceHttp) return null;
  return new ServiceClient({ baseUrl: serviceHttp.baseUrl, token: serviceHttp.token,
    clientSessionToken: clientSession?.token });
}

function desktopCapabilitiesFrom(raw: {
  serviceInstanceId?: string;
  storeId?: string;
  bootId?: string;
  multiClient?: {
    contractVersion: string;
    mode: string;
    lifecycle: string;
    registrationRequiredForMutation: boolean;
    limits?: Record<string, unknown>;
  };
  features?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  operations?: ReadonlyArray<{
    id?: unknown;
    availability?: unknown;
    reasonCode?: unknown;
    limits?: unknown;
    contractVersion?: unknown;
  }>;
}): DesktopCapabilities {
  const features = raw.features;
  const limits = raw.limits;
  const operations = raw.operations;
  const featureNames = ['sessionV2', 'durableEvents', 'visibleOutputStream', 'worktreeExecution', 'mission', 'mcpHost', 'servicePty'] as const;
  const limitNames = ['maxDiffBytes', 'maxEventPage', 'maxVisibleDeltaChars'] as const;
  if (!features || !limits
    || !operations
    || featureNames.some((name) => typeof features[name] !== 'boolean')
    || limitNames.some((name) => typeof limits[name] !== 'number' || !Number.isFinite(limits[name] as number))
    || operations.some((operation) => operation.id === undefined
      || typeof operation.id !== 'string'
      || (operation.availability !== 'AVAILABLE'
        && operation.availability !== 'DEGRADED'
        && operation.availability !== 'UNAVAILABLE')
      || typeof operation.contractVersion !== 'string'
      || operation.contractVersion.length === 0
      || (operation.reasonCode !== undefined && operation.reasonCode !== null && typeof operation.reasonCode !== 'string')
      || (operation.limits !== undefined && operation.limits !== null
        && (typeof operation.limits !== 'object' || Array.isArray(operation.limits))))) {
    return {
      compatible: false,
      operations: [],
      features: {
        sessionV2: false,
        durableEvents: false,
        visibleOutputStream: false,
        worktreeExecution: false,
        mission: false,
        mcpHost: false,
        servicePty: false,
        readOnlySources: false,
        mcpReadOnlySource: false,
        skillsCatalog: false,
        hooks: false,
        readOnlySubagent: false
      },
      limits: {
        maxDiffBytes: 0,
        maxEventPage: 0,
        maxVisibleDeltaChars: 0,
        maxReadOnlySubagentTasksPerBatch: 0,
        maxReadOnlySubagentBatchesPerRun: 0,
        maxReadOnlySubagentParallelism: 0
      }
    };
  }
  const operationCapabilities: OperationCapability[] = operations.map((operation) => ({
    id: operation.id as string,
    availability: operation.availability as OperationCapability['availability'],
    ...(typeof operation.reasonCode === 'string' ? { reasonCode: operation.reasonCode } : {}),
    limits: operation.limits && typeof operation.limits === 'object'
      ? operation.limits as Record<string, never>
      : {},
    contractVersion: operation.contractVersion as string
  }));
  return {
    features: {
      sessionV2: features.sessionV2 as boolean,
      durableEvents: features.durableEvents as boolean,
      visibleOutputStream: features.visibleOutputStream as boolean,
      worktreeExecution: features.worktreeExecution as boolean,
      mission: features.mission as boolean,
      mcpHost: features.mcpHost as boolean,
      servicePty: features.servicePty as boolean,
      readOnlySources: features.readOnlySources === true,
      mcpReadOnlySource: features.mcpReadOnlySource === true,
      skillsCatalog: features.skillsCatalog === true,
      hooks: features.hooks === true,
      readOnlySubagent: features.readOnlySubagent === true,
      ...(typeof features.readOnlySubagentAvailability === 'string'
        ? { readOnlySubagentAvailability: features.readOnlySubagentAvailability }
        : {})
    },
    limits: {
      maxDiffBytes: limits.maxDiffBytes as number,
      maxEventPage: limits.maxEventPage as number,
      maxVisibleDeltaChars: limits.maxVisibleDeltaChars as number,
      ...(typeof limits.maxReadOnlySubagentTasksPerBatch === 'number'
        ? { maxReadOnlySubagentTasksPerBatch: limits.maxReadOnlySubagentTasksPerBatch as number }
        : {}),
      ...(typeof limits.maxReadOnlySubagentBatchesPerRun === 'number'
        ? { maxReadOnlySubagentBatchesPerRun: limits.maxReadOnlySubagentBatchesPerRun as number }
        : {}),
      ...(typeof limits.maxReadOnlySubagentParallelism === 'number'
        ? { maxReadOnlySubagentParallelism: limits.maxReadOnlySubagentParallelism as number }
        : {})
    },
    operations: operationCapabilities,
    compatible: true,
    ...(raw.serviceInstanceId ? { serviceInstanceId: raw.serviceInstanceId } : {}),
    ...(raw.storeId ? { storeId: raw.storeId } : {}),
    ...(raw.bootId ? { bootId: raw.bootId } : {}),
    ...(raw.multiClient ? {
      multiClient: {
        contractVersion: raw.multiClient.contractVersion,
        mode: raw.multiClient.mode,
        lifecycle: raw.multiClient.lifecycle,
        registrationRequiredForMutation: raw.multiClient.registrationRequiredForMutation,
        ...(raw.multiClient.limits && typeof raw.multiClient.limits === 'object'
          ? { limits: raw.multiClient.limits as Record<string, never> } : {})
      }
    } : {})
  };
}

function pushToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function resyncDurableStream(
  client: DurableEventClient,
  generation: number,
  reason: 'CURSOR_EXPIRED' | 'GAP'
): Promise<void> {
  if (durableResyncInFlight) return;
  durableResyncInFlight = true;
  try {
    const service = proxyClient();
    if (!service) throw new Error('SERVICE_NOT_CONNECTED');
    // A resync only needs an atomic journal boundary. Replaying the entire
    // global journal into the renderer blocks the live stream and cannot
    // rebuild session history anyway; the renderer refetches resource
    // snapshots below and historical activity is available per Run.
    const page = await service.getEventSnapshot('GLOBAL', { pageSize: 1 });
    if (!page || !Array.isArray(page.events)
        || typeof page.highWaterMark !== 'number'
        || !Number.isSafeInteger(page.highWaterMark) || page.highWaterMark < 0) {
      throw new Error('EVENT_SNAPSHOT_INVALID');
    }
    if (!connectionCoordinator.isCurrentGeneration(generation)
        || activeConnectionGeneration !== generation || durableClient !== client) return;
    if (durableResyncRetryTimer) {
      clearTimeout(durableResyncRetryTimer);
      durableResyncRetryTimer = null;
    }
    durableResyncRetryAttempt = 0;
    pushToRenderer(IPC_CHANNELS.eventStatusPush, {
      resync: reason,
      snapshotCursor: page.highWaterMark
    });
    client.restart(page.highWaterMark);
  } catch (error) {
    if (connectionCoordinator.isCurrentGeneration(generation) && activeConnectionGeneration === generation) {
      pushToRenderer(IPC_CHANNELS.eventStatusPush, {
        status: 'RECONNECTING',
        resync: reason,
        resyncError: error instanceof Error ? error.message : 'EVENT_SNAPSHOT_FAILED'
      });
      if (durableResyncRetryTimer === null) {
        const delay = Math.min(5000, 500 * 2 ** durableResyncRetryAttempt);
        durableResyncRetryAttempt += 1;
        durableResyncRetryTimer = setTimeout(() => {
          durableResyncRetryTimer = null;
          void resyncDurableStream(client, generation, reason);
        }, delay);
      }
    }
  } finally {
    durableResyncInFlight = false;
  }
}

function startDurableStream(generation: number): void {
  if (!serviceHttp) return;
  const connection = serviceHttp;
  if (durableResyncRetryTimer) {
    clearTimeout(durableResyncRetryTimer);
    durableResyncRetryTimer = null;
  }
  durableResyncRetryAttempt = 0;
  durableClient?.stop();
  const client = new DurableEventClient({
    endpoint: connection.baseUrl,
    token: connection.token,
    clientSessionToken: clientSession?.token,
    strictCursor: true,
    onEvents: (frames: DurableEventFrame[]) => {
      if (connectionCoordinator.isCurrentGeneration(generation) && activeConnectionGeneration === generation) {
        pushToRenderer(IPC_CHANNELS.durableEventsPush, frames);
      }
    },
    onResync: (reason) => {
      if (!connectionCoordinator.isCurrentGeneration(generation) || activeConnectionGeneration !== generation) return;
      // A cursor expiry/gap is recovered from a fixed global journal snapshot;
      // restarting from zero would either loop on retention or fabricate a
      // complete replay boundary.
      pushToRenderer(IPC_CHANNELS.eventStatusPush, { resync: reason });
      void resyncDurableStream(client, generation, reason);
    },
    onStatus: (status) => {
      if (connectionCoordinator.isCurrentGeneration(generation) && activeConnectionGeneration === generation) {
        pushToRenderer(IPC_CHANNELS.eventStatusPush, { status });
      }
    }
  });
  durableClient = client;
  client.start();
}

function stopDurableStream(): void {
  durableClient?.stop();
  durableClient = null;
  if (durableResyncRetryTimer) {
    clearTimeout(durableResyncRetryTimer);
    durableResyncRetryTimer = null;
  }
  durableResyncRetryAttempt = 0;
}

// ---- per-task worker-events/1 streams (native output acceleration) ----
// One NativeTaskEventClient per subscribed task; frames reach the renderer
// through the fixed 'app/events/native' push channel. The stream is a
// visibility accelerator — TASK_MESSAGES polling stays authoritative.

interface NativeEventSubscription {
  client: NativeTaskEventClient;
  resyncRestarts: number;
}

const nativeEventSubscriptions = new Map<string, NativeEventSubscription>();
/** Cursor-resync replays are bounded: repeated failures degrade to an
 * honest DISCONNECTED push instead of a tight open/400 loop. */
const NATIVE_RESYNC_RESTART_LIMIT = 3;

function stopNativeEventStreams(): void {
  for (const [taskId, entry] of nativeEventSubscriptions) {
    entry.client.stop();
    pushToRenderer(IPC_CHANNELS.nativeEventsPush, { taskId, status: 'DISCONNECTED' });
  }
  nativeEventSubscriptions.clear();
}

function stopNativeEventStream(taskId: string): void {
  const entry = nativeEventSubscriptions.get(taskId);
  if (!entry) return;
  entry.client.stop();
  nativeEventSubscriptions.delete(taskId);
}

function nativeEventAckMeta(): Record<string, unknown> {
  return {
    source: 'native-events', instance: 'desktop-main', controlPlaneId: 'local',
    observedAt: new Date().toISOString(), revision: '1',
    supportedActions: [], reasonCodes: []
  };
}

/** The personal transport the current bootstrap selected: production personal
 * gateway when its loopback endpoint is configured, else the ACS client. */
function personalTransport(): ServiceClient | null {
  if (process.env.CODEAGENT_PERSONAL_ENDPOINT !== undefined) {
    try { return personalGatewayClient(process.env.CODEAGENT_PERSONAL_ENDPOINT); }
    catch { return null; }
  }
  return proxyClient();
}

async function subscribeNativeTaskEvents(taskId: string, afterCursor?: string): Promise<unknown> {
  const client = personalTransport();
  if (!client) return { error: 'service is not connected', code: 'SERVICE_NOT_CONNECTED' };
  let cursor = 0;
  if (afterCursor !== undefined) {
    cursor = Number.parseInt(afterCursor, 10);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return { error: 'afterCursor must be a non-negative safe integer', code: 'INVALID_CURSOR' };
    }
  }
  // Authorization before any stream opens: the same bounded TASK read the
  // renderer already uses proves the task is reachable through the current
  // gateway AND bound to a local worker — a renderer-supplied id is never
  // streamed without the current task binding and storeId mapping.
  let bindingKind: string | undefined;
  try {
    const detail = await client.personalOperation({ action: 'TASK', taskId });
    const data = detail.data as { executionBinding?: { kind?: string } } | undefined;
    bindingKind = data?.executionBinding?.kind;
  } catch (error) {
    if (error instanceof ServiceProblem) {
      return { error: error.failure?.safeMessage ?? error.message, code: error.code, status: error.status };
    }
    return { error: error instanceof Error ? error.message : '任务详情读取失败', code: 'PROXY_FAILED' };
  }
  if (bindingKind !== 'WORKER_LOCAL') {
    return { error: '任务未绑定本机原生执行', code: 'NOT_A_NATIVE_TASK' };
  }
  stopNativeEventStream(taskId);
  const entry: NativeEventSubscription = { client: undefined as unknown as NativeTaskEventClient, resyncRestarts: 0 };
  const stream = new NativeTaskEventClient({
    initialCursor: cursor,
    open: async (position, signal) => {
      try {
        const response = await client.personalTaskEventStream(taskId, {
          afterCursor: String(position), lastEventId: String(position), signal
        });
        return { status: response.status, body: response.body };
      } catch (error) {
        // worker-events/1 answers a stale/conflicting cursor with HTTP 400 —
        // on this bounded client that surfaces as a thrown ServiceProblem, so
        // connectLoop's 400/409 resync branch never saw it and a refused
        // cursor became a silent reconnect loop. Hand the status back so
        // CURSOR_EXPIRED resync runs exactly like a wire-level rejection.
        if (error instanceof ServiceProblem && (error.status === 400 || error.status === 409)) {
          return { status: error.status, body: null };
        }
        throw error;
      }
    },
    onEvents: (frames) => {
      pushToRenderer(IPC_CHANNELS.nativeEventsPush, { taskId, frames });
    },
    onResync: (reason) => {
      if (!nativeEventSubscriptions.has(taskId)) return;
      pushToRenderer(IPC_CHANNELS.nativeEventsPush, { taskId, resync: reason });
      if (entry.resyncRestarts < NATIVE_RESYNC_RESTART_LIMIT) {
        entry.resyncRestarts += 1;
        stream.restart(0);
      } else {
        stopNativeEventStream(taskId);
        pushToRenderer(IPC_CHANNELS.nativeEventsPush, { taskId, status: 'DISCONNECTED', resync: 'EXHAUSTED' });
      }
    },
    onStatus: (status) => {
      if (status === 'CONNECTED') entry.resyncRestarts = 0;
      pushToRenderer(IPC_CHANNELS.nativeEventsPush, { taskId, status });
    }
  });
  entry.client = stream;
  nativeEventSubscriptions.set(taskId, entry);
  stream.start();
  return { meta: nativeEventAckMeta(), data: { taskId, subscribed: true } };
}

function unsubscribeNativeTaskEvents(taskId: string): unknown {
  stopNativeEventStream(taskId);
  pushToRenderer(IPC_CHANNELS.nativeEventsPush, { taskId, status: 'UNSUBSCRIBED' });
  return { meta: nativeEventAckMeta(), data: { taskId, subscribed: false } };
}

function stopClientSessionHeartbeat(): void {
  if (clientSessionHeartbeatTimer !== null) {
    clearInterval(clientSessionHeartbeatTimer);
    clientSessionHeartbeatTimer = null;
  }
}

function startClientSessionHeartbeat(generation: number, heartbeatMillis: number): void {
  stopClientSessionHeartbeat();
  const intervalMillis = Math.min(60_000, Math.max(1_000,
    Number.isFinite(heartbeatMillis) ? Math.floor(heartbeatMillis) : 20_000));
  clientSessionHeartbeatTimer = setInterval(() => {
    const session = clientSession;
    const connection = serviceHttp;
    if (!session || !connection || !connectionCoordinator.isCurrentGeneration(generation)
        || activeConnectionGeneration !== generation) {
      stopClientSessionHeartbeat();
      return;
    }
    const heartbeatClient = new ServiceClient({
      baseUrl: connection.baseUrl,
      token: connection.token,
      clientSessionToken: session.token
    });
    void heartbeatClient.heartbeatClientSession(session.id).catch((error) => {
      if (!connectionCoordinator.isCurrentGeneration(generation)
          || activeConnectionGeneration !== generation
          || clientSession?.id !== session.id) return;
      // An expired/revoked session must not remain in the transport. Re-register
      // against the same active connection; the coordinator coalesces this with
      // any concurrent bootstrap and the new generation guards stale callbacks.
      clientSession = null;
      stopClientSessionHeartbeat();
      stopDurableStream();
      pushToRenderer(IPC_CHANNELS.eventStatusPush, {
        clientSession: 'RECONNECTING',
        reason: String(error)
      });
      void runBootstrap(false);
    });
  }, intervalMillis);
}

function LOG_ERROR(message: string): void {
  // desktop log: process/connection events only, no bodies, no secrets (§15.2)
  console.error(`[codeagent-desktop] ${message}`);
}

function LOG_INFO(message: string): void {
  console.info(`[codeagent-desktop] ${message}`);
}

// ---- secure config ----

function createSecretStore(): SecretStore {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(plain) : null),
    decrypt: (encrypted) => {
      try {
        return safeStorage.decryptString(encrypted);
      } catch {
        return null;
      }
    }
  };
}

let tokenPersisted = false;

function resolveToken(config: DesktopConfig): string | null {
  // 1) explicit environment (spike/CI compatibility), 2) OS-encrypted store
  const envToken = process.env.CODEAGENT_SERVICE_TOKEN;
  if (envToken) return envToken;
  return configStore.loadToken();
}

function attachConfigFrom(config: DesktopConfig): AttachConfig {
  const envEndpoint = process.env.CODEAGENT_SERVICE_ENDPOINT;
  const envToken = process.env.CODEAGENT_SERVICE_TOKEN;
  // CODEAGENT_SERVICE_TOKEN is commonly supplied as a user-level secret while
  // the dedicated local service endpoint is stable and has a safe default.
  // Requiring an endpoint override in that case makes a direct desktop launch
  // fail before it can attach to the local service. An explicit endpoint still
  // requires an explicit token so credentials cannot be sent accidentally.
  if (envToken !== undefined && !envToken) {
    throw new Error('service token environment override must be non-empty');
  }
  if (envEndpoint !== undefined && envToken === undefined) {
    throw new Error('service endpoint and token environment overrides must be supplied together');
  }
  if (envEndpoint !== undefined && envToken !== undefined) {
    if (!envEndpoint || !envToken) throw new Error('service endpoint and token environment overrides must be non-empty');
    return { endpoint: envEndpoint, token: envToken };
  }
  const endpoint = config.attachEndpoint ?? DEFAULT_ATTACH_ENDPOINT;
  const token = resolveToken(config);
  if (token) return { endpoint, token };
  return {};
}

/** Reads only the non-secret endpoint before the profile lock. */
function readPrelockAttachEndpoint(userDataDir: string): string | undefined {
  try {
    const configPath = path.join(userDataDir, 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) return undefined;
    const parsed = JSON.parse(raw) as { attachEndpoint?: unknown };
    return typeof parsed.attachEndpoint === 'string' && parsed.attachEndpoint.length <= 2048
      ? parsed.attachEndpoint : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Connection-mode resolution (desktop consolidation design §8.4):
 * an explicit CODEAGENT_SERVICE_MODE always wins; a configured bundled
 * service (what a personal installation ships) selects OWNED_PRIVATE;
 * otherwise the desktop keeps attaching to the shared local service.
 */
function serviceModeFrom(config: DesktopConfig): 'SHARED_ATTACH' | 'OWNED_PRIVATE' {
  const envMode = process.env.CODEAGENT_SERVICE_MODE;
  if (envMode === 'OWNED_PRIVATE' || envMode === 'SHARED_ATTACH') return envMode;
  if (envMode !== undefined && envMode.trim().length > 0) {
    throw new Error(`CODEAGENT_SERVICE_MODE is invalid: ${envMode}`);
  }
  return config.bundledService || process.env.CODEAGENT_BUNDLED_SERVICE_CMD
    ? 'OWNED_PRIVATE' : 'SHARED_ATTACH';
}

function bundledConfigFrom(config: DesktopConfig, mode: 'SHARED_ATTACH' | 'OWNED_PRIVATE'): BundledServiceConfig | undefined {
  if (mode !== 'OWNED_PRIVATE') return undefined;
  if (process.env.CODEAGENT_BUNDLED_SERVICE_CMD) {
    return {
      command: process.env.CODEAGENT_BUNDLED_SERVICE_CMD,
      args: (process.env.CODEAGENT_BUNDLED_SERVICE_ARGS ?? '').split(' ').filter((a) => a.length > 0)
    };
  }
  if (config.bundledService) return config.bundledService;
  return undefined;
}

function connectionTargetFrom(config: DesktopConfig): ConnectionTarget {
  const mode = serviceModeFrom(config);
  return {
    mode,
    attach: attachConfigFrom(config),
    bundled: bundledConfigFrom(config, mode)
  };
}

async function runBootstrap(restart = false): Promise<DesktopBootstrap> {
  const config = configStore.loadConfig();
  stopClientSessionHeartbeat();
  try {
    const connection = restart
      ? await connectionCoordinator.restart(connectionTargetFrom(config))
      : await connectionCoordinator.connect(connectionTargetFrom(config));
    const result = connection;
    const { capabilities } = result;
    const identity = configStore.checkAttachIdentity(capabilities.serviceInstanceId);
    configStore.rememberServiceInstanceId(capabilities.serviceInstanceId);
    serviceHttp = { baseUrl: connection.baseUrl, token: connection.token };
    clientSession = null;
    const multiClient = (capabilities as CapabilityHandshake & {
      multiClient?: {
        registrationRequiredForMutation?: boolean;
        limits?: Record<string, unknown>;
      }
    }).multiClient;
    if (multiClient) {
      const registrationClient = new ServiceClient({
        baseUrl: connection.baseUrl,
        token: connection.token
      });
      const registered = await registrationClient.registerClientSession({
        registrationKey: crypto.randomUUID(),
        clientId: profileManifest.clientId,
        processInstanceId: profileManifest.processInstanceId,
        clientKind: 'ELECTRON',
        protocols: ['multi-client/1', 'v2'],
        displayLabel: 'Electron Main'
      });
      if (!connectionCoordinator.isCurrentGeneration(connection.generation)) {
        // Registration created a short-lived server-side session, but the
        // connection changed while the request was in flight. Revoke that
        // session best-effort and never publish it into the new connection.
        await new ServiceClient({
          baseUrl: connection.baseUrl,
          token: connection.token,
          clientSessionToken: registered.clientSessionToken
        }).revokeClientSession(registered.clientSessionId).catch(() => undefined);
        throw new Error('connection result belongs to an obsolete generation');
      }
      clientSession = {
        id: registered.clientSessionId,
        token: registered.clientSessionToken,
        bootId: registered.bootId,
        storeId: registered.storeId
      };
    }
    activeConnectionGeneration = connection.generation;
    startDurableStream(connection.generation);
    if (clientSession && multiClient) {
      const heartbeat = multiClient.limits?.heartbeatMillis;
      startClientSessionHeartbeat(connection.generation,
        typeof heartbeat === 'number' ? heartbeat : 20_000);
    }
    return {
      status: result.mode,
      serviceInstanceId: capabilities.serviceInstanceId,
      protocolVersion: capabilities.protocolVersion,
      capabilities: desktopCapabilitiesFrom(capabilities),
      message: identity.identityMatch ? undefined : 'serviceInstance 与上次运行不同（Service 可能已重装或更换）'
    };
  } catch (err) {
    serviceHttp = null;
    clientSession = null;
    stopClientSessionHeartbeat();
    stopDurableStream();
    const secretValues = [process.env.CODEAGENT_SERVICE_TOKEN ?? '', configStore.loadToken() ?? ''];
    return {
      status: 'START_FAILED',
      serviceMode: serviceModeFrom(config),
      message: redactSecrets(String(err), secretValues)
    };
  }
}

async function refreshServiceStatus(): Promise<void> {
  // diagnostics projection used by the degraded shell and the status channel
  lastStatusView = await buildStatusView();
}

let lastStatusView: ServiceStatusResult = {
  state: 'BOOTING',
  encryptionAvailable: false,
  tokenPersisted: false
};

async function buildStatusView(): Promise<ServiceStatusResult> {
  const owned = supervisor.getOwnedProcessInfo();
  const scheduler = proxyClient();
  const schedulerOverview = scheduler
    ? await scheduler.getSchedulerOverview().catch(() => undefined)
    : undefined;
  const result: ServiceStatusResult = {
    state: supervisor.getState(),
    serviceInstanceId: configStore.loadConfig().lastServiceInstanceId,
    ownedPid: owned?.pid,
    ownedPort: owned?.port,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    tokenPersisted,
    ...(schedulerOverview ? { scheduler: schedulerOverview } : {})
  };
  return result;
}

// ---- IPC admission ----

function registerIpcHandlers(): void {
  registry.register(bootstrapDefinition);
  registry.register(windowControlDefinition);
  registry.register(chooseDirectoryDefinition);
  registry.register(serviceRestartDefinition);
  registry.register(serviceStatusDefinition);
  registry.register(chooseAndRegisterDefinition);
  registry.register(diagnosticsDefinition);
  registry.register(saveConversationExportDefinition);
  registry.register(openExternalDefinition);
  registry.register(projectsListDefinition);
  registry.register(projectSessionPreflightDefinition);
  registry.register(projectBuildPlanDefinition);
  registry.register(projectBuildPlanOverrideDefinition);
  registry.register(projectBuildPlanPreviewDefinition);
  registry.register(projectVerificationProfilesDefinition);
  registry.register(projectVerificationProfilePutDefinition);
  registry.register(sessionsListDefinition);
  registry.register(collaborationDefinition);
  registry.register(writableCollaborationDefinition);
  registry.register(personalDefinition);
  registry.register(personalAccessDefinition);
  registry.register(sessionsGetDefinition);
  registry.register(sessionSummariesListDefinition);
  registry.register(sessionSummaryGetDefinition);
  registry.register(sessionMetadataGetDefinition);
  registry.register(sessionMessagesPageDefinition);
  registry.register(sessionMessageContentDefinition);
  registry.register(sessionsCreateDefinition);
  registry.register(sessionsPatchDefinition);
  registry.register(sessionsMessageDefinition);
  registry.register(sessionsAttachmentContentDefinition);
  registry.register(sessionsAttachmentBytesDefinition);
  registry.register(sessionsForkDefinition);
  registry.register(sessionsArchiveDefinition);
  registry.register(runsListDefinition);
  registry.register(attentionListDefinition);
  registry.register(terminalSessionsListDefinition);
  registry.register(terminalSessionCreateDefinition);
  registry.register(terminalSessionGetDefinition);
  registry.register(terminalOutputGetDefinition);
  registry.register(terminalInputWriteDefinition);
  registry.register(terminalSessionResizeDefinition);
  registry.register(terminalSessionSignalDefinition);
  registry.register(terminalSessionCloseDefinition);
  registry.register(terminalControlAcquireDefinition);
  registry.register(terminalControlRenewDefinition);
  registry.register(terminalControlReleaseDefinition);
  registry.register(specsCreateDefinition);
  registry.register(specsGetDefinition);
  registry.register(specsReviseDefinition);
  registry.register(specsDecideDefinition);
  registry.register(specsConvertDefinition);
  registry.register(commandApprovalDefinition);
  registry.register(sandboxApprovalDefinition);
  registry.register(sandboxApprovalPendingDefinition);
  registry.register(terminalApprovalDefinition);
  registry.register(terminalApprovalPendingDefinition);
  registry.register(budgetApprovalDefinition);
  registry.register(writeApprovalDefinition);
  registry.register(writeApprovalPendingDefinition);
  registry.register(executionPolicyGetDefinition);
  registry.register(executionPolicyUpdateDefinition);
  registry.register(executionPolicyDefaultsGetDefinition);
  registry.register(executionPolicyDefaultsUpdateDefinition);
  registry.register(executionPolicyMyDefaultsGetDefinition);
  registry.register(executionPolicyMyDefaultsUpdateDefinition);
  registry.register(automationControlGetDefinition);
  registry.register(automationControlUpdateDefinition);
  registry.register(approvalsListDefinition);
  registry.register(approvalGetDefinition);
  registry.register(approvalDecideDefinition);
  registry.register(approvalAdvanceDefinition);
  registry.register(approvalControlDefinition);
  registry.register(runCancelDefinition);
  registry.register(runInterruptDefinition);
  registry.register(runControlDefinition);
  registry.register(runContinueDefinition);
  registry.register(runDiffDefinition);
  registry.register(runReviewDefinition);
  registry.register(runEvidenceDefinition);
  registry.register(runActivitiesDefinition);
  registry.register(sessionExecutionsDefinition);
  registry.register(sessionExecutionDefinition);
  registry.register(sessionExecutionArtifactDefinition);
  registry.register(runReasoningDefinition);
  registry.register(runOutputDefinition);
  registry.register(workspaceConflictsListDefinition);
  registry.register(workspaceConflictGetDefinition);
  registry.register(workspaceConflictResolveDefinition);
  registry.register(workspaceConflictAutoMergeDefinition);
  registry.register(workspaceConflictDismissDefinition);
  registry.register(workspaceConflictProposalSubmitDefinition);
  registry.register(workspaceConflictProposalPollDefinition);
  registry.register(workspaceConflictsResolveBatchDefinition);
  registry.register(workspaceConflictsFilteredDefinition);
  registry.register(workspaceContentGetDefinition);
  registry.register(workspaceContentPutDefinition);
  registry.register(readProjectFileDefinition);
  registry.register(createFixTaskDefinition);
  registry.register(revealProjectFileDefinition);
  registry.register(workspaceExecutionsListDefinition);
  registry.register(workspaceExecutionCreateDefinition);
  registry.register(workspaceExecutionHandoffDefinition);
  registry.register(workspaceExecutionReclaimDefinition);
  registry.register(workspaceLaneCreateDefinition);
  registry.register(workspaceLaneGetDefinition);
  registry.register(workspaceLaneBindDefinition);
  registry.register(workspaceLaneReopenDefinition);
  registry.register(workspaceLaneReleaseDefinition);
  registry.register(deliveryCreateDefinition);
  registry.register(deliveryGetDefinition);
  registry.register(deliveryChangesDefinition);
  registry.register(deliveryPrepareDefinition);
  registry.register(deliveryDecideDefinition);
  registry.register(deliveryApplyDefinition);
  registry.register(deliveryReconcileDefinition);
  registry.register(deliveryRebaseDefinition);
  registry.register(deliveryListDefinition);
  registry.register(missionsListDefinition);
  registry.register(missionsGetDefinition);
  registry.register(missionsCreateDefinition);
  registry.register(missionsDecideDefinition);
  registry.register(missionsStartDefinition);
  registry.register(missionsPauseDefinition);
  registry.register(missionsResumeDefinition);
  registry.register(missionsCancelDefinition);
  registry.register(policyLayersListDefinition);
  registry.register(policyLayerUpdateDefinition);
  registry.register(settingsGetDefinition);
  registry.register(settingsUpdateDefinition);
  registry.register(knowledgeListDefinition);
  registry.register(knowledgeSuggestDefinition);
  registry.register(knowledgeConfirmDefinition);
  // settings center (SET-2/SET-3)
  registry.register(preferencesGetDefinition);
  registry.register(preferencesUpdateDefinition);
  registry.register(modelsCatalogDefinition);
  registry.register(agentProfilesListDefinition);
  registry.register(diagnosticsRevealDefinition);
  registry.register(diagnosticsCopyDefinition);
  registry.register(aboutGetDefinition);
  registry.register(approvalPingDefinition);
  // read-only external sources (EW10.2)
  registry.register(sourcesFetchDefinition);
  // read-only MCP sources (EW10.3)
  registry.register(mcpServersListDefinition);
  registry.register(mcpResourcesListDefinition);
  registry.register(mcpResourceReadDefinition);
  // skill catalog (EW10.5) + typed hooks health (EW10.6)
  registry.register(skillsRegisterDefinition);
  registry.register(skillsListDefinition);
  registry.register(mcpServersGovernedDefinition);
  registry.register(mcpServerCreateDefinition);
  registry.register(mcpServerGetDefinition);
  registry.register(mcpServerUpdateDefinition);
  registry.register(mcpServerStatusDefinition);
  registry.register(mcpConnectionActionDefinition);
  registry.register(mcpOperationGetDefinition);
  registry.register(mcpToolsListDefinition);
  registry.register(mcpCatalogRefreshDefinition);
  registry.register(mcpAuthActionDefinition);
  registry.register(mcpPromptsListDefinition);
  registry.register(mcpPromptResolveDefinition);
  registry.register(mcpResourceTemplatesDefinition);
  // WU01 (uplift design §5): Hub association channels.
  registry.register(hubConnectionsListDefinition);
  registry.register(hubConnectionCreateDefinition);
  registry.register(hubConnectionGetDefinition);
  registry.register(hubConnectionUpdateDefinition);
  registry.register(hubConnectionActionDefinition);
  registry.register(hubRegisterServerDefinition);
  registry.register(hubCapabilitiesDefinition);
  registry.register(hubResourcesDefinition);
  registry.register(hubSessionsListDefinition);
  registry.register(hubSessionAcquireDefinition);
  registry.register(hubSessionControlDefinition);
  registry.register(skillsGovernedDefinition);
  registry.register(skillImportPickDefinition);
  registry.register(skillImportPreviewDefinition);
  registry.register(skillImportDefinition);
  registry.register(skillVersionsListDefinition);
  registry.register(skillVersionSelectDefinition);
  registry.register(executionExtensionsDefinition);
  registry.register(extensionInvocationsDefinition);
  registry.register(extensionInvocationActionDefinition);
  registry.register(extensionTestExecutionDefinition);
  registry.register(skillManifestDefinition);
  // environment feature surface (settings design)
  registry.register(environmentFeaturesDefinition);
  registry.register(environmentFeatureUpdateDefinition);
  registry.register(environmentFeaturePreflightDefinition);
  registry.register(modelProvidersDefinition);
  registry.register(modelProviderRemoteModelsDefinition);
  registry.register(modelProviderUpsertDefinition);
  registry.register(modelProviderDeleteDefinition);
  registry.register(modelProviderModelUpsertDefinition);
  registry.register(modelProviderModelDeleteDefinition);
  registry.register(webSearchProvidersDefinition);
  registry.register(webSearchProviderUpsertDefinition);
  registry.register(webSearchProviderDeleteDefinition);
  registry.register(skillStatusDefinition);
  registry.register(hooksListDefinition);
  registry.register(hooksExecutionsDefinition);

  ipcMain.handle(IPC_CHANNELS.bootstrap, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.bootstrap, event.senderFrame?.url, payload);
    if (!admission.ok) return degraded(`IPC rejected: ${admission.reason}`);
    // 个人管理网关探测与 ACS 引导互相独立，任一失败不阻断另一项结果。
    let personalGatewayConfigured = false;
    let personalError: string | undefined;
    if (process.env.CODEAGENT_PERSONAL_ENDPOINT !== undefined) {
      try {
        personalGatewayClient(process.env.CODEAGENT_PERSONAL_ENDPOINT);
        personalGatewayConfigured = true;
      } catch {
        personalError = '个人管理网关配置无效；只接受显式本机 HTTP origin';
      }
    }
    const acsResult = await runBootstrap();
    const message = [acsResult.message, personalError]
      .filter((part): part is string => part !== undefined && part !== '')
      .join('；');
    return {
      ...acsResult,
      ...(personalGatewayConfigured ? {personalGatewayConfigured: true} : {}),
      ...(message !== '' ? {message} : {})
    } satisfies DesktopBootstrap;
  });

  ipcMain.handle(IPC_CHANNELS.windowControl, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.windowControl, event.senderFrame?.url, payload);
    if (!admission.ok) return { ok: false, error: `IPC rejected: ${admission.reason}` };
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { ok: false, error: 'window is unavailable' };
    }
    if (admission.value.action === 'MINIMIZE') mainWindow.minimize();
    if (admission.value.action === 'TOGGLE_MAXIMIZE') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
    if (admission.value.action === 'CLOSE') mainWindow.close();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.chooseDirectory, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.chooseDirectory, event.senderFrame?.url, payload);
    if (!admission.ok) return { selected: false, reason: `IPC rejected: ${admission.reason}` };
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { selected: false, reason: 'unavailable' };
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择合同目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return { selected: false, reason: 'cancelled' };
    return { selected: true, path: result.filePaths[0] };
  });

  ipcMain.handle(IPC_CHANNELS.serviceRestart, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.serviceRestart, event.senderFrame?.url, payload);
    if (!admission.ok) return degraded(`IPC rejected: ${admission.reason}`);
    const config = configStore.loadConfig();
    if (serviceModeFrom(config) === 'SHARED_ATTACH') {
      // A shared attachment is owned by its external launcher. Re-running
      // attachOrStart only performs another handshake; it does not restart
      // that process, so reporting success here would leave database-backed
      // settings unapplied while making the UI look as if they took effect.
      return {
        status: 'START_FAILED',
        serviceMode: 'SHARED_ATTACH',
        message: '当前连接的是外部 Service，桌面端只能重新连接，不能重启该进程。请在启动 Service 的终端重启 Service 后再重新检测。'
      } satisfies DesktopBootstrap;
    }
    try {
      const result = await runBootstrap(true);
      return {
        ...result
      } satisfies DesktopBootstrap;
    } catch (err) {
      serviceHttp = null;
      stopDurableStream();
      const secretValues = [process.env.CODEAGENT_SERVICE_TOKEN ?? '', configStore.loadToken() ?? ''];
      return degraded(redactSecrets(String(err), secretValues));
    } finally {
      void refreshServiceStatus();
    }
  });

  ipcMain.handle(IPC_CHANNELS.serviceStatus, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.serviceStatus, event.senderFrame?.url, payload);
    if (!admission.ok) return degraded(`IPC rejected: ${admission.reason}`);
    await refreshServiceStatus();
    return lastStatusView;
  });

  ipcMain.handle(IPC_CHANNELS.diagnostics, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.diagnostics, event.senderFrame?.url, payload);
    if (!admission.ok) return { serviceState: 'UNKNOWN', ownedProcess: null, logLocation: '', encryptionAvailable: false };
    const owned = supervisor.getOwnedProcessInfo();
    return {
      serviceState: supervisor.getState(),
      ownedProcess: owned ? { pid: owned.pid, port: owned.port, nonce: owned.nonce } : null,
      logLocation: launchProfile.logsDir,
      encryptionAvailable: safeStorage.isEncryptionAvailable()
    };
  });

  ipcMain.handle(IPC_CHANNELS.chooseAndRegister, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.chooseAndRegister, event.senderFrame?.url, payload);
    if (!admission.ok) return { registered: false, reason: `IPC rejected: ${admission.reason}` };
    return chooseAndRegisterProject();
  });

  ipcMain.handle(IPC_CHANNELS.openExternalHttps, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.openExternalHttps, event.senderFrame?.url, payload);
    if (!admission.ok) throw new Error('rejected: untrusted sender or payload');
    if (!validateOpenExternalPayload(payload)) {
      throw new Error('rejected: only https or loopback http URLs without credentials may be opened');
    }
    await shell.openExternal(payload.url);
  });

  ipcMain.handle(IPC_CHANNELS.saveConversationExport, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.saveConversationExport, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const request = admission.value as { suggestedName: string; format: 'markdown' | 'txt' | 'json' | 'csv' | 'html' | 'pdf'; content: string };
    const extension = request.format === 'markdown' ? 'md' : request.format;
    const baseName = request.suggestedName
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 140) || 'conversation-export';
    const defaultPath = path.join(app.getPath('documents'), `${baseName}.${extension}`);
    const filters = request.format === 'pdf'
      ? [{ name: 'PDF 文件', extensions: ['pdf'] }]
      : [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }];
    const saveOptions: SaveDialogOptions = {
      title: '导出会话',
      defaultPath,
      filters,
      properties: ['showOverwriteConfirmation']
    };
    const chosen = mainWindow
      ? await dialog.showSaveDialog(mainWindow, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (chosen.canceled || !chosen.filePath) return { canceled: true };

    let bytes: Buffer;
    if (request.format === 'pdf') {
      // PDF is rendered in an isolated, hidden page. The serializer already
      // escapes message content; these guards prevent a malformed caller from
      // turning the print page into an active document.
      const safeHtml = request.content
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, '')
        .replace(/(?:javascript|data|file):/gi, 'about:blank:');
      const printWindow = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
      });
      try {
        await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(safeHtml)}`);
        await printWindow.webContents.executeJavaScript('document.fonts?.ready ? document.fonts.ready : Promise.resolve()', true);
        bytes = await printWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
      } finally {
        if (!printWindow.isDestroyed()) printWindow.destroy();
      }
    } else {
      bytes = Buffer.from(request.content, 'utf8');
    }
    const temporaryPath = `${chosen.filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporaryPath, bytes, { flag: 'wx' });
      try {
        await fs.promises.rename(temporaryPath, chosen.filePath);
      } catch (renameError) {
        // Windows does not replace an existing file with rename(). The native
        // save dialog has already asked for overwrite confirmation; only then
        // remove a regular existing file and complete the atomic temp->target
        // handoff. Never remove a directory selected as a target.
        if (!renameError || !['EEXIST', 'EPERM'].includes((renameError as NodeJS.ErrnoException).code ?? '')) throw renameError;
        const existing = await fs.promises.stat(chosen.filePath);
        if (existing.isDirectory()) throw renameError;
        await fs.promises.unlink(chosen.filePath);
        await fs.promises.rename(temporaryPath, chosen.filePath);
      }
    } catch (error) {
      try { await fs.promises.unlink(temporaryPath); } catch { /* best effort cleanup */ }
      return { error: error instanceof Error ? error.message : '导出文件写入失败', code: 'EXPORT_WRITE_FAILED' };
    }
    return { canceled: false, filePath: chosen.filePath, bytes: bytes.byteLength };
  });

  // ---- data proxy + governance handlers (renderer never fetches directly) ----

  async function withService<T>(run: (client: ServiceClient) => Promise<T>): Promise<T | DesktopError> {
    const client = proxyClient();
    if (!client) return { error: 'service is not connected', code: 'SERVICE_NOT_CONNECTED' };
    try {
      return await run(client);
    } catch (err) {
      if (err instanceof ServiceProblem) {
        return {
          // Failure Contract safeMessage is the only user-facing error text
          // when the service supplied a structured failure.
          error: err.failure?.safeMessage ?? err.message,
          code: err.code,
          status: err.status,
          ...(err.failure !== undefined ? { failure: err.failure } : {}),
          ...(err.scheduling !== undefined ? { scheduling: err.scheduling } : {}),
          ...(err.reasonCode !== undefined ? { reasonCode: err.reasonCode } : {}),
          ...(err.operationOutcome !== undefined ? { operationOutcome: err.operationOutcome } : {}),
          ...(err.receiptId !== undefined ? { receiptId: err.receiptId } : {}),
          ...(err.correlationId !== undefined ? { correlationId: err.correlationId } : {})
        };
      }
      const code = err instanceof ProtocolIncompatible ? 'PROTOCOL_INCOMPATIBLE' : 'PROXY_FAILED';
      return { error: err instanceof Error ? err.message : 'service proxy failed', code };
    }
  }

  ipcMain.handle(IPC_CHANNELS.projectsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.projectsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listProjects());
  });

  ipcMain.handle(IPC_CHANNELS.projectSessionPreflight, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.projectSessionPreflight, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getProjectSessionPreflight(admission.value.projectId));
  });

  // ---- build-plan surface (design 2026-09-26 §7.2): plan views and
  // previews are resolver dry runs; overrides are validated element-wise
  // here and again authoritatively on the service.

  ipcMain.handle(IPC_CHANNELS.projectBuildPlan, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.projectBuildPlan, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getProjectBuildPlan(admission.value.projectId));
  });

  ipcMain.handle(IPC_CHANNELS.projectBuildPlanOverride, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.projectBuildPlanOverride, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const value = admission.value;
    return withService((client) => client.putProjectBuildPlanOverride(value.projectId, {
      targetId: value.targetId,
      action: value.action,
      runner: value.runner,
      argv: value.argv,
      env: value.env,
      disabled: value.disabled
    }));
  });

  ipcMain.handle(IPC_CHANNELS.projectBuildPlanPreview, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.projectBuildPlanPreview, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const value = admission.value;
    return withService((client) => client.previewProjectBuildPlan(value.projectId, {
      targetId: value.targetId,
      action: value.action,
      runner: value.runner,
      argv: value.argv,
      env: value.env,
      disabled: value.disabled
    }));
  });

  // ---- verification-profile surface (design 2026-09-26 §7.4/§10.2):
  // CAS-guarded profile documents; the run snapshots the enabled
  // "default" profile once at options-build time.

  ipcMain.handle(IPC_CHANNELS.projectVerificationProfiles, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.projectVerificationProfiles, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listProjectVerificationProfiles(admission.value.projectId));
  });

  ipcMain.handle(IPC_CHANNELS.projectVerificationProfilePut, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.projectVerificationProfilePut, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const value = admission.value;
    return withService((client) => client.putProjectVerificationProfile(value.projectId, value.profileId, {
      config: value.config,
      enabled: value.enabled,
      expectedRevision: value.expectedRevision
    }));
  });

  ipcMain.handle(IPC_CHANNELS.sessionsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listSessions());
  });

  const writableHandler = createWritableCollaborationHandler(registry, operation => withService(client => client.writableCollaboration(operation)));
  ipcMain.handle(IPC_CHANNELS.writableCollaboration, (event, payload: unknown) => writableHandler(event.senderFrame?.url, payload));
  const collaborationHandler = createCollaborationHandler(registry, (operation) => withService((client) => client.collaboration(operation)));
  ipcMain.handle(IPC_CHANNELS.collaboration, (event, payload: unknown) => collaborationHandler(event.senderFrame?.url, payload));
  // PAE P8: /api/personal/v1 bounded operations through the same
  // whitelist-admission pattern (P0 personal.ts contract).
  const personalHandler = createPersonalHandler(registry, async (operation) => {
    // Stream-control ops are consumed in main — the whitelist admits them,
    // but the subscribe ack is synthesized here and the open stream never
    // leaves this process (worker-events/1 -> 'app/events/native' pushes).
    if (operation.action === 'TASK_EVENTS_SUBSCRIBE') {
      return subscribeNativeTaskEvents(operation.taskId, operation.afterCursor);
    }
    if (operation.action === 'TASK_EVENTS_UNSUBSCRIBE') {
      return unsubscribeNativeTaskEvents(operation.taskId);
    }
    if (process.env.CODEAGENT_PERSONAL_ENDPOINT === undefined) return withService(client => client.personalOperation(operation));
    try { return await personalGatewayClient(process.env.CODEAGENT_PERSONAL_ENDPOINT).personalOperation(operation); }
    catch (error) { return {error: error instanceof Error ? error.message : '个人管理网关请求失败', code: error instanceof ServiceProblem ? error.code : 'PROXY_FAILED'}; }
  });
  ipcMain.handle(IPC_CHANNELS.personal, (event, payload: unknown) => personalHandler(event.senderFrame?.url, payload));
  ipcMain.handle('app/native-artifact/save',async(event,payload:unknown)=>{
    if(!validNativeArtifactSave(payload))return {error:'Invalid artifact request',code:'IPC_REJECTED'};
    const read=async(operation:import('../../packages/protocol/src/personal').PersonalOperation)=>{
      const result=await personalHandler(event.senderFrame?.url,operation) as {data?:unknown;error?:unknown};
      if(!result||!('data'in result)||result.error)throw new Error('ARTIFACT_SOURCE_UNAVAILABLE');return result.data;
    };
    try{
      const detail=await read({action:'TASK',taskId:payload.taskId}) as {sourceStoreId?:string;sourceError?:string};
      if(detail.sourceStoreId!==payload.sourceStoreId||detail.sourceError)throw new Error('ARTIFACT_SOURCE_CHANGED');
      const bytes=decodeNativeArtifact(await read({action:'NATIVE_ARTIFACT',taskId:payload.taskId,entityId:payload.artifactId}),payload);
      const name=path.basename(payload.path.replace(/\\/g,'/')).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,140)||'artifact';
      const chosen=await dialog.showSaveDialog({title:'保存任务成果',defaultPath:path.join(app.getPath('documents'),name),properties:['showOverwriteConfirmation']});
      if(chosen.canceled||!chosen.filePath)return {canceled:true};
      const temp=chosen.filePath+'.'+crypto.randomUUID()+'.tmp';
      try{fs.writeFileSync(temp,bytes,{flag:'wx'});if(crypto.createHash('sha256').update(fs.readFileSync(temp)).digest('hex')!==payload.sha256)throw new Error('SAVED_DIGEST_MISMATCH');fs.renameSync(temp,chosen.filePath);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
      return {canceled:false,sha256:payload.sha256};
    }catch(error){return {error:error instanceof Error?error.message:'成果保存失败',code:'ARTIFACT_SAVE_FAILED'};}
  });

  // UCA-001 C4: client-access/1 personal access server. Independent of the
  // Service connection — its binding is configured explicitly per profile.
  const personalAccess = new PersonalAccessSession({
    directory: launchProfile.userDataDir,
    connectionId: profileManifest.clientId,
    secretStore: createSecretStore()
  });
  const personalAccessHandler = createPersonalAccessHandler(registry, (operation) => personalAccess.execute(operation));
  ipcMain.handle(IPC_CHANNELS.personalAccess, (event, payload: unknown) => personalAccessHandler(event.senderFrame?.url, payload));

  ipcMain.handle(IPC_CHANNELS.sessionsGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionsGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getSession(admission.value.sessionId));
  });

  ipcMain.handle(IPC_CHANNELS.sessionSummariesList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionSummariesList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listSessionSummaries(admission.value));
  });

  ipcMain.handle(IPC_CHANNELS.sessionSummaryGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionSummaryGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getSessionSummary(admission.value.sessionId,
      { refreshEnvironment: admission.value.refreshEnvironment }));
  });

  ipcMain.handle(IPC_CHANNELS.sessionMetadataGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionMetadataGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getSessionMetadata(admission.value.sessionId));
  });

  ipcMain.handle(IPC_CHANNELS.sessionMessagesPage, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionMessagesPage, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.pageSessionMessages(admission.value.sessionId, admission.value));
  });

  ipcMain.handle(IPC_CHANNELS.sessionMessageContent, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionMessageContent, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getMessageContentPage(
      admission.value.sessionId, admission.value.messageId, admission.value));
  });

  ipcMain.handle(IPC_CHANNELS.sessionsCreate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionsCreate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const key = typeof admission.value.idempotencyKey === 'string' ? admission.value.idempotencyKey : undefined;
    return withService((client) => key === undefined
      ? client.createSession(admission.value.body as never)
      : client.createSession(admission.value.body as never, key));
  });

  ipcMain.handle(IPC_CHANNELS.sessionsPatch, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionsPatch, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.patchSession(admission.value.sessionId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.sessionsMessage, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionsMessage, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    // 长输入设计 §6.7：优先透传渲染器冻结意图的幂等键；缺失时回退为
    // sessionId + clientMessageId 的稳定派生，保证同一意图重试不变。
    const body = admission.value.body as { clientMessageId?: string } & Record<string, unknown>;
    const explicit = typeof admission.value.idempotencyKey === 'string' ? admission.value.idempotencyKey : undefined;
    const fallback = typeof body.clientMessageId === 'string' && body.clientMessageId.length > 0
      ? `msg-${admission.value.sessionId}-${body.clientMessageId}`
      : undefined;
    const idempotencyKey = explicit ?? fallback;
    return withService((client) => idempotencyKey === undefined
      ? client.sendSessionMessage(admission.value.sessionId, admission.value.body as never)
      : client.sendSessionMessage(admission.value.sessionId, admission.value.body as never, idempotencyKey));
  });

  ipcMain.handle(IPC_CHANNELS.sessionsAttachmentContent, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionsAttachmentContent, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getSessionAttachmentContent(
      admission.value.sessionId, admission.value.messageId, admission.value.attachmentId));
  });

  ipcMain.handle(IPC_CHANNELS.sessionsAttachmentBytes, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionsAttachmentBytes, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getSessionAttachmentBytes(
      admission.value.sessionId, admission.value.messageId, admission.value.attachmentId));
  });

  ipcMain.handle(IPC_CHANNELS.sessionsFork, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionsFork, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.forkSession(admission.value.sessionId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.sessionsArchive, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionsArchive, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.archiveSession(admission.value.sessionId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.runsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.runsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listRuns(admission.value));
  });

  ipcMain.handle(IPC_CHANNELS.attentionList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.attentionList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listAttention());
  });

  ipcMain.handle(IPC_CHANNELS.terminalSessionsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalSessionsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listTerminalSessions(admission.value.businessSessionId));
  });

  ipcMain.handle(IPC_CHANNELS.terminalSessionCreate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalSessionCreate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.createTerminalSession(
      admission.value.businessSessionId,
      admission.value.body as never
    ));
  });

  ipcMain.handle(IPC_CHANNELS.terminalSessionGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalSessionGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getTerminalSession(admission.value.terminalSessionId));
  });

  ipcMain.handle(IPC_CHANNELS.terminalOutputGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalOutputGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const { terminalSessionId, ...query } = admission.value;
    return withService((client) => client.getTerminalOutput(terminalSessionId, query));
  });

  ipcMain.handle(IPC_CHANNELS.terminalInputWrite, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalInputWrite, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.writeTerminalInput(
      admission.value.terminalSessionId,
      admission.value.body as never
    ));
  });

  ipcMain.handle(IPC_CHANNELS.terminalSessionResize, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalSessionResize, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.resizeTerminalSession(
      admission.value.terminalSessionId,
      admission.value.body as never
    ));
  });

  ipcMain.handle(IPC_CHANNELS.terminalSessionSignal, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalSessionSignal, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.signalTerminalSession(
      admission.value.terminalSessionId,
      admission.value.body as never
    ));
  });

  ipcMain.handle(IPC_CHANNELS.terminalSessionClose, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalSessionClose, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.closeTerminalSession(
      admission.value.terminalSessionId,
      admission.value.body as never
    ));
  });

  ipcMain.handle(IPC_CHANNELS.terminalControlAcquire, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalControlAcquire, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.acquireTerminalControl(
      admission.value.terminalSessionId,
      admission.value.body as never
    ));
  });

  ipcMain.handle(IPC_CHANNELS.terminalControlRenew, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalControlRenew, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.renewTerminalControl(
      admission.value.terminalSessionId,
      admission.value.body as never
    ));
  });

  ipcMain.handle(IPC_CHANNELS.terminalControlRelease, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalControlRelease, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.releaseTerminalControl(
      admission.value.terminalSessionId,
      admission.value.body as never
    ));
  });

  // ---- governance handlers (EW5) ----

  ipcMain.handle(IPC_CHANNELS.specsCreate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.specsCreate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.createSpec(admission.value.sessionId, admission.value.body));
  });

  ipcMain.handle(IPC_CHANNELS.specsGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.specsGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getSpec(admission.value.specId));
  });

  ipcMain.handle(IPC_CHANNELS.specsRevise, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.specsRevise, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.reviseSpec(admission.value.id, admission.value.body));
  });

  ipcMain.handle(IPC_CHANNELS.specsDecide, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.specsDecide, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.decideSpecApproval(
      admission.value.specId, admission.value.approvalId, admission.value.body));
  });

  ipcMain.handle(IPC_CHANNELS.specsConvert, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.specsConvert, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.convertSpecToAct(admission.value.id, admission.value.body));
  });

  ipcMain.handle(IPC_CHANNELS.commandApproval, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.commandApproval, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.decideCommandApproval(admission.value.id, admission.value.body));
  });

  ipcMain.handle(IPC_CHANNELS.sandboxApproval, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sandboxApproval, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.decideSandboxApproval(admission.value.id, admission.value.body));
  });

  ipcMain.handle(IPC_CHANNELS.sandboxApprovalPending, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sandboxApprovalPending, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.pendingSandboxApproval(admission.value.id));
  });

  ipcMain.handle(IPC_CHANNELS.terminalApproval, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalApproval, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.decideTerminalApproval(admission.value.id, admission.value.body));
  });

  ipcMain.handle(IPC_CHANNELS.terminalApprovalPending, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.terminalApprovalPending, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.pendingTerminalApproval(admission.value.id));
  });

  ipcMain.handle(IPC_CHANNELS.budgetApproval, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.budgetApproval, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.decideBudgetApproval(admission.value.id, admission.value.body));
  });

  ipcMain.handle(IPC_CHANNELS.writeApproval, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.writeApproval, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.decideWriteApproval(admission.value.id, admission.value.body));
  });

  ipcMain.handle(IPC_CHANNELS.writeApprovalPending, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.writeApprovalPending, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.pendingWriteApproval(admission.value.id));
  });

  ipcMain.handle(IPC_CHANNELS.executionPolicyGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.executionPolicyGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getExecutionPolicy(admission.value.sessionId, admission.value.projectId));
  });

  ipcMain.handle(IPC_CHANNELS.executionPolicyUpdate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.executionPolicyUpdate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.updateExecutionPolicy(
      admission.value.id,
      admission.value.body as never,
      admission.value.idempotencyKey,
      admission.value.projectId
    ));
  });

  ipcMain.handle(IPC_CHANNELS.executionPolicyDefaultsGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.executionPolicyDefaultsGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getExecutionPolicyDefaults(admission.value.projectId));
  });

  ipcMain.handle(IPC_CHANNELS.executionPolicyDefaultsUpdate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.executionPolicyDefaultsUpdate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.updateExecutionPolicyDefaults(
      admission.value.id,
      admission.value.body as never,
      admission.value.idempotencyKey
    ));
  });

  ipcMain.handle(IPC_CHANNELS.executionPolicyMyDefaultsGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.executionPolicyMyDefaultsGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getMyExecutionPolicyDefaults());
  });

  ipcMain.handle(IPC_CHANNELS.executionPolicyMyDefaultsUpdate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.executionPolicyMyDefaultsUpdate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.updateMyExecutionPolicyDefaults(
      admission.value.body as never,
      admission.value.idempotencyKey
    ));
  });

  ipcMain.handle(IPC_CHANNELS.automationControlGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.automationControlGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getAutomationControl(admission.value.sessionId));
  });

  ipcMain.handle(IPC_CHANNELS.automationControlUpdate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.automationControlUpdate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.controlAutomation(
      admission.value.id,
      admission.value.body as never,
      admission.value.idempotencyKey
    ));
  });

  ipcMain.handle(IPC_CHANNELS.approvalsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.approvalsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listApprovals(admission.value.sessionId, {
      cursor: admission.value.cursor,
      limit: admission.value.limit
    }));
  });

  ipcMain.handle(IPC_CHANNELS.approvalGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.approvalGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getApproval(admission.value.approvalId));
  });

  ipcMain.handle(IPC_CHANNELS.approvalDecide, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.approvalDecide, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.decideApproval(
      admission.value.id,
      admission.value.body as never,
      admission.value.idempotencyKey
    ));
  });

  ipcMain.handle(IPC_CHANNELS.approvalAdvance, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.approvalAdvance, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.advanceApproval(
      admission.value.id,
      admission.value.body as never,
      admission.value.idempotencyKey
    ));
  });

  ipcMain.handle(IPC_CHANNELS.approvalControl, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.approvalControl, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.controlApproval(
      admission.value.id,
      admission.value.body as never,
      admission.value.idempotencyKey
    ));
  });

  ipcMain.handle(IPC_CHANNELS.runCancel, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.runCancel, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.cancelRun(admission.value.runId));
  });

  ipcMain.handle(IPC_CHANNELS.runInterrupt, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.runInterrupt, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.interruptRun(admission.value.runId, {
      idempotencyKey: undefined,
      expectedStateVersion: admission.value.expectedStateVersion ?? undefined
    }));
  });

  ipcMain.handle(IPC_CHANNELS.runControl, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.runControl, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.controlRun(admission.value.runId, admission.value.body));
  });

  ipcMain.handle(IPC_CHANNELS.runContinue, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.runContinue, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.continueRun(admission.value.runId, {
      expectedStateVersion: admission.value.expectedStateVersion ?? undefined,
      message: admission.value.message ?? undefined
    }));
  });

  // ---- diff / review / evidence handlers (EW6) ----

  ipcMain.handle(IPC_CHANNELS.runDiff, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.runDiff, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getRunDiff(admission.value.runId, {
      page: admission.value.page,
      pageSize: admission.value.pageSize
    }));
  });

  ipcMain.handle(IPC_CHANNELS.runReview, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.runReview, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getRunReview(admission.value.runId));
  });

  // Run activity snapshot (design 2026-09-02 §11.1): the renderer never
  // fetches the service directly and never sees the bearer token.
  ipcMain.handle(IPC_CHANNELS.runActivities, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.runActivities, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getRunActivities(admission.value.runId, {
      afterCursor: admission.value.afterCursor,
      limit: admission.value.limit > 0 ? admission.value.limit : undefined
    }));
  });

  // Run display-reasoning snapshot (design 2026-09-18): read-only, bounded.
  ipcMain.handle(IPC_CHANNELS.runReasoning, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.runReasoning, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getRunReasoning(admission.value.runId));
  });

  // Run visible-output snapshot (design 2026-09-19 §5.5-B): read-only, bounded.
  ipcMain.handle(IPC_CHANNELS.runOutput, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.runOutput, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getRunOutput(admission.value.runId));
  });

  // Session execution-evidence reads (design 2026-09-26 §10.2): read-only,
  // session-scoped, service-bounded. Artifact responses carry bounded UTF-8
  // slices only; the renderer fetches them on demand, never eagerly.
  ipcMain.handle(IPC_CHANNELS.sessionExecutions, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionExecutions, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listSessionExecutions(admission.value.sessionId, {
      runId: admission.value.runId,
      limit: admission.value.limit > 0 ? admission.value.limit : undefined
    }));
  });

  ipcMain.handle(IPC_CHANNELS.sessionExecution, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionExecution, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getSessionExecution(
      admission.value.sessionId, admission.value.executionId));
  });

  ipcMain.handle(IPC_CHANNELS.sessionExecutionArtifact, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sessionExecutionArtifact, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.readSessionExecutionArtifact(
      admission.value.sessionId,
      admission.value.executionId,
      admission.value.path,
      {
        offset: admission.value.offset > 0 ? admission.value.offset : undefined,
        maxBytes: admission.value.maxBytes > 0 ? admission.value.maxBytes : undefined
      }));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceConflictsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceConflictsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listRunWorkspaceConflicts(admission.value.runId));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceConflictGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceConflictGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getWorkspaceConflict(admission.value.conflictId));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceConflictResolve, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceConflictResolve, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.resolveWorkspaceConflict(
      admission.value.conflictId,
      admission.value.body as never,
      admission.value.idempotencyKey
    ));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceConflictAutoMerge, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceConflictAutoMerge, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.autoMergeWorkspaceConflict(
      admission.value.conflictId, admission.value.idempotencyKey));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceConflictDismiss, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceConflictDismiss, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.dismissWorkspaceConflict(
      admission.value.conflictId, admission.value.idempotencyKey));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceConflictsResolveBatch, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceConflictsResolveBatch, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.resolveWorkspaceConflictsBatch(
      admission.value.body as never, admission.value.idempotencyKey));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceConflictsFiltered, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceConflictsFiltered, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listWorkspaceConflicts(admission.value));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceConflictProposalSubmit, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceConflictProposalSubmit, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.requestWorkspaceConflictProposal(
      admission.value.conflictId, admission.value.idempotencyKey));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceConflictProposalPoll, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceConflictProposalPoll, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.pollWorkspaceConflictProposal(admission.value.proposalId));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceContentGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceContentGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService(async (client) => {
      const out = await client.getWorkspaceContent(
        admission.value.ref, admission.value.offset ?? 0, admission.value.limit ?? 0);
      return {
        contentBase64: Buffer.from(out.bytes).toString('base64'),
        truncated: out.truncated,
        totalBytes: out.totalBytes
      };
    });
  });

  ipcMain.handle(IPC_CHANNELS.workspaceContentPut, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceContentPut, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.putWorkspaceContent(
      new Uint8Array(Buffer.from(admission.value.contentBase64, 'base64')),
      admission.value.idempotencyKey));
  });

  ipcMain.handle(IPC_CHANNELS.runEvidence, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.runEvidence, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getRunEvidence(admission.value.runId));
  });

  ipcMain.handle(IPC_CHANNELS.readProjectFile, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.readProjectFile, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.readProjectFile(
      admission.value.projectId,
      admission.value.fileRef,
      admission.value.revision ? { revision: admission.value.revision } : {}
    ));
  });

  ipcMain.handle(IPC_CHANNELS.createFixTask, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.createFixTask, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.createFixTask(admission.value.id, admission.value.body as { workspaceAlias: string; goal: string }));
  });

  ipcMain.handle(IPC_CHANNELS.revealProjectFile, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.revealProjectFile, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService(async (client) => {
      const intent = await client.revealProjectFile(admission.value.projectId, admission.value.fileRef) as {
        action?: string;
        root?: string;
        fileRef?: string;
      };
      if (!serviceHttp) return { error: 'service is not connected', code: 'SERVICE_NOT_CONNECTED' };
      if (intent.action === 'REVEAL_FILE' && intent.root && intent.fileRef) {
        // The intent is main-only; the shell call happens here, not in the
        // renderer. showItemInFolder *locates* the file in the OS file
        // manager — openPath would instead launch the file's associated
        // app (or the system "open with" picker), which is not the intent.
        shell.showItemInFolder(path.join(intent.root, intent.fileRef));
      }
      return intent;
    });
  });

  // ---- service-owned workspace executions (EW7). The renderer only ever
  // receives safe refs/states; provisioning and git stay in the service.

  ipcMain.handle(IPC_CHANNELS.workspaceExecutionsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceExecutionsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listWorkspaceExecutions(admission.value.projectId));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceExecutionCreate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceExecutionCreate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.createWorkspaceExecution(admission.value));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceExecutionHandoff, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceExecutionHandoff, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.handoffWorkspaceExecution(
      admission.value.workspaceExecutionId,
      { expectedStateVersion: admission.value.expectedStateVersion ?? undefined }));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceExecutionReclaim, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceExecutionReclaim, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.reclaimWorkspaceExecution(
      admission.value.workspaceExecutionId,
      { expectedStateVersion: admission.value.expectedStateVersion ?? undefined }));
  });

  // ---- session-owned workspace lanes + delivery control plane ----
  ipcMain.handle(IPC_CHANNELS.workspaceLaneCreate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceLaneCreate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.createWorkspaceLane(admission.value as never));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceLaneGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceLaneGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getWorkspaceLane(admission.value.workspaceLaneId));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceLaneBind, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceLaneBind, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.bindWorkspaceLane(admission.value.workspaceLaneId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceLaneReopen, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceLaneReopen, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.reopenWorkspaceLane(admission.value.workspaceLaneId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.workspaceLaneRelease, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.workspaceLaneRelease, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.releaseWorkspaceLane(admission.value.workspaceLaneId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.deliveryCreate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.deliveryCreate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.createDelivery(admission.value as never));
  });

  ipcMain.handle(IPC_CHANNELS.deliveryGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.deliveryGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getDelivery(admission.value.deliveryId));
  });

  ipcMain.handle(IPC_CHANNELS.deliveryChanges, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.deliveryChanges, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getDeliveryChanges(admission.value.deliveryId));
  });

  ipcMain.handle(IPC_CHANNELS.deliveryPrepare, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.deliveryPrepare, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.prepareDelivery(admission.value.deliveryId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.deliveryDecide, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.deliveryDecide, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.decideDelivery(admission.value.deliveryId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.deliveryApply, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.deliveryApply, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.applyDelivery(admission.value.deliveryId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.deliveryReconcile, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.deliveryReconcile, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.reconcileDelivery(admission.value.deliveryId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.deliveryRebase, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.deliveryRebase, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.rebaseDelivery(admission.value.deliveryId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.deliveryList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.deliveryList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const { projectId, ...query } = admission.value;
    return withService((client) => client.listProjectDeliveries(projectId, query));
  });

  // ---- mission control (EW8): read projections + user commands only.

  ipcMain.handle(IPC_CHANNELS.missionsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.missionsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listMissions(admission.value.sessionId ?? undefined));
  });

  ipcMain.handle(IPC_CHANNELS.missionsGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.missionsGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getMission(admission.value.missionId));
  });

  ipcMain.handle(IPC_CHANNELS.missionsCreate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.missionsCreate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.createMission(admission.value.sessionId, admission.value.body as { title: string; goal: string; workspaceAlias: string }));
  });

  ipcMain.handle(IPC_CHANNELS.missionsDecide, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.missionsDecide, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.decideMissionApproval(
      admission.value.missionId,
      admission.value.approvalId,
      admission.value.body as { expectedMissionVersion: number; decision: 'APPROVE' | 'REJECT' }));
  });

  ipcMain.handle(IPC_CHANNELS.missionsStart, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.missionsStart, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.startMission(admission.value.missionId, { expectedMissionVersion: admission.value.expectedMissionVersion }));
  });

  ipcMain.handle(IPC_CHANNELS.missionsPause, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.missionsPause, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.pauseMission(admission.value.missionId, { expectedMissionVersion: admission.value.expectedMissionVersion }));
  });

  ipcMain.handle(IPC_CHANNELS.missionsResume, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.missionsResume, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.resumeMission(admission.value.missionId, { expectedMissionVersion: admission.value.expectedMissionVersion }));
  });

  ipcMain.handle(IPC_CHANNELS.missionsCancel, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.missionsCancel, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.cancelMission(admission.value.missionId, { expectedMissionVersion: admission.value.expectedMissionVersion }));
  });

  // ---- product governance (EW9): policy layers, settings, knowledge.

  ipcMain.handle(IPC_CHANNELS.policyLayersList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.policyLayersList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listPolicyLayers());
  });

  ipcMain.handle(IPC_CHANNELS.policyLayerUpdate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.policyLayerUpdate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.updatePolicyLayer(
      admission.value.layer as 'PROJECT' | 'USER',
      {
        maximumAutonomy: admission.value.maximumAutonomy,
        expectedRevision: admission.value.expectedRevision ?? undefined
      }));
  });

  ipcMain.handle(IPC_CHANNELS.settingsGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.settingsGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getProductSettings());
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.settingsUpdate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.updateProductSettings({
      traceExportEnabled: admission.value.traceExportEnabled ?? undefined,
      localOnly: admission.value.localOnly ?? undefined,
      eventJournalRetentionDays: admission.value.eventJournalRetentionDays ?? undefined,
      expectedRevision: admission.value.expectedRevision ?? undefined
    }));
  });

  ipcMain.handle(IPC_CHANNELS.knowledgeList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.knowledgeList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listKnowledge());
  });

  ipcMain.handle(IPC_CHANNELS.knowledgeSuggest, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.knowledgeSuggest, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.suggestKnowledge({
      content: admission.value.content,
      sourceRef: admission.value.sourceRef ?? undefined
    }));
  });

  ipcMain.handle(IPC_CHANNELS.knowledgeConfirm, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.knowledgeConfirm, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.confirmKnowledge(admission.value.knowledgeId));
  });

  // ---- settings center (SET-2/SET-3) ----

  ipcMain.handle(IPC_CHANNELS.preferencesGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.preferencesGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return preferencesStore.load();
  });

  ipcMain.handle(IPC_CHANNELS.preferencesUpdate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.preferencesUpdate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const result = preferencesStore.applyUpdate(admission.value);
    if (result.conflict) {
      return {
        error: `preferences revision moved on: expected ${result.conflict.expectedRevision}, current ${result.conflict.currentRevision}`,
        code: 'STATE_VERSION_CONFLICT'
      };
    }
    return result.applied;
  });

  ipcMain.handle(IPC_CHANNELS.modelsCatalog, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.modelsCatalog, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getModelCatalog());
  });

  // ---- environment feature surface (settings design): capability cards
  // with desired/effective state + typed preflight/install actions. All
  // writes persist in the service database and apply at the next restart.

  ipcMain.handle(IPC_CHANNELS.environmentFeatures, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.environmentFeatures, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getEnvironmentFeatures());
  });

  ipcMain.handle(IPC_CHANNELS.environmentFeatureUpdate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.environmentFeatureUpdate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.updateEnvironmentFeature(admission.value.featureId, {
      enabled: admission.value.enabled ?? undefined,
      entries: admission.value.entries,
      expectedRevision: admission.value.expectedRevision
    }));
  });

  ipcMain.handle(IPC_CHANNELS.environmentFeaturePreflight, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.environmentFeaturePreflight, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.preflightEnvironmentFeature(admission.value.featureId));
  });

  ipcMain.handle(IPC_CHANNELS.modelProviders, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.modelProviders, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listManagedModelProviders());
  });

  ipcMain.handle(IPC_CHANNELS.modelProviderRemoteModels, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.modelProviderRemoteModels, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.probeRemoteProviderModels(
      admission.value.body as Parameters<typeof client.probeRemoteProviderModels>[0]));
  });

  ipcMain.handle(IPC_CHANNELS.modelProviderUpsert, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.modelProviderUpsert, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.upsertModelProvider(
      admission.value.providerId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.modelProviderDelete, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.modelProviderDelete, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.deleteModelProvider(
      admission.value.providerId, admission.value.expectedRevision,
      undefined, admission.value.replaceDefault));
  });

  ipcMain.handle(IPC_CHANNELS.modelProviderModelUpsert, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.modelProviderModelUpsert, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.upsertProviderModel(
      admission.value.providerId, admission.value.modelId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.modelProviderModelDelete, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.modelProviderModelDelete, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.deleteProviderModel(
      admission.value.providerId, admission.value.modelId, admission.value.expectedRevision,
      undefined, admission.value.replaceDefault));
  });

  ipcMain.handle(IPC_CHANNELS.webSearchProviders, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.webSearchProviders, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listWebSearchProviders());
  });

  ipcMain.handle(IPC_CHANNELS.webSearchProviderUpsert, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.webSearchProviderUpsert, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.upsertWebSearchProvider(
      admission.value.providerId, admission.value.body as never));
  });

  ipcMain.handle(IPC_CHANNELS.webSearchProviderDelete, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.webSearchProviderDelete, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.deleteWebSearchProvider(
      admission.value.providerId, admission.value.expectedRevision));
  });

  ipcMain.handle(IPC_CHANNELS.agentProfilesList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.agentProfilesList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listAgentProfiles());
  });

  // Fixed-intent OS actions: the renderer never supplies a path; main opens
  // its own userData diagnostics folder only (settings design §6.12).
  ipcMain.handle(IPC_CHANNELS.diagnosticsReveal, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.diagnosticsReveal, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    try {
      await shell.openPath(launchProfile.diagnosticsDir);
      return { revealed: true };
    } catch (err) {
      return { revealed: false, reason: `无法打开诊断文件夹：${String(err)}` };
    }
  });

  // Main-generated, allowlisted, bounded diagnostics text (§6.12). Only fixed
  // public-safe fields are included: no tokens, paths, commands, env or bodies.
  ipcMain.handle(IPC_CHANNELS.diagnosticsCopy, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.diagnosticsCopy, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const owned = supervisor.getOwnedProcessInfo();
    const status = lastStatusView;
    const lines = [
      'CodeAgent Desktop diagnostics',
      `generatedAt: ${new Date().toISOString()}`,
      `serviceState: ${status.state}`,
      `ownedProcess: ${owned ? `pid ${owned.pid}, port ${owned.port}` : 'none'}`,
      `encryptionAvailable: ${String(safeStorage.isEncryptionAvailable())}`,
      `tokenPersisted: ${String(tokenPersisted)}`,
      `serviceInstanceId: ${status.serviceInstanceId ? status.serviceInstanceId.slice(0, 12) : 'unknown'}`
    ];
    const text = lines.join('\n').slice(0, 4000);
    clipboard.writeText(text);
    return { copied: true, bytes: text.length };
  });

  ipcMain.handle(IPC_CHANNELS.aboutGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.aboutGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return {
      desktopVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      chromeVersion: process.versions.chrome ?? 'unknown',
      nodeVersion: process.versions.node ?? 'unknown'
    };
  });

  // Approval attention ping: flash the taskbar/dock once when a new approval
  // waits while the window is not focused. No payload, no secrets, and the
  // renderer rate-limits to one ping per waiting run.
  ipcMain.handle(IPC_CHANNELS.approvalPing, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.approvalPing, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    if (mainWindow && !mainWindow.isFocused()) {
      mainWindow.flashFrame(true);
      mainWindow.once('focus', () => mainWindow?.flashFrame(false));
    }
    return { pinged: true };
  });

  ipcMain.handle(IPC_CHANNELS.sourcesFetch, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.sourcesFetch, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.fetchSource({
      sourceType: admission.value.sourceType,
      uri: admission.value.uri,
      maxBytes: admission.value.maxBytes ?? undefined
    }));
  });

  ipcMain.handle(IPC_CHANNELS.mcpServersList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpServersList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listMcpServers());
  });

  ipcMain.handle(IPC_CHANNELS.mcpResourcesList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpResourcesList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listMcpResources(admission.value.serverId));
  });

  ipcMain.handle(IPC_CHANNELS.mcpResourceRead, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpResourceRead, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.readMcpResource(admission.value.serverId, admission.value.uri));
  });

  ipcMain.handle(IPC_CHANNELS.skillsRegister, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.skillsRegister, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.registerSkill(admission.value));
  });

  ipcMain.handle(IPC_CHANNELS.skillsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.skillsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listSkills());
  });

  ipcMain.handle(IPC_CHANNELS.skillStatus, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.skillStatus, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.changeSkillStatus(
      admission.value.skillId,
      { status: admission.value.status, expectedRevision: admission.value.expectedRevision }
    ));
  });

  ipcMain.handle(IPC_CHANNELS.hooksList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hooksList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listHooks());
  });

  ipcMain.handle(IPC_CHANNELS.hooksExecutions, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hooksExecutions, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listHookExecutions());
  });

  // ---- governed extension surface (capability uplift WU07) ----
  // The renderer drives configuration and reads evidence; every launch,
  // invocation and script stays inside the Java host.

  ipcMain.handle(IPC_CHANNELS.mcpServersGoverned, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpServersGoverned, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listMcpServersGoverned());
  });

  ipcMain.handle(IPC_CHANNELS.mcpServerCreate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpServerCreate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.createMcpServer(admission.value));
  });

  ipcMain.handle(IPC_CHANNELS.mcpServerGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpServerGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getMcpServer(admission.value.serverId));
  });

  ipcMain.handle(IPC_CHANNELS.mcpServerUpdate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpServerUpdate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const { serverId, ...fields } = admission.value;
    // Strip nulls — PATCH semantics treat absent fields as untouched.
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (key !== 'expectedRevision' && value !== null) patch[key] = value;
    }
    const request = {
      expectedRevision: fields.expectedRevision,
      ...patch
    } as unknown as McpServerUpdateRequest;
    return withService((client) => client.updateMcpServer(serverId, request));
  });

  ipcMain.handle(IPC_CHANNELS.mcpServerStatus, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpServerStatus, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.setMcpServerStatus(admission.value.serverId, {
      enabled: admission.value.enabled,
      expectedRevision: admission.value.expectedRevision
    }));
  });

  ipcMain.handle(IPC_CHANNELS.mcpConnectionAction, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpConnectionAction, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.requestMcpConnectionAction(admission.value.serverId, {
      action: admission.value.action
    }));
  });

  ipcMain.handle(IPC_CHANNELS.mcpOperationGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpOperationGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getMcpOperation(admission.value.operationId));
  });

  ipcMain.handle(IPC_CHANNELS.mcpToolsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpToolsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listMcpServerTools(admission.value.serverId, {
      cursor: admission.value.cursor ?? undefined,
      limit: admission.value.limit ?? undefined
    }));
  });

  ipcMain.handle(IPC_CHANNELS.mcpCatalogRefresh, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpCatalogRefresh, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.refreshMcpServerCatalog(admission.value.serverId));
  });

  ipcMain.handle(IPC_CHANNELS.mcpAuthAction, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpAuthAction, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.requestMcpAuthAction(admission.value.serverId, {
      action: admission.value.action
    }));
  });

  ipcMain.handle(IPC_CHANNELS.mcpPromptsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpPromptsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listMcpPrompts(admission.value.serverId));
  });

  ipcMain.handle(IPC_CHANNELS.mcpPromptResolve, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpPromptResolve, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.resolveMcpPrompt(admission.value.serverId, {
      name: admission.value.name,
      arguments: admission.value.arguments_ ?? undefined
    }));
  });

  ipcMain.handle(IPC_CHANNELS.mcpResourceTemplates, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.mcpResourceTemplates, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listMcpResourceTemplates(admission.value.serverId));
  });

  // ---- WU01 Hub associations (uplift design §5) ----

  ipcMain.handle(IPC_CHANNELS.hubConnectionsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hubConnectionsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listHubConnections());
  });

  ipcMain.handle(IPC_CHANNELS.hubConnectionCreate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hubConnectionCreate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.registerHubConnection(admission.value));
  });

  ipcMain.handle(IPC_CHANNELS.hubConnectionGet, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hubConnectionGet, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getHubConnection(admission.value.hubConnectionId));
  });

  ipcMain.handle(IPC_CHANNELS.hubConnectionUpdate, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hubConnectionUpdate, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const { hubConnectionId, ...fields } = admission.value;
    // Strip nulls — PATCH semantics treat absent fields as untouched;
    // expectedRevision is the CAS guard and always travels.
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (key !== 'expectedRevision' && value !== null) patch[key] = value;
    }
    return withService((client) => client.updateHubConnection(hubConnectionId, {
      expectedRevision: fields.expectedRevision,
      ...patch
    }));
  });

  ipcMain.handle(IPC_CHANNELS.hubConnectionAction, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hubConnectionAction, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.requestHubConnectionAction(admission.value.hubConnectionId, {
      action: admission.value.action
    }));
  });

  ipcMain.handle(IPC_CHANNELS.hubRegisterServer, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hubRegisterServer, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.registerHubManagedServer(admission.value.hubConnectionId));
  });

  ipcMain.handle(IPC_CHANNELS.hubCapabilities, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hubCapabilities, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getHubCapabilities(admission.value.hubConnectionId));
  });

  // W3 resource sessions: the service proxies Hub /api/v2/resources*
  // verbatim; the renderer supplies no token and no session state of its
  // own — control state is adopted only from the authoritative receipt.
  ipcMain.handle(IPC_CHANNELS.hubResources, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hubResources, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listHubResources(admission.value.hubConnectionId));
  });

  ipcMain.handle(IPC_CHANNELS.hubSessionsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hubSessionsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listHubSessions(admission.value.hubConnectionId));
  });

  ipcMain.handle(IPC_CHANNELS.hubSessionAcquire, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hubSessionAcquire, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const v = admission.value;
    return withService((client) => client.acquireHubSession(v.hubConnectionId, {
      resourceKey: v.resourceKey,
      mode: v.mode as 'managed' | 'attached',
      controller: v.controller,
      ...(v.ttlSeconds != null ? { ttlSeconds: v.ttlSeconds } : {})
    }));
  });

  ipcMain.handle(IPC_CHANNELS.hubSessionControl, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.hubSessionControl, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    const v = admission.value;
    return withService((client) => client.controlHubSession(v.hubConnectionId, v.sessionId, {
      action: v.action,
      ...(v.controller != null ? { controller: v.controller } : {}),
      ...(v.expectedEpoch != null ? { expectedEpoch: v.expectedEpoch } : {})
    }));
  });

  /**
   * Skill import source: the MAIN process opens the directory picker and
   * hands the chosen path to the service as rootHint. The renderer only
   * ever sees the opaque sourceHandle — it can never supply a path of its
   * own (extension design §6.3 handle model).
   */
  ipcMain.handle(IPC_CHANNELS.skillsGoverned, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.skillsGoverned, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listSkillsGoverned());
  });

  ipcMain.handle(IPC_CHANNELS.skillImportPick, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.skillImportPick, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    if (!mainWindow) return { error: 'no window', code: 'IPC_REJECTED' };
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入的 Skill 包目录',
      properties: ['openDirectory']
    });
    if (picked.canceled || picked.filePaths.length !== 1) {
      return { error: 'cancelled', code: 'PICK_CANCELLED' };
    }
    const body = payload as Record<string, unknown>;
    const displayName = typeof body?.displayName === 'string' && body.displayName.trim().length > 0
      ? body.displayName.slice(0, 256) : undefined;
    return withService((client) => client.createSkillImportSource({
      rootHint: picked.filePaths[0] as string,
      displayName
    }));
  });

  ipcMain.handle(IPC_CHANNELS.skillImportPreview, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.skillImportPreview, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.previewSkillImport({ sourceHandle: admission.value.sourceHandle }));
  });

  ipcMain.handle(IPC_CHANNELS.skillImport, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.skillImport, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.importSkillPackage({
      previewId: admission.value.previewId,
      expectedSourceDigest: admission.value.expectedSourceDigest,
      scope: admission.value.scope,
      projectAlias: admission.value.projectAlias ?? undefined,
      name: admission.value.name ?? undefined
    }));
  });

  ipcMain.handle(IPC_CHANNELS.skillVersionsList, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.skillVersionsList, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listSkillVersions(admission.value.skillId));
  });

  ipcMain.handle(IPC_CHANNELS.skillVersionSelect, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.skillVersionSelect, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.selectSkillVersion(admission.value.skillId, {
      versionDigest: admission.value.versionDigest,
      expectedRevision: admission.value.expectedRevision
    }));
  });

  ipcMain.handle(IPC_CHANNELS.executionExtensions, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.executionExtensions, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getExecutionExtensions(admission.value.executionId));
  });

  ipcMain.handle(IPC_CHANNELS.extensionInvocations, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.extensionInvocations, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.listExtensionInvocations(admission.value.executionId, {
      cursor: admission.value.cursor ?? undefined,
      limit: admission.value.limit ?? undefined
    }));
  });

  ipcMain.handle(IPC_CHANNELS.extensionInvocationAction, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.extensionInvocationAction, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.requestExtensionInvocationAction(
      admission.value.executionId, admission.value.invocationId, {
        action: admission.value.action,
        input: (admission.value.input ?? undefined) as { [key: string]: JsonValue } | undefined
      }));
  });

  ipcMain.handle(IPC_CHANNELS.extensionTestExecution, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.extensionTestExecution, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.createExtensionTestExecution({
      sessionId: admission.value.sessionId ?? undefined,
      extensions: {
        mode: 'EXPLICIT',
        mcpServers: [{ serverId: admission.value.serverId, toolIds: [admission.value.toolId], resourcesEnabled: false }]
      },
      arguments: admission.value.arguments_ ?? undefined
    }));
  });

  ipcMain.handle(IPC_CHANNELS.skillManifest, async (event, payload: unknown) => {
    const admission = registry.admit(IPC_CHANNELS.skillManifest, event.senderFrame?.url, payload);
    if (!admission.ok) return { error: admission.reason, code: 'IPC_REJECTED' };
    return withService((client) => client.getSkillManifest(
      admission.value.skillId, admission.value.versionDigest));
  });
}

function degraded(message: string): DesktopBootstrap {
  return { status: 'DEGRADED', message };
}

/**
 * Native folder picker -> service registration, fully main-proxied.
 * The renderer only ever receives the server-owned alias, never the path
 * and never the service-side canonicalRoot (desktop design §9.3).
 */
async function chooseAndRegisterProject(): Promise<{ registered: boolean; projectId?: string; displayName?: string; reason?: string }> {
  if (!mainWindow) return { registered: false, reason: 'no window' };
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: '选择要注册的项目目录',
    properties: ['openDirectory']
  });
  if (picked.canceled || picked.filePaths.length !== 1) {
    return { registered: false, reason: 'cancelled' };
  }
  const absolutePath = picked.filePaths[0] as string;
  if (!serviceHttp) return { registered: false, reason: 'service is not connected' };
  try {
    const client = proxyClient();
    if (!client) return { registered: false, reason: 'service is not connected' };
    const registration = await client.registerProject({ absolutePath });
    return {
      registered: true,
      projectId: registration.projectId,
      displayName: registration.displayName ?? registration.projectId
    };
  } catch (err) {
    const code = err instanceof ServiceProblem ? err.code
      : err instanceof ProtocolIncompatible ? 'PROTOCOL_INCOMPATIBLE' : 'REGISTRATION_FAILED';
    return { registered: false, reason: code };
  }
}

// ---- notifications ----

function notifyServiceEvent(title: string, body: string): void {
  // configStore/notifications are created in whenReady; a supervisor event
  // can never precede that in practice, but fail silent rather than crash.
  if (!configStore || !notifications || !preferencesStore) return;
  if (!preferencesStore.load().notificationsEnabled) return;
  const decision = notifications.update('service-lifecycle', { title, body });
  if (!decision.show) return;
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.show();
}

// ---- window/security ----

// compiled layout (rootDir "."): dist-electron/electron/main/main.js
function rendererRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', 'dist', 'renderer');
}

function preloadPath(): string {
  // tsconfig.preload (rootDir ".") emits to
  // dist-electron/electron/preload/preload.js — sibling of the main dir.
  return path.resolve(__dirname, '..', 'preload', 'preload.js');
}

function windowState(): { isMaximized: boolean; isMinimized: boolean } {
  return {
    isMaximized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()),
    isMinimized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized())
  };
}

function notifyWindowState(): void {
  pushToRenderer(IPC_CHANNELS.windowStatePush, windowState());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    frame: false,
    webPreferences: buildWebPreferences(preloadPath())
  });

  const currentUrl = `${APP_SCHEME}://codeagent/index.html`;

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (navigationDecision(currentUrl, targetUrl) !== 'ALLOW') {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpsExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('maximize', notifyWindowState);
  mainWindow.on('unmaximize', notifyWindowState);
  mainWindow.on('minimize', notifyWindowState);
  mainWindow.on('restore', notifyWindowState);
  mainWindow.webContents.on('did-finish-load', notifyWindowState);

  void mainWindow.loadURL(currentUrl);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerAppProtocolHandler(): void {
  protocol.handle(APP_SCHEME, (request) => {
    const requestUrl = new URL(request.url);
    const requestPath = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
    const filePath = resolveAppFilePath(rendererRoot(), requestPath);
    if (!filePath) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function hardenSession(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP_HEADER]
      }
    });
  });
  // deny every permission request by default (design §6.2)
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
}

let pendingSecondInstanceNotice: string | null = null;
app.on('second-instance', (_event, _commandLine, _workingDirectory, additionalData) => {
  const intent = validateSecondInstanceIntent(additionalData);
  if (!intent) return;
  if (intent.profileId !== launchProfile.profileId) return;
  const currentIntent = buildSecondInstanceIntent(process.env, {
    profileId: launchProfile.profileId,
    endpoint: startupConnectionEndpoint,
    buildId: app.getVersion()
  });
  const differentConnection = intent.endpoint !== undefined && currentIntent.endpoint !== undefined
    && intent.endpoint !== currentIntent.endpoint;
  const differentBuild = intent.buildId !== undefined && currentIntent.buildId !== undefined
    && intent.buildId !== currentIntent.buildId;
  if (differentConnection || differentBuild) {
    pendingSecondInstanceNotice = 'PROFILE_IN_USE_WITH_DIFFERENT_CONNECTION: 当前 profile 已在使用其他连接或版本，未切换服务。';
  } else if (intent.credentialOverridePresent) {
    pendingSecondInstanceNotice = 'PROFILE_RESTART_REQUIRED: 已有同 profile 实例，凭据覆盖不会切换当前连接。';
  }
  if (pendingSecondInstanceNotice && app.isReady()) {
    const notice = pendingSecondInstanceNotice;
    pendingSecondInstanceNotice = null;
    void dialog.showMessageBox({ type: 'info', message: notice });
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

void app.whenReady().then(() => {
  if (!gotLock) return;
  profileManifest = loadOrCreateProfileManifest(launchProfile.profileDir, launchProfile.profileId, {
    channel: launchProfile.channel,
    createdByVersion: app.getVersion()
  });
  configStore = new SecureConfigStore(launchProfile.userDataDir, createSecretStore());
  preferencesStore = new DesktopPreferencesStore(launchProfile.userDataDir);
  migrateLegacyPreferences(launchProfile.userDataDir, preferencesStore);
  notifications = new NotificationCoordinator();
  // Environment endpoint/token overrides are process-scoped. They must not be
  // silently persisted or overwrite an existing profile credential record.
  tokenPersisted = configStore.loadToken() !== null;
  registerAppProtocolHandler();
  hardenSession();
  registerIpcHandlers();
  // The renderer owns the only visible window chrome. Keep Electron's native
  // application menu out of the desktop shell as well.
  Menu.setApplicationMenu(null);
  createWindow();
  void refreshServiceStatus();
  if (pendingSecondInstanceNotice) {
    void dialog.showMessageBox({ type: 'info', message: pendingSecondInstanceNotice });
    pendingSecondInstanceNotice = null;
  }

  // spike smoke mode: quit shortly after first paint (used by CLI/CI only)
  if (process.argv.includes('--smoke')) {
    const win = mainWindow;
    if (win) {
      win.webContents.on('did-finish-load', () => {
        setTimeout(() => app.quit(), 1500);
      });
    }
    setTimeout(() => app.quit(), 10000);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  // stop only the owned child; an attached external service is never touched
  stopClientSessionHeartbeat();
  stopDurableStream();
  stopNativeEventStreams();
  connectionCoordinator.close();
  supervisor.stopOwned();
});
