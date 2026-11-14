import { CollaborationPanel } from './CollaborationPanel';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
  unwrap,
  reduceVisibleOutput,
  reduceVisibleReasoning,
  useAttention,
  useDurableEvents,
  useProjects,
  useProjectSessionPreflight,
  useProjectFile,
  useRuns,
  useRunActivities,
  useRunReasoning,
  useRunOutput,
  invalidateSessionHistory,
  useRunWorkspaceConflicts,
  useExecutionPolicy,
  useAutomationControl,
  useRunDiffSummary,
  useSessionApprovals,
  useMissions,
  runsQueryKey,
  normalizeApprovalForRenderer,
  type ApprovalRequestLike,
  type AttentionLike,
  type MissionLike,
  type ProjectLike,
  type RunLike,
  type SessionLike,
  modelCatalogEntryRef,
  modelCatalogEntryMatches,
  useSession,
  useSessions,
  useAgentProfiles,
  useSpec,
  type RunActivitySnapshot,
  type VisibleOutputState,
  type VisibleReasoningState,
  type RunReasoningSnapshot,
  type RunOutputSnapshot,
  type WorkspaceExecutionLike,
  type WorkspaceBindingLike,
  type WorkspaceConflictLike,
  type DeliveryReviewLike,
  type DiffPageLike
} from './queries';
import { activitiesOf, mergeActivitySnapshot, reduceRunActivities } from './activity/activityReducer';
import { activityHistoryReasonLabel } from './activity/activityPresentation';
import type { LiveActivityProjection } from './activity/activityReducer';
import type { RunActivity } from './activity/activityTypes';
import { AgentRunBlock, roundTranscriptEnabled } from './conversation/AgentRunBlock';
import { ungroupedTextOf } from './activity/roundDisplayModel';
import { CliExecutionTranscript } from './conversation/CliExecutionTranscript';
import { RoundTranscript } from './conversation/RoundTranscript';
import { RunStatusBar } from './conversation/RunStatusBar';
import { useRunDisplayClock } from './conversation/useRunDisplayClock';
import { deriveRunDisplayModel } from './activity/runDisplayModel';
import { RunContinueEntry } from './conversation/RunContinueEntry';
import { RunFailureCard } from './conversation/RunFailureCard';
import { ApprovalCard, AuthorizationExpiredCard, type ApprovalKind } from './conversation/ApprovalCard';
import { DangerApprovalPanel } from './conversation/DangerApprovalPanel';
import { UnifiedApprovalCard } from './conversation/UnifiedApprovalCard';
import { ExtensionSelectionChips, ExtensionSelectionPicker, useExtensionSelection } from './ExtensionSelectionBar';
import { ConversationHeader } from './conversation/ConversationHeader';
import type { ExtensionSelection } from '../../../packages/protocol/src/index.js';
import { DIFF_PAGE_SIZE, EvidenceLayers, GitChangesPage, ReviewFindings, WorkspaceExecutions } from './EvidencePanels';
import { MissionPanel } from './MissionPanel';
import { type SettingsRoute } from './settings/SettingsCenter';
import { appearanceFromPreferences } from './settings/pages/AppearancePage';
import { useDesktopPreferences, useModelCatalog, usePatchSessionModel } from './settings/useSettingsQueries';
import { WorkPane } from './panes/WorkPane';
import { TerminalDock } from './TerminalDock';
import { ContentRenderer } from './ContentRenderer';
import { Icon } from './Icon';
import { CommandPalette } from './panes/CommandPalette';
import { FileReferenceDialog } from './panes/FileReferenceDialog';
import { ApprovalReminder } from './panes/ApprovalReminder';
import { PERMISSION_MODE_SHORT_LABELS } from './conversation/PermissionModeSelector';
import { PermissionModeMenu } from './conversation/PermissionModeMenu';
import { AttentionSurface, ExtensionsSurface, MissionsSurface, SettingsSurface } from './surfaces/Surfaces';
import { PersonalAccessPanel } from './PersonalAccessPanel';
import { NativeConversation } from '../personal/NativeConversation';
import { ConversationMessage } from './conversation/ConversationMessage';
import { NativeTaskLauncher } from '../personal/NativeTaskLauncher';
import { useNativeTaskIndex } from '../personal/useNativeTaskIndex';
import { PersonalNativeTasks } from '../personal/PersonalNativeTasks';
import type { PersonalTaskIndex } from '../../../packages/protocol/src/personal-task';
import { VirtualMessageWindow } from './conversation/VirtualMessageWindow';
import { DeliveryReviewCard } from './conversation/DeliveryReviewCard';
import { WorkspaceConflictSurface } from './conflicts/WorkspaceConflictSurface';
import {
  historyPaginationAvailable,
  readFullMessageContent,
  useHistorySessionDetail,
  useHistorySessions
} from './data/historyQueries';
import {
  DEFAULT_SESSION_CAPABILITIES,
  type SessionCapabilities
} from './sessionContract';
import { DesktopTitleBar } from './DesktopTitleBar';
import { DirectoryPanel } from './DirectoryPanel';
import { ActivitySummaryPanel } from './ActivitySummaryPanel';
import { BuildPlanPanel } from './BuildPlanPanel';
import { ExportDrawer } from './export/ExportDrawer';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_TOTAL_MAX_BYTES,
  autoTitle,
  checkBodyWithinLimits,
  describeInputProblem,
  resolveTextInputLimits,
  SUPPORTED_ATTACHMENT_MEDIA_TYPES,
  type TextInputLimits
} from './inputPolicy';
import { runStateIconName, runStateLabel, runStateTone, sessionStatusView } from './sessionStatus';
import { Popover } from './ui/Popover';
import { StatusBadge, badgeTone } from './ui/StatusBadge';
import type { ApprovalsListResponse, DesktopCapabilities, MessageContentPageResponse, PendingSandboxApproval, PendingTerminalApproval, PermissionMode, SessionMessageResponse } from '../../../electron/shared/api-types';
import type { ModelCatalogResponse, OperationReceiptResponse, SessionModelSettings } from '../../../packages/protocol/src/index.js';

/**
 * Session-first desktop workbench (UI Refresh R1-R9).
 * The rail and conversation are stable; inspection surfaces open on demand,
 * while Settings, Extensions, Attention and Missions remain separate routes.
 * Selection generation keeps slow responses from an earlier session out of
 * the current conversation.
 */

/** EW10.2 read-only source fetch result (provenance + untrusted marker). */
interface SourceFetchLike {
  sourceType?: string | null;
  sourceUri?: string | null;
  finalUri?: string | null;
  fetchedAt?: string | null;
  contentType?: string | null;
  contentBytes?: number | null;
  contentText?: string | null;
  truncated?: boolean | null;
  untrustedContent?: boolean | null;
}

interface NewSessionCreationResult {
  sessionId?: string;
  sessionVersion?: number;
  initialSpecId?: string;
  /**
   * Session admission and the first-turn submission are two different
   * operations.  Keep a follow-up failure out of the session-create error
   * path so an accepted session is never reported as if it did not exist.
   */
  initialMessageError?: string;
  initialMessage?: {
    content: string;
    attachments: AttachmentWire[];
    messageKey: string;
    expectedSessionVersion: number;
  };
  flowId: number;
}

/**
 * Public WAITING_APPROVAL minus budget waits: the service projects budget
 * top-up waits through the same public state, and sourceStatus keeps the
 * specific kind.
 */
function isNonBudgetApprovalWait(run: { state: string; sourceStatus?: string | null }): boolean {
  return run.state === 'WAITING_APPROVAL' && run.sourceStatus !== 'WAITING_BUDGET_APPROVAL';
}

function isApprovalWaiting(run: { state?: string | null; sourceStatus?: string | null }): boolean {
  return run.state === 'WAITING_APPROVAL'
    || run.state === 'WAITING_BUDGET_APPROVAL'
    || run.sourceStatus === 'WAITING_BUDGET_APPROVAL';
}

/** Ordinal rank matching the service's PermissionMode ordering. */
const RUN_TERMINAL_STATES = new Set(['COMPLETED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'TIMED_OUT', 'ABORTED', 'REJECTED', 'TERMINAL', 'NEEDS_ATTENTION']);

/** U2 §6.4: slim "Review changes" strip above the composer. Hidden when the
 * summary query fails or reports no files — fail-closed, never a guess. */
/** Terminal work pane: lifts the dock's workspace one-liner into the panel
 * chrome as its subtitle so it renders exactly once (U5 §9.1 T2). */
function TerminalDockPane(props: {
  businessSessionId: string;
  projectId: string | null;
  enabled: boolean;
  unavailableReason?: string | null;
  docked: boolean;
  floatingWidth: string;
  onResizeStart: (event: React.PointerEvent) => void;
  onToggleDock: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const [workspaceSummary, setWorkspaceSummary] = useState<string | null>(null);
  return (
    <WorkPane
      label="终端面板"
      title="终端"
      subtitle={workspaceSummary ?? undefined}
      closeLabel="关闭终端面板"
      className="terminal-work-pane"
      docked={props.docked}
      floatingWidth={props.floatingWidth}
      onResizeStart={props.onResizeStart}
      onToggleDock={props.onToggleDock}
      onClose={props.onClose}
    >
      <div className="pane-content terminal-pane">
        <TerminalDock
          businessSessionId={props.businessSessionId}
          projectId={props.projectId}
          enabled={props.enabled}
          unavailableReason={props.unavailableReason}
          onWorkspaceSummary={setWorkspaceSummary}
        />
      </div>
    </WorkPane>
  );
}

function ComposerDiffStrip(props: { runId: string; onOpen: () => void }): React.JSX.Element | null {
  const diff = useRunDiffSummary(props.runId);
  if (!diff.data || diff.data.files === 0) return null;
  return (
    <div className="composer-diff-strip" data-testid="composer-diff-strip">
      <span className="composer-diff-counts">
        {diff.data.files} 个文件
        <strong className="positive">+{diff.data.additions}</strong>
        <strong className="negative">−{diff.data.deletions}</strong>
        {diff.data.complete === false ? '（不完整）' : ''}
      </span>
      <button type="button" className="link-button" onClick={props.onOpen}>查看变更</button>
    </div>
  );
}

function modeRank(mode: string): number {
  const order = ['STANDARD', 'AUTO_APPROVE', 'FULL_ACCESS'];
  const index = order.indexOf(mode);
  return index < 0 ? order.length : index;
}

const LAST_WORKBENCH_STATE_KEY = 'codeagent.desktop.last-workbench-state.v1';

interface PersistedWorkbenchState {
  sessionId?: string | null;
  activeSurface?: ActiveSurface;
  /** ECN-001: last open native conversation locator (management taskId). */
  nativeTaskId?: string | null;
}

interface ExpiredSandboxApproval {
  status: 'EXPIRED';
  reasonCode: string;
  message: string;
  expiresAtMillis?: number;
}

type SandboxApprovalProjection = PendingSandboxApproval | ExpiredSandboxApproval | null;

function readPersistedWorkbenchState(): PersistedWorkbenchState {
  try {
    const raw = window.localStorage.getItem(LAST_WORKBENCH_STATE_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as Record<string, unknown>;
    const activeSurface = value.activeSurface;
    return {
      ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
      ...(typeof value.nativeTaskId === 'string' ? { nativeTaskId: value.nativeTaskId } : {}),
      ...(typeof activeSurface === 'string' && ['WORKSPACE', 'GIT', 'ATTENTION', 'MISSIONS', 'SETTINGS', 'EXTENSIONS', 'PERSONAL_ACCESS', 'NATIVE_DIAGNOSTICS'].includes(activeSurface)
        ? { activeSurface: activeSurface as ActiveSurface } : {})
    };
  } catch {
    return {};
  }
}

function persistWorkbenchState(value: PersistedWorkbenchState): void {
  try {
    window.localStorage.setItem(LAST_WORKBENCH_STATE_KEY, JSON.stringify(value));
  } catch {
    // Browser storage is only a convenience; the Service remains authoritative.
  }
}

function approvalErrorCode(error: unknown): string {
  const candidate = error as { code?: unknown } | null;
  return typeof candidate?.code === 'string' ? candidate.code : errorMessage(error);
}

function useMediaQuery(queryText: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === 'function' && window.matchMedia(queryText).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(queryText);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [queryText]);
  return matches;
}

function isAuthorizationExpiredRun(run: Pick<RunLike, 'state' | 'failureCode' | 'terminationCode' | 'reasonCode' | 'failureMessage'>): boolean {
  const facts = [run.failureCode, run.terminationCode, run.reasonCode, run.failureMessage]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return /(?:APPROVAL_EXPIRED|APPROVAL_TIMED_OUT|AUTHORIZATION_EXPIRED|AUTHORIZATION_INVALID)/i.test(facts);
}

function expiredSandboxApproval(error: unknown): ExpiredSandboxApproval | null {
  const code = approvalErrorCode(error);
  if (!/(?:SANDBOX_APPROVAL_EXPIRED|APPROVAL_EXPIRED|AUTHORIZATION_EXPIRED)/i.test(code)) return null;
  return {
    status: 'EXPIRED',
    reasonCode: code,
    message: '沙箱授权已失效，旧请求不能继续使用；请重新发起新的运行。'
  };
}

function isExpiredSandboxApproval(value: SandboxApprovalProjection): value is ExpiredSandboxApproval {
  return value !== null && 'status' in value && value.status === 'EXPIRED';
}

interface PendingConversationTurn {
  sessionId: string;
  content: string;
  startedAt: number;
  clientMessageId: string;
}

interface SendMessageInput {
  sessionId: string;
  content: string;
  attachments?: AttachmentWire[];
  clientMessageId?: string;
  expectedSessionVersion?: number;
  fromNewSession?: boolean;
  frozenContent?: string;
  frozenAttachments?: AttachmentWire[];
  frozenGeneration?: number;
  /** WU07: per-turn extension selection frozen into the message. */
  extensions?: ExtensionSelection | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRequestTimeout(error: unknown): boolean {
  return /(?:aborted due to timeout|timed?\s*out|timeout)/i.test(errorMessage(error));
}

function formatRunElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `已耗时 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `已耗时 ${minutes} 分 ${seconds % 60} 秒`;
}

type ActiveSurface = 'WORKSPACE' | 'GIT' | 'ATTENTION' | 'MISSIONS' | 'SETTINGS' | 'EXTENSIONS' | 'PERSONAL_ACCESS' | 'NATIVE_DIAGNOSTICS';
type PaneType = 'ACTIVITY' | 'GIT' | 'EVIDENCE' | 'PLAN' | 'MISSION' | 'DETAILS' | 'TERMINAL';
/** Git panel tabs; evidence is a separate top-level panel. */
type GitTab = 'DIFF' | 'WORKSPACE';

/** 长输入设计 §5.3：从 capability 读取 session.message.send.text 的 limits；缺失即回退旧 4000/200。 */
function textInputLimitsOf(capabilities: DesktopCapabilities | undefined): Record<string, unknown> | null {
  const operation = capabilities?.operations?.find((candidate) => candidate.id === 'session.message.send.text');
  const limits = operation?.limits;
  return limits !== null && limits !== undefined && typeof limits === 'object'
    ? limits as Record<string, unknown>
    : null;
}

function operationAvailable(
  capabilities: DesktopCapabilities | undefined,
  operationId: string,
  featureFallback: boolean
): boolean {
  if (!capabilities) return featureFallback;
  const operations = capabilities.operations;
  if (!operations) return featureFallback;
  return operations.some((operation) => operation.id === operationId && operation.availability === 'AVAILABLE');
}

function operationReason(capabilities: DesktopCapabilities | undefined, operationId: string): string | null {
  const operations = capabilities?.operations;
  const operation = operations?.find((candidate) => candidate.id === operationId);
  if (!operation || operation.availability === 'AVAILABLE') return null;
  return operation.reasonCode ?? operation.availability;
}


/** Base64 for bounded source text; UTF-8 safe via explicit byte chunks. */
function base64OfText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

/** 附件名安全检查（设计 §5.1）：禁止路径分隔符、CR/LF/NUL。用显式判断避开正则转义坑。 */
function hasUnsafeAttachmentName(name: string): boolean {
  if (!name) return true;
  if (name.indexOf('/') >= 0) return true;
  if (name.indexOf(String.fromCharCode(92)) >= 0) return true;
  if (name.indexOf(String.fromCharCode(13)) >= 0) return true;
  if (name.indexOf(String.fromCharCode(10)) >= 0) return true;
  if (name.indexOf(String.fromCharCode(0)) >= 0) return true;
  return false;
}

/** Bounded display/attachment name derived from the source URI only. */
function sourceAttachmentName(uri: string): string {
  try {
    const parsed = new URL(uri);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    const base = (lastSegment || parsed.hostname).replace(/[^\w.-]+/g, '_').slice(0, 80);
    return base.length > 0 ? base : 'source.txt';
  } catch {
    return 'source.txt';
  }
}

/** Time-of-day greeting for the blank workspace hero (design inspiration 2026-09-03). */
function greetingForHour(hour: number): string {
  if (hour < 6) return '凌晨好';
  if (hour < 12) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/** Recency label from a list-view timestamp; null when the service omits it. */
function relativeTimeLabel(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const diffMs = Date.now() - value;
  if (diffMs < 0) return '刚刚';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  const date = new Date(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** Last non-empty message excerpt for list preview; never invents content. */
function sessionPreview(item: { messages?: Array<{ content?: string | null }> | null }): string | null {
  const messages = item.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content?.trim();
    if (content) return content.length > 60 ? `${content.slice(0, 60)}…` : content;
  }
  return null;
}

type SidebarSectionKey = 'pinned' | 'projects' | 'chats' | 'recent' | 'native';
type SidebarView = 'PROJECTS' | 'RECENT';

interface SidebarNavigationState {
  view: SidebarView;
  pinnedSessionIds: string[];
  collapsedSections: Partial<Record<SidebarSectionKey, boolean>>;
  collapsedProjects: Record<string, boolean>;
}

const SIDEBAR_NAVIGATION_STORAGE_KEY = 'business-agent-desktop.sidebar-navigation.v1';

function booleanRecordOf(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => typeof entry === 'boolean')
      .map(([key, entry]) => [key, entry as boolean])
  );
}

function readSidebarNavigationState(): SidebarNavigationState {
  const empty: SidebarNavigationState = {
    view: 'PROJECTS',
    pinnedSessionIds: [],
    collapsedSections: {},
    collapsedProjects: {}
  };
  if (typeof window === 'undefined') return empty;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_NAVIGATION_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as {
      view?: unknown;
      pinnedSessionIds?: unknown;
      collapsedSections?: unknown;
      collapsedProjects?: unknown;
    };
    return {
      view: parsed.view === 'RECENT' || parsed.view === 'PROJECTS' ? parsed.view : 'PROJECTS',
      pinnedSessionIds: Array.isArray(parsed.pinnedSessionIds)
        ? parsed.pinnedSessionIds.filter((id): id is string => typeof id === 'string')
        : [],
      collapsedSections: booleanRecordOf(parsed.collapsedSections) as Partial<Record<SidebarSectionKey, boolean>>,
      collapsedProjects: booleanRecordOf(parsed.collapsedProjects)
    };
  } catch {
    // A malformed or unavailable local preference must never block the shell.
    return empty;
  }
}

interface MessageAttachmentSummary {
  id?: string | null;
  name?: string | null;
  mediaType?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
  width?: number | null;
  height?: number | null;
}

type AttachmentWire = {
  clientAttachmentId: string;
  name: string;
  mediaType: string;
  dataBase64: string;
};

type PendingAttachment = AttachmentWire & {
  orderIndex: number;
  status: 'READING' | 'READY' | 'ERROR';
  error?: string;
  previewDataUrl?: string;
};

function isImageAttachment(mediaType: string | null | undefined): boolean {
  return mediaType === 'image/png' || mediaType === 'image/jpeg';
}

function toAttachmentWire(attachment: PendingAttachment): AttachmentWire {
  return {
    clientAttachmentId: attachment.clientAttachmentId,
    name: attachment.name,
    mediaType: attachment.mediaType,
    dataBase64: attachment.dataBase64
  };
}

function attachmentAccept(canSendImage: boolean): string {
  return canSendImage ? '.txt,.md,image/png,image/jpeg' : '.txt,.md';
}

function attachmentLabel(attachment: PendingAttachment): string {
  if (attachment.status === 'READING') return `${attachment.name}（读取中…）`;
  if (attachment.status === 'ERROR') return `${attachment.name}（读取失败）`;
  return attachment.name;
}

function PendingAttachments(props: {
  attachments: PendingAttachment[];
  onRemove: (clientAttachmentId: string) => void;
  testId?: string;
}): React.JSX.Element | null {
  if (props.attachments.length === 0) return null;
  return (
    <div className="pending-attachments" data-testid={props.testId ?? 'pending-attachments'} aria-label="待发送附件">
      {props.attachments.slice().sort((a, b) => a.orderIndex - b.orderIndex).map((attachment) => (
        <div className={`pending-attachment ${attachment.status === 'ERROR' ? 'is-error' : ''}`} key={attachment.clientAttachmentId}>
          {attachment.previewDataUrl && isImageAttachment(attachment.mediaType) ? (
            <img className="pending-attachment-preview" src={attachment.previewDataUrl} alt="" aria-hidden="true" />
          ) : <Icon name="file" size={14} />}
          <span className="pending-attachment-name" title={attachment.name}>{attachmentLabel(attachment)}</span>
          <button type="button" className="pending-attachment-remove" aria-label={`移除附件 ${attachment.name}`} onClick={() => props.onRemove(attachment.clientAttachmentId)}>移除</button>
        </div>
      ))}
    </div>
  );
}

/** Model id shown on the chip: the segment after the last `/` (§6.2); the
 * full alias stays on the title. */
function modelShortName(modelAlias: string | null | undefined): string | null {
  if (!modelAlias) return null;
  const segment = modelAlias.split('/').pop();
  return segment && segment.length > 0 ? segment : modelAlias;
}

function ComposerModelSelector(props: {
  catalog?: ModelCatalogResponse;
  value: string | null;
  defaultModel?: string | null;
  disabled?: boolean;
  pending?: boolean;
  onChange: (modelAlias: string | null) => void;
  reasoningMode?: 'DEFAULT' | 'OFF' | 'EFFORT';
  reasoningOptionId?: string | null;
  reasoningOptions?: string[];
  onReasoningChange?: (mode: 'DEFAULT' | 'OFF' | 'EFFORT', optionId?: string | null) => void;
  contextMode?: 'AUTO' | 'PRESET';
  contextPresetId?: string | null;
  contextOptions?: number[];
  onContextChange?: (mode: 'AUTO' | 'PRESET', presetId?: string | null) => void;
  testId: string;
}): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const availableModels = (props.catalog?.items ?? []).filter((entry) =>
    entry.availability === 'AVAILABLE' && entry.configured
  );
  const catalogModels = props.catalog?.items ?? [];
  const matchedAvailableModel = props.value
    ? availableModels.find((entry) => modelCatalogEntryMatches(entry, props.value))
    : null;
  const currentModelAvailable = props.value === null || Boolean(matchedAvailableModel);
  const effectiveAlias = props.value || props.defaultModel || props.catalog?.defaultModel || null;
  const selectedModel = catalogModels.find((entry) => modelCatalogEntryMatches(entry, effectiveAlias));
  const selectValue = props.value
    ? (matchedAvailableModel ? modelCatalogEntryRef(matchedAvailableModel) : props.value)
    : '';
  const shortName = modelShortName(effectiveAlias);
  const reasoningOptions = props.reasoningOptions ?? [];
  const contextOptions = props.contextOptions ?? [];
  const contextValue = props.contextMode === 'PRESET' && props.contextPresetId
    && contextOptions.includes(Number(props.contextPresetId))
    ? `PRESET:${props.contextPresetId}` : 'AUTO';
  const contextWindowTokens = selectedModel?.contextWindowTokens
    ?? parsePositiveContextTokens(selectedModel?.maxContextLevel)
    ?? (selectedModel?.contextTokenOptions?.length
      ? Math.max(...selectedModel.contextTokenOptions) : null);
  const contextUsedTokens = selectedModel?.contextUsedTokens ?? null;
  const contextPercent = contextWindowTokens && contextUsedTokens != null
    ? Math.round((contextUsedTokens / contextWindowTokens) * 100) : null;
  const contextSummary = contextWindowTokens
    ? contextUsedTokens == null
      ? `上限 ${formatUsageTokens(contextWindowTokens)} · 已用暂无数据`
      : `${formatUsageTokens(contextUsedTokens)} / ${formatUsageTokens(contextWindowTokens)}${contextPercent == null ? '' : ` (${contextPercent}%)`}`
    : '暂无数据';
  const cacheHitSummary = selectedModel?.cacheHitRatePercent == null
    ? '暂无数据' : `${selectedModel.cacheHitRatePercent.toFixed(1)}%`;

  return (
    <div className="composer-model-controls" data-testid={props.testId}>
      <span className="popover-anchor">
        <button
          ref={anchorRef}
          type="button"
          className={`composer-chip composer-model-trigger${menuOpen ? ' selected' : ''}`}
          data-testid={`${props.testId}-trigger`}
          title={effectiveAlias ?? '模型'}
          aria-label={effectiveAlias ? `模型：${shortName}` : '模型'}
          aria-expanded={menuOpen}
          aria-controls="composer-model-menu"
          disabled={Boolean(props.disabled)}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {shortName ?? '模型'}
          <Icon name="chevron" size={11} className="chip-chevron" />
        </button>
        <Popover
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorRef={anchorRef}
          placement="top"
          align="end"
          className="composer-model-menu"
          id="composer-model-menu"
          ariaLabel="模型选择"
        >
          <div className="menu-caption">模型</div>
          <div className="composer-model-row">
            <select
              className="composer-model-select"
              aria-label="选择模型"
              data-testid={`${props.testId}-select`}
              value={selectValue}
              disabled={Boolean(props.disabled) || availableModels.length === 0}
              onChange={(event) => props.onChange(event.target.value || null)}
            >
              <option value="">
                {props.defaultModel ? `默认（${props.defaultModel}）` : '默认模型'}
              </option>
              {!currentModelAvailable && props.value ? (
                <option value={props.value}>{props.value}（当前不可用）</option>
              ) : null}
              {availableModels.map((entry) => (
                <option key={`${entry.providerId ?? 'provider'}:${entry.modelAlias}`} value={modelCatalogEntryRef(entry)}>
                  {entry.modelAlias}
                </option>
              ))}
            </select>
            {props.pending ? <span className="composer-model-pending" role="status">保存中…</span> : null}
            {!props.pending && availableModels.length === 0 ? <span className="composer-model-pending">暂无可用模型</span> : null}
          </div>
          {props.onContextChange ? (
            <div className="composer-model-row composer-model-context-row">
              <select
                className="composer-model-select"
                aria-label="会话上下文长度"
                data-testid={`${props.testId}-context`}
                value={contextValue}
                disabled={Boolean(props.disabled) || Boolean(props.pending)}
                onChange={(event) => {
                  const value = event.target.value;
                  props.onContextChange?.(value === 'AUTO' ? 'AUTO' : 'PRESET', value === 'AUTO' ? null : value.slice('PRESET:'.length));
                }}
              >
                <option value="AUTO">上下文</option>
                {contextOptions.map((option) => (
                  <option key={option} value={`PRESET:${option}`}>{formatContextTokens(option)}</option>
                ))}
              </select>
            </div>
          ) : null}
          {props.onReasoningChange ? (
            <div className="composer-model-row composer-model-reasoning-row">
              <select
                className="composer-model-select"
                aria-label="会话推理强度"
                data-testid={`${props.testId}-reasoning-mode`}
                value={props.reasoningMode ?? 'DEFAULT'}
                disabled={Boolean(props.disabled) || Boolean(props.pending)}
                onChange={(event) => {
                  const mode = event.target.value as 'DEFAULT' | 'OFF' | 'EFFORT';
                  props.onReasoningChange?.(mode, mode === 'EFFORT' ? (reasoningOptions[0] ?? null) : null);
                }}
              >
                <option value="DEFAULT">默认推理</option>
                <option value="OFF">关闭（若支持）</option>
                {reasoningOptions.length > 0 ? <option value="EFFORT">选择档位</option> : null}
              </select>
              {props.reasoningMode === 'EFFORT' && reasoningOptions.length > 0 ? (
                <select
                  className="composer-model-select"
                  aria-label="会话推理档位"
                  data-testid={`${props.testId}-reasoning-option`}
                  value={props.reasoningOptionId ?? reasoningOptions[0]}
                  disabled={Boolean(props.disabled) || Boolean(props.pending)}
                  onChange={(event) => props.onReasoningChange?.('EFFORT', event.target.value || null)}
                >
                  {reasoningOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : null}
            </div>
          ) : null}
          <div className="composer-usage-panel" data-testid={`${props.testId}-usage`}>
            <div className="composer-usage-heading">
              <strong>模型用量</strong>
              <span>{selectedModel?.modelAlias ?? props.defaultModel ?? '当前模型'}</span>
            </div>
            <div className="composer-usage-item">
              <span>上下文容量</span>
              <strong>{contextSummary}</strong>
            </div>
            <div className="composer-usage-item">
              <span>平均缓存命中率</span>
              <strong>{cacheHitSummary}</strong>
            </div>
            <div className="composer-usage-note">
              {selectedModel?.usageSampleCount
                ? `基于 ${selectedModel.usageSampleCount} 次模型响应`
                : '模型调用后显示实时用量'}
            </div>
          </div>
        </Popover>
      </span>
    </div>
  );
}

function parsePositiveContextTokens(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatUsageTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    // Keep the panel compact and aligned with the product's Chinese token
    // labels: 1,048,576 is presented as the familiar 100 万级窗口.
    return `${Math.round(tokens / 100_000) * 10}万`;
  }
  if (tokens >= 10_000) {
    const value = tokens / 10_000;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}万`;
  }
  return `${Math.round(tokens)}`;
}

function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}K`;
  }
  return `${tokens}`;
}

/** Keep valid drafts quiet; show only an actionable validation error. */
function NewSessionInputMeta(props: { goal: string; limits: TextInputLimits }): React.JSX.Element | null {
  if (!props.goal) return null;
  let check;
  try {
    check = checkBodyWithinLimits(props.goal, props.limits);
  } catch {
    return null;
  }
  if (check.ok) return null;
  return <div className="new-session-options-note" data-testid="new-session-input-meta" role="alert">
    {check.message ?? '输入超出上限，请缩短后重试。'}
  </div>;
}

/**
 * 长输入设计 §6.3/§6.8：会话消息的附件摘要（只读元数据）与按需内容读取。
 * 列表只展示 id/name/mediaType/sizeBytes；textContent 经窄 IPC 按需读取，
 * 不在会话列表里物化全文。Markdown 内容按纯文本展示，不渲染 HTML。
 */
function MessageAttachments(props: {
  sessionId: string;
  messageId: string;
  attachments: MessageAttachmentSummary[];
}): React.JSX.Element | null {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [failedId, setFailedId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  if (props.attachments.length === 0) return null;
  const load = async (attachmentId: string) => {
    const attachment = props.attachments.find((item) => item.id === attachmentId);
    if (attachment && isImageAttachment(attachment.mediaType)) {
      if (imageUrls[attachmentId] !== undefined || failedId === attachmentId) {
        setExpandedId((current) => (current === attachmentId ? null : attachmentId));
        return;
      }
      setLoadingId(attachmentId);
      try {
        const bytes = await unwrap<{ mediaType: string; dataBase64: string }>(await window.codeAgentDesktop.getSessionAttachmentBytes(
          props.sessionId, props.messageId, attachmentId));
        if (!isImageAttachment(bytes.mediaType)) throw new Error('unsupported image media type');
        setImageUrls((current) => ({ ...current, [attachmentId]: `data:${bytes.mediaType};base64,${bytes.dataBase64}` }));
        setFailedId(null);
        setExpandedId(attachmentId);
      } catch {
        setFailedId(attachmentId);
        setExpandedId(attachmentId);
      } finally {
        setLoadingId(null);
      }
      return;
    }
    if (contents[attachmentId] !== undefined || failedId === attachmentId) {
      setExpandedId((current) => (current === attachmentId ? null : attachmentId));
      return;
    }
    try {
      const text = await unwrap<string>(await window.codeAgentDesktop.getSessionAttachmentContent(
        props.sessionId, props.messageId, attachmentId));
      setContents((current) => ({ ...current, [attachmentId]: text }));
      setFailedId(null);
      setExpandedId(attachmentId);
    } catch {
      setFailedId(attachmentId);
      setExpandedId(attachmentId);
    }
  };
  return (
    <div className="message-attachments" data-testid="message-attachments">
      {props.attachments.map((attachment, index) => {
        const attachmentId = attachment.id ?? `attachment-${index}`;
        const open = expandedId === attachmentId;
        const text = contents[attachmentId];
        const image = isImageAttachment(attachment.mediaType);
        return (
          <div key={attachmentId} className="message-attachment">
            <button
              type="button"
              className="attachment-toggle"
              data-testid={`attachment-toggle-${attachmentId}`}
              onClick={() => void load(attachmentId)}
            >
              <span className="attachment-name">{attachment.name ?? attachmentId}</span>
              <span className="run-meta">
                {attachment.mediaType ?? 'text/plain'}
                {typeof attachment.sizeBytes === 'number' ? ` · ${attachment.sizeBytes} 字节` : ''}
              </span>
              <span className="fold-hint">{open ? '收起' : image ? '预览' : '查看'}</span>
            </button>
            {open ? (
              failedId === attachmentId && text === undefined ? (
                <p className="content-fallback" role="alert">附件内容读取失败（无权或已被归档）。</p>
              ) : image ? (
                loadingId === attachmentId ? <p className="content-fallback">预览读取中…</p>
                  : imageUrls[attachmentId] ? <img className="attachment-image-preview" src={imageUrls[attachmentId]} alt={attachment.name ?? attachmentId} />
                    : <p className="content-fallback">暂无可用预览。</p>
              ) : (
                <pre className="attachment-content" data-testid={`attachment-content-${attachmentId}`}>
                  {text ?? '读取中…'}
                </pre>
              )
             ) : null}
           </div>
         );
      })}
    </div>
  );
}

/** Full message bodies stay visible; only server-deferred content needs an explicit load. */
const LongMessageBody = memo(function LongMessageBody(props: { content: string }): React.JSX.Element {
  return <div className="content"><ContentRenderer text={props.content} /></div>;
});

/**
 * Ordinary-chat display reasoning persisted on the assistant message
 * itself (design 2026-09-18). Bounded provider-returned public thinking
 * text only; rendered collapsed so the answer stays primary.
 */
function MessageReasoning(props: { text: string; truncated?: boolean | null }): React.JSX.Element {
  return (
    <details className="reasoning-block" data-testid="message-reasoning">
      <summary className="reasoning-summary">
        <span className="reasoning-label">{props.truncated ? '思考过程（较早部分已截断）' : '思考过程'}</span>
      </summary>
      <div className="reasoning-text"><ContentRenderer text={props.text} /></div>
    </details>
  );
}

/**
 * Historical run-scoped reasoning (design 2026-09-18): the fold is fetched
 * from the durable run journal only when the user expands the entry — one
 * bounded request per expanded run, cache-backed on re-expand.
 */
function HistoricalRunReasoning(props: {
  runId: string;
  canRead: boolean;
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const query = useRunReasoning(props.canRead && expanded ? props.runId : null);
  if (!props.canRead) return null;
  const text = query.data?.text?.trim();
  return (
    <details
      className="reasoning-block reasoning-run"
      data-testid={`run-reasoning-${props.runId}`}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="reasoning-summary">
        <span className="reasoning-label">思考过程</span>
      </summary>
      {expanded ? (
        <div className="reasoning-text">
          {query.isPending ? <span className="run-meta" role="status">正在读取思考过程…</span> : null}
          {query.isError
            ? <span className="run-meta" role="status">思考过程读取失败。<button type="button" onClick={() => void query.refetch()}>重试</button></span>
            : null}
          {text ? <ContentRenderer text={text} /> : null}
          {query.data && !text && !query.isPending && !query.isError
            ? <span className="run-meta">该次执行没有记录可展示的思考内容。</span>
            : null}
          {query.data && query.data.complete === false
            ? <span className="run-meta">思考快照不完整{query.data.reasonCode ? `（${activityHistoryReasonLabel(query.data.reasonCode)}）` : ''}。</span>
            : null}
        </div>
      ) : null}
    </details>
  );
}

/**
 * Routes one message body by its content state (2026-09-05 design §7.2):
 * INLINE renders through the memoized body; DEFERRED shows the bounded
 * service-owned load card with an explicit load action. Full inline bodies
 * render directly without an automatic fold.
 */
function HistoryMessageBody(props: {
  sessionId: string;
  message: {
    id: string;
    content?: string | null;
    contentState?: 'INLINE' | 'DEFERRED';
    contentPreview?: string | null;
    contentRevision?: string;
    contentBytes?: number;
  };
}): React.JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    if (loading || props.message.contentRevision === undefined) return;
    setLoading(true);
    setError(null);
    try {
      const first = unwrap(await window.codeAgentDesktop.getMessageContentPage(
        props.sessionId, props.message.id, { maxBytes: 65_536 })) as MessageContentPageResponse;
      const full = await readFullMessageContent(props.sessionId, props.message.id, first);
      setText(full);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  };
  if (text !== null) {
    return <LongMessageBody content={text} />;
  }
  if (props.message.contentState === 'DEFERRED' || props.message.content == null) {
    return (
      <div className="content">
        <div className="long-message-card" data-testid={`deferred-body-${props.message.id}`}>
          <span className="run-meta">正文较长，点击加载完整内容</span>
          {error ? (
            <p className="content-fallback" role="alert">
              {error.includes('HISTORY_REVISION_CHANGED') ? '正文已更新，请重新打开后加载。'
                : error.includes('HISTORY_CONTENT_TOO_LARGE') ? '内容超出一次完整读取预算。'
                : '内容读取失败，可重试。'}
            </p>
          ) : null}
          <div className="long-message-toolbar">
            <button type="button" onClick={() => void load()} disabled={loading}>
              {loading ? '正在读取…' : '加载完整内容'}
            </button>
          </div>
        </div>
      </div>
    );
  }
  return <LongMessageBody content={props.message.content} />;
}

/**
 * Historical assistant-turn activity (2026-09-05 design §9.1): the entry is
 * visible before any data arrives, and the durable fold is requested only
 * while expanded — one request per expanded run, cache-backed on re-expand.
 * Snapshot incompleteness keeps its service-provided reason instead of
 * pretending the trace is whole.
 */
/** The session's fixed default-workspace directory row carries the run
 * workspace's absolute root — display metadata for file-path tooltips
 * only; file refs themselves stay project-relative everywhere else. */
function sessionWorkspaceRoot(session: SessionLike | null | undefined): string | null {
  if (!session?.workspaceAlias) return null;
  const directories = session.directories ?? [];
  const defaultId = (session.directoryAccess?.entries ?? [])
    .find((entry) => entry.reason === 'DEFAULT_WORKSPACE' || entry.immutable === true)?.id;
  const match = (defaultId ? directories.find((directory) => directory.id === defaultId) : undefined)
    ?? directories[0];
  const path = match?.path?.trim();
  return path ? path : null;
}

function HistoricalRunActivity(props: {
  runId: string;
  canRead: boolean;
  unavailableReason?: string | null;
  items: RunActivity[] | undefined;
  onSnapshot: (snapshot: RunActivitySnapshot) => void;
  workspaceRoot?: string | null;
  /** Owning session id for session-scoped evidence-artifact reads. */
  sessionId?: string | null;
  onOpenFile?: (fileRef: string, startLine?: number | null, runId?: string) => void;
}): React.JSX.Element | null {
  // A finished turn keeps its process panel collapsed — it never degrades to
  // a bare entry button (design 2026-09-19: 终态只折叠不消失). The snapshot
  // loads when the user opens the execution details.
  const [expanded, setExpanded] = useState(false);
  const query = useRunActivities(props.canRead && expanded ? props.runId : null);
  const items = props.items && props.items.length > 0
    ? props.items
    : (query.data?.items ?? []);
  const useRounds = roundTranscriptEnabled();
  // Round history needs the same data as the live path (§9): output and
  // reasoning snapshots load once the run's activity state is known — cached
  // items prove it immediately; a resolved (even empty) snapshot means the
  // text channels may still carry this run's only content.
  const wantsRoundData = expanded && useRounds && props.canRead && (items.length > 0 || query.data !== undefined);
  const outputQuery = useRunOutput(wantsRoundData ? props.runId : null, { enabled: wantsRoundData });
  const reasoningQuery = useRunReasoning(wantsRoundData ? props.runId : null, { enabled: wantsRoundData });
  useEffect(() => {
    if (query.data) props.onSnapshot(query.data);
  }, [query.data, props.onSnapshot]);
  if (!props.canRead) {
    return props.unavailableReason
      ? <div className="activity-group activity-unavailable" data-testid="activity-unavailable">当前服务未提供执行明细（{props.unavailableReason}）</div>
      : null;
  }
  if (!expanded) {
    return <div className="message-turn-activity"><button type="button" className="secondary-button"
      onClick={() => setExpanded(true)}>查看执行过程</button></div>;
  }
  const incomplete = query.data && query.data.complete === false
    ? <span className="run-meta">活动快照不完整{query.data.reasonCode ? `（${activityHistoryReasonLabel(query.data.reasonCode)}）` : ''}，仅显示已折叠的有限快照。</span>
    : null;
  const transcript = useRounds ? (
    <RoundTranscript
      runId={props.runId}
      activities={items}
      outputRounds={outputQuery.data?.segments ?? null}
      reasoningRounds={reasoningQuery.data?.segments ?? null}
      ungroupedOutput={ungroupedTextOf(null, outputQuery.data ?? null)}
      ungroupedReasoning={ungroupedTextOf(null, reasoningQuery.data ?? null)}
      live={false}
      runTerminal
      answerMessagePresent
      nowMs={Date.now()}
      activitiesAvailable
      loadedActivityCount={items.length}
      activityHistoryComplete={query.data?.complete !== false}
      activityHistoryReason={query.data?.reasonCode ?? null}
      fold="HISTORY"
      workspaceRoot={props.workspaceRoot}
      sessionId={props.sessionId}
      onOpenFile={props.onOpenFile}
    />
  ) : (
    <CliExecutionTranscript runId={props.runId} activities={items} live={false} nowMs={Date.now()} activitiesAvailable observedStartedAt={null} loadedActivityCount={items.length} activityHistoryComplete={query.data?.complete !== false} activityHistoryReason={query.data?.reasonCode ?? null} workspaceRoot={props.workspaceRoot} sessionId={props.sessionId} onOpenFile={props.onOpenFile} />
  );
  if (items.length > 0 || (useRounds && (outputQuery.data || reasoningQuery.data))) {
    return (
      <div className="message-turn-activity">
        {transcript}
      </div>
    );
  }
  if (query.isPending || (wantsRoundData && (outputQuery.isPending || reasoningQuery.isPending))) {
    return (
      <div className="message-turn-activity">
        <span className="run-meta" role="status">正在读取执行活动…</span>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="message-turn-activity">
        <span className="run-meta" role="status">执行活动读取失败。<button type="button" onClick={() => void query.refetch()}>重试</button></span>
      </div>
    );
  }
  // Resolved with nothing displayable: keep the entry as an honest empty
  // transcript instead of dropping the panel outright.
  return query.data
    ? (
      <div className="message-turn-activity">
        {transcript}
        {incomplete}
      </div>
    )
    : null;
}

/**
 * Single-run inspector: one run context header + one tab body at a time.
 * Tabs are view-only Git grouping; each tab's queries stay mounted only while
 * selected, so opening the pane does not eagerly fetch unrelated projections.
 * Evidence is intentionally rendered by its own top-level panel.
 */
/**
 * Git overview stays a floating panel. It is intentionally a directory/repo
 * index, not a second diff viewer: details only open after the user chooses a
 * specific directory's changes.
 */
function GitOverviewPanel(props: {
  projects: ProjectLike[];
  runs: RunLike[];
  selectedRunId: string | null;
  /** Resolves a run to the registered project alias it belongs to; a run in an
   * isolated worktree reports the worktree's own alias, not the project's. */
  runProjectAlias: (run: RunLike) => string | null;
  onOpenChanges: (project: ProjectLike, run: RunLike) => void;
}): React.JSX.Element {
  const statusLabel = (project: ProjectLike): string => {
    if (!project.vcsKind || project.vcsKind.toUpperCase() === 'NONE') return '非 Git 目录';
    const dirty = project.dirtySummary?.trim();
    if (!dirty) return '状态未知';
    if (dirty.toUpperCase() === 'CLEAN') return '干净';
    return dirty;
  };
  const runsFor = (project: ProjectLike): RunLike[] => props.runs.filter((run) => props.runProjectAlias(run) === project.workspaceAlias);
  return (
    <section className="git-overview-panel" data-testid="git-overview-panel" aria-label="Git 目录概览">
      <header className="git-overview-header">
        <div><span className="eyebrow">仓库</span><h3>目录状态</h3><p>按目录查看分支、提交和变更；选择具体目录后再打开详细 diff。</p></div>
      </header>
      <div className="git-directory-list">
        {props.projects.map((project) => {
          const projectRuns = runsFor(project);
          const selectedRun = props.runs.find((candidate) => candidate.runId === props.selectedRunId);
          const run = projectRuns.find((candidate) => candidate.runId === props.selectedRunId) ?? projectRuns[0];
          const isGit = Boolean(project.vcsKind && project.vcsKind.toUpperCase() !== 'NONE');
          return (
            <details key={project.projectId} className="git-directory-card" open={selectedRun ? props.runProjectAlias(selectedRun) === project.workspaceAlias : project.workspaceAlias === props.projects[0]?.workspaceAlias}>
              <summary className="git-directory-summary">
                <span className="git-directory-chevron" aria-hidden="true">▸</span>
                <Icon name="folder" size={14} />
                <span className="git-directory-title"><strong>{project.displayName ?? project.workspaceAlias}</strong><code>{project.workspaceAlias}</code></span>
                <span className={`git-directory-status ${statusLabel(project) === '干净' ? 'is-clean' : ''}`}>{statusLabel(project)}</span>
              </summary>
              <div className="git-directory-body">
                <dl className="git-directory-facts">
                  <div><dt>版本控制</dt><dd>{isGit ? project.vcsKind ?? 'GIT' : '—'}</dd></div>
                  <div><dt>分支</dt><dd><code>{project.branchDisplay ?? '—'}</code></dd></div>
                  <div><dt>HEAD</dt><dd><code>{project.headShortRevision ?? '—'}</code></dd></div>
                </dl>
                <div className="git-directory-actions">
                  {run ? <span className="git-directory-run">最近 Run · {run.changedFileCount !== undefined ? `${run.changedFileCount} 个变更文件` : run.runId.slice(0, 8)}</span> : <span className="git-directory-run">暂无可查看的 Run 变更</span>}
                  <button type="button" className="git-directory-changes" onClick={() => { if (run) props.onOpenChanges(project, run); }} disabled={!run}>
                    查看变更
                  </button>
                </div>
              </div>
            </details>
          );
        })}
        {props.projects.length === 0 ? <p className="git-overview-empty">暂无已注册目录。</p> : null}
      </div>
    </section>
  );
}

/** Full-page Git workbench. The changes view owns the large diff layout;
 * Worktree remains a sibling Git tab instead of another right-side pane. */
function GitWorkspacePage(props: {
  runId: string | null;
  activeTab: GitTab;
  onTabChange: (tab: GitTab) => void;
  stateLabel: string;
  stateTone: string;
  workspaceAlias: string | null;
  deliveryId?: string | null;
  deliveries?: React.ReactNode;
  diff: React.ReactNode;
  workspace: React.ReactNode;
  onBack: () => void;
  onOpenEvidence: () => void;
}): React.JSX.Element {
  const conflicts = useRunWorkspaceConflicts(props.runId);
  // Design 2026-09-30 §6.1: the 变更 tab count only reads the shared diff
  // cache (enabled: false never fetches); it appears once the page data
  // has been loaded by the changes surface itself.
  const cachedDiff = useQuery<DiffPageLike | null>({
    queryKey: ['diff', props.runId, 0, DIFF_PAGE_SIZE],
    enabled: false,
    queryFn: () => null
  });
  const diffFileCount = cachedDiff.data?.files?.length ?? null;
  const tabs: Array<{ id: GitTab; label: string }> = [
    { id: 'DIFF', label: `变更${diffFileCount != null ? ` (${diffFileCount}${cachedDiff.data?.hasMore ? '+' : ''})` : ''}` },
    { id: 'WORKSPACE', label: 'Worktree' }
  ];
  return (
    <section className="git-surface-page" data-testid="git-surface">
      <header className="git-surface-header">
        <div className="git-surface-title">
          <span className="eyebrow">Git</span>
          <h1>{props.workspaceAlias || '未选择项目'}</h1>
          <p className="git-run-context" data-testid="run-context"><StatusBadge tone={badgeTone(props.stateTone)} label={props.stateLabel} /><code className="run-context-id">{props.runId ? `run ${props.runId.slice(0, 8)}` : '未选择 Run'}</code></p>
        </div>
        <div className="git-surface-actions">
          <button type="button" className="secondary-button" onClick={props.onOpenEvidence} disabled={!props.runId}><Icon name="shield" size={14} />证据</button>
          <button type="button" className="secondary-button" onClick={props.onBack}>返回会话</button>
        </div>
      </header>
      <div className="git-surface-tabs" role="tablist" aria-label="Git 页面">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={props.activeTab === tab.id} className={`git-surface-tab${props.activeTab === tab.id ? ' selected' : ''}`} data-testid={`git-surface-tab-${tab.id.toLowerCase()}`} onClick={() => props.onTabChange(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>
      {props.runId ? <WorkspaceConflictPanel runId={props.runId} query={conflicts} /> : null}
      {/* WU-03 设计 §6.7: DeliveryReviewCard 挂载在 Changes 侧栏，
          不再顶部常驻；仅在存在 delivery 时渲染。 */}
      {props.deliveryId ? <DeliveryReviewCard deliveryId={props.deliveryId} /> : null}
      {props.deliveries}
      <div className="git-surface-content">
        {props.runId ? (props.activeTab === 'DIFF' ? props.diff : props.workspace) : <div className="git-page-empty"><h2>选择一个 Run</h2><p>从左侧 Activity 或会话中的 Git 入口打开变更。</p></div>}
      </div>
    </section>
  );
}

/** Project delivery history (deliveries/list): read-only index; each row
 * expands to the full review card so decisions still go through the card's
 * fingerprint-guarded mutations. */
function ProjectDeliveriesSection(props: { projectId: string }): React.JSX.Element {
  const deliveries = useQuery({
    queryKey: ['deliveries', props.projectId],
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.listProjectDeliveries(props.projectId, { limit: 20 })) as { items?: DeliveryReviewLike[]; nextCursor?: string | null }
  });
  const items = deliveries.data?.items ?? [];
  return (
    <section className="ew6-panel" data-testid="delivery-history">
      <h3>交付记录<span className="run-meta">{items.length > 0 ? ` ${items.length}` : ''}</span></h3>
      {deliveries.isError ? <p className="error-text" role="alert">交付记录读取失败。</p> : null}
      {items.length === 0 && !deliveries.isPending ? <p className="empty">该项目暂无交付记录。</p> : null}
      {items.map((item) => (
        <details key={item.deliveryId} className="delivery-history-item" data-testid="delivery-history-item">
          <summary>
            <code>{item.deliveryId.slice(0, 8)}</code>
            <span className="delivery-review-state">{item.state ?? 'UNKNOWN'}</span>
            {item.updatedAt ? <span className="run-meta">{item.updatedAt}</span> : null}
          </summary>
          <DeliveryReviewCard deliveryId={item.deliveryId} />
        </details>
      ))}
    </section>
  );
}

/** Lane lifecycle for the lane a session workspace is bound to: read state
 * via get; reopen returns ownership to this session+run. Release needs the
 * active lease (leaseId/fencingToken) which lane detail does not return —
 * it is intentionally not offered rather than guessed. */
function WorkspaceLaneSection(props: { laneId: string; sessionId: string; runId: string | null }): React.JSX.Element {
  const [actionError, setActionError] = useState<string | null>(null);
  const lane = useQuery({
    queryKey: ['workspace-lane', props.laneId],
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getWorkspaceLane(props.laneId)) as {
      workspaceLaneId: string;
      state?: string;
      mode?: string | null;
      integrationState?: string | null;
      baseRevision?: string | null;
      stateVersion?: number;
      attentionReason?: string | null;
    }
  });
  const reopenM = useMutation({
    mutationFn: async () => unwrap(await window.codeAgentDesktop.reopenWorkspaceLane(props.laneId, {
      sessionId: props.sessionId,
      runId: props.runId ?? '',
      expectedStateVersion: lane.data?.stateVersion ?? null
    })),
    onSuccess: () => { setActionError(null); void lane.refetch(); },
    onError: (error) => setActionError(error instanceof Error ? error.message : String(error))
  });
  const data = lane.data;
  return (
    <section className="ew6-panel lane-section" data-testid="workspace-lane-section">
      <h3>Workspace Lane<code className="run-meta"> {props.laneId.slice(0, 8)}</code></h3>
      {lane.isPending ? <p className="empty">正在读取 lane 状态…</p> : null}
      {lane.isError ? <p className="error-text" role="alert">lane 详情读取失败。<button type="button" onClick={() => void lane.refetch()}>重试</button></p> : null}
      {data ? (
        <dl className="lane-facts">
          <dt>状态</dt><dd>{data.state ?? '—'}</dd>
          <dt>模式</dt><dd>{data.mode ?? '—'}</dd>
          <dt>集成</dt><dd>{data.integrationState ?? '—'}</dd>
          <dt>基线</dt><dd>{data.baseRevision ?? '—'}</dd>
          {data.attentionReason ? <><dt>注意</dt><dd>{data.attentionReason}</dd></> : null}
        </dl>
      ) : null}
      <div className="lane-actions">
        <button type="button" className="secondary-button" data-testid="lane-reopen"
          disabled={!props.runId || !data || reopenM.isPending}
          title={!props.runId ? '需要关联运行记录' : '将 lane 重新绑定到当前会话与运行'}
          onClick={() => reopenM.mutate()}>重新打开</button>
        <button type="button" className="secondary-button" data-testid="lane-release" disabled
          title="释放需要活跃租约（leaseId/fencingToken）；lane 详情未返回租约，无法从本面板释放">释放</button>
      </div>
      {actionError ? <span className="delivery-review-error" role="alert">{actionError}</span> : null}
    </section>
  );
}

function WorkspaceConflictPanel(props: {
  runId: string;
  query: ReturnType<typeof useRunWorkspaceConflicts>;
}): React.JSX.Element | null {
  const items = (props.query.data as { items?: WorkspaceConflictLike[] } | undefined)?.items ?? [];
  if (props.query.isLoading && items.length === 0) {
    return <div className="workspace-conflicts" data-testid="workspace-conflicts"><span className="run-meta">正在读取文件冲突…</span></div>;
  }
  if (props.query.isError) {
    return <div className="workspace-conflicts" data-testid="workspace-conflicts"><span className="run-meta">文件冲突读取失败。<button type="button" onClick={() => void props.query.refetch()}>重试</button></span></div>;
  }
  return <WorkspaceConflictSurface runId={props.runId} items={items} />;
}

/** §6.7 会话入口：一行摘要 + 解决冲突；仅在有 OPEN 冲突时渲染。 */
function WorkspaceConflictEntry(props: {
  runId: string | null | undefined;
  onOpen: () => void;
}): React.JSX.Element | null {
  const query = useRunWorkspaceConflicts(props.runId ?? null);
  const items = (query.data as { items?: WorkspaceConflictLike[] } | undefined)?.items ?? [];
  const openCount = items.filter((item) =>
    item.state === 'OPEN' || item.state === 'RESOLVING' || item.state === 'STALE').length;
  if (!props.runId || openCount === 0) return null;
  return (
    <button type="button" className="workspace-conflict-entry"
      data-testid="conversation-conflict-entry" onClick={props.onOpen}>
      <span>{openCount} 个文件存在冲突</span>
      <span className="workspace-conflict-entry-action">解决冲突</span>
    </button>
  );
}

function SessionWorkspaceBindingNotice(props: { binding: WorkspaceBindingLike; deliveryStatus?: string | null }): React.JSX.Element {
  const binding = props.binding;
  const deliveryUncertain = props.deliveryStatus === 'UNKNOWN' || props.deliveryStatus === 'NEEDS_ATTENTION';
  const uncertain = binding.state === 'UNKNOWN' || binding.state === 'NEEDS_ATTENTION' || deliveryUncertain;
  return (
    <div className={`session-binding-notice ${uncertain ? 'is-uncertain' : ''}`} data-testid="session-workspace-binding" role={uncertain ? 'status' : undefined}>
      <span className="session-binding-label">工作区通道</span>
      <span className="session-binding-value">{binding.mode ?? 'UNKNOWN'} · {binding.state ?? 'UNKNOWN'}</span>
      {binding.baseRevision ? <span className="session-binding-meta">base {binding.baseRevision}{binding.baseSource ? ` · ${binding.baseSource}` : ''}</span> : null}
      {binding.latestDeliveryId ? <span className="session-binding-meta">delivery {binding.latestDeliveryId}</span> : null}
      {props.deliveryStatus ? <span className="session-binding-meta">delivery state {props.deliveryStatus}</span> : null}
      {uncertain ? <span className="session-binding-warning">状态需 Service 对账；未确认前不会自动重试。</span> : null}
    </div>
  );
}

export function Workbench(props: { capabilities?: DesktopCapabilities; protocolVersion?: string | null; initialBanner?: string | null; personalGateway?: boolean; serviceDegraded?: boolean } = {}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<{ sessionId: string; generation: number } | null>(null);
  // ECN-001: native (Pi/Codex) conversation selection shares the same
  // workspace slot; it never mixes with an ACS selection.
  const [nativeSelection, setNativeSelection] = useState<{ taskId: string; generation: number } | null>(null);
  const nativeSelectionRef = useRef<{ taskId: string; generation: number } | null>(null);
  const [newConversationSource, setNewConversationSource] = useState<'ACS' | 'NATIVE'>('ACS');
  const personalChannelAvailable = Boolean(props.personalGateway)
    && typeof window.codeAgentDesktop?.personalOperation === 'function';
  const collaborationAvailable = typeof (window.codeAgentDesktop as { collaboration?: unknown } | undefined)?.collaboration === 'function';
  const nativeTasks = useNativeTaskIndex(personalChannelAvailable);
  const persistedWorkbenchStateRef = useRef<PersistedWorkbenchState>(readPersistedWorkbenchState());
  const startupRecoveryDoneRef = useRef(false);
  const [composer, setComposer] = useState('');
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const [banner, setBanner] = useState<string | null>(props.initialBanner ?? null);
  const [visibleOutputs, setVisibleOutputs] = useState<Map<string, VisibleOutputState>>(new Map());
  // Durable output can arrive in much smaller chunks than a browser frame.
  // Keep the reducer authoritative, but publish its projection at most once
  // per frame so Markdown parsing, layout and auto-follow move together.
  const visibleOutputProjectionRef = useRef<Map<string, VisibleOutputState>>(new Map());
  const visibleOutputFlushRef = useRef<{ id: number; raf: boolean } | null>(null);
  // Reasoning shares the same publish-once-per-frame discipline as output;
  // unlike output its fold survives run.terminal so it can stay visible
  // next to the finished answer.
  const [visibleReasonings, setVisibleReasonings] = useState<Map<string, VisibleReasoningState>>(new Map());
  const visibleReasoningProjectionRef = useRef<Map<string, VisibleReasoningState>>(new Map());
  const visibleReasoningFlushRef = useRef<{ id: number; raf: boolean } | null>(null);
  const [lastActivityObservedAt, setLastActivityObservedAt] = useState<Map<string, number>>(new Map());
  // Run activity projection (design 2026-09-02 §11.2): snapshot + live merge,
  // keyed by runId; always rebuildable from the service journal.
  const [liveActivities, setLiveActivities] = useState<LiveActivityProjection>(new Map());
  const [newSessionGoal, setNewSessionGoal] = useState('');
  const [specDraftGoal, setSpecDraftGoal] = useState('');
  const [specId, setSpecId] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const attachmentOrderRef = useRef(0);
  // 长输入设计 §6.2/§6.7：草稿代际隔离 —— 异步附件回调只写入同代草稿，
  // 切换会话/清空草稿后旧回调不得污染新草稿；发送意图冻结正文/附件/key。
  const draftGenerationRef = useRef(0);
  const bumpDraftGeneration = useCallback(() => {
    draftGenerationRef.current += 1;
    attachmentOrderRef.current = 0;
    return draftGenerationRef.current;
  }, []);
  interface FrozenSendIntent {
    generation: number;
    content: string;
    attachments: AttachmentWire[];
    createKey: string;
    messageKey: string;
    sessionId: string | null;
  }
  const [newSessionIntent, setNewSessionIntent] = useState<FrozenSendIntent | null>(null);
  const [composerIntent, setComposerIntent] = useState<FrozenSendIntent | null>(null);
  // Ordinary chat waits inside the model gateway and therefore has no Run
  // identity or intermediate event to render. Keep a local, presentation-only
  // turn so the selected conversation responds immediately while durable
  // history remains the authority.
  const [pendingTurns, setPendingTurns] = useState<PendingConversationTurn[]>([]);
  const [newSessionStartedAt, setNewSessionStartedAt] = useState<number | null>(null);
  const [sendingSessionIds, setSendingSessionIds] = useState<Set<string>>(() => new Set());
  const selectionRef = useRef<{ sessionId: string; generation: number } | null>(null);
  const newSessionFlowIdRef = useRef(0);
  const pendingMessageKeyRef = useRef(new Map<string, string>());
  /** WU07: the composer's current extension selection — frozen per send. */
  const extensionSelectionRef = useRef<ExtensionSelection | null>(null);
  const extensionSelection = useExtensionSelection(true, (value) => { extensionSelectionRef.current = value.selection; });
  const sendingSessionIdsRef = useRef(new Set<string>());
  const composerIntentRef = useRef<FrozenSendIntent | null>(null);
  composerIntentRef.current = composerIntent;
  // EW10.2 read-only external sources; content is untrusted data (design §10.9)
  const [sourceType, setSourceType] = useState<'WEB' | 'ISSUE' | 'DOCS'>('WEB');
  const [sourceUri, setSourceUri] = useState('');
  const [fetchedSources, setFetchedSources] = useState<SourceFetchLike[]>([]);
  const [sourceDisabled, setSourceDisabled] = useState(() => props.capabilities ? !props.capabilities.features.readOnlySources : false);
  // EW6 inspection target
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedFileRef, setSelectedFileRef] = useState<string | null>(null);
  const [selectedFileLine, setSelectedFileLine] = useState<number | null>(null);
  const [selectedFileProjectId, setSelectedFileProjectId] = useState<string | null>(null);
  // View state only. Authority state remains in React Query / Java Service.
  const [activeSurface, setActiveSurface] = useState<ActiveSurface>('WORKSPACE');
  const [showArchived, setShowArchived] = useState(false);
  const [sessionRailCollapsed, setSessionRailCollapsed] = useState(false);
  const [sidebarNavigation, setSidebarNavigation] = useState<SidebarNavigationState>(readSidebarNavigationState);
  const [activePaneBySession, setActivePaneBySession] = useState<Record<string, PaneType | null>>({});
  const [standalonePane, setStandalonePane] = useState<PaneType | null>(null);
  const [activityPanelOpen, setActivityPanelOpen] = useState(false);
  const [buildPlanOpen, setBuildPlanOpen] = useState(false);
  const [workPaneDocked, setWorkPaneDocked] = useState(false);
  // The side-channel (旁路讨论) toggle lives in the conversation header; the
  // panel tracks which session it was opened for so a session switch closes
  // it without a dedicated effect.
  const [collaborationOpenSession, setCollaborationOpenSession] = useState<string | null>(null);
  const [paneWidth, setPaneWidth] = useState(560);
  const [railMenuOpen, setRailMenuOpen] = useState(false);
  const [activityTrayExpanded, setActivityTrayExpanded] = useState(false);
  const sessionWorkspaceRef = useRef<HTMLElement | null>(null);
  const startPaneResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const workspace = sessionWorkspaceRef.current;
    if (!workspace) return;
    const right = workspace.getBoundingClientRect().right;
    const maxWidth = Math.max(360, workspace.clientWidth - 160);
    const onMove = (moveEvent: PointerEvent) => {
      setPaneWidth(Math.min(maxWidth, Math.max(360, Math.round(right - moveEvent.clientX))));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);
  // Last-selected Git tab per runId. Evidence is a separate panel and does
  // not participate in this tab state.
  const [gitTabByRun, setGitTabByRun] = useState<Record<string, GitTab>>({});
  const [directoryPanelOpen, setDirectoryPanelOpen] = useState(false);
  const [approvalSettingsOpen, setApprovalSettingsOpen] = useState(false);
  const [exportPanelOpen, setExportPanelOpen] = useState(false);
  const [approvalReminderOpen, setApprovalReminderOpen] = useState(false);
  const [approvalReminderRunId, setApprovalReminderRunId] = useState<string | null>(null);
  const [approvalSyncingRunIds, setApprovalSyncingRunIds] = useState<Set<string>>(() => new Set());
  // runId → the request identity ('fp:<fingerprint>' or 'id:<approvalId>')
  // whose decision the Service already accepted. The card for that exact
  // request closes immediately; a different pending request on the same run
  // still renders and decides normally.
  const decidedApprovalMarks = useRef(new Map<string, string>());
  // Legacy routes keep their state shape for backwards-compatible deep links;
  // neither surface is rendered by the new shell.
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Per-session row actions: the popover is rendered fixed at the rail item
  // (the rail scrolls, so an absolute popover inside the row would clip).
  const [sessionMenu, setSessionMenu] = useState<{ sessionId: string; top: number; right: number } | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [specReviseOpen, setSpecReviseOpen] = useState(false);
  const [specReviseGoal, setSpecReviseGoal] = useState('');
  // Density is persisted as a desktop preference (SET-2); the memory value
  // only covers the window before the preference query resolves.
  const [density, setDensity] = useState<'SUMMARY' | 'STANDARD' | 'DETAILED'>('STANDARD');
  const [selectedWorkspaceAlias, setSelectedWorkspaceAlias] = useState<string | null>(null);
  const [newSessionAgentProfileId, setNewSessionAgentProfileId] = useState('default');
  const [newSessionReadonlyResearchMode, setNewSessionReadonlyResearchMode] = useState<'AUTO' | 'OFF'>('OFF');
  const [newSessionModelAlias, setNewSessionModelAlias] = useState<string | null>(null);
  const [newSessionModelTouched, setNewSessionModelTouched] = useState(false);
  const [composerModelAlias, setComposerModelAlias] = useState<string | null>(null);
  const [composerReasoningMode, setComposerReasoningMode] = useState<'DEFAULT' | 'OFF' | 'EFFORT'>('DEFAULT');
  const [composerReasoningOptionId, setComposerReasoningOptionId] = useState<string | null>(null);
  const [composerContextMode, setComposerContextMode] = useState<'AUTO' | 'PRESET'>('AUTO');
  const [composerContextPresetId, setComposerContextPresetId] = useState<string | null>(null);
  const runStartedAtRef = useRef(new Map<string, number>());
  const [stopRequestedRunIds, setStopRequestedRunIds] = useState<Set<string>>(() => new Set());
  const stopRequestedRunIdsRef = useRef(new Set<string>());

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_NAVIGATION_STORAGE_KEY, JSON.stringify(sidebarNavigation));
    } catch {
      // Sidebar preferences are best-effort and must not affect the workbench.
    }
  }, [sidebarNavigation]);

  const projects = useProjects();
  // A workspace-backed implementation must carry the Service-owned write
  // scope returned by project preflight.  An empty scope is an intentional
  // read-only contract, so never create one accidentally while the preflight
  // request is still pending.
  const newSessionProjectId = projects.data?.find((project) => project.workspaceAlias === selectedWorkspaceAlias)?.projectId
    ?? selectedWorkspaceAlias;
  const newSessionPreflight = useProjectSessionPreflight(
    newSessionProjectId,
    Boolean(selectedWorkspaceAlias)
  );
  const modelCatalog = useModelCatalog(Boolean(props.capabilities));
  const agentProfiles = useAgentProfiles(Boolean(props.capabilities));
  const selectedAgentProfile = useMemo(
    () => (agentProfiles.data?.profiles ?? []).find((profile) => profile.id === newSessionAgentProfileId)
      ?? (agentProfiles.data?.profiles ?? []).find((profile) => profile.id === 'default'),
    [agentProfiles.data?.profiles, newSessionAgentProfileId]
  );
  const patchSessionModel = usePatchSessionModel();
  // 2026-09-05 design HP-5: dual-channel history reads; the legacy array
  // and detail routes stay the default until the service capability
  // advertises the paginated contract.
  const historySessions = useHistorySessions(props.capabilities);
  // Mission plan/replan approvals are rendered in the approval floating panel.
  // Keep the query keyed by session so a fast session switch cannot leak a card.
  const missions = useMissions(selection?.sessionId ?? null);

  const handleFrame = useCallback((frame: { cursor: number; type: string; payload: unknown }) => {
    const previousProjection = visibleOutputProjectionRef.current;
    const nextProjection = reduceVisibleOutput(previousProjection, frame);
    if (nextProjection !== previousProjection) {
      visibleOutputProjectionRef.current = nextProjection;
      if (visibleOutputFlushRef.current === null) {
        const publish = (): void => {
          visibleOutputFlushRef.current = null;
          setVisibleOutputs(visibleOutputProjectionRef.current);
        };
        if (typeof window.requestAnimationFrame === 'function') {
          visibleOutputFlushRef.current = { id: window.requestAnimationFrame(publish), raf: true };
        } else {
          visibleOutputFlushRef.current = { id: window.setTimeout(publish, 32), raf: false };
        }
      }
    }
    const previousReasoning = visibleReasoningProjectionRef.current;
    const nextReasoning = reduceVisibleReasoning(previousReasoning, frame);
    if (nextReasoning !== previousReasoning) {
      visibleReasoningProjectionRef.current = nextReasoning;
      if (visibleReasoningFlushRef.current === null) {
        const publish = (): void => {
          visibleReasoningFlushRef.current = null;
          setVisibleReasonings(visibleReasoningProjectionRef.current);
        };
        if (typeof window.requestAnimationFrame === 'function') {
          visibleReasoningFlushRef.current = { id: window.requestAnimationFrame(publish), raf: true };
        } else {
          visibleReasoningFlushRef.current = { id: window.setTimeout(publish, 32), raf: false };
        }
      }
    }
    setLiveActivities((previous) => reduceRunActivities(previous, frame));
    if (frame.type === 'tool.started' || frame.type === 'tool.completed' || frame.type === 'tool.failed'
        || frame.type === 'sandbox.command.started' || frame.type === 'sandbox.command.finished'
        || frame.type.startsWith('run.subagent.')) {
      const payload = frame.payload as { runId?: unknown } | null;
      if (payload && typeof payload.runId === 'string') {
        setLastActivityObservedAt((previous) => {
          const next = new Map(previous);
          next.set(payload.runId as string, Date.now());
          return next;
        });
      }
    }
  }, []);
  useEffect(() => () => {
    const pending = visibleOutputFlushRef.current;
    if (pending !== null) {
      if (pending.raf && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(pending.id);
      else window.clearTimeout(pending.id);
      visibleOutputFlushRef.current = null;
    }
    const pendingReasoning = visibleReasoningFlushRef.current;
    if (pendingReasoning !== null) {
      if (pendingReasoning.raf && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(pendingReasoning.id);
      else window.clearTimeout(pendingReasoning.id);
      visibleReasoningFlushRef.current = null;
    }
  }, []);
  const [resyncing, setResyncing] = useState(false);
  const onResync = useCallback(() => {
    setResyncing(true);
    setBanner('事件流已过期，正在重新同步权威快照…');
  }, []);

  const connection = useDurableEvents(onResync, handleFrame);
  const pollFallback = connection !== 'CONNECTED';
  const historyDetail = useHistorySessionDetail(selection?.sessionId ?? null, props.capabilities, { poll: pollFallback });
  const runs = useRuns({}, { poll: pollFallback });
  const attention = useAttention();
  const executionPolicyProjectId = projects.data?.find((project) => project.workspaceAlias === historyDetail.session?.workspaceAlias)?.projectId ?? null;
  const executionPolicy = useExecutionPolicy(selection?.sessionId ?? null, executionPolicyProjectId);
  const automationControl = useAutomationControl(selection?.sessionId ?? null);
  const unifiedApprovals = useSessionApprovals(selection?.sessionId ?? null, true, pollFallback);

  // Desktop-owned appearance preferences (Main store, offline-safe). The
  // Appearance page streams draft previews through appearancePreview; null
  // re-adopts the persisted values.
  const preferencesQuery = useDesktopPreferences();
  const [appearancePreview, setAppearancePreview] = useState<ReturnType<typeof appearanceFromPreferences>>(null);
  const [settingsRouteRequest, setSettingsRouteRequest] = useState<{ route: SettingsRoute; nonce: number } | null>(null);
  const openSettingsRoute = useCallback((route: SettingsRoute) => {
    setSettingsRouteRequest((current) => ({ route, nonce: (current?.nonce ?? 0) + 1 }));
    setActiveSurface('SETTINGS');
  }, []);
  const appearance = appearancePreview ?? appearanceFromPreferences(preferencesQuery.data);
  const systemPrefersLight = useMediaQuery('(prefers-color-scheme: light)');
  const systemPrefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const resolvedTheme = appearance?.theme === 'LIGHT' || ((appearance?.theme ?? 'SYSTEM') === 'SYSTEM' && systemPrefersLight) ? 'light' : 'dark';
  const reduceMotionPref = appearance?.reduceMotion ?? 'SYSTEM';
  const resolvedReduceMotion = reduceMotionPref === 'ON' || (reduceMotionPref === 'SYSTEM' && systemPrefersReducedMotion) ? 'REDUCE' : 'NORMAL';
  const sendShortcut = preferencesQuery.data?.sendShortcut ?? 'ENTER';

  // A completed resync must not leave a stale warning on screen; only the
  // resync banner clears itself here, user-facing error banners stay.
  useEffect(() => {
    if (connection === 'CONNECTED' && resyncing) {
      setResyncing(false);
      setBanner((current) => (current === '事件流已过期，正在重新同步权威快照…' ? null : current));
    }
  }, [connection, resyncing]);

  function selectSession(sessionId: string): void {
    // A user click is authoritative; startup recovery must not remount the
    // conversation after the user has already chosen a session.
    startupRecoveryDoneRef.current = true;
    if (selectionRef.current?.sessionId === sessionId) {
      setActiveSurface('WORKSPACE');
      return;
    }
    const nextSelection = {
      sessionId,
      generation: (selectionRef.current?.generation ?? 0) + 1
    };
    selectionRef.current = nextSelection;
    setSelection(nextSelection);
    nativeSelectionRef.current = null;
    setNativeSelection(null);
    setActiveSurface('WORKSPACE');
    setSelectedFileRef(null);
    setSelectedRunId(null);
    setSpecId(null);
    setSpecDraftGoal('');
    setFetchedSources([]);
    setSourceUri('');
    setDirectoryPanelOpen(false);
    setApprovalSettingsOpen(false);
    setActivityPanelOpen(false);
    // 长输入设计 §6.2：切换会话换代 —— 旧附件回调/发送意图不得写入新会话草稿。
    bumpDraftGeneration();
    setPendingAttachments([]);
    setComposer('');
    composerIntentRef.current = null;
    setComposerIntent(null);
    setNewSessionStartedAt(null);
  }

  function startNewSession(): void {
    startupRecoveryDoneRef.current = true;
    newSessionFlowIdRef.current += 1;
    selectionRef.current = null;
    setSelection(null);
    nativeSelectionRef.current = null;
    setNativeSelection(null);
    setActiveSurface('WORKSPACE');
    setSelectedFileRef(null);
    setSelectedRunId(null);
    setSpecId(null);
    setSpecDraftGoal('');
    setFetchedSources([]);
    setSourceUri('');
    setDirectoryPanelOpen(false);
    setApprovalSettingsOpen(false);
    setApprovalReminderOpen(false);
    setApprovalReminderRunId(null);
    setActivityPanelOpen(false);
    bumpDraftGeneration();
    setPendingAttachments([]);
    setComposer('');
    composerIntentRef.current = null;
    setComposerIntent(null);
    setNewSessionIntent(null);
    setNewSessionGoal('');
    setSelectedWorkspaceAlias(null);
    setNewSessionAgentProfileId('default');
    setNewSessionReadonlyResearchMode('OFF');
    setNewSessionModelAlias(null);
    setNewSessionModelTouched(false);
    setNewSessionStartedAt(null);
  }

  /** ECN-001: selecting a native conversation replaces the ACS selection and
   * remounts the workspace slot via generation, mirroring selectSession. */
  function selectNativeTask(taskId: string): void {
    startupRecoveryDoneRef.current = true;
    if (nativeSelectionRef.current?.taskId === taskId) {
      setActiveSurface('WORKSPACE');
      return;
    }
    const nextSelection = {
      taskId,
      generation: (nativeSelectionRef.current?.generation ?? 0) + 1
    };
    nativeSelectionRef.current = nextSelection;
    setNativeSelection(nextSelection);
    selectionRef.current = null;
    setSelection(null);
    setActiveSurface('WORKSPACE');
    setSelectedFileRef(null);
    setSelectedRunId(null);
    setSpecId(null);
    setSpecDraftGoal('');
    setFetchedSources([]);
    setSourceUri('');
    setDirectoryPanelOpen(false);
    setApprovalSettingsOpen(false);
    setActivityPanelOpen(false);
    bumpDraftGeneration();
    setPendingAttachments([]);
    setComposer('');
    composerIntentRef.current = null;
    setComposerIntent(null);
    setNewSessionStartedAt(null);
  }

  function startNewSessionForWorkspace(workspaceAlias: string | null): void {
    startNewSession();
    setSelectedWorkspaceAlias(workspaceAlias);
  }

  const selectedPane = selection ? activePaneBySession[selection.sessionId] ?? null : standalonePane;
  const openPane = useCallback((pane: PaneType | null, gitTab?: GitTab, runIdOverride?: string | null) => {
    const targetRunId = runIdOverride ?? selectedRunId;
    // Evidence is an independent workspace panel. If Git is currently the
    // main surface, return to the session surface before opening it.
    if (pane === 'EVIDENCE') setActiveSurface('WORKSPACE');
    if (pane) {
      setActivityPanelOpen(false);
      setCollaborationOpenSession(null);
    }
    if (gitTab && targetRunId) {
      // Opening intent only sets the initial tab; a stored user choice wins.
      setGitTabByRun((current) => (current[targetRunId] ? current : { ...current, [targetRunId]: gitTab }));
    }
    if (!selection) {
      setStandalonePane(pane);
      return;
    }
    setActivePaneBySession((current) => ({ ...current, [selection.sessionId]: pane }));
  }, [selection, selectedRunId]);

  const openGitOverview = useCallback((runIdOverride?: string | null) => {
    const targetRunId = runIdOverride ?? selectedRunId;
    if (targetRunId) setSelectedRunId(targetRunId);
    setActivityPanelOpen(false);
    setActiveSurface('WORKSPACE');
    openPane('GIT', undefined, targetRunId);
  }, [openPane, selectedRunId]);

  const openGitSurface = useCallback((runIdOverride?: string | null, gitTab: GitTab = 'DIFF') => {
    const targetRunId = runIdOverride ?? selectedRunId;
    if (targetRunId) {
      setSelectedRunId(targetRunId);
      setGitTabByRun((current) => current[targetRunId] ? current : { ...current, [targetRunId]: gitTab });
    }
    setActivityPanelOpen(false);
    openPane(null);
    setActiveSurface('GIT');
  }, [openPane, selectedRunId]);

  // Lively approvals: the service exposes no entered-waiting timestamp, so
  // the waiting timer measures "since the renderer first saw this run
  // waiting". A 5s ticker re-renders the label; runs that leave waiting
  // are forgotten so a later wait restarts the clock.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);
  void nowTick;
  const firstSeenWaitingRef = useRef(new Map<string, number>());
  useEffect(() => {
    const seen = firstSeenWaitingRef.current;
    const active = new Set(
      (runs.data ?? [])
        .filter(isApprovalWaiting)
        .map((r) => r.runId)
    );
    for (const id of active) if (!seen.has(id)) seen.set(id, Date.now());
    for (const id of [...seen.keys()]) if (!active.has(id)) seen.delete(id);
  }, [runs.data]);
  function waitingSeconds(runId: string): number {
    const first = firstSeenWaitingRef.current.get(runId) ?? Date.now();
    return Math.max(0, Math.floor((Date.now() - first) / 1000));
  }
  // Newest arrival plays the enter animation once; the id clears after 1.2s
  // so re-renders (ticker, polls) never replay it.
  const [freshApprovalRunId, setFreshApprovalRunId] = useState<string | null>(null);
  const knownWaitingRef = useRef(new Set<string>());
  const knownExpiredRef = useRef(new Set<string>());
  const pingedWaitingRef = useRef(new Set<string>());
  // Browsers block audio before any user gesture; track it once so the
  // approval chime never throws or silently fails on autoplay policy.
  const userGesturedRef = useRef(false);
  useEffect(() => {
    const mark = (): void => { userGesturedRef.current = true; };
    window.addEventListener('pointerdown', mark, { once: true });
    window.addEventListener('keydown', mark, { once: true });
    return () => {
      window.removeEventListener('pointerdown', mark);
      window.removeEventListener('keydown', mark);
    };
  }, []);
  const notificationsMuted = preferencesQuery.data?.notificationsEnabled === false;
  useEffect(() => {
    const active = new Set(
      (runs.data ?? [])
        .filter(isApprovalWaiting)
        .map((r) => r.runId)
    );
    const expired = (runs.data ?? []).filter(isAuthorizationExpiredRun);
    setApprovalSyncingRunIds((current) => {
      const next = new Set([...current].filter((id) => active.has(id)));
      if (next.size === current.size) return current;
      for (const id of current) if (!next.has(id)) decidedApprovalMarks.current.delete(id);
      return next;
    });
    for (const id of active) {
      if (!knownWaitingRef.current.has(id)) {
        knownWaitingRef.current.add(id);
        setFreshApprovalRunId(id);
        setApprovalReminderRunId(id);
        setApprovalReminderOpen(true);
        window.setTimeout(() => {
          setFreshApprovalRunId((current) => (current === id ? null : current));
        }, 1200);
        // One taskbar flash per waiting run; main no-ops when focused.
        // Fire-and-forget: a failed ping must never block the approval UI.
        // Optional call: older preload bridges (and some test doubles) may
        // not expose approvalPing yet.
        if (!pingedWaitingRef.current.has(id)) {
          pingedWaitingRef.current.add(id);
          try {
            const ping = window.codeAgentDesktop.approvalPing?.();
            void (ping as Promise<unknown> | undefined)?.catch?.(() => undefined);
          } catch {
            /* approval UI must never break on a ping failure */
          }
          // Soft chime on new approval: WebAudio, no assets, only after a
          // user gesture and only when desktop notifications are enabled.
          // Respect reduced motion the same way animations do: no sound
          // without an explicit user expectation of liveliness.
          try {
            const reduceMotion = appearance?.reduceMotion
              ?? preferencesQuery.data?.reduceMotion
              ?? 'SYSTEM';
            const systemReduced = typeof window.matchMedia === 'function'
              && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (!notificationsMuted && userGesturedRef.current
              && (reduceMotion !== 'ON' && !(reduceMotion === 'SYSTEM' && systemReduced))) {
              const AudioContextCtor = window.AudioContext
                ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
              if (AudioContextCtor) {
                const context = new AudioContextCtor();
                const play = (): void => {
                  const oscillator = context.createOscillator();
                  const gain = context.createGain();
                  oscillator.type = 'sine';
                  oscillator.frequency.value = 880;
                  gain.gain.setValueAtTime(0.0001, context.currentTime);
                  gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);
                  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
                  oscillator.connect(gain).connect(context.destination);
                  oscillator.start();
                  oscillator.stop(context.currentTime + 0.4);
                  oscillator.onended = () => void context.close().catch(() => undefined);
                };
                if (context.state === 'suspended') {
                  void context.resume().then(play).catch(() => undefined);
                } else {
                  play();
                }
              }
            }
          } catch {
            /* chime is best-effort only */
          }
        }
      }
    }
    for (const run of expired) {
      if (knownExpiredRef.current.has(run.runId)) continue;
      knownExpiredRef.current.add(run.runId);
      // Expiry is a terminal attention fact, not an actionable decision. It
      // still deserves a global notice so a restart cannot hide why the run
      // stopped.
      setApprovalReminderRunId((current) => current ?? run.runId);
      setApprovalReminderOpen(true);
    }
    for (const id of [...knownWaitingRef.current]) if (!active.has(id)) knownWaitingRef.current.delete(id);
    for (const id of [...pingedWaitingRef.current]) if (!active.has(id)) pingedWaitingRef.current.delete(id);
    const expiredIds = new Set(expired.map((run) => run.runId));
    for (const id of [...knownExpiredRef.current]) if (!expiredIds.has(id)) knownExpiredRef.current.delete(id);
    // appearance/preferences feed the chime gate above; runs.data drives it.
  }, [runs.data, appearance?.reduceMotion, preferencesQuery.data?.reduceMotion, notificationsMuted]);

  useEffect(() => {
    if (!approvalReminderRunId) return;
    if ((runs.data ?? []).some((run) => run.runId === approvalReminderRunId
      && (isApprovalWaiting(run) || isAuthorizationExpiredRun(run)))) return;
    setApprovalReminderOpen(false);
    setApprovalReminderRunId(null);
  }, [approvalReminderRunId, runs.data]);

  // The Service can take a moment to move a decided run out of
  // WAITING_APPROVAL: while a decision is syncing, poll runs tighter so the
  // approval card clears on the first confirmation instead of the next 2s
  // tick. Bounded — the normal poll cadence resumes afterwards.
  const approvalSyncOutstanding = approvalSyncingRunIds.size > 0;
  useEffect(() => {
    if (!approvalSyncOutstanding) return;
    let ticks = 0;
    const timer = window.setInterval(() => {
      ticks += 1;
      void queryClient.refetchQueries({ queryKey: runsQueryKey({}), exact: true }).catch(() => undefined);
      if (selection?.sessionId) {
        void queryClient.refetchQueries({ queryKey: ['approvals', selection.sessionId], exact: true }).catch(() => undefined);
      }
      if (ticks >= 20) window.clearInterval(timer);
    }, 400);
    return () => window.clearInterval(timer);
  }, [approvalSyncOutstanding, queryClient, selection?.sessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key === ',') {
        event.preventDefault();
        setActiveSurface('SETTINGS');
        return;
      }
      if (modifier && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        startNewSession();
        return;
      }
      if (modifier && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setSessionRailCollapsed((collapsed) => !collapsed);
        return;
      }
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen((open) => !open);
        return;
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        openGitOverview();
        return;
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        openPane('EVIDENCE');
        return;
      }
      if (modifier && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
        return;
      }
      if (modifier && event.key.toLowerCase() === 'w' && selectedPane) {
        event.preventDefault();
        openPane(null);
        return;
      }
      // Keyboard-first approvals: Ctrl+1 approve / Ctrl+2 reject the first pending
      // approval in the app.  The popup is global, so keyboard decisions must
      // not silently depend on whichever session happens to be selected.
      if (modifier && !event.shiftKey && !event.altKey && (event.key === '1' || event.key === '2')) {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        const decision = event.key === '1' ? 'APPROVE' : 'REJECT';
        if (unifiedQuickDecideRef.current?.(decision)) {
          event.preventDefault();
          return;
        }
        const waiting = (runs.data ?? []).filter((r) =>
          isApprovalWaiting(r));
        if (waiting.length > 0) {
          event.preventDefault();
          const run = waiting[0];
          if (run) quickDecideRef.current?.(run.runId, decision);
          return;
        }
      }
      if (event.key === 'Escape') {
        if (commandPaletteOpen) setCommandPaletteOpen(false);
        else if (sessionMenu) setSessionMenu(null);
        else if (renamingSessionId) setRenamingSessionId(null);
        else if (approvalReminderOpen) setApprovalReminderOpen(false);
        else if (exportPanelOpen) setExportPanelOpen(false);
        else if (approvalSettingsOpen) setApprovalSettingsOpen(false);
        else if (directoryPanelOpen) setDirectoryPanelOpen(false);
        else if (activityPanelOpen) setActivityPanelOpen(false);
        else if (selectedPane) openPane(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activityPanelOpen, approvalReminderOpen, approvalSettingsOpen, commandPaletteOpen, directoryPanelOpen, exportPanelOpen, openGitOverview, openPane, renamingSessionId, selectedPane, selection?.sessionId, sessionMenu, runs.data]);

  // Assigned after decideApproval is created (below): keyboard Ctrl+1/Ctrl+2 goes
  // through the same fingerprint-guarded mutation as the buttons.
  const quickDecideRef = useRef<((runId: string, decision: 'APPROVE' | 'REJECT') => void) | null>(null);
  // Same escape hatch for unified approvals: returns true when the displayed
  // approval card was handled (or must swallow the key because its action is
  // not in allowedActions), false when no unified card is on screen.
  const unifiedQuickDecideRef = useRef<((decision: 'APPROVE' | 'REJECT') => boolean) | null>(null);

  // Entered via 降级屏「仍要进入」: the bootstrap failed, so there is no
  // capability snapshot — surfaces degrade per-operation, and the banner
  // keeps a live retry affordance instead of stranding the user.
  const serviceOffline = Boolean(props.serviceDegraded);
  const [serviceRetryBusy, setServiceRetryBusy] = useState(false);
  const retryService = async (): Promise<void> => {
    setServiceRetryBusy(true);
    try {
      const result = await window.codeAgentDesktop.restartService();
      if (result.status === 'ATTACHED' || result.status === 'OWNED_READY') { location.reload(); return; }
      setBanner(result.message ?? 'Service 仍未就绪，可在设置中查看诊断');
    } catch (err) {
      setBanner(`重试失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setServiceRetryBusy(false);
    }
  };

  const capabilities: SessionCapabilities = props.capabilities
    ? {
      ask: operationAvailable(props.capabilities, 'session.create.inspect', props.capabilities.features.sessionV2),
      code: operationAvailable(props.capabilities, 'session.create.modify', props.capabilities.features.sessionV2),
      plan: operationAvailable(props.capabilities, 'session.create.plan', props.capabilities.features.sessionV2),
      mission: operationAvailable(props.capabilities, 'mission.manage', props.capabilities.features.mission)
    }
    : DEFAULT_SESSION_CAPABILITIES;
  // A fresh chat is deliberately workspace-free. Selecting a project is an
  // explicit opt-in to the existing workspace/editing pipeline.
  const newSessionWorkspaceAlias = selectedWorkspaceAlias ?? '';
  const workspaceSelected = Boolean(newSessionWorkspaceAlias);
  const currentCreateOperation = workspaceSelected ? 'session.create.modify' : 'session.create.inspect';
  // The Service materializes the fixed writable workspace-root row for V2
  // workspace sessions. A project preflight can still be attached as an
  // admission/baseline snapshot, but its suggested scope must never gate
  // creation or silently become authorization.
  const workspaceScopeReady = true;
  const canCreateCurrentSession = operationAvailable(
    props.capabilities,
    currentCreateOperation,
    workspaceSelected ? capabilities.code : capabilities.ask
  ) && workspaceScopeReady;
  const canSendText = operationAvailable(
    props.capabilities,
    'session.message.send.text',
    Boolean(selection)
  );
  const canSendImage = operationAvailable(
    props.capabilities,
    'session.message.send.image',
    false
  );
  const canReadDiff = operationAvailable(
    props.capabilities,
    'run.diff.read',
    props.capabilities ? Boolean(props.capabilities.features.sessionV2) : true
  );
  const canReadEvidence = operationAvailable(
    props.capabilities,
    'evidence.read',
    props.capabilities ? Boolean(props.capabilities.features.sessionV2) : true
  );
  const canRevealFile = operationAvailable(
    props.capabilities,
    'file.reveal',
    props.capabilities ? Boolean(props.capabilities.features.sessionV2) : true
  );
  const canUseTerminal = operationAvailable(
    props.capabilities,
    'terminal.session.create',
    props.capabilities ? Boolean(props.capabilities.features.servicePty) : true
  );
  const readonlyResearchUnavailableReason = props.capabilities
    && !props.capabilities.features.readOnlySubagent
    ? '服务未启用或未就绪'
    : null;

  /** Stale fingerprint/expectedVersion/expiry handling (design §13 EW5 验收). */
  const governanceError = useCallback((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('CONFLICT') || message.includes('FINGERPRINT')
        || message.includes('EXPIRED') || message.includes('MISMATCH')) {
      setBanner(`状态已变化（${message}）：已刷新权威数据，请重试。`);
      void queryClient.invalidateQueries();
    } else {
      setBanner(`操作失败：${message}`);
    }
  }, [queryClient]);

  const createSession = useMutation({
    mutationFn: async () => {
      if (!canCreateCurrentSession) {
        throw new Error(`OPERATION_UNAVAILABLE:${operationReason(props.capabilities, currentCreateOperation) ?? currentCreateOperation}`);
      }
      const flowId = newSessionFlowIdRef.current;
      const alias = newSessionWorkspaceAlias || undefined;
      // 长输入设计 §6.1/§6.7：冻结发送意图 —— 正文/附件/幂等键在意图内保持不变，
      // 重试不读取用户后来编辑的草稿；标题只用 ≤80 code points 的展示标题，绝不截正文。
      // 同一意图重试复用 createKey/messageKey，不再创建第二个会话。
      const frozen = newSessionIntent && newSessionIntent.generation === draftGenerationRef.current
        ? newSessionIntent
        : null;
      // The text/attachments stay frozen across retries, but model choice is
      // an explicit UI setting and may be changed before retrying the first
      // message. Keep the latest selection for the session patch below.
      const selectedNewModelAlias = newSessionModelAlias;
      const initialContent = frozen?.content ?? newSessionGoal.trim();
      const initialAttachments = frozen?.attachments
        ?? pendingAttachments.filter((attachment) => attachment.status === 'READY').map(toAttachmentWire);
      const createKey = frozen?.createKey ?? crypto.randomUUID();
      const messageKey = frozen?.messageKey ?? crypto.randomUUID();
      if (!frozen) {
        setNewSessionIntent({
          generation: draftGenerationRef.current,
          content: initialContent,
          attachments: initialAttachments,
          createKey,
          messageKey,
          sessionId: null
        });
      }
      // F01 根治：完整正文绝不进 title；无正文时由服务生成（不传 title）。
      const initialTitle = autoTitle(initialContent);

      // R0 预检：本地先做 4000 保守校验，失败保留草稿、不建会话。
      const frozenLimits = resolveTextInputLimits(textInputLimitsOf(props.capabilities));
      const frozenCheck = initialContent ? checkBodyWithinLimits(initialContent, frozenLimits) : null;
      if (frozenCheck && !frozenCheck.ok) {
        throw new Error(`INPUT_LIMIT_EXCEEDED:${frozenCheck.message ?? ''}`);
      }
      let created: { sessionId?: string; sessionVersion?: number };
      const workspacePreflight = workspaceSelected ? newSessionPreflight.data : null;
      // The Service owns the project preflight/baseline and materializes the
      // fixed writable workspace-root row. Carry the frozen metadata into the
      // create contract; the client does not manufacture write authority.
      if (frozen?.sessionId) {
        created = { sessionId: frozen.sessionId };
      } else {
        created = unwrap<{ sessionId?: string; sessionVersion?: number }>(await window.codeAgentDesktop.createSession({
          schemaVersion: 'business-session/2.0',
          ...(initialTitle ? { title: initialTitle } : {}),
          workspaceAlias: alias ?? '',
          interactionMode: 'ACT',
          intent: alias ? 'IMPLEMENT' : 'ASK',
          executionMode: alias ? 'MODIFY' : 'INSPECT',
          autonomyLevel: alias ? 'LOW' : 'OFF',
          // No explicit permissionMode: the service binds the durable
          // user/project default grant (design §5.1); WORKSPACE is only sent
          // when the user actively chooses standard mode.
          permissionMode: null,
          ...(workspaceSelected && newSessionAgentProfileId !== 'default' ? {
            agentProfileId: newSessionAgentProfileId,
            ...(selectedAgentProfile?.revision ? { agentProfileRevision: selectedAgentProfile.revision } : {})
          } : {}),
          ...(workspaceSelected ? { readonlyResearchMode: newSessionReadonlyResearchMode } : {}),
          initialWorkspaceListing: preferencesQuery.data?.initialWorkspaceListing !== false,
          directoryPolicyVersion: 2,
          directories: [],
          verificationLevel: 'NONE',
          ...(workspacePreflight ? {
            policyFingerprint: workspacePreflight.policyFingerprint,
            preflightRevision: workspacePreflight.revision,
            workspaceFingerprint: workspacePreflight.workspaceFingerprint,
            workspacePolicy: {
              mode: 'LOCAL_CHECKOUT',
              startPolicy: 'USER_WIP_SNAPSHOT',
              baseSnapshotFingerprint: workspacePreflight.workspaceFingerprint,
              preflightRevision: workspacePreflight.revision
            }
          } : {})
        }, createKey));
        if (created.sessionId) {
          setNewSessionIntent({
            generation: draftGenerationRef.current,
            content: initialContent,
            attachments: initialAttachments,
            createKey,
            messageKey,
            sessionId: created.sessionId
          });
        }
      }
      // Session admission must not wait for the model gateway. The first turn
      // is handed to the normal per-session send path after admission, so a
      // slow model call cannot keep the new-session screen or other sessions
      // in a shared pending state.
      let initialMessageError: string | undefined;
      if (created.sessionId) {
        try {
          if (newSessionModelTouched) {
            const createdVersion = Number(created.sessionVersion ?? 0);
            const modelPatchVersion = createdVersion >= 1
              ? createdVersion
              : (unwrap(await window.codeAgentDesktop.getSession(created.sessionId)) as { sessionVersion: number }).sessionVersion;
            const patched = await patchSessionModel.mutateAsync({
              sessionId: created.sessionId,
              modelAlias: selectedNewModelAlias,
              expectedSessionVersion: modelPatchVersion
            });
            created = { ...created, sessionVersion: patched.sessionVersion };
          }
        } catch (error) {
          // Model selection is a separate session patch. Keep an admitted
          // session usable even if that optional patch is temporarily slow or
          // fails; the user can retry it from the session controls.
          initialMessageError = errorMessage(error);
        }
      }
      return {
        ...created,
        initialMessageError,
        flowId,
        initialMessage: created.sessionId && initialContent && !initialMessageError
          ? {
            content: initialContent,
            attachments: initialAttachments,
            messageKey,
            expectedSessionVersion: Number(created.sessionVersion ?? 1)
          }
          : undefined
      } satisfies NewSessionCreationResult;
    },
    onMutate: () => {
      setNewSessionStartedAt((current) => current ?? Date.now());
    },
    onSuccess: (created: NewSessionCreationResult) => {
      setNewSessionStartedAt(null);
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      // The first message may have already queued a Run while the new session
      // was being created. Refresh the Run projection before rendering the
      // selected session so the live activity fallback can bind immediately.
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      const createdSession = created;
      const shouldAdoptSession = created.flowId === newSessionFlowIdRef.current
        && (selectionRef.current === null
          || selectionRef.current.sessionId === createdSession.sessionId);
      if (shouldAdoptSession) {
        if (createdSession.initialMessageError) {
          // Keep the frozen create intent and its draft in the new-session
          // form. Retrying can repair the optional model binding without
          // creating a second session or losing the user's first message.
          setBanner(`会话已创建，但模型设置未完成：${createdSession.initialMessageError}`);
          return;
        }
        setNewSessionGoal('');
        setNewSessionAgentProfileId('default');
        setNewSessionReadonlyResearchMode('OFF');
        setNewSessionModelAlias(null);
        setNewSessionModelTouched(false);
        setPendingAttachments([]);
        bumpDraftGeneration();
        setNewSessionIntent(null);
        // Workspace choice is per session. Returning to the new-session view
        // starts ordinary chat again unless the user explicitly selects a project.
        setSelectedWorkspaceAlias(null);
        if (createdSession.sessionId) selectSession(createdSession.sessionId);
      }
      // Admission and the first model call are independent. Even if the user
      // has already switched away, dispatch the frozen first turn in the
      // background without changing the active conversation.
      if (createdSession.initialMessage && createdSession.sessionId) {
        startSendMessage({
          sessionId: createdSession.sessionId,
          content: createdSession.initialMessage.content,
          attachments: createdSession.initialMessage.attachments,
          clientMessageId: createdSession.initialMessage.messageKey,
          expectedSessionVersion: createdSession.initialMessage.expectedSessionVersion,
          fromNewSession: true
        });
      }
    },
    onError: (err) => {
      setNewSessionStartedAt(null);
      const explained = describeInputProblem(err);
      if (explained) {
        setBanner(`创建会话失败：${explained}`);
        return;
      }
      const message = errorMessage(err);
      // A transport timeout has no authoritative outcome: the request may
      // have reached the service even though the renderer stopped waiting.
      // Keep the idempotency intent and tell the user to retry safely rather
      // than claiming that session creation failed.
      if (isRequestTimeout(err)) {
        setBanner('请求超时，服务可能仍在处理；请重试。系统会复用同一幂等键，不会重复创建会话。');
        return;
      }
      setBanner(`创建会话失败：${message}`);
    }
  });

  const refreshApprovalState = useCallback(async (sessionId: string | null | undefined): Promise<void> => {
    const keys: Array<{ queryKey: readonly unknown[]; exact: boolean }> = [
      { queryKey: runsQueryKey({}), exact: true },
      { queryKey: ['attention'], exact: true },
      { queryKey: ['sessions'], exact: true }
    ];
    if (sessionId) {
      keys.push(
        { queryKey: ['sessions', sessionId], exact: true },
        { queryKey: ['approvals', sessionId], exact: true },
        { queryKey: ['write-approvals', 'global'], exact: true },
        { queryKey: ['sandbox-approvals', 'global'], exact: true },
        { queryKey: ['terminal-approvals', 'global'], exact: true }
      );
    }
    await Promise.all(keys.map((options) => queryClient.refetchQueries(options).catch(() => undefined)));
  }, [queryClient]);

  const decideApproval = useMutation({
    mutationFn: async (input: { runId: string; kind: 'COMMAND' | 'BUDGET' | 'WRITE' | 'TERMINAL' | 'SANDBOX'; decision: 'APPROVE' | 'REJECT'; fingerprint?: string | null }) => {      if (input.kind === 'COMMAND') {
        return unwrap(await window.codeAgentDesktop.decideCommandApproval(
          input.runId, { fingerprint: input.fingerprint ?? '', decision: input.decision }));
      }
      if (input.kind === 'SANDBOX') {
        return unwrap(await window.codeAgentDesktop.decideSandboxApproval(
          input.runId, { fingerprint: input.fingerprint ?? '', decision: input.decision }));
      }
      if (input.kind === 'TERMINAL') {
        return unwrap(await window.codeAgentDesktop.decideTerminalApproval(
          input.runId, { fingerprint: input.fingerprint ?? '', decision: input.decision }));
      }
      if (input.kind === 'WRITE') {
        // The write approval decision fetches the pending projection itself:
        // the service-owned approvalId + fingerprint must echo exactly.
        return unwrap(await window.codeAgentDesktop.decideWriteApproval(
          input.runId, { decision: input.decision }));
      }
      return unwrap(await window.codeAgentDesktop.decideBudgetApproval(
        input.runId, { requestFingerprint: input.fingerprint ?? '', decision: input.decision }));
    },
    onMutate: (input) => {
      setApprovalSyncingRunIds((current) => {
        if (current.has(input.runId)) return current;
        return new Set(current).add(input.runId);
      });
    },
    onSuccess: async (_result, input) => {
      if (approvalReminderRunId === input.runId) setApprovalReminderOpen(false);
      if (input.fingerprint) decidedApprovalMarks.current.set(input.runId, `fp:${input.fingerprint}`);
      const sessionId = (runs.data ?? []).find((run) => run.runId === input.runId)?.sessionId;
      // A successful decision is not itself the new Run state. Refresh the
      // exact projections and keep the sync label until Service reports the
      // resumed or terminal state.
      await refreshApprovalState(sessionId);
    },
    onError: (error, input) => {
      setApprovalSyncingRunIds((current) => {
        if (!current.has(input.runId)) return current;
        const next = new Set(current);
        next.delete(input.runId);
        return next;
      });
      governanceError(error);
    }
  });

  // V2 permission mode mutation. The service owns the effective mode and
  // revision; the renderer never persists a local grant. FULL_ACCESS
  // semantics 2: selecting the mode IS the authorization — no second
  // confirmation; a semantics-2 grant auto-approves execution approvals.
  const updateExecutionPolicyM = useMutation({
    mutationFn: async (input: { mode: PermissionMode; sessionId: string; projectId: string | null; expectedRevision: number }) => {
      if (!executionPolicy.data || typeof window.codeAgentDesktop.updateExecutionPolicy !== 'function') {
        throw new Error('EXECUTION_POLICY_UNAVAILABLE');
      }
      return unwrap(await window.codeAgentDesktop.updateExecutionPolicy(input.sessionId, {
        expectedRevision: input.expectedRevision,
        requestedMode: input.mode,
        permissionSemanticsVersion: 2,
        // Semantics-2 grants do not consume the flag; it stays explicit for
        // any legacy-semantics row the service still has on record.
        fullAccessConfirmation: input.mode === 'FULL_ACCESS',
        // Enabling (or leaving) a mode re-evaluates this session's still-valid
        // pending approvals server-side so waiting work continues without a
        // frontend gesture (design A12).
        pendingApprovalAction: 'RECONCILE_SESSION'
      }, input.projectId ?? undefined));
    },
    onSuccess: (result, input) => {
      queryClient.setQueryData(['execution-policy', input.sessionId, input.projectId], result);
      void queryClient.invalidateQueries({ queryKey: ['execution-policy', input.sessionId, input.projectId] });
      // A mode change may reconcile pending approvals server-side (grant v2):
      // runs resume, sessions mirror the effective mode and attention items
      // clear — refresh every projection that can carry policy-derived state.
      void queryClient.invalidateQueries({ queryKey: ['approvals', input.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['session', input.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['sessionList'] });
      void queryClient.invalidateQueries({ queryKey: ['sessionMetadata', input.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
      void queryClient.invalidateQueries({ queryKey: ['automation-control', input.sessionId] });
    },
    onError: governanceError
  });

  const automationControlM = useMutation({
    mutationFn: async (input: {
      sessionId: string;
      control: 'PAUSE_AUTOMATION' | 'RESUME_AUTOMATION';
      expectedVersion: number;
    }) => {
      if (typeof window.codeAgentDesktop.controlAutomation !== 'function') {
        throw new Error('AUTOMATION_CONTROL_UNAVAILABLE');
      }
      return unwrap(await window.codeAgentDesktop.controlAutomation(input.sessionId, {
        expectedVersion: input.expectedVersion,
        control: input.control
      }));
    },
    onSuccess: (result, input) => {
      queryClient.setQueryData(['automation-control', input.sessionId], result);
      void queryClient.invalidateQueries({ queryKey: ['automation-control', input.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['approvals', input.sessionId] });
    },
    onError: governanceError
  });

  // V2 approval mutations are keyed by approvalId. A slow decision for A does
  // not disable the controls on B, and a stale response is only projected
  // into the session that still owns that approval.
  const unifiedDecisionM = useMutation({
    mutationFn: async (input: { approval: ApprovalRequestLike; decision: 'APPROVE' | 'REJECT' | 'EXECUTE' }) => {
      if (typeof window.codeAgentDesktop.decideApproval !== 'function') throw new Error('APPROVAL_DECISION_UNAVAILABLE');
      return unwrap(await window.codeAgentDesktop.decideApproval(input.approval.approvalId, {
        expectedVersion: input.approval.version,
        decision: input.decision === 'REJECT' ? 'DENY' : input.decision,
        fingerprint: input.approval.requestFingerprint
      }));
    },
    onMutate: (input) => {
      if (!input.approval.runId) return;
      setApprovalSyncingRunIds((current) => {
        if (current.has(input.approval.runId)) return current;
        return new Set(current).add(input.approval.runId);
      });
    },
    onSuccess: async (result, input) => {
      if (approvalReminderRunId === input.approval.runId) setApprovalReminderOpen(false);
      if (input.approval.runId) decidedApprovalMarks.current.set(input.approval.runId, `id:${input.approval.approvalId}`);
      // The decision response is the Service's updated record: project it
      // into the list cache so a decided card closes immediately instead of
      // waiting out the next poll. The refetch below reconciles as usual.
      const decided = result as ApprovalRequestLike | undefined;
      if (decided && typeof decided.approvalId === 'string') {
        const record = normalizeApprovalForRenderer(decided);
        queryClient.setQueryData(['approval', record.approvalId], record);
        queryClient.setQueryData(['approvals', input.approval.sessionId], (current: ApprovalsListResponse | undefined) =>
          current?.items
            ? { ...current, items: current.items.map((item) => item.approvalId === record.approvalId ? record : item) }
            : current);
      }
      void queryClient.invalidateQueries({ queryKey: ['approval', input.approval.approvalId], exact: true });
      await refreshApprovalState(input.approval.sessionId);
    },
    onError: (error, input) => {
      if (input.approval.runId) {
        setApprovalSyncingRunIds((current) => {
          if (!current.has(input.approval.runId as string)) return current;
          const next = new Set(current);
          next.delete(input.approval.runId as string);
          return next;
        });
      }
      governanceError(error);
    }
  });

  const unifiedAdvanceM = useMutation({
    mutationFn: async (input: { approval: ApprovalRequestLike }) => {
      if (typeof window.codeAgentDesktop.advanceApproval !== 'function') throw new Error('APPROVAL_ADVANCE_UNAVAILABLE');
      return unwrap(await window.codeAgentDesktop.advanceApproval(input.approval.approvalId, {
        expectedVersion: input.approval.version,
        fingerprint: input.approval.requestFingerprint
      }));
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ['approvals', input.approval.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['approval', input.approval.approvalId] });
    },
    onError: governanceError
  });

  const unifiedControlM = useMutation({
    mutationFn: async (input: { approval: ApprovalRequestLike; control: 'PAUSE_DELAY' | 'RESUME_DELAY' | 'CANCEL' }) => {
      if (typeof window.codeAgentDesktop.controlApproval !== 'function') throw new Error('APPROVAL_CONTROL_UNAVAILABLE');
      return unwrap(await window.codeAgentDesktop.controlApproval(input.approval.approvalId, {
        expectedVersion: input.approval.version,
        fingerprint: input.approval.requestFingerprint,
        requestFingerprint: input.approval.requestFingerprint,
        control: input.control
      }));
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ['approvals', input.approval.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['approval', input.approval.approvalId] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: governanceError
  });

  // Legacy approval projections are global.  The automatic reminder is an
  // app-level surface, so its data cannot be keyed by the currently selected
  // session; otherwise a restart or a background run has no actionable card.
  const pendingWriteApprovals = useQuery({
    queryKey: ['write-approvals', 'global'],
    enabled: (runs.data ?? []).some((r) =>
      isNonBudgetApprovalWait(r)),
    refetchInterval: 2000,
    queryFn: async () => {
      const waiting = (runs.data ?? []).filter((r) =>
        isNonBudgetApprovalWait(r));
      const out: Record<string, Record<string, unknown> | null> = {};
      for (const run of waiting) {
        try {
          out[run.runId] = await unwrap(await window.codeAgentDesktop.pendingWriteApproval(run.runId));
        } catch {
          out[run.runId] = null;
        }
      }
      return out;
    }
  });

  // Sandbox approvals are a separate legacy-v1 projection because the
  // approval payload contains a redacted script preview and OCI facts rather
  // than a host executable/argv.  Keep polling while any run waits; the
  // service remains authoritative for the fingerprint.  An explicit expiry
  // projection is retained so the popup can say 授权已失效 instead of
  // silently turning a missing pending record into a generic command card.
  const pendingSandboxApprovals = useQuery({
    queryKey: ['sandbox-approvals', 'global'],
    enabled: (runs.data ?? []).some((r) =>
      isNonBudgetApprovalWait(r)),
    refetchInterval: 2000,
    queryFn: async () => {
      const waiting = (runs.data ?? []).filter((r) =>
        isNonBudgetApprovalWait(r));
      const out: Record<string, SandboxApprovalProjection> = {};
      for (const run of waiting) {
        try {
          const pending = unwrap(await window.codeAgentDesktop.pendingSandboxApproval(run.runId)) as PendingSandboxApproval | null;
          if (pending) {
            out[run.runId] = pending;
          } else {
            const attentionItem = (attention.data ?? []).find((item: AttentionLike) => item.sourceId === run.runId);
            // A recovered run can briefly report WAITING_APPROVAL while the
            // old in-memory request is gone.  The Service's sandbox attention
            // fact makes that distinction safe; the next poll replaces this
            // marker when the recovered request is available.
            out[run.runId] = attentionItem?.attentionType === 'SANDBOX_APPROVAL'
              ? { status: 'EXPIRED', reasonCode: 'SANDBOX_APPROVAL_NOT_PENDING', message: '沙箱授权已失效，旧请求不能继续使用；请重新发起新的运行。' }
              : null;
          }
        } catch (error) {
          out[run.runId] = expiredSandboxApproval(error);
        }
      }
      return out;
    }
  });

  // Agent terminal approvals share the Run waiting state with command/write
  // approvals, so the typed pending projection identifies the approval kind
  // without trusting renderer-local state or model-supplied metadata.
  const pendingTerminalApprovals = useQuery({
    queryKey: ['terminal-approvals', 'global'],
    enabled: (runs.data ?? []).some((r) =>
      isNonBudgetApprovalWait(r)),
    refetchInterval: 2000,
    queryFn: async () => {
      const waiting = (runs.data ?? []).filter((r) =>
        isNonBudgetApprovalWait(r));
      const out: Record<string, PendingTerminalApproval | null> = {};
      for (const run of waiting) {
        try {
          out[run.runId] = unwrap(await window.codeAgentDesktop.pendingTerminalApproval(run.runId));
        } catch {
          out[run.runId] = null;
        }
      }
      return out;
    }
  });

  quickDecideRef.current = (runId, decision) => {
    const run = (runs.data ?? []).find((r) => r.runId === runId);
    if (!run) return;
    const isBudget = run.sourceStatus === 'WAITING_BUDGET_APPROVAL' || run.state === 'WAITING_BUDGET_APPROVAL';
    const writePending = isBudget ? null : pendingWriteApprovals.data?.[runId] ?? null;
    const sandboxPending = isBudget ? null : pendingSandboxApprovals.data?.[runId] ?? null;
    const terminalPending = isBudget ? null : pendingTerminalApprovals.data?.[runId] ?? null;
    if (writePending) {
      decideApproval.mutate({
        runId,
        kind: 'WRITE',
        decision,
        fingerprint: typeof writePending.fingerprint === 'string' ? writePending.fingerprint : undefined
      });
      return;
    }
    if (sandboxPending && !isExpiredSandboxApproval(sandboxPending)) {
      decideApproval.mutate({
        runId,
        kind: 'SANDBOX',
        decision,
        fingerprint: sandboxPending.fingerprint
      });
      return;
    }
    const attention = attentionItems.find((a) => a.sourceId === runId) as { fingerprint?: string | null } | undefined;
    if (terminalPending || (attention as { attentionType?: string } | undefined)?.attentionType === 'TERMINAL_APPROVAL') {
      decideApproval.mutate({
        runId,
        kind: 'TERMINAL',
        decision,
        fingerprint: terminalPending?.fingerprint ?? attention?.fingerprint ?? undefined
      });
      return;
    }
    decideApproval.mutate({
      runId,
      kind: isBudget ? 'BUDGET' : 'COMMAND',
      decision,
      fingerprint: attention?.fingerprint ?? undefined
    });
  };

  // Ctrl+1/2 on the unified card decides exactly what is displayed: the first
  // pending approval of the selected session. A visible card whose requested
  // action is not allowed swallows the key (returns true) so the shortcut can
  // never decide a different, unseen approval.
  unifiedQuickDecideRef.current = (decision) => {
    const approval = unifiedPendingApprovals[0];
    if (!approval || !unifiedApprovalEndpoints.decide) return false;
    const requiredAction = decision === 'APPROVE' ? 'APPROVE' : 'DENY';
    const allowed = approval.executionStatus !== 'UNKNOWN'
      && (approval.decisionStatus === 'PENDING' || approval.decisionStatus === 'WAITING_DELAY')
      && Array.isArray(approval.allowedActions)
      && (approval.allowedActions as string[]).includes(requiredAction);
    if (!allowed) return true;
    unifiedDecisionM.mutate({ approval, decision });
    return true;
  };

  const clearStopRequested = useCallback((runId: string): void => {
    stopRequestedRunIdsRef.current.delete(runId);
    setStopRequestedRunIds((previous) => {
      if (!previous.has(runId)) return previous;
      const next = new Set(previous);
      next.delete(runId);
      return next;
    });
  }, []);

  const interruptRun = useMutation({
    mutationFn: async (input: { runId: string; expectedStateVersion: number }) => {
      return unwrap(await window.codeAgentDesktop.interruptRun(
        input.runId, { expectedStateVersion: input.expectedStateVersion }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (error, input) => {
      // The local STOP_REQUESTED marker is optimistic. If the service rejects
      // the request (for example because the run became terminal or was still
      // queued), it must not survive as a misleading permanent UI state.
      clearStopRequested(input.runId);
      governanceError(error);
    }
  });

  // A successful interrupt request is not a terminal fact. Keep the bar in
  // STOP_REQUESTED until the authoritative Run projection reaches a terminal
  // state, and send at most one request for a click.
  useEffect(() => {
    const terminal = new Set(['COMPLETED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'TIMED_OUT', 'ABORTED', 'REJECTED', 'TERMINAL', 'NEEDS_ATTENTION']);
    setStopRequestedRunIds((previous) => {
      const next = new Set(previous);
      for (const runId of previous) {
        const run = (runs.data ?? []).find((item) => item.runId === runId);
        if (!run || terminal.has(run.state)) {
          next.delete(runId);
          stopRequestedRunIdsRef.current.delete(runId);
        }
      }
      return next.size === previous.size ? previous : next;
    });
  }, [clearStopRequested, runs.data]);
  const requestStop = useCallback((runId: string, expectedStateVersion: number): void => {
    if (stopRequestedRunIdsRef.current.has(runId)) return;
    stopRequestedRunIdsRef.current.add(runId);
    setStopRequestedRunIds((previous) => new Set(previous).add(runId));
    interruptRun.mutate({ runId, expectedStateVersion });
  }, [interruptRun]);

  const cancelRunM = useMutation({
    mutationFn: async (runId: string) => unwrap(await window.codeAgentDesktop.cancelRun(runId)),
    onSuccess: (_result, runId) => {
      clearStopRequested(runId);
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (error, runId) => {
      clearStopRequested(runId);
      governanceError(error);
    }
  });

  const recoverRunM = useMutation({
    mutationFn: async (input: { runId: string; expectedStateVersion: number }) => unwrap(await window.codeAgentDesktop.controlRun(
      input.runId,
      { intent: 'RECOVER', expectedStateVersion: input.expectedStateVersion, reasonCode: 'USER_REQUESTED_RECOVERY' }
    )),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: governanceError
  });

  // EW6: reveal a diff file via a server-validated intent (path traversal safe)
  const revealFileM = useMutation({
    mutationFn: async (input: { projectId: string; fileRef: string }) =>
      unwrap(await window.codeAgentDesktop.revealProjectFile(input.projectId, input.fileRef)),
    onError: (err) => setBanner(`定位文件失败：${String(err)}`)
  });

  // A run may execute inside an isolated worktree whose workspaceAlias is not
  // a registered project. Resolve through each candidate alias in order — the
  // run's own alias first, then the owning session's workspace alias — and
  // never guess an arbitrary registered project (fail-closed).
  const projectForAliases = useCallback((...aliases: Array<string | null | undefined>) => {
    const projectList = projects.data ?? [];
    for (const alias of aliases) {
      if (!alias) continue;
      const match = projectList.find((p) => p.workspaceAlias === alias);
      if (match) return match;
    }
    return null;
  }, [projects.data]);
  const sessionAliasById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of historySessions.sessions) {
      const alias = item.workspaceAlias?.trim();
      if (item.sessionId && alias) map.set(item.sessionId, alias);
    }
    return map;
  }, [historySessions.sessions]);

  const handleReveal = useCallback((fileRef: string, runIdOverride?: string | null) => {
    if (!canRevealFile) {
      setBanner(`定位文件不可用：${operationReason(props.capabilities, 'file.reveal') ?? 'file.reveal'}`);
      return;
    }
    const run = (runs.data ?? []).find((r) => r.runId === (runIdOverride ?? selectedRunId));
    // An activity must resolve through its own run workspace. When the run is
    // outside the bounded run list, the owning session's workspace alias is
    // the only safe fallback — never the first registered project, which could
    // open a same-named file in an unrelated workspace.
    const project = projectForAliases(
      run?.workspaceAlias,
      run?.sessionId ? sessionAliasById.get(run.sessionId) : null,
      historyDetail.session?.workspaceAlias
    );
    if (!project) {
      setBanner('无法确定项目，未能定位文件。');
      return;
    }
    setSelectedFileProjectId(project.projectId);
    setSelectedFileRef(fileRef);
    setSelectedFileLine(null);
    revealFileM.mutate({ projectId: project.projectId, fileRef });
  }, [canRevealFile, props.capabilities, runs.data, selectedRunId, historyDetail.session, revealFileM, projectForAliases, sessionAliasById]);

  // EW7: service-owned workspace executions; provisioning stays server-side.
  const createWorktreeM = useMutation({
    mutationFn: async (input: { workspaceAlias: string; ownerId: string }) =>
      unwrap(await window.codeAgentDesktop.createWorkspaceExecution({
        workspaceAlias: input.workspaceAlias,
        kind: 'WORKTREE',
        ownerType: 'RUN',
        ownerId: input.ownerId
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-executions'] });
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
    onError: governanceError
  });

  const handoffWorkspaceM = useMutation({
    mutationFn: async (input: { workspaceExecutionId: string; expectedStateVersion?: number }) =>
      unwrap(await window.codeAgentDesktop.handoffWorkspaceExecution(
        input.workspaceExecutionId, input.expectedStateVersion)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-executions'] });
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
    onError: governanceError
  });

  const reclaimWorkspaceM = useMutation({
    mutationFn: async (input: { workspaceExecutionId: string; expectedStateVersion?: number }) =>
      unwrap(await window.codeAgentDesktop.reclaimWorkspaceExecution(
        input.workspaceExecutionId, input.expectedStateVersion)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspace-executions'] });
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
    onError: governanceError
  });

  const handleCreateWorktree = useCallback(() => {
    const run = (runs.data ?? []).find((r) => r.runId === selectedRunId);
    // Provision under a registered project alias — a run already inside an
    // isolated worktree must not spawn a worktree-of-a-worktree.
    const alias = projectForAliases(
      run?.workspaceAlias,
      run?.sessionId ? sessionAliasById.get(run.sessionId) : null,
      historyDetail.session?.workspaceAlias
    )?.workspaceAlias ?? null;
    if (!alias || !selectedRunId) {
      setBanner('无法确定项目或运行，未能创建隔离 worktree。');
      return;
    }
    createWorktreeM.mutate({ workspaceAlias: alias, ownerId: selectedRunId });
  }, [runs.data, selectedRunId, historyDetail.session, createWorktreeM, projectForAliases, sessionAliasById]);

  const workspacePending = createWorktreeM.isPending || handoffWorkspaceM.isPending || reclaimWorkspaceM.isPending;

  // EW8: mission control commands; stale-version conflicts surface via the
  // shared governance banner (replan stale approval / restart recovery).
  const missionCreateM = useMutation({
    mutationFn: async (input: { sessionId: string; title: string; goal: string; workspaceAlias: string }) =>
      unwrap(await window.codeAgentDesktop.createMission(input.sessionId, {
        title: input.title, goal: input.goal, workspaceAlias: input.workspaceAlias
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['missions'] });
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
    onError: governanceError
  });

  const missionDecideM = useMutation({
    mutationFn: async (input: {
      mission: { missionId: string; approvalId?: string | null; stateVersion?: number; revision?: number; planFingerprint?: string | null; pendingRevisionFingerprint?: string | null };
      decision: 'APPROVE' | 'REJECT';
    }) =>
      unwrap(await window.codeAgentDesktop.decideMissionApproval(input.mission.missionId, input.mission.approvalId?.trim() || 'plan', {
        expectedMissionVersion: input.mission.stateVersion ?? 0,
        decision: input.decision,
        planFingerprint: input.mission.pendingRevisionFingerprint ?? input.mission.planFingerprint ?? undefined
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['missions'] });
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
    onError: governanceError
  });

  const missionCommandM = useMutation({
    mutationFn: async (input: {
      mission: { missionId: string; stateVersion?: number };
      command: 'start' | 'pause' | 'resume' | 'cancel';
    }) => {
      const body = { expectedMissionVersion: input.mission.stateVersion ?? 0 };
      switch (input.command) {
        case 'start': return unwrap(await window.codeAgentDesktop.startMission(input.mission.missionId, body.expectedMissionVersion));
        case 'pause': return unwrap(await window.codeAgentDesktop.pauseMission(input.mission.missionId, body.expectedMissionVersion));
        case 'resume': return unwrap(await window.codeAgentDesktop.resumeMission(input.mission.missionId, body.expectedMissionVersion));
        default: return unwrap(await window.codeAgentDesktop.cancelMission(input.mission.missionId, body.expectedMissionVersion));
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['missions'] });
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
    },
    onError: governanceError
  });

  const createSpecM = useMutation({
    mutationFn: async () => {
      if (!selection) throw new Error('NO_SESSION');
      return unwrap(await window.codeAgentDesktop.createSpec(selection.sessionId, {
        goal: specDraftGoal,
        workspaceAlias: historyDetail.session?.workspaceAlias ?? ''
      }));
    },
    onSuccess: (data) => {
      setSpecDraftGoal('');
      setSpecId((data as { specId?: string }).specId ?? null);
      void queryClient.invalidateQueries({ queryKey: ['specs'] });
    },
    onError: governanceError
  });

  const decideSpecM = useMutation({
    mutationFn: async (decision: 'APPROVE' | 'REJECT') => {
      const spec = specQuery.data;
      if (!spec?.approvalId) throw new Error('NO_PENDING_APPROVAL');
      return unwrap(await window.codeAgentDesktop.decideSpecApproval(spec.specId, spec.approvalId, {
        expectedRevision: spec.revision,
        decision,
        contractFingerprint: spec.contractFingerprint ?? undefined,
        policyFingerprint: spec.policyFingerprint ?? undefined,
        workspaceBaselineFingerprint: spec.workspaceBaselineFingerprint ?? undefined,
        planFingerprint: spec.planFingerprint ?? undefined
      }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['specs'] });
    },
    onError: governanceError
  });

  const convertSpecM = useMutation({
    mutationFn: async () => {
      const spec = specQuery.data;
      if (!spec) throw new Error('NO_SPEC');
      return unwrap(await window.codeAgentDesktop.convertSpecToAct(spec.specId, {
        expectedRevision: spec.revision
      }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['specs'] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: governanceError
  });

  const textInputLimits = useMemo(
    () => resolveTextInputLimits(textInputLimitsOf(props.capabilities)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(textInputLimitsOf(props.capabilities))]
  );
  const composerCheck = useMemo(
    () => {
      try {
        return checkBodyWithinLimits(composer, textInputLimits);
      } catch {
        return { ok: true, normalized: composer, points: composer.length, bytes: 0, lines: 1, collapsed: false };
      }
    },
    [composer, textInputLimits]
  );

  const sendMessage = useMutation<SessionMessageResponse, unknown, SendMessageInput>({
    // React Query's mutation observer is intentionally used only as an
    // executor here. Completion/error cleanup lives inside mutationFn so each
    // concurrent session owns its own lifecycle; one slow session cannot
    // overwrite another session's observer callbacks.
    mutationFn: async (input) => {
      const content = input.frozenContent ?? input.content;
      const attachments = input.frozenAttachments ?? input.attachments ?? [];
      const messageKey = input.clientMessageId
        ?? pendingMessageKeyRef.current.get(input.sessionId)
        ?? crypto.randomUUID();
      try {
        // Capability handshakes are authoritative when present. Embedded
        // hosts without the optional handshake retain the legacy send path;
        // the created-session response itself is the admission authority.
        if (props.capabilities && !canSendText) {
          throw new Error(`OPERATION_UNAVAILABLE:${operationReason(props.capabilities, 'session.message.send.text') ?? 'session.message.send.text'}`);
        }
        const check = checkBodyWithinLimits(content, textInputLimits);
        if (!check.ok) {
          throw new Error(`INPUT_LIMIT_EXCEEDED:${check.message ?? ''}`);
        }
        // 服务对会话消息强制 expectedSessionVersion（缺失即 428）。只
        // 复用当前选中会话的缓存版本；后台发送的其他会话必须回读。
        const knownVersion = selectionRef.current?.sessionId === input.sessionId
          ? session?.sessionVersion : undefined;
        const currentVersion = typeof input.expectedSessionVersion === 'number' && input.expectedSessionVersion >= 1
          ? input.expectedSessionVersion
          : typeof knownVersion === 'number' && knownVersion >= 1
          ? knownVersion
          : (unwrap(await window.codeAgentDesktop.getSession(input.sessionId)) as { sessionVersion: number }).sessionVersion;
        const result = unwrap(
          await window.codeAgentDesktop.sendSessionMessage(input.sessionId, {
            clientMessageId: messageKey,
            content: check.normalized,
            expectedSessionVersion: currentVersion,
            attachments,
            // WU07: frozen per-turn extension selection; null means no
            // extensions bound (same wire shape as before).
            ...(input.extensions ? { extensions: input.extensions } : {})
          }, messageKey)
        ) as SessionMessageResponse;
        finishSendSuccess({ ...input, clientMessageId: messageKey }, result);
        return result;
      } catch (error) {
        finishSendError({ ...input, clientMessageId: messageKey, content, attachments }, error);
        throw error;
      }
    }
  });

  function finishSendSuccess(input: SendMessageInput, _data: SessionMessageResponse): void {
    const sessionId = input.sessionId;
    sendingSessionIdsRef.current.delete(sessionId);
    setSendingSessionIds(new Set(sendingSessionIdsRef.current));
    setPendingTurns((current) => current.filter((turn) => turn.sessionId !== sessionId));
    pendingMessageKeyRef.current.delete(sessionId);
    const currentIntent = composerIntentRef.current;
    if (currentIntent?.sessionId === sessionId && currentIntent.messageKey === input.clientMessageId) {
      composerIntentRef.current = null;
      setComposerIntent(null);
    }
    const sentGeneration = input.frozenGeneration ?? draftGenerationRef.current;
    if (draftGenerationRef.current === sentGeneration
        && selectionRef.current?.sessionId === sessionId) {
      setComposer('');
      setPendingAttachments([]);
      bumpDraftGeneration();
    }
    // Never change the user's active conversation when a background send
    // completes; only refresh that session's authoritative history.
    invalidateSessionHistory(queryClient, sessionId);
    void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    void queryClient.invalidateQueries({ queryKey: ['runs'] });
  }

  async function reconcileSendOutcome(input: SendMessageInput): Promise<void> {
    try {
      if (!input.clientMessageId) throw new Error('MISSING_MESSAGE_KEY');
      const receipt = unwrap<OperationReceiptResponse>(await window.codeAgentDesktop.lookupSessionMessageReceipt(
        input.sessionId, input.clientMessageId));
      if (receipt.status === 'APPLIED') {
        finishSendSuccess(input, receipt.result as SessionMessageResponse);
        setBanner(null);
        return;
      }
      if (receipt.status === 'NOT_APPLIED') {
        setBanner('服务确认未接收这条消息，可以用原请求重试。');
        return;
      }
    } catch {
      // A failed lookup cannot rule out an in-flight send.
    }
    setBanner('发送结果待确认。重试会沿用同一条消息。');
  }

  function finishSendError(input: SendMessageInput, error: unknown): void {
    const sessionId = input.sessionId;
    sendingSessionIdsRef.current.delete(sessionId);
    setSendingSessionIds(new Set(sendingSessionIdsRef.current));
    setPendingTurns((current) => current.filter((turn) => turn.sessionId !== sessionId));
    pendingMessageKeyRef.current.delete(sessionId);
    if (input.fromNewSession
        && selectionRef.current?.sessionId === sessionId
        && composerRef.current.trim().length === 0) {
      const attachments = input.frozenAttachments ?? input.attachments ?? [];
      const content = input.frozenContent ?? input.content;
      const restoredAttachments: PendingAttachment[] = attachments.map((attachment, index) => ({
        ...attachment,
        orderIndex: index,
        status: 'READY',
        previewDataUrl: isImageAttachment(attachment.mediaType)
          ? `data:${attachment.mediaType};base64,${attachment.dataBase64}`
          : undefined
      }));
      setComposer(content);
      setPendingAttachments(restoredAttachments);
      const restoredIntent: FrozenSendIntent = {
        generation: draftGenerationRef.current,
        content,
        attachments,
        createKey: crypto.randomUUID(),
        messageKey: input.clientMessageId ?? crypto.randomUUID(),
        sessionId
      };
      composerIntentRef.current = restoredIntent;
      setComposerIntent(restoredIntent);
    }
    const explained = describeInputProblem(error);
    if (explained) {
      setBanner(`发送失败：${explained}`);
    } else if (isRequestTimeout(error)) {
      // A transport timeout means the outcome is unknown, not failed:
      // look up the original request before offering a retry.
      setBanner('发送超时，正在确认服务是否已接收…');
      void reconcileSendOutcome(input);
    } else {
      setBanner(`发送失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function startSendMessage(input: SendMessageInput): void {
    if (sendingSessionIdsRef.current.has(input.sessionId)) return;
    const frozenComposer = composerIntentRef.current?.sessionId === input.sessionId
      ? composerIntentRef.current : null;
    const content = frozenComposer?.content ?? input.content;
    const attachments = frozenComposer?.attachments ?? input.attachments ?? [];
    const messageKey = frozenComposer?.messageKey
      ?? input.clientMessageId
      ?? pendingMessageKeyRef.current.get(input.sessionId)
      ?? crypto.randomUUID();
    const generation = frozenComposer?.generation ?? draftGenerationRef.current;
    if (!frozenComposer) {
      const nextIntent: FrozenSendIntent = {
        generation,
        content,
        attachments,
        createKey: crypto.randomUUID(),
        messageKey,
        sessionId: input.sessionId
      };
      composerIntentRef.current = nextIntent;
      setComposerIntent(nextIntent);
    }
    pendingMessageKeyRef.current.set(input.sessionId, messageKey);
    sendingSessionIdsRef.current.add(input.sessionId);
    setSendingSessionIds(new Set(sendingSessionIdsRef.current));
    setPendingTurns((current) => [
      ...current.filter((turn) => turn.sessionId !== input.sessionId),
      { sessionId: input.sessionId, content, startedAt: Date.now(), clientMessageId: messageKey }
    ]);
    sendMessage.mutate({
      ...input,
      content,
      attachments,
      clientMessageId: messageKey,
      frozenContent: content,
      frozenAttachments: attachments,
      frozenGeneration: generation,
      // The selection present at submit time freezes into this message;
      // later composer changes never retro-edit an in-flight send.
      extensions: input.extensions ?? extensionSelectionRef.current
    });
  }

  // 长输入设计 §5.1/§6.2：文件先占位，再异步预读；占位携带稳定
  // orderIndex，避免 FileReader 完成顺序改变模型输入顺序。
  const handleAttachmentPicked = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const generation = draftGenerationRef.current;
    const picked = Array.from(files);
    const available = textInputLimits.attachmentMaxCount - pendingAttachments.length;
    if (picked.length > available) {
      setBanner(`附件超出上限（最多 ${textInputLimits.attachmentMaxCount} 个），超出部分未加入。`);
    }
    picked.slice(0, Math.max(0, available)).forEach((file) => {
      const declared = file.type || 'text/plain';
      const lower = declared.toLowerCase();
      const textLike = lower === 'text/plain' || lower === 'text/markdown'
        || file.name.toLowerCase().endsWith('.txt') || file.name.toLowerCase().endsWith('.md');
      const imageLike = isImageAttachment(lower);
      if (!textLike && !(imageLike && canSendImage)) {
        setBanner(imageLike
          ? '当前服务未声明图片模型输入能力，图片未加入。'
          : declared === 'application/pdf'
            ? '暂不支持 PDF 附件：服务端没有对应的模型输入通道。'
            : '仅支持文本附件（.txt/.md）以及 capability 已开放的 PNG/JPEG 图片。');
        return;
      }
      if (file.size > ATTACHMENT_MAX_BYTES) {
        setBanner(`附件 ${file.name} 超过单个 ${ATTACHMENT_MAX_BYTES / 1024} KiB 上限，未加入。`);
        return;
      }
      if (hasUnsafeAttachmentName(file.name)) {
        setBanner(`附件名 ${file.name} 含路径分隔符或控制字符，已拒绝。`);
        return;
      }
      const mediaType = imageLike ? lower : lower === 'text/markdown' || file.name.toLowerCase().endsWith('.md')
        ? 'text/markdown'
        : 'text/plain';
      const clientAttachmentId = crypto.randomUUID();
      const orderIndex = attachmentOrderRef.current++;
      const placeholder: PendingAttachment = {
        clientAttachmentId,
        name: file.name,
        mediaType,
        dataBase64: '',
        orderIndex,
        status: 'READING'
      };
      setPendingAttachments((current) => [...current, placeholder].sort((a, b) => a.orderIndex - b.orderIndex));
      const reader = new FileReader();
      reader.onload = () => {
        if (draftGenerationRef.current !== generation) return;
        try {
          const dataUrl = String(reader.result ?? '');
          const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
          const decodedBytes = Math.floor((base64.length * 3) / 4);
          if (decodedBytes > ATTACHMENT_MAX_BYTES) {
            setPendingAttachments((current) => current.map((item) => item.clientAttachmentId === clientAttachmentId
              ? { ...item, status: 'ERROR', error: 'size' } : item));
            setBanner(`附件 ${file.name} 解码后超过 ${ATTACHMENT_MAX_BYTES / 1024} KiB 上限，未加入。`);
            return;
          }
          setPendingAttachments((current) => {
            const next = current.map((item) => item.clientAttachmentId === clientAttachmentId
              ? { ...item, dataBase64: base64, previewDataUrl: imageLike ? dataUrl : undefined, status: 'READY' as const, error: undefined }
              : item);
            const totalBytes = next.reduce((sum, entry) => sum + Math.floor((entry.dataBase64.length * 3) / 4), 0);
            if (totalBytes > textInputLimits.attachmentTotalMaxBytes) {
              setBanner(`附件合计超过 ${textInputLimits.attachmentTotalMaxBytes / 1024} KiB 上限，本次附件未加入。`);
              return current.map((item) => item.clientAttachmentId === clientAttachmentId
                ? { ...item, status: 'ERROR' as const, error: 'total' } : item);
            }
            return next;
          });
        } catch {
          setPendingAttachments((current) => current.map((item) => item.clientAttachmentId === clientAttachmentId
            ? { ...item, status: 'ERROR', error: 'read' } : item));
          setBanner(`附件 ${file.name} 读取失败，未加入。`);
        }
      };
      reader.onerror = () => {
        if (draftGenerationRef.current !== generation) return;
        setPendingAttachments((current) => current.map((item) => item.clientAttachmentId === clientAttachmentId
          ? { ...item, status: 'ERROR', error: 'read' } : item));
        setBanner(`附件 ${file.name} 读取失败，未加入。`);
      };
      reader.readAsDataURL(file);
    });
  }, [canSendImage, pendingAttachments.length, textInputLimits]);

  const removePendingAttachment = useCallback((clientAttachmentId: string) => {
    setPendingAttachments((current) => current.filter((item) => item.clientAttachmentId !== clientAttachmentId));
  }, []);

  const pendingAttachmentsReady = pendingAttachments.every((attachment) => attachment.status === 'READY');
  const pendingWireAttachments = pendingAttachments.filter((attachment) => attachment.status === 'READY').map(toAttachmentWire);

  const appendReadyAttachment = useCallback((attachment: AttachmentWire) => {
    const orderIndex = attachmentOrderRef.current++;
    setPendingAttachments((current) => {
      if (current.length >= textInputLimits.attachmentMaxCount) {
        setBanner(`附件超出上限（最多 ${textInputLimits.attachmentMaxCount} 个），未加入。`);
        return current;
      }
      const next: PendingAttachment[] = [...current, {
        ...attachment,
        orderIndex,
        status: 'READY'
      }];
      const totalBytes = next.reduce((sum, entry) => sum + Math.floor((entry.dataBase64.length * 3) / 4), 0);
      if (totalBytes > textInputLimits.attachmentTotalMaxBytes) {
        setBanner(`附件合计超过 ${textInputLimits.attachmentTotalMaxBytes / 1024} KiB，本次附件未加入。`);
        return current;
      }
      return next.sort((a, b) => a.orderIndex - b.orderIndex);
    });
  }, [textInputLimits]);

  const handleAttachmentDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    handleAttachmentPicked(event.dataTransfer.files);
  }, [handleAttachmentPicked]);

  const handleAttachmentPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (event.clipboardData.files.length === 0) return;
    event.preventDefault();
    handleAttachmentPicked(event.clipboardData.files);
  }, [handleAttachmentPicked]);

  // EW10.2: fetch a read-only Web/issue/docs source through the Java Host
  // adapter. The service gates this behind the readOnlySources flag and marks
  // every payload untrustedContent=true; the renderer displays the text as
  // plain text only and never renders it as HTML or markdown.
  const fetchSourceM = useMutation({
    mutationFn: async (input: { sourceType: 'WEB' | 'ISSUE' | 'DOCS'; uri: string }) => {
      return unwrap(
        await window.codeAgentDesktop.fetchSource({ sourceType: input.sourceType, uri: input.uri })
      ) as SourceFetchLike;
    },
    onSuccess: (data) => {
      setSourceDisabled(false);
      setSourceUri('');
      setFetchedSources((current) => [data, ...current].slice(0, 4));
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('FEATURE_DISABLED')) {
        setSourceDisabled(true);
        setBanner('外部来源暂时不可用。');
      } else {
        setBanner(`来源读取失败：${message}`);
      }
    }
  });

  /** Attach fetched source text as a bounded text attachment (EW10.1 path). */
  const attachSource = useCallback((source: SourceFetchLike) => {
    const text = source.contentText;
    if (!text) return;
    appendReadyAttachment({
      clientAttachmentId: crypto.randomUUID(),
      name: sourceAttachmentName(source.finalUri ?? source.sourceUri ?? ''),
      mediaType: source.contentType === 'text/markdown' ? 'text/markdown' : 'text/plain',
      dataBase64: base64OfText(text)
    });
  }, [appendReadyAttachment]);

  const forkSession = useMutation({
    mutationFn: async (sessionId: string) => {
      const sessionData = unwrap(await window.codeAgentDesktop.getSession(sessionId)) as {
        sessionVersion: number;
      };
      return unwrap(
        await window.codeAgentDesktop.forkSession(sessionId, {
          expectedSessionVersion: sessionData.sessionVersion,
          copyPolicy: 'MESSAGES_ONLY'
        })
      );
    },
    onSuccess: (_data, sessionId) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      const forked = _data as { sessionId?: string };
      if (forked.sessionId) selectSession(forked.sessionId);
      void sessionId;
    },
    onError: (err) => setBanner(`Fork 失败：${String(err)}`)
  });

  const archiveSession = useMutation({
    mutationFn: async (sessionId: string) => {
      const sessionData = unwrap(await window.codeAgentDesktop.getSession(sessionId)) as {
        sessionVersion: number;
      };
      return unwrap(
        await window.codeAgentDesktop.archiveSession(sessionId, {
          expectedSessionVersion: sessionData.sessionVersion,
          reason: 'archived from workbench'
        })
      );
    },
    onSuccess: () => {
      setSelection(null);
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (err) => setBanner(`归档失败：${String(err)}`)
  });

  const renameSessionM = useMutation({
    mutationFn: async (input: { sessionId: string; title: string }) => {
      const sessionData = unwrap(await window.codeAgentDesktop.getSession(input.sessionId)) as {
        sessionVersion: number;
      };
      return unwrap(
        await window.codeAgentDesktop.patchSession(input.sessionId, {
          expectedSessionVersion: sessionData.sessionVersion,
          title: input.title
        })
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setRenamingSessionId(null);
    },
    onError: (err) => setBanner(`重命名失败：${String(err)}`)
  });

  const reviseSpecM = useMutation({
    mutationFn: async () => {
      const spec = specQuery.data;
      if (!spec) throw new Error('NO_SPEC');
      return unwrap(
        await window.codeAgentDesktop.reviseSpec(spec.specId, {
          expectedRevision: spec.revision,
          goal: specReviseGoal.trim() || undefined
        })
      );
    },
    onSuccess: () => {
      setSpecReviseOpen(false);
      setSpecReviseGoal('');
      void queryClient.invalidateQueries({ queryKey: ['specs'] });
    },
    onError: governanceError
  });

  const createFixTaskM = useMutation({
    mutationFn: async (finding: { findingId: string; file?: string | null; line?: number | null; message?: string | null }) => {
      const where = `${finding.file ?? ''}${finding.line != null ? `:${finding.line}` : ''}`.trim();
      const goal = `修复评审发现：${[where, finding.message].filter(Boolean).join(' ')}`.slice(0, 2000);
      return unwrap(
        await window.codeAgentDesktop.createFixTask(finding.findingId, {
          workspaceAlias: currentWorkspace,
          goal
        })
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
    onError: (err) => setBanner(`创建修复任务失败：${String(err)}`)
  });

  const session = historyDetail.session;
  const workspaceRoot = sessionWorkspaceRoot(session);
  const composerTargetModel = (modelCatalog.data?.items ?? []).find((entry) =>
    modelCatalogEntryMatches(entry, composerModelAlias)
  ) ?? (modelCatalog.data?.items ?? []).find((entry) => modelCatalogEntryMatches(entry, modelCatalog.data?.defaultModel));
  const composerReasoningOptions = composerTargetModel?.reasoningEffortOptions ?? [];
  const composerContextOptions = composerTargetModel?.contextTokenOptions ?? [];

  useEffect(() => {
    const settings = session?.modelSettings ?? {};
    setComposerModelAlias(settings.modelAlias ?? session?.modelAlias ?? null);
    setComposerReasoningMode(settings.reasoningMode === 'OFF' || settings.reasoningMode === 'EFFORT'
      ? settings.reasoningMode : 'DEFAULT');
    setComposerReasoningOptionId(settings.reasoningOptionId ?? null);
    const presetMode = settings.contextMode === 'PRESET' || settings.contextMode === 'CUSTOM';
    setComposerContextMode(presetMode ? 'PRESET' : 'AUTO');
    setComposerContextPresetId(settings.contextPresetId
      ?? (presetMode && settings.contextMaxTokens != null ? String(settings.contextMaxTokens) : null));
  }, [selection?.sessionId, session?.modelAlias, session?.modelSettings]);

  const adoptComposerSettings = useCallback((updated: {
    modelAlias?: string | null;
    modelSettings?: SessionModelSettings | null;
  }) => {
    const settings = updated.modelSettings ?? {};
    setComposerModelAlias(settings.modelAlias ?? updated.modelAlias ?? null);
    setComposerReasoningMode(settings.reasoningMode === 'OFF' || settings.reasoningMode === 'EFFORT'
      ? settings.reasoningMode : 'DEFAULT');
    setComposerReasoningOptionId(settings.reasoningOptionId ?? null);
    const presetMode = settings.contextMode === 'PRESET' || settings.contextMode === 'CUSTOM';
    setComposerContextMode(presetMode ? 'PRESET' : 'AUTO');
    setComposerContextPresetId(settings.contextPresetId
      ?? (presetMode && settings.contextMaxTokens != null ? String(settings.contextMaxTokens) : null));
  }, []);

  const patchComposerSettings = useCallback((changes: Partial<SessionModelSettings>) => {
    if (!selection || !session) return;
    // The local value is authoritative while a patch is in flight; the
    // session detail query may still contain the previous alias for a moment.
    const currentModelAlias = composerModelAlias;
    const requestedModelAlias = changes.modelAlias === undefined ? currentModelAlias : changes.modelAlias ?? null;
    const modelChanged = changes.modelAlias !== undefined && requestedModelAlias !== currentModelAlias;
    const base = session.modelSettings ?? {};
    const nextReasoningMode = (modelChanged ? 'DEFAULT' : (changes.reasoningMode ?? composerReasoningMode)) as 'DEFAULT' | 'OFF' | 'EFFORT';
    const nextReasoningOptionId = nextReasoningMode === 'EFFORT'
      ? (changes.reasoningOptionId ?? (modelChanged ? null : composerReasoningOptionId) ?? composerReasoningOptions[0] ?? null)
      : null;
    const nextContextMode = (modelChanged ? 'AUTO' : (changes.contextMode ?? composerContextMode)) as 'AUTO' | 'PRESET';
    const nextContextPresetId = nextContextMode === 'PRESET'
      ? (changes.contextPresetId ?? (modelChanged ? null : composerContextPresetId))
      : null;
    patchSessionModel.mutate({
      sessionId: selection.sessionId,
      modelAlias: requestedModelAlias,
      expectedSessionVersion: session.sessionVersion,
      modelSettings: {
        providerId: modelChanged ? null : (changes.providerId ?? base.providerId ?? null),
        modelAlias: requestedModelAlias,
        catalogRevision: modelChanged ? null : (changes.catalogRevision ?? base.catalogRevision ?? null),
        reasoningMode: nextReasoningMode,
        reasoningOptionId: nextReasoningOptionId,
        reasoningBudgetTokens: null,
        contextMode: nextContextMode,
        contextPresetId: nextContextPresetId,
        contextMaxTokens: null,
        outputMode: 'AUTO',
        outputMaxTokens: null
      }
    }, {
      onSuccess: adoptComposerSettings,
      onError: governanceError
    });
  }, [adoptComposerSettings, composerContextMode, composerContextPresetId, composerModelAlias, composerReasoningMode,
    composerReasoningOptionId, composerReasoningOptions, governanceError, patchSessionModel,
    selection, session]);

  const handleComposerModelChange = useCallback((modelAlias: string | null) => {
    if (composerModelAlias === modelAlias) return;
    patchComposerSettings({ modelAlias });
  }, [composerModelAlias, patchComposerSettings]);

  const handleComposerReasoningChange = useCallback((mode: 'DEFAULT' | 'OFF' | 'EFFORT', optionId?: string | null) => {
    patchComposerSettings({
      reasoningMode: mode,
      reasoningOptionId: mode === 'EFFORT' ? (optionId ?? composerReasoningOptions[0] ?? null) : null
    });
  }, [composerReasoningOptions, patchComposerSettings]);

  const handleComposerContextChange = useCallback((mode: 'AUTO' | 'PRESET', presetId?: string | null) => {
    patchComposerSettings({
      contextMode: mode,
      contextPresetId: mode === 'PRESET' ? presetId ?? null : null
    });
  }, [patchComposerSettings]);
  const specQuery = useSpec(specId);

  const attentionItems = attention.data ?? [];
  const selectedProject = selectedWorkspaceAlias
    ? (projects.data ?? []).find((project) => project.workspaceAlias === selectedWorkspaceAlias)
    : undefined;
  const workspaceName = selection
    ? (session?.workspaceAlias ?? '未选择工作区')
    : (selectedProject?.displayName ?? '普通对话');

  const allSessions = historySessions.sessions;
  // Startup recovery is deliberately renderer-side navigation only.  The
  // Service has already recovered/queued the durable Run; selecting its
  // session here makes the activity visible, while the global reminder below
  // remains usable even when no session is selected.
  useEffect(() => {
    if (startupRecoveryDoneRef.current || historySessions.isPending || runs.isPending) return;
    const recoveredRun = (runs.data ?? []).find((run) =>
      isApprovalWaiting(run) || isAuthorizationExpiredRun(run));
    const saved = persistedWorkbenchStateRef.current;
    const targetSessionId = recoveredRun?.sessionId
      ?? (preferencesQuery.data?.restoreLastSurface ? saved.sessionId : null);
    if (targetSessionId && allSessions.some((item) => item.sessionId === targetSessionId)) {
      selectSession(targetSessionId);
    } else if (!recoveredRun && personalChannelAvailable && preferencesQuery.data?.restoreLastSurface && saved.nativeTaskId) {
      selectNativeTask(saved.nativeTaskId);
    } else if (!recoveredRun && preferencesQuery.data?.restoreLastSurface && saved.activeSurface) {
      setActiveSurface(saved.activeSurface);
    }
    startupRecoveryDoneRef.current = true;
  }, [allSessions, historySessions.isPending, personalChannelAvailable, preferencesQuery.data?.restoreLastSurface, runs.data, runs.isPending]);

  useEffect(() => {
    if (!startupRecoveryDoneRef.current) return;
    persistWorkbenchState({
      sessionId: selection?.sessionId ?? null,
      nativeTaskId: nativeSelection?.taskId ?? null,
      activeSurface
    });
  }, [activeSurface, nativeSelection?.taskId, selection?.sessionId]);

  // “进行中” is reserved for runs consuming an execution slot. Queued,
  // paused, and approval-waiting runs remain visible in the activity list but
  // must not inflate the active execution count.
  const activeRuns = (runs.data ?? []).filter((run) => run.state === 'RUNNING');
  // Design 2026-09-30 §5.1.7: the tray lists every run, capped to 3 (8 expanded).
  const trayRuns = [...activeRuns, ...(runs.data ?? []).filter((run) => !activeRuns.some((active) => active.runId === run.runId))];
  const visibleTrayRuns = activityTrayExpanded ? trayRuns.slice(0, 8) : trayRuns.slice(0, 3);
  const activityRuns = (runs.data ?? []).filter((run) =>
    run.state === 'RUNNING'
    || run.state === 'QUEUED'
    || run.state === 'PAUSED'
    || isApprovalWaiting(run)
  );
  const filteredSessions = useMemo(() => allSessions.filter((item) => showArchived || item.status !== 'ARCHIVED'), [allSessions, showArchived]);
  // Single session list: running sessions float to the top, marked by the
  // status dot. No separate RUNNING / RECENT groups.
  const orderedSessions = useMemo(() => {
    const running = filteredSessions.filter((item) => sessionStatusView(item, runs.data ?? [], attentionItems).active);
    const runningIds = new Set(running.map((item) => item.sessionId));
    return [...running, ...filteredSessions.filter((item) => !runningIds.has(item.sessionId))];
  }, [filteredSessions, runs.data, attentionItems]);
  const pinnedSessionIds = useMemo(
    () => new Set(sidebarNavigation.pinnedSessionIds),
    [sidebarNavigation.pinnedSessionIds]
  );
  const pinnedSessions = useMemo(
    () => orderedSessions.filter((item) => pinnedSessionIds.has(item.sessionId)),
    [orderedSessions, pinnedSessionIds]
  );
  const unpinnedSessions = useMemo(
    () => orderedSessions.filter((item) => !pinnedSessionIds.has(item.sessionId)),
    [orderedSessions, pinnedSessionIds]
  );
  const projectGroups = useMemo(() => {
    const grouped = new Map<string, typeof orderedSessions>();
    for (const item of unpinnedSessions) {
      const key = item.workspaceAlias?.trim() || '';
      if (!key) continue;
      const current = grouped.get(key) ?? [];
      current.push(item);
      grouped.set(key, current);
    }
    const knownWorkspaceAliases = new Set<string>();
    const workspaceGroups = (projects.data ?? []).map((project) => {
      knownWorkspaceAliases.add(project.workspaceAlias);
      return {
        key: `workspace:${project.workspaceAlias}`,
        title: project.displayName ?? project.workspaceAlias,
        workspaceAlias: project.workspaceAlias,
        sessions: grouped.get(project.workspaceAlias) ?? []
      };
    });
    const unregisteredWorkspaceGroups = [...grouped.entries()]
      .filter(([workspaceAlias]) => workspaceAlias.length > 0 && !knownWorkspaceAliases.has(workspaceAlias))
      .map(([workspaceAlias, sessions]) => ({
        key: `workspace:${workspaceAlias}`,
        title: workspaceAlias,
        workspaceAlias,
        sessions
      }));
    return [
      ...workspaceGroups,
      ...unregisteredWorkspaceGroups
    ];
  }, [projects.data, unpinnedSessions]);
  const recentSessions = useMemo(
    () => unpinnedSessions,
    [unpinnedSessions]
  );
  // Design 2026-09-30 §5.1: workspace-less sessions get their own group in the
  // projects view so the rail never drops a session (S2).
  const chatSessions = useMemo(
    () => unpinnedSessions.filter((item) => !item.workspaceAlias?.trim()),
    [unpinnedSessions]
  );
  const recentGroups = useMemo(() => {
    const DAY_MS = 86_400_000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today = startOfDay.getTime();
    const groups: Array<{ key: string; label: string; items: typeof unpinnedSessions }> = [
      { key: 'today', label: '今天', items: [] },
      { key: 'yesterday', label: '昨天', items: [] },
      { key: 'week', label: '近 7 天', items: [] },
      { key: 'earlier', label: '更早', items: [] }
    ];
    for (const item of unpinnedSessions) {
      const ts = typeof item.updatedAt === 'number' ? item.updatedAt : 0;
      const index = ts >= today ? 0 : ts >= today - DAY_MS ? 1 : ts >= today - 7 * DAY_MS ? 2 : 3;
      groups[index]?.items.push(item);
    }
    return groups.filter((group) => group.items.length > 0);
  }, [unpinnedSessions]);
  // U7.3 (R3): sessions sharing one title inside the same project get a
  // distinguishing second line — newest run state first, recency fallback.
  const duplicateTitleIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of allSessions) {
      const key = `${item.workspaceAlias ?? ''}${item.title ?? ''}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set(
      allSessions
        .filter((item) => (counts.get(`${item.workspaceAlias ?? ''}${item.title ?? ''}`) ?? 0) > 1)
        .map((item) => item.sessionId)
    );
  }, [allSessions]);
  const sessionHasRuns = useMemo(() => {
    const ids = new Set<string>();
    for (const run of runs.data ?? []) if (run.sessionId) ids.add(run.sessionId);
    return ids;
  }, [runs.data]);
  const selectedSessionStatus = session ? sessionStatusView(session, runs.data ?? [], attentionItems) : null;
  const selectedRun = (runs.data ?? []).find((run) => run.runId === selectedRunId);
  const relatedRun = selectedRun ?? (runs.data ?? []).find((run) => run.sessionId === selection?.sessionId);
  const runProjectAlias = useCallback((run: RunLike): string | null => projectForAliases(
    run.workspaceAlias,
    run.sessionId ? sessionAliasById.get(run.sessionId) : null,
    session?.workspaceAlias
  )?.workspaceAlias ?? null, [projectForAliases, sessionAliasById, session]);
  const currentWorkspace = session?.workspaceAlias ?? newSessionWorkspaceAlias;
  const ordinaryPendingApproval = session?.pendingCommandApproval ?? null;
  const projectFileQuery = useProjectFile(selectedFileProjectId, selectedFileRef);
  const sessionRuns = (runs.data ?? []).filter((run) => run.sessionId === selection?.sessionId);
  const preferredActiveRun = session?.activeRunId
    ? sessionRuns.find((run) => run.runId === session.activeRunId
      && !['COMPLETED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'TIMED_OUT', 'ABORTED', 'REJECTED', 'TERMINAL', 'NEEDS_ATTENTION'].includes(run.state))
    : undefined;
  const selectedActiveRunId = preferredActiveRun?.runId ?? sessionRuns.find((run) =>
    run.state === 'RUNNING' || run.state === 'QUEUED' || run.state === 'PAUSED' || isApprovalWaiting(run))?.runId;
  const selectedActiveRun = selectedActiveRunId ? (runs.data ?? []).find((run) => run.runId === selectedActiveRunId) : undefined;
  const selectedRunIsLive = Boolean(selectedActiveRunId && selectedActiveRun?.state !== 'PAUSED');
  // U2 §6.4: newest terminal run of this session feeds the composer diff strip.
  const latestTerminalRun = sessionRuns
    .filter((run) => RUN_TERMINAL_STATES.has(run.state))
    .sort((a, b) => String(b.finishedAt ?? b.updatedAt ?? b.startedAt ?? '').localeCompare(String(a.finishedAt ?? a.updatedAt ?? a.startedAt ?? '')))[0];
  useEffect(() => {
    const now = Date.now();
    for (const run of runs.data ?? []) {
      if ((run.state === 'RUNNING' || run.state === 'QUEUED' || isApprovalWaiting(run))
          && !runStartedAtRef.current.has(run.runId)) {
        runStartedAtRef.current.set(run.runId, now);
      }
    }
    if (selectedActiveRunId && !runStartedAtRef.current.has(selectedActiveRunId)) {
      runStartedAtRef.current.set(selectedActiveRunId, now);
    }
  }, [runs.data, selectedActiveRunId]);
  const runClock = useRunDisplayClock(Boolean(selectedRunIsLive
    || pendingTurns.some((turn) => turn.sessionId === selection?.sessionId)
    || ordinaryPendingApproval
    || newSessionStartedAt !== null));
  const pendingTurnForSession = pendingTurns.find((turn) => turn.sessionId === selection?.sessionId) ?? null;
  const pendingTurnAlreadyInHistory = Boolean(pendingTurnForSession
    && (session?.messages ?? []).some((message) => message.role === 'user'
      && (message.clientMessageId === pendingTurnForSession.clientMessageId
        || (message.clientMessageId == null && message.content === pendingTurnForSession.content))));
  const showPendingTurn = Boolean(pendingTurnForSession && !pendingTurnAlreadyInHistory);
  const ordinaryTurnActive = (session?.messages ?? []).some(message =>
    message.role === 'user' && !message.runId && message.status === 'RUNNING');
  const sendingSelectedSession = Boolean(
    selection?.sessionId && (sendingSessionIds.has(selection.sessionId) || ordinaryTurnActive)
  );
  const composerRunActive = Boolean(selectedActiveRun && (selectedActiveRun.state === 'RUNNING' || selectedActiveRun.state === 'QUEUED'));
  // While this session has a live run the send button becomes a stop
  // control — including approval waits, which are stoppable server-side
  // (interrupt denies the parked latches and terminates the turn).
  const composerStoppableRun = selectedActiveRun && (composerRunActive || isApprovalWaiting(selectedActiveRun))
    ? selectedActiveRun
    : undefined;
  // Approval waits are rendered in the selected conversation. A background
  // run may still raise a lightweight reminder, but the reminder never owns
  // approval controls or duplicates the conversation card.
  const sessionWaitingRuns = (runs.data ?? []).filter((run) =>
    run.sessionId === selection?.sessionId
    && isApprovalWaiting(run));
  const ordinaryApprovalRun = ordinaryPendingApproval?.runId && selection ? {
    runId: ordinaryPendingApproval.runId,
    taskId: '',
    state: 'WAITING_APPROVAL',
    stateVersion: 0,
    sessionId: selection.sessionId
  } : null;
  const unifiedApprovalEndpoints = {
    decide: operationAvailable(props.capabilities, 'approval.decide', false)
      && typeof window.codeAgentDesktop.decideApproval === 'function',
    advance: operationAvailable(props.capabilities, 'approval.advance', false)
      && typeof window.codeAgentDesktop.advanceApproval === 'function',
    control: operationAvailable(props.capabilities, 'approval.control', false)
      && typeof window.codeAgentDesktop.controlApproval === 'function'
  };
  const automationControlAvailable = operationAvailable(props.capabilities, 'automation.control', false)
    && typeof window.codeAgentDesktop.getAutomationControl === 'function'
    && typeof window.codeAgentDesktop.controlAutomation === 'function';
  // requiresUserAction is the authoritative "needs a human" flag (semantics-2):
  // automatically-resolved records never surface as reminders. Older services
  // that omit the field fall back to the raw status checks.
  const unifiedPendingApprovals = (unifiedApprovals.data?.items ?? []).filter((approval) =>
    approval.sessionId === selection?.sessionId
    && (approval.decisionStatus === 'PENDING' || approval.decisionStatus === 'WAITING_DELAY'
      || approval.executionStatus === 'UNKNOWN')
    && approval.requiresUserAction !== false);
  // Fingerprint of the pending request a run would display right now. WRITE
  // resolves through its pending projection, an expired sandbox request
  // carries no decidable fingerprint, and command/budget waits resolve
  // through the sandbox/terminal projections or the attention item.
  const pendingApprovalFingerprint = (run: RunLike): string | null => {
    const isBudgetApproval = run.sourceStatus === 'WAITING_BUDGET_APPROVAL' || run.state === 'WAITING_BUDGET_APPROVAL';
    if (!isBudgetApproval) {
      const writePending = pendingWriteApprovals.data?.[run.runId] ?? null;
      if (writePending) {
        return typeof writePending.fingerprint === 'string' ? writePending.fingerprint : null;
      }
      const sandboxPending = pendingSandboxApprovals.data?.[run.runId] ?? null;
      if (isExpiredSandboxApproval(sandboxPending)) return null;
      const projected = sandboxPending?.fingerprint
        ?? (pendingTerminalApprovals.data?.[run.runId] ?? null)?.fingerprint;
      if (projected) return projected;
    }
    const approvalAttention = attentionItems.find((a) => a.sourceId === run.runId);
    return (approvalAttention as { fingerprint?: string | null } | undefined)?.fingerprint ?? null;
  };
  // True when the request this run would display is the one whose decision
  // the Service already accepted: its card closes at once while a different
  // pending request on the same run still renders. A missing fingerprint is
  // ambiguous, so it falls back to the submitted state rather than hiding.
  const decidedRequestHidden = (run: RunLike): boolean => {
    if (!approvalSyncingRunIds.has(run.runId)) return false;
    const mark = decidedApprovalMarks.current.get(run.runId);
    if (mark === undefined) return false;
    const fingerprint = pendingApprovalFingerprint(run);
    return fingerprint !== null && mark === `fp:${fingerprint}`;
  };
  const renderLegacyApproval = (run: RunLike): React.JSX.Element | null => {
    const isBudgetApproval = run.sourceStatus === 'WAITING_BUDGET_APPROVAL' || run.state === 'WAITING_BUDGET_APPROVAL';
    const writePending = isBudgetApproval ? null : (pendingWriteApprovals.data?.[run.runId] ?? null);
    const sandboxPending = isBudgetApproval ? null : (pendingSandboxApprovals.data?.[run.runId] ?? null);
    const terminalPending = isBudgetApproval ? null : (pendingTerminalApprovals.data?.[run.runId] ?? null);
    const approvalAttention = attentionItems.find((a) => a.sourceId === run.runId);
    const sandboxExpired = isExpiredSandboxApproval(sandboxPending);
    const isSandboxApproval = Boolean(sandboxPending)
      || (approvalAttention as { attentionType?: string } | undefined)?.attentionType === 'SANDBOX_APPROVAL';
    const isTerminalApproval = Boolean(terminalPending)
      || (approvalAttention as { attentionType?: string } | undefined)?.attentionType === 'TERMINAL_APPROVAL';
    const approvalKind: ApprovalKind = writePending ? 'WRITE' : isSandboxApproval ? 'SANDBOX' : isTerminalApproval ? 'TERMINAL' : isBudgetApproval ? 'BUDGET' : 'COMMAND';
    const approvalFingerprint = approvalKind === 'WRITE' ? undefined
      : sandboxExpired ? undefined
      : sandboxPending?.fingerprint
        ?? terminalPending?.fingerprint
        ?? (approvalAttention as { fingerprint?: string | null } | undefined)?.fingerprint;
    const terminalCommand = terminalPending
      ? [terminalPending.executable, ...(terminalPending.arguments ?? [])]
        .filter((part) => part != null && String(part).length > 0).join(' ')
      : null;
    const terminalSummary = terminalPending
      ? `Agent 请求打开终端：${terminalCommand || terminalPending.executable} · 目录 ${terminalPending.workingDirectory || '.'} · ${terminalPending.profile || 'DIRECT_PROCESS'}`
      : null;
    const sandboxSummary = sandboxPending && !sandboxExpired
      ? `sandbox_shell：${sandboxPending.scriptRedactedPreview || '已提交受控脚本'} · ${sandboxPending.backendType || 'OCI'} · 隔离 ${sandboxPending.isolationLevel || 'CONTAINER_RESTRICTED'} · 网络 ${sandboxPending.networkPolicy || 'none'}`
      : null;
    if (sandboxExpired || isAuthorizationExpiredRun(run)) {
      return <AuthorizationExpiredCard
        key={run.runId}
        run={run}
        kind={approvalKind}
        reasonCode={sandboxExpired ? sandboxPending.reasonCode : run.failureCode ?? run.terminationCode ?? run.reasonCode ?? 'APPROVAL_EXPIRED'}
        message={sandboxExpired ? sandboxPending.message : run.failureMessage ?? '这次授权已失效，旧请求不能继续使用。'}
      />;
    }
    if (decidedRequestHidden(run)) return null;
    const requestFingerprint = pendingApprovalFingerprint(run);
    const decidedMark = decidedApprovalMarks.current.get(run.runId);
    const decisionPending = (decideApproval.isPending && decideApproval.variables?.runId === run.runId)
      || (approvalSyncingRunIds.has(run.runId)
        && (decidedMark === undefined || requestFingerprint === null || decidedMark === `fp:${requestFingerprint}`));
    return <ApprovalCard key={run.runId} run={run} kind={approvalKind} summary={sandboxSummary ?? terminalSummary ?? approvalAttention?.summary ?? null} fingerprintReady={Boolean(approvalFingerprint)} writePending={(writePending ?? null) as { path?: string; operation?: string; reason?: string; toolName?: string; taskScopeEntries?: string[] } | null} pending={decisionPending} waitingSeconds={waitingSeconds(run.runId)} fresh={freshApprovalRunId === run.runId} onDecide={(decision) => decideApproval.mutate({ runId: run.runId, kind: approvalKind, decision, fingerprint: requestFingerprint ?? undefined })} />;
  };
  const selectedApprovalRun = (runs.data ?? []).find((run) =>
    run.sessionId === selection?.sessionId
    && (isApprovalWaiting(run) || isAuthorizationExpiredRun(run))
    && !decidedRequestHidden(run));
  // Mirrors the inline card's source of truth: unified queue when the decide
  // endpoint exists, legacy waiting runs otherwise — never a sum of both.
  const sessionPendingApprovalCount = unifiedApprovalEndpoints.decide
    ? unifiedPendingApprovals.length
    : (runs.data ?? []).filter((run) => run.sessionId === selection?.sessionId && isApprovalWaiting(run)).length;
  const selectedUnifiedApproval = unifiedPendingApprovals[0];
  // A decision for this exact approvalId may still be syncing while a newer
  // pending request on the same run is already visible — only the decided
  // record stays non-actionable.
  const unifiedDecidedMark = selectedUnifiedApproval?.runId
    ? decidedApprovalMarks.current.get(selectedUnifiedApproval.runId)
    : undefined;
  const unifiedApprovalPending = Boolean(selectedUnifiedApproval?.runId
    && approvalSyncingRunIds.has(selectedUnifiedApproval.runId)
    && (unifiedDecidedMark === undefined || unifiedDecidedMark === `id:${selectedUnifiedApproval.approvalId}`))
    || (unifiedDecisionM.isPending && unifiedDecisionM.variables?.approval.approvalId === selectedUnifiedApproval?.approvalId);
  const selectedApprovalCard = selectedUnifiedApproval && unifiedApprovalEndpoints.decide
    ? /^D[1-4]/.test(selectedUnifiedApproval.riskCategory)
      ? <DangerApprovalPanel
          approval={selectedUnifiedApproval}
          available={unifiedApprovalEndpoints}
          pending={unifiedApprovalPending}
          onDecide={(item, decision) => unifiedDecisionM.mutate({ approval: item, decision })}
          onAdvance={(item) => unifiedAdvanceM.mutate({ approval: item })}
          onControl={(item, control) => unifiedControlM.mutate({ approval: item, control })}
        />
      : <UnifiedApprovalCard
          approval={selectedUnifiedApproval}
          available={unifiedApprovalEndpoints}
          pending={unifiedApprovalPending}
          onDecide={(item, decision) => unifiedDecisionM.mutate({ approval: item, decision })}
          onAdvance={(item) => unifiedAdvanceM.mutate({ approval: item })}
          onControl={(item, control) => unifiedControlM.mutate({ approval: item, control })}
        />
    : selectedApprovalRun ? renderLegacyApproval(selectedApprovalRun) : null;
  const selectedVisibleOutput = selectedActiveRunId ? visibleOutputs.get(selectedActiveRunId) : undefined;
  const selectedVisibleReasoning = selectedActiveRunId ? visibleReasonings.get(selectedActiveRunId) : undefined;

  // ---- Run activity timeline (design 2026-09-02 §11.2/§11.3) ----
  const canReadActivities = operationAvailable(
    props.capabilities,
    'run.activity.read',
    props.capabilities ? false : true
  );
  const activeActivitySnapshot = useRunActivities(canReadActivities ? (selectedActiveRunId ?? null) : null, {
    live: selectedRunIsLive && pollFallback
  });
  // Reasoning mirrors the activity read family: the journal snapshot is the
  // authoritative fold, the SSE reducer provides lower-latency live chunks.
  const activeReasoningSnapshot = useRunReasoning(canReadActivities ? (selectedActiveRunId ?? null) : null, {
    live: selectedRunIsLive && pollFallback
  });
  // Per-round visible output (design 2026-09-19 §5.5-B): same gating as
  // reasoning — a bounded live poll plus the terminal refetch.
  const activeOutputSnapshot = useRunOutput(canReadActivities ? (selectedActiveRunId ?? null) : null, {
    live: selectedRunIsLive && pollFallback
  });
  useEffect(() => {
    const snapshot: RunActivitySnapshot | undefined = activeActivitySnapshot.data;
    if (!snapshot) return;
    setLiveActivities((previous) => mergeActivitySnapshot(previous, snapshot));
    if (snapshot.items.length > 0) {
      setLastActivityObservedAt((previous) => {
        const next = new Map(previous);
        next.set(snapshot.runId, Date.now());
        return next;
      });
    }
  }, [activeActivitySnapshot.data]);
  // Historical assistant turns load when their row mounts (the virtual
  // window bounds this to the visible band): a finished run keeps its
  // collapsed process panel, and once a snapshot is merged it renders from
  // cache without refetching.
  const mergeHistoricalSnapshot = useCallback((snapshot: RunActivitySnapshot) => {
    setLiveActivities((previous) => mergeActivitySnapshot(previous, snapshot));
  }, []);
  const activitiesByRun = useMemo(() => {
    const out = new Map<string, RunActivity[]>();
    for (const runId of liveActivities.keys()) {
      const items = activitiesOf(liveActivities, runId);
      if (items.length > 0) out.set(runId, items);
    }
    return out;
  }, [liveActivities]);
  const activeRunActivities = selectedActiveRunId
    ? (activitiesByRun.get(selectedActiveRunId) ?? [])
    : [];
  const currentRunApprovalPending = Boolean(
    ordinaryApprovalRun
    || (selectedActiveRun && isApprovalWaiting(selectedActiveRun))
    || (selectedActiveRunId && unifiedPendingApprovals.some((approval) => approval.runId === selectedActiveRunId))
  );
  const currentRunBudgetApprovalPending = Boolean(
    selectedActiveRun && (selectedActiveRun.state === 'WAITING_BUDGET_APPROVAL'
      || selectedActiveRun.sourceStatus === 'WAITING_BUDGET_APPROVAL')
    || (selectedActiveRunId && unifiedPendingApprovals.some((approval) => approval.runId === selectedActiveRunId
      && approval.kind === 'BUDGET'))
  );
  const selectedLastObservedAt = selectedActiveRunId
    ? Math.max(lastActivityObservedAt.get(selectedActiveRunId) ?? 0, selectedVisibleOutput?.lastUpdatedAt ?? 0) || null
    : null;
  const runDisplayModel = useMemo(() => deriveRunDisplayModel({
    sessionId: selection?.sessionId ?? '',
    run: selectedActiveRun ?? null,
    activities: activeRunActivities,
    visibleOutput: selectedVisibleOutput ?? null,
    approvalPending: currentRunApprovalPending,
    budgetApprovalPending: currentRunBudgetApprovalPending,
    connection,
    resyncing,
    stopRequested: selectedActiveRunId ? stopRequestedRunIds.has(selectedActiveRunId) : false,
    submitting: Boolean(pendingTurnForSession),
    nowMs: runClock,
    observedStartedAt: selectedActiveRunId ? runStartedAtRef.current.get(selectedActiveRunId) ?? null : null,
    activitiesAvailable: canReadActivities,
    loadedActivityCount: activeRunActivities.length,
    activityHistoryComplete: activeActivitySnapshot.data?.complete !== false,
    activityHistoryReason: activeActivitySnapshot.data?.reasonCode ?? null,
    lastContentObservedAt: selectedLastObservedAt
  }), [activeActivitySnapshot.data?.complete, activeActivitySnapshot.data?.reasonCode, activeRunActivities, canReadActivities,
    connection, currentRunApprovalPending, currentRunBudgetApprovalPending, pendingTurnForSession,
    lastActivityObservedAt, resyncing, runClock, selectedActiveRun, selectedActiveRunId, selectedLastObservedAt, selectedVisibleOutput,
    selection?.sessionId, stopRequestedRunIds]);
  // The server snapshot has no run while a send is still in flight, so the
  // header must echo the client-side SUBMITTING phase instead of reading 就绪.
  const headerSessionStatus = runDisplayModel.phase === 'SUBMITTING'
    ? { label: '正在提交…', tone: 'info' as const, active: true, attention: false }
    : selectedSessionStatus;
  const messageRunIds = useMemo(() => new Set(
    (session?.messages ?? [])
      .map((message) => message.runId)
      .filter((runId): runId is string => typeof runId === 'string' && runId.length > 0)
  ), [session?.messages]);
  // A terminal run may not have produced an assistant message (for example a
  // preflight or transport failure). Keep that failure visible in the same
  // conversation path without attaching it to an unrelated turn.
  const unboundRunFailures = useMemo(() => (runs.data ?? []).filter((run) =>
    run.sessionId === selection?.sessionId && run.failure != null && !messageRunIds.has(run.runId)
  ), [messageRunIds, runs.data, selection?.sessionId]);

  const openActivityFile = useCallback((fileRef: string, startLine?: number | null, runId?: string): void => {
    // Clicking a file ref only opens the in-app read-only preview dialog —
    // it must NOT trigger the OS file-open path (that surfaced a system
    // "open with" picker for extensionless file associations). Locating the
    // file in the OS file manager stays on the dialog's 定位文件 button.
    const run = (runs.data ?? []).find((r) => r.runId === (runId ?? selectedRunId));
    // Same rule as handleReveal: an unknown run — or a run bound to an
    // isolated worktree alias — falls back to the session's own workspace
    // alias, never to an arbitrary registered project.
    const project = projectForAliases(
      run?.workspaceAlias,
      run?.sessionId ? sessionAliasById.get(run.sessionId) : null,
      session?.workspaceAlias
    );
    if (!project) {
      setBanner('无法确定项目，未能打开文件。');
      return;
    }
    setSelectedFileProjectId(project.projectId);
    setSelectedFileRef(fileRef);
    setSelectedFileLine(typeof startLine === 'number' && Number.isInteger(startLine) && startLine >= 1 ? startLine : null);
  }, [runs.data, selectedRunId, session, projectForAliases, sessionAliasById]);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  const [conversationUnpinned, setConversationUnpinned] = useState(false);
  const conversationScrollFrameRef = useRef<{ id: number; raf: boolean } | null>(null);
  // 2026-09-05 design §7.3: older pages prepend; the height delta restores the
  // reading position, and exactly one automatic around-rebuild follows a 409.
  const pendingHistoryHeightRef = useRef<number | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const loadedMessageCount = session?.messages?.length ?? 0;
  useEffect(() => {
    const previousHeight = pendingHistoryHeightRef.current;
    if (previousHeight === null) return;
    pendingHistoryHeightRef.current = null;
    const container = conversationScrollRef.current;
    if (container) container.scrollTop = container.scrollHeight - previousHeight;
  }, [loadedMessageCount]);
  const handleLoadOlder = useCallback(async () => {
    if (!historyDetail.loadOlder) return;
    const container = conversationScrollRef.current;
    if (container) pendingHistoryHeightRef.current = container.scrollHeight;
    const result = await historyDetail.loadOlder();
    if (result === 'revision-changed') {
      const firstVisibleId = historyDetail.session?.messages?.[0]?.id ?? null;
      if (firstVisibleId && historyDetail.recoverAround) {
        historyDetail.recoverAround(firstVisibleId);
        setHistoryNotice('历史内容已更新，已按当前位置重新定位。');
      } else {
        setHistoryNotice('历史内容已更新，刷新后继续加载。');
      }
    } else if (result === 'error') {
      pendingHistoryHeightRef.current = null;
      setHistoryNotice('更早消息加载失败，可重试。');
    }
  }, [historyDetail]);
  const scrollConversationToBottom = useCallback(() => {
    const container = conversationScrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, []);
  const scheduleConversationScroll = useCallback(() => {
    if (conversationScrollFrameRef.current !== null) return;
    const follow = (): void => {
      conversationScrollFrameRef.current = null;
      if (pinnedToBottomRef.current) scrollConversationToBottom();
    };
    if (typeof window.requestAnimationFrame === 'function') {
      conversationScrollFrameRef.current = { id: window.requestAnimationFrame(follow), raf: true };
    } else {
      conversationScrollFrameRef.current = { id: window.setTimeout(follow, 32), raf: false };
    }
  }, [scrollConversationToBottom]);
  useEffect(() => () => {
    const pending = conversationScrollFrameRef.current;
    if (pending === null) return;
    if (pending.raf && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(pending.id);
    else window.clearTimeout(pending.id);
    conversationScrollFrameRef.current = null;
  }, []);
  // Jump to the newest turn whenever the open conversation (re)mounts.
  useEffect(() => {
    pinnedToBottomRef.current = true;
    setConversationUnpinned(false);
    scrollConversationToBottom();
  }, [selection?.sessionId, selection?.generation, scrollConversationToBottom]);
  const transcriptSignature = useMemo(() => {
    const messages = session?.messages ?? [];
    const last = messages[messages.length - 1];
    return `${selection?.sessionId ?? ''}:${messages.length}:${last ? `${last.id}:${last.content?.length ?? 0}` : ''}`;
  }, [session?.messages, selection?.sessionId]);
  // Follow the growing transcript/stream only while the user stays pinned
  // near the bottom; never yank the view if they scrolled up to read.
  useEffect(() => {
    if (pinnedToBottomRef.current) scheduleConversationScroll();
  }, [transcriptSignature, selectedVisibleOutput?.text.length, selectedVisibleReasoning?.lastUpdatedAt,
    selectedLastObservedAt, scheduleConversationScroll]);
  const chooseProject = useCallback(() => {
    void window.codeAgentDesktop.chooseAndRegisterProject().then((result) => {
      if (!result.registered && result.reason === 'cancelled') return;
      if (result.registered) {
        if (result.projectId) setSelectedWorkspaceAlias(result.projectId);
        setBanner(`项目已注册：${result.displayName ?? result.projectId ?? '已更新'}`);
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      } else {
        setBanner(`项目未注册：${result.reason ?? '服务拒绝或未知原因'}`);
      }
    }).catch((error: unknown) => setBanner(`项目注册失败：${error instanceof Error ? error.message : String(error)}`));
  }, [queryClient]);

  const toggleSidebarSection = (section: SidebarSectionKey): void => {
    setSidebarNavigation((current) => ({
      ...current,
      collapsedSections: {
        ...current.collapsedSections,
        [section]: !current.collapsedSections[section]
      }
    }));
  };

  const toggleProjectGroup = (workspaceAlias: string): void => {
    setSidebarNavigation((current) => {
      // Design 2026-09-30 §5.1.1: an untouched group expands only when it owns
      // the selected session, so the toggle must invert the effective state.
      const expanded = current.collapsedProjects[workspaceAlias] === undefined
        ? workspaceAlias === session?.workspaceAlias
        : !current.collapsedProjects[workspaceAlias];
      return {
        ...current,
        collapsedProjects: { ...current.collapsedProjects, [workspaceAlias]: expanded }
      };
    });
  };

  const toggleChatsGroup = (): void => {
    setSidebarNavigation((current) => {
      const expanded = current.collapsedSections.chats === undefined
        ? Boolean(selection && !session?.workspaceAlias)
        : !current.collapsedSections.chats;
      return {
        ...current,
        collapsedSections: { ...current.collapsedSections, chats: expanded }
      };
    });
  };

  const setSidebarView = (view: SidebarView): void => {
    setSidebarNavigation((current) => ({ ...current, view }));
  };

  const collapseAllProjects = (): void => {
    setSidebarNavigation((current) => ({
      ...current,
      collapsedProjects: Object.fromEntries(
        projectGroups.map((group) => [group.workspaceAlias, true])
      ),
      collapsedSections: { ...current.collapsedSections, chats: true }
    }));
  };

  const togglePinnedSession = (sessionId: string): void => {
    setSidebarNavigation((current) => {
      const pinned = new Set(current.pinnedSessionIds);
      if (pinned.has(sessionId)) pinned.delete(sessionId);
      else pinned.add(sessionId);
      return { ...current, pinnedSessionIds: [...pinned] };
    });
  };

  const renderSessionRow = (item: typeof allSessions[number], options?: { showWorkspace?: boolean }): React.JSX.Element => {
    const status = sessionStatusView(item, runs.data ?? [], attentionItems);
    const title = item.title ?? item.sessionId.slice(0, 8);
    // Quiet rows: Ready / Completed show only title + preview. States needing
    // action are marked by the status dot alone — no text label.
    const quiet = !status.attention && (status.tone === 'neutral' || status.tone === 'success');
    const preview = sessionPreview(item);
    const recency = relativeTimeLabel(item.updatedAt);
    // Design 2026-09-30 §5.1.2: line 1 = dot + title + recency;
    // line 2 = [workspace ·] preview, only when content exists.
    // U7.3: duplicated titles inside one project prepend a distinguishing
    // phrase — newest run state first, relative time as fallback.
    const disambiguator = duplicateTitleIds.has(item.sessionId)
      ? (sessionHasRuns.has(item.sessionId) ? status.label : recency)
      : null;
    const subtitle = [
      disambiguator,
      options?.showWorkspace ? (item.workspaceAlias?.trim() || '普通对话') : null,
      preview
    ].filter(Boolean).join(' · ');
    return (
      <li key={item.sessionId}>
        <div className="session-row-shell">
          <button
            type="button"
            className={`session-row${quiet ? ' quiet' : ''} ${selection?.sessionId === item.sessionId ? 'selected' : ''}`}
            aria-current={selection?.sessionId === item.sessionId ? 'page' : undefined}
            title={[title, quiet ? null : status.label, preview].filter(Boolean).join(' · ')}
            onClick={() => selectSession(item.sessionId)}
          >
            {!quiet ? <span className={`session-status-dot tone-${status.tone}`} role="img" aria-label={status.label} /> : null}
            <span className="session-row-copy">
              <span className="session-row-title-row">
                {renamingSessionId === item.sessionId ? (
                  <input
                    className="session-row-rename"
                    data-testid="session-rename-input"
                    value={renameDraft}
                    autoFocus
                    aria-label="会话名称"
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Enter' && renameDraft.trim()) {
                        renameSessionM.mutate({ sessionId: item.sessionId, title: renameDraft.trim() });
                      } else if (event.key === 'Escape') {
                        setRenamingSessionId(null);
                      }
                    }}
                    onBlur={() => setRenamingSessionId(null)}
                  />
                ) : (
                  <span className="session-row-title">{title}</span>
                )}
                {recency ? <span className="session-row-time">{recency}</span> : null}
              </span>
              {subtitle ? (
                <span className="session-row-subtitle">{subtitle}</span>
              ) : null}
            </span>
          </button>
          <span className="session-row-actions">
          <button
            type="button"
            className={`session-row-menu${pinnedSessionIds.has(item.sessionId) ? ' is-pinned' : ''}`}
            title={pinnedSessionIds.has(item.sessionId) ? '取消置顶' : '置顶会话'}
            aria-label={pinnedSessionIds.has(item.sessionId) ? '取消置顶' : '置顶'}
            onClick={(event) => {
              event.stopPropagation();
              togglePinnedSession(item.sessionId);
            }}
          >
            <Icon name="pin" size={12} />
          </button>
          <button
            type="button"
            className="session-row-menu"
            title="会话操作"
            aria-label="会话操作"
            aria-haspopup="menu"
            aria-expanded={sessionMenu?.sessionId === item.sessionId}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setSessionMenu((current) => current?.sessionId === item.sessionId
                ? null
                : { sessionId: item.sessionId, top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
            }}
          >
            <Icon name="more" size={12} />
          </button>
          </span>
        </div>
      </li>
    );
  };

  /** ECN-001: a management-gateway native task row. The source name/project
   * stay display labels; authority lives behind the task detail binding. */
  const renderNativeTaskRow = (item: PersonalTaskIndex): React.JSX.Element => {
    const title = item.displayName ?? `原生任务 · ${item.taskId.slice(0, 8)}`;
    const updatedAt = Date.parse(item.updatedAt ?? '');
    const recency = Number.isFinite(updatedAt) ? relativeTimeLabel(updatedAt) : null;
    const engineLabel = item.core === 'PI' ? 'Pi' : item.core === 'CODEX' ? 'Codex' : item.core === 'MACOS' ? 'Mac' : item.core === 'CODEP' ? 'Codep' : '原生';
    const subtitle = item.accepted ? engineLabel : `${engineLabel} · 提交待核对`;
    return (
      <li key={item.taskId}>
        <div className="session-row-shell">
          <button
            type="button"
            className={`session-row quiet ${nativeSelection?.taskId === item.taskId ? 'selected' : ''}`}
            aria-current={nativeSelection?.taskId === item.taskId ? 'page' : undefined}
            title={title}
            onClick={() => selectNativeTask(item.taskId)}
            data-testid={`native-task-row-${item.taskId}`}
          >
            <span className="session-row-copy">
              <span className="session-row-title-row">
                <span className="session-row-title">{title}</span>
                {recency ? <span className="session-row-time">{recency}</span> : null}
              </span>
              <span className="session-row-subtitle">{subtitle}</span>
            </span>
          </button>
        </div>
      </li>
    );
  };

  const approvalReminderRun = approvalReminderRunId
    ? (runs.data ?? []).find((run) => run.runId === approvalReminderRunId
      && (isApprovalWaiting(run) || isAuthorizationExpiredRun(run)))
    : undefined;
  const approvalReminderSession = approvalReminderRun?.sessionId
    ? allSessions.find((item) => item.sessionId === approvalReminderRun.sessionId)
    : undefined;
  const approvalReminderSandbox = approvalReminderRun
    ? pendingSandboxApprovals.data?.[approvalReminderRun.runId] ?? null
    : null;
  const approvalReminderExpired = Boolean(approvalReminderRun
    && (isAuthorizationExpiredRun(approvalReminderRun) || isExpiredSandboxApproval(approvalReminderSandbox)));

  // Design 2026-09-30 §4.3: the frame title names the page the user is looking at.
  const titleBarTitle = activeSurface === 'SETTINGS' ? '设置'
    : activeSurface === 'ATTENTION' ? '待处理'
    : activeSurface === 'PERSONAL_ACCESS' ? '个人接入'
    : activeSurface === 'NATIVE_DIAGNOSTICS' ? '原生任务'
    : selectedPane && activeSurface === 'WORKSPACE'
      ? (selectedPane === 'GIT' ? 'Git'
        : selectedPane === 'EVIDENCE' ? '证据'
        : selectedPane === 'PLAN' ? '计划'
        : selectedPane === 'MISSION' ? '任务编排'
        : selectedPane === 'DETAILS' ? '会话详情'
        : selectedPane === 'TERMINAL' ? '终端面板'
        : '活动')
      : selection ? `${session?.title ?? '会话'} · ${session?.agentProfileName ?? '默认智能体'}`
        : nativeSelection ? '原生任务' : '新会话';

  return (
    <div
      className={`workbench ${sessionRailCollapsed ? 'rail-collapsed' : ''} ${activeSurface === 'SETTINGS' ? 'surface-settings' : ''} ${(selectedPane || directoryPanelOpen || approvalSettingsOpen || activityPanelOpen || exportPanelOpen) ? 'pane-open' : ''} density-${(appearance?.density ?? density).toLowerCase()}`}
      data-theme={resolvedTheme}
      data-reduce-motion={resolvedReduceMotion}
      style={{
        ...(appearance && appearance.uiScalePercent !== 100 ? { zoom: appearance.uiScalePercent / 100 } : {}),
        ...(appearance ? { '--code-font-size': `${appearance.codeFontSizePx}px` } : {})
      } as React.CSSProperties}
    >
      <DesktopTitleBar title={titleBarTitle} />
      {(connection !== 'CONNECTED' || banner !== null || serviceOffline) && <div className="banner" role="status"><span>{banner !== null ? banner : serviceOffline ? 'Service 未连接；会话与执行功能不可用' : `事件流：${connection}`}</span>{serviceOffline ? <button type="button" disabled={serviceRetryBusy} onClick={() => void retryService()}>{serviceRetryBusy ? '正在重试…' : '重试连接'}</button> : <button type="button" onClick={() => setBanner(null)}>关闭</button>}</div>}
      {approvalReminderOpen && approvalReminderRun && approvalReminderRun.sessionId !== selection?.sessionId ? (
        <ApprovalReminder
          runId={approvalReminderRun.runId}
          budgetApproval={approvalReminderRun.state === 'WAITING_BUDGET_APPROVAL' || approvalReminderRun.sourceStatus === 'WAITING_BUDGET_APPROVAL'}
          expired={approvalReminderExpired}
          sessionTitle={approvalReminderSession?.title ?? null}
          canOpenSession={Boolean(approvalReminderSession)}
          onOpenSession={() => { if (approvalReminderSession) selectSession(approvalReminderSession.sessionId); setApprovalReminderOpen(false); }}
          onDismiss={() => setApprovalReminderOpen(false)}
        />
      ) : null}

      <div className="app-layout">
        <aside className="session-rail" id="workspace-nav" aria-label="会话栏">
          <div className="rail-topline">
            <button type="button" className={`new-session-trigger ${selection === null && activeSurface === 'WORKSPACE' ? 'open' : ''}`} aria-label="新建会话…" onClick={startNewSession}><Icon name="plus" size={15} /><span>新建会话</span><kbd>Ctrl N</kbd></button>
            <div className="rail-menu">
              <button type="button" className="icon-button rail-menu-trigger" title="更多会话栏操作" aria-label="更多会话栏操作" aria-haspopup="menu" aria-expanded={railMenuOpen} onClick={() => setRailMenuOpen((open) => !open)}><Icon name="more" size={15} /></button>
              {railMenuOpen ? (
                <>
                  <div className="pane-menu-backdrop" onMouseDown={() => setRailMenuOpen(false)} />
                  <div className="rail-menu-popover" role="menu">
                    <div className="rail-menu-view" role="radiogroup" aria-label="会话栏视图" data-testid="sidebar-view-toggle">
                      <button type="button" role="radio" aria-checked={sidebarNavigation.view === 'PROJECTS'} className={sidebarNavigation.view === 'PROJECTS' ? 'selected' : ''} data-testid="sidebar-view-projects" onClick={() => { setSidebarView('PROJECTS'); setRailMenuOpen(false); }}>按项目</button>
                      <button type="button" role="radio" aria-checked={sidebarNavigation.view === 'RECENT'} className={sidebarNavigation.view === 'RECENT' ? 'selected' : ''} data-testid="sidebar-view-recent" onClick={() => { setSidebarView('RECENT'); setRailMenuOpen(false); }}>按时间</button>
                    </div>
                    <label className="rail-menu-check" role="menuitemcheckbox" aria-checked={showArchived}>
                      <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
                      显示已归档
                    </label>
                    <button type="button" role="menuitem" onClick={() => { collapseAllProjects(); setRailMenuOpen(false); }}>全部折叠项目</button>
                  </div>
                </>
              ) : null}
            </div>
            <button type="button" className="icon-button" title="折叠会话栏" aria-label="折叠会话栏" onClick={() => setSessionRailCollapsed((collapsed) => !collapsed)}><Icon name="panel" size={15} /></button>
          </div>
          <div className="session-groups" data-testid="sidebar-navigation">
            <section className="rail-section rail-section-pinned" data-testid="sidebar-section-pinned" aria-label="置顶">
              {pinnedSessions.length > 0 ? (
                <>
                  <div className="rail-section-heading-row">
                    <button type="button" className="rail-section-heading" aria-expanded={!sidebarNavigation.collapsedSections.pinned} aria-controls="sidebar-pinned-items" onClick={() => toggleSidebarSection('pinned')}>
                      <span className="rail-section-heading-label"><span className="rail-section-chevron" aria-hidden="true">{sidebarNavigation.collapsedSections.pinned ? '▸' : '▾'}</span><Icon name="pin" size={12} />置顶</span>
                      <span className="section-count">{pinnedSessions.length}</span>
                    </button>
                  </div>
                  {!sidebarNavigation.collapsedSections.pinned
                    ? <ul className="session-list" id="sidebar-pinned-items">{pinnedSessions.map((item) => renderSessionRow(item, { showWorkspace: sidebarNavigation.view === 'RECENT' }))}</ul>
                    : null}
                </>
              ) : null}
            </section>

            {sidebarNavigation.view === 'PROJECTS' ? (
              <section className="rail-section rail-section-projects" data-testid="sidebar-section-projects" aria-label="项目">
                <div className="rail-section-heading-row">
                  <button type="button" className="rail-section-heading" aria-expanded={!sidebarNavigation.collapsedSections.projects} aria-controls="sidebar-project-items" onClick={() => toggleSidebarSection('projects')}>
                    <span className="rail-section-heading-label"><span className="rail-section-chevron" aria-hidden="true">{sidebarNavigation.collapsedSections.projects ? '▸' : '▾'}</span><Icon name="folder" size={12} />项目</span>
                    <span className="section-count">{projectGroups.length}</span>
                  </button>
                  <button type="button" className="rail-section-action" title="注册项目" aria-label="注册项目" onClick={chooseProject}><Icon name="plus" size={13} /></button>
                </div>
                {!sidebarNavigation.collapsedSections.projects ? <div className="project-groups" id="sidebar-project-items">
                  {projectGroups.map((group) => {
                    // Design 2026-09-30 §5.1.1: never-touched groups expand only when
                    // they own the selected session; everything else stays collapsed.
                    const expanded = sidebarNavigation.collapsedProjects[group.workspaceAlias] === undefined
                      ? group.workspaceAlias === session?.workspaceAlias
                      : !sidebarNavigation.collapsedProjects[group.workspaceAlias];
                    const listId = `project-sessions-${group.workspaceAlias.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
                    return (
                      <div className={`project-group${expanded ? ' is-expanded' : ' is-collapsed'}`} key={group.key}>
                        <div className="project-row">
                          <button type="button" className="project-row-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => toggleProjectGroup(group.workspaceAlias)}>
                            <span className="project-row-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                            <Icon name="folder" size={13} />
                            <span className="project-row-title">{group.title}</span>
                            <span className="section-count">{group.sessions.length}</span>
                          </button>
                          <button type="button" className="session-group-add" title={`在 ${group.title} 新建会话`} aria-label={`在 ${group.title} 新建会话`} onClick={() => startNewSessionForWorkspace(group.workspaceAlias)}><Icon name="plus" size={12} /></button>
                        </div>
                        {expanded ? (group.sessions.length > 0
                          ? <ul className="session-list project-session-list" id={listId}>{group.sessions.map((item) => renderSessionRow(item))}</ul>
                          : <p className="empty session-group-empty" id={listId}>暂无会话</p>) : null}
                      </div>
                    );
                  })}
                  {chatSessions.length > 0 ? (() => {
                    const expanded = sidebarNavigation.collapsedSections.chats === undefined
                      ? Boolean(selection && !session?.workspaceAlias)
                      : !sidebarNavigation.collapsedSections.chats;
                    return (
                      <div className={`project-group${expanded ? ' is-expanded' : ' is-collapsed'}`} data-testid="sidebar-section-chats">
                        <div className="project-row">
                          <button type="button" className="project-row-toggle" aria-expanded={expanded} aria-controls="sidebar-chats-items" onClick={toggleChatsGroup}>
                            <span className="project-row-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                            <Icon name="chat" size={13} />
                            <span className="project-row-title">普通对话</span>
                            <span className="section-count">{chatSessions.length}</span>
                          </button>
                          <button type="button" className="session-group-add" title="在普通对话新建会话" aria-label="在普通对话新建会话" onClick={() => startNewSessionForWorkspace(null)}><Icon name="plus" size={12} /></button>
                        </div>
                        {expanded ? <ul className="session-list project-session-list" id="sidebar-chats-items">{chatSessions.map((item) => renderSessionRow(item))}</ul> : null}
                      </div>
                    );
                  })() : null}
                  {projectGroups.length === 0 && chatSessions.length === 0 ? <p className="empty session-group-empty">暂无项目</p> : null}
                </div> : null}
              </section>
            ) : (
              <section className="rail-section rail-section-recent" data-testid="sidebar-section-recent" aria-label="最近">
                <div className="rail-section-heading-row">
                  <button type="button" className="rail-section-heading" aria-expanded={!sidebarNavigation.collapsedSections.recent} aria-controls="sidebar-recent-items" onClick={() => toggleSidebarSection('recent')}>
                    <span className="rail-section-heading-label"><span className="rail-section-chevron" aria-hidden="true">{sidebarNavigation.collapsedSections.recent ? '▸' : '▾'}</span><Icon name="clock" size={12} />最近</span>
                    <span className="section-count">{recentSessions.length}</span>
                  </button>
                </div>
                {!sidebarNavigation.collapsedSections.recent ? (recentGroups.length > 0
                  ? <div id="sidebar-recent-items">
                    {recentGroups.map((group) => (
                      <div className="recent-group" key={group.key}>
                        <div className="recent-group-label">{group.label}</div>
                        <ul className="session-list">{group.items.map((item) => renderSessionRow(item, { showWorkspace: true }))}</ul>
                      </div>
                    ))}
                  </div>
                  : <p className="empty session-group-empty" id="sidebar-recent-items">暂无最近会话</p>) : null}
              </section>
            )}

            {personalChannelAvailable ? (
              <section className="rail-section rail-section-native" data-testid="sidebar-section-native" aria-label="原生任务">
                <div className="rail-section-heading-row">
                  <button type="button" className="rail-section-heading" aria-expanded={!sidebarNavigation.collapsedSections.native} aria-controls="sidebar-native-items" onClick={() => toggleSidebarSection('native')}>
                    <span className="rail-section-heading-label"><span className="rail-section-chevron" aria-hidden="true">{sidebarNavigation.collapsedSections.native ? '▸' : '▾'}</span><Icon name="chat" size={12} />原生任务</span>
                    <span className="section-count">{nativeTasks.items.length}</span>
                  </button>
                  <button type="button" className="rail-section-action" title="新建原生任务" aria-label="新建原生任务" onClick={() => { startNewSession(); setNewConversationSource('NATIVE'); }}><Icon name="plus" size={13} /></button>
                </div>
                {!sidebarNavigation.collapsedSections.native ? (nativeTasks.items.length > 0
                  ? <ul className="session-list" id="sidebar-native-items" data-testid="native-task-list">{nativeTasks.items.map((item) => renderNativeTaskRow(item))}</ul>
                  : <p className="empty session-group-empty" id="sidebar-native-items">{nativeTasks.error ?? '暂无原生任务'}</p>) : null}
              </section>
            ) : null}

            {historySessions.channel === 'paginated' && historySessions.hasMore ? (
              <button type="button" className="session-load-more" data-testid="session-load-more"
                disabled={historySessions.isLoadingMore}
                onClick={() => { if (historySessions.loadMore) historySessions.loadMore(); }}>
                {historySessions.isLoadingMore ? '正在加载会话…' : '加载更多会话'}
              </button>
            ) : null}
            {filteredSessions.length === 0 ? <p className="empty session-empty">{showArchived ? '没有匹配的会话。' : '尚无会话。'}</p> : null}
          </div>
          {trayRuns.length > 0 ? <details className="activity-tray" id="task-center" open={activityRuns.length > 0}>
            <summary className="activity-tray-heading"><span><Icon name="play" size={13} /> 活动</span><span>{activeRuns.length > 0 ? `${activeRuns.length} 进行中` : activityRuns.length > 0 ? `${activityRuns.length} 待处理` : `${trayRuns.length} 最近`}</span></summary>
            <ul className="run-list">
              {visibleTrayRuns.map((run) => {
                const owner = allSessions.find((item) => item.sessionId === run.sessionId);
                const ownerTitle = owner?.title ?? '未知会话';
                const workspaceShort = run.workspaceAlias ?? owner?.workspaceAlias ?? null;
                return <li key={run.runId} className={selectedRunId === run.runId ? 'selected' : ''}>
                  <button type="button" className="run-select" title={`${runStateLabel(run.state)} · run ${run.runId.slice(0, 8)}`} aria-label={`${runStateLabel(run.state)} · run ${run.runId.slice(0, 8)}`} onClick={() => { const next = selectedRunId === run.runId ? null : run.runId; if (next) openGitOverview(next); else { setSelectedRunId(null); setActiveSurface('WORKSPACE'); } }}>
                    <Icon name={runStateIconName(run.state)} size={14} className={`run-state-icon tone-${runStateTone(run.state)}${run.state === 'RUNNING' ? ' icon-loader' : ''}`} />
                    <span className="run-select-title">{ownerTitle}{workspaceShort ? ` · ${workspaceShort}` : ''}<span className="run-select-state">{runStateLabel(run.state)}</span></span>
                  </button>
                   {run.state === 'RUNNING' || run.state === 'WAITING_APPROVAL' || run.state === 'WAITING_BUDGET_APPROVAL' ? <span className="run-controls run-controls-hover"><button type="button" aria-label="中断" title="中断" onClick={() => requestStop(run.runId, run.stateVersion)} disabled={interruptRun.isPending || stopRequestedRunIds.has(run.runId)}><Icon name="stop" size={12} /></button></span> : run.state === 'QUEUED' ? <span className="run-controls"><button type="button" onClick={() => cancelRunM.mutate(run.runId)} disabled={cancelRunM.isPending}>取消排队</button></span> : run.state === 'PAUSED' ? <span className="run-controls"><button type="button" onClick={() => recoverRunM.mutate({ runId: run.runId, expectedStateVersion: run.stateVersion })} disabled={recoverRunM.isPending}>继续运行</button></span> : null}
                </li>;
              })}
            </ul>
            {!activityTrayExpanded && trayRuns.length > 3 ? (
              <button type="button" className="activity-tray-more" onClick={() => setActivityTrayExpanded(true)}>还有 {trayRuns.length - 3} 条 · 展开</button>
            ) : null}
          </details> : null}
          <nav className="rail-nav-bottom" aria-label="工作台导航">
            <button type="button" className="rail-nav-item" title="命令面板" aria-label="命令面板" onClick={() => setCommandPaletteOpen(true)}><Icon name="search" size={15} /></button>
            <button type="button" className={`rail-nav-item ${activeSurface === 'WORKSPACE' && selectedPane !== 'GIT' ? 'active' : ''}`} title="会话" aria-label="会话" onClick={() => setActiveSurface('WORKSPACE')}><Icon name="chat" size={15} /></button>
            <button type="button" className={`rail-nav-item ${activeSurface === 'GIT' || (activeSurface === 'WORKSPACE' && selectedPane === 'GIT') ? 'active' : ''}`} title="Git" aria-label="Git" onClick={() => openGitOverview(relatedRun?.runId)}><Icon name="file" size={15} /></button>
            <button type="button" className={`rail-nav-item ${activeSurface === 'MISSIONS' ? 'active' : ''}`} title="任务编排" aria-label="打开任务编排" onClick={() => setActiveSurface('MISSIONS')}><Icon name="list" size={15} /></button>
            <button type="button" className={`rail-nav-item ${activeSurface === 'EXTENSIONS' ? 'active' : ''}`} title="扩展" aria-label="打开扩展" onClick={() => setActiveSurface('EXTENSIONS')}><Icon name="puzzle" size={15} /></button>
            {attentionItems.length > 0 ? <button type="button" className={`rail-nav-item ${activeSurface === 'ATTENTION' ? 'active' : ''}`} title="待处理" aria-label={`待处理 ${attentionItems.length}`} onClick={() => setActiveSurface('ATTENTION')}><Icon name="alert" size={15} /><span className="attention-badge">{attentionItems.length}</span></button> : null}
            <button type="button" className={`rail-nav-item ${activeSurface === 'PERSONAL_ACCESS' ? 'active' : ''}`} title="个人接入" aria-label="个人接入" onClick={() => setActiveSurface('PERSONAL_ACCESS')}><Icon name="external" size={15} /></button>
            {personalChannelAvailable ? <button type="button" className={`rail-nav-item ${activeSurface === 'NATIVE_DIAGNOSTICS' ? 'active' : ''}`} title="原生任务诊断" aria-label="原生任务诊断" onClick={() => setActiveSurface('NATIVE_DIAGNOSTICS')}><Icon name="terminal" size={15} /></button> : null}
            <button type="button" className={`rail-nav-item ${activeSurface === 'SETTINGS' ? 'active' : ''}`} title="设置" aria-label="设置" onClick={() => setActiveSurface('SETTINGS')}><Icon name="settings" size={15} /></button>
          </nav>
        </aside>

        <main className={`session-workspace${workPaneDocked ? ' pane-docked' : ''}`} ref={sessionWorkspaceRef} style={{ '--pane-dock-width': `${paneWidth}px` } as React.CSSProperties}>
          {selection?.sessionId && activeSurface === 'WORKSPACE' ? <CollaborationPanel key={selection.sessionId} sessionId={selection.sessionId} runId={(selectedRun ?? selectedActiveRun)?.runId} open={collaborationOpenSession === selection.sessionId} onOpenChange={(next) => setCollaborationOpenSession(next ? selection.sessionId : null)} /> : null}
          {activityPanelOpen && activeSurface === 'WORKSPACE' ? <aside className="work-pane work-pane-floating activity-work-pane" aria-label="状态摘要面板"><ActivitySummaryPanel run={selectedRun ?? selectedActiveRun} project={selectedProject} sessionId={selection?.sessionId ?? null} canRead={canReadActivities} approvalSyncing={Boolean((selectedRun ?? selectedActiveRun) && approvalSyncingRunIds.has((selectedRun ?? selectedActiveRun)?.runId ?? ''))} onClose={() => setActivityPanelOpen(false)} onOpenGit={() => { if (relatedRun) openGitOverview(relatedRun.runId); }} onOpenBuildPlan={() => setBuildPlanOpen(true)} /></aside> : null}
          {/* §7.3 验证计划面板：dry-run 构建计划 + 受控 override 编辑。 */}
          {buildPlanOpen && activeSurface === 'WORKSPACE' ? <aside className="work-pane work-pane-floating build-plan-work-pane" aria-label="验证计划面板"><BuildPlanPanel projectId={selectedProject?.projectId ?? null} onClose={() => setBuildPlanOpen(false)} /></aside> : null}
          {activeSurface === 'GIT' ? <GitWorkspacePage
            runId={selectedRunId}
            activeTab={selectedRunId ? gitTabByRun[selectedRunId] ?? 'DIFF' : 'DIFF'}
            onTabChange={(tab) => { if (selectedRunId) setGitTabByRun((current) => ({ ...current, [selectedRunId]: tab })); }}
            stateLabel={selectedRun ? runStateLabel(selectedRun.state) : '状态待同步'}
            stateTone={runStateTone(selectedRun?.state ?? '')}
            workspaceAlias={selectedRun?.workspaceAlias ?? currentWorkspace ?? null}
            deliveryId={session?.workspaceBinding?.latestDeliveryId ?? null}
            deliveries={(() => { const p = projectForAliases(selectedRun?.workspaceAlias, currentWorkspace); return p ? <ProjectDeliveriesSection projectId={p.projectId} /> : null; })()}
            onBack={() => setActiveSurface('WORKSPACE')}
            onOpenEvidence={() => { if (selectedRunId) openPane('EVIDENCE', undefined, selectedRunId); }}
            diff={selectedRunId ? <GitChangesPage runId={selectedRunId} runState={selectedRun?.state} onReveal={handleReveal} revealPending={revealFileM.isPending} enabled={canReadDiff} unavailableReason={operationReason(props.capabilities, 'run.diff.read')} /> : null}
            workspace={selectedRunId ? (() => { const workspaceProject = projectForAliases(selectedRun?.workspaceAlias, currentWorkspace); if (!workspaceProject) return <div className="git-page-empty"><h2>未找到项目</h2><p>当前 Run 没有关联可用工作区。</p></div>; return <div className="git-worktree-page"><WorkspaceExecutions runId={selectedRunId} projectId={workspaceProject.projectId} runState={selectedRun?.state} onCreateWorktree={handleCreateWorktree} onHandoff={(execution: WorkspaceExecutionLike) => handoffWorkspaceM.mutate({ workspaceExecutionId: execution.workspaceExecutionId, expectedStateVersion: execution.stateVersion })} onReclaim={(execution: WorkspaceExecutionLike) => reclaimWorkspaceM.mutate({ workspaceExecutionId: execution.workspaceExecutionId, expectedStateVersion: execution.stateVersion })} pending={workspacePending} /></div>; })() : null}
          /> : null}
          {activeSurface === 'ATTENTION' ? <AttentionSurface items={attentionItems} onOpenSession={(sessionId) => { selectSession(sessionId); setActiveSurface('WORKSPACE'); }} />
            : activeSurface === 'MISSIONS' ? <MissionsSurface sessionId={selection?.sessionId ?? null} workspaceAlias={currentWorkspace} onDecide={(mission, decision) => missionDecideM.mutate({ mission, decision })} onCommand={(mission, command) => missionCommandM.mutate({ mission, command })} onCreate={(input) => missionCreateM.mutate({ sessionId: selection?.sessionId ?? '', title: input.title, goal: input.goal, workspaceAlias: currentWorkspace })} pending={missionCreateM.isPending || missionDecideM.isPending || missionCommandM.isPending} onBack={() => setActiveSurface('WORKSPACE')} onOpenSession={(sessionId) => { selectSession(sessionId); setActiveSurface('WORKSPACE'); }} />
            : activeSurface === 'SETTINGS' ? <SettingsSurface context={{
              capabilities: props.capabilities,
              protocolVersion: props.protocolVersion ?? null,
              connection,
              session,
              projects: projects.data ?? [],
              sessionActiveRun: selectedActiveRun && (selectedActiveRun.state === 'RUNNING' || selectedActiveRun.state === 'QUEUED')
                ? { runId: selectedActiveRun.runId, state: selectedActiveRun.state, primaryReason: selectedActiveRun.scheduling?.primaryReason ?? selectedActiveRun.reasonCode ?? null }
                : null,
              onOpenExtensions: () => setActiveSurface('EXTENSIONS'),
              onOpenSettingsRoute: openSettingsRoute
            }} onAppearancePreview={setAppearancePreview} routeRequest={settingsRouteRequest} onDone={() => setActiveSurface('WORKSPACE')} />
             : activeSurface === 'EXTENSIONS' ? <ExtensionsSurface mcpEnabled={props.capabilities ? props.capabilities.features.mcpReadOnlySource : true} skillsEnabled={props.capabilities ? props.capabilities.features.skillsCatalog : true} hooksEnabled={props.capabilities ? props.capabilities.features.hooks : true} onAttach={(input) => appendReadyAttachment({ clientAttachmentId: crypto.randomUUID(), name: input.name, mediaType: input.mediaType, dataBase64: base64OfText(input.text) })} onBack={() => setActiveSurface('WORKSPACE')} />
             : activeSurface === 'PERSONAL_ACCESS' ? <PersonalAccessPanel onBack={() => setActiveSurface('WORKSPACE')} />
             : activeSurface === 'NATIVE_DIAGNOSTICS' ? <PersonalNativeTasks onOpenTask={selectNativeTask} />
             : selection === null && nativeSelection !== null ? <NativeConversation key={`native:${nativeSelection.taskId}:${nativeSelection.generation}`} taskId={nativeSelection.taskId} sendShortcut={sendShortcut} />
             : selection === null ? <section className="new-session-workspace" aria-labelledby="new-session-title">
                <div className="new-session-intro">
                  <h1 id="new-session-title">{greetingForHour(new Date().getHours())}</h1>
                </div>
                <div className="new-session-source rail-menu-view" role="radiogroup" aria-label="会话来源" data-testid="new-session-source">
                  <button type="button" role="radio" aria-checked={newConversationSource === 'ACS' || !personalChannelAvailable} className={newConversationSource === 'ACS' || !personalChannelAvailable ? 'selected' : ''} onClick={() => setNewConversationSource('ACS')}>智能体会话</button>
                  <button type="button" role="radio" aria-checked={newConversationSource === 'NATIVE' && personalChannelAvailable} className={newConversationSource === 'NATIVE' && personalChannelAvailable ? 'selected' : ''} disabled={!personalChannelAvailable} title={personalChannelAvailable ? undefined : '未配置个人管理网关；接入后原生任务可用'} data-testid="new-session-source-native" onClick={() => setNewConversationSource('NATIVE')}>原生任务</button>
                </div>
                {newConversationSource === 'NATIVE' && personalChannelAvailable ? <NativeTaskLauncher onCreated={(taskId) => selectNativeTask(taskId)} /> : <>
                {createSession.isPending && newSessionStartedAt !== null ? <div className="run-progress-status new-session-progress" data-testid="new-session-progress" role="status"><span className="run-progress-elapsed">{formatRunElapsed(Math.max(0, Math.floor((runClock - newSessionStartedAt) / 1_000)))}</span></div> : null}
                <form className="new-session new-session-form" data-testid="new-session" onSubmit={(event) => { event.preventDefault(); createSession.mutate(); }}>
                  <div className="new-session-project"><span className="new-session-project-icon"><Icon name="folder" size={15} /></span>{((projects.data ?? []).length === 0 || newSessionWorkspaceAlias) ? <strong>{workspaceName}</strong> : null}{(projects.data ?? []).length > 0 ? <select aria-label="新会话项目" data-testid="new-session-project" value={newSessionWorkspaceAlias} onChange={(event) => { const alias = event.target.value || null; setSelectedWorkspaceAlias(alias); if (!alias) { setNewSessionAgentProfileId('default'); setNewSessionReadonlyResearchMode('OFF'); } }}><option value="">普通对话（不使用工作区）</option>{(projects.data ?? []).map((project) => <option key={project.workspaceAlias} value={project.workspaceAlias}>{project.displayName ?? project.workspaceAlias}</option>)}</select> : null}</div>
                 <div className="new-session-specialist" data-testid="new-session-agent-profile">
                   <label><span>专业智能体</span><select aria-label="专业智能体" value={newSessionAgentProfileId} disabled={!workspaceSelected || createSession.isPending || agentProfiles.isLoading} onChange={(event) => { const id = event.target.value; setNewSessionAgentProfileId(id); const profile = (agentProfiles.data?.profiles ?? []).find((item) => item.id === id); setNewSessionReadonlyResearchMode(profile?.readonlyResearchDefault === 'AUTO' ? 'AUTO' : 'OFF'); if (!newSessionModelTouched && profile?.modelSettings?.modelAlias) setNewSessionModelAlias(profile.modelSettings.modelAlias); }}><option value="default">默认智能体</option>{(agentProfiles.data?.profiles ?? []).filter((profile) => profile.id !== 'default').map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
                   <button type="button" className="secondary-button new-session-profile-refresh" onClick={() => { void agentProfiles.refetch(); }} disabled={agentProfiles.isFetching || createSession.isPending}>刷新</button>
                   {selectedAgentProfile && newSessionAgentProfileId !== 'default' ? <span className="new-session-specialist-description">{selectedAgentProfile.description}</span> : null}
                   <label className="new-session-readonly-toggle"><input type="checkbox" checked={newSessionReadonlyResearchMode === 'AUTO'} disabled={!workspaceSelected || createSession.isPending} onChange={(event) => setNewSessionReadonlyResearchMode(event.target.checked ? 'AUTO' : 'OFF')} />自动只读研究</label>
                   {workspaceSelected && newSessionReadonlyResearchMode === 'AUTO' && readonlyResearchUnavailableReason ? <span className="new-session-directory-warning" role="status">自动只读研究：不可用（{readonlyResearchUnavailableReason}）。</span> : null}
                   {agentProfiles.isError ? <span className="new-session-directory-warning" role="status">专业智能体目录不可用，将使用默认智能体。</span> : null}
                 </div>
                 <label className="new-session-goal"><textarea value={newSessionGoal} onChange={(event) => setNewSessionGoal(event.target.value)} placeholder="说说想做什么…" rows={4} autoFocus aria-label="说说想做什么" /></label>
                 <NewSessionInputMeta goal={newSessionGoal} limits={textInputLimits} />
                 <ComposerModelSelector
                   catalog={modelCatalog.data}
                   value={newSessionModelAlias}
                   defaultModel={modelCatalog.data?.defaultModel ?? null}
                   disabled={createSession.isPending}
                   onChange={(modelAlias) => { setNewSessionModelAlias(modelAlias); setNewSessionModelTouched(true); }}
                   testId="new-session-model-selector"
                 />
                 {newSessionIntent?.sessionId ? <p className="new-session-options-note" role="status">会话已创建，首条消息未完成（{newSessionIntent.sessionId.slice(0, 8)}）：重试只发送首条消息，不再创建会话。</p> : null}
                 <p className="new-session-directory-note">不选工作区时会话归入普通会话；从左侧工作区新建时进入对应工作区。目录可在消息输入框上沿管理。</p>
                 {workspaceSelected && newSessionPreflight.isPending ? <p className="new-session-directory-note new-session-directory-warning" role="status">正在读取项目状态；目录授权可在会话创建后于消息区管理。</p> : null}
                 {workspaceSelected && newSessionPreflight.isError ? <p className="new-session-directory-note new-session-directory-warning" role="alert">项目状态预检不可用；仍可创建会话，目录授权将在消息区单独校验。</p> : null}
                  <PendingAttachments attachments={pendingAttachments} onRemove={removePendingAttachment} testId="new-session-attachments" />
                   <div className="new-session-composer-footer" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={handleAttachmentDrop}><div className="new-session-footer-actions"><button type="button" className="composer-icon-button" title={canSendImage ? '添加文本或图片附件' : '添加文本附件（.txt/.md）'} aria-label="添加附件"><Icon name="paperclip" size={16} /><input type="file" multiple accept={attachmentAccept(canSendImage)} data-testid="new-session-attachment" onChange={(event) => handleAttachmentPicked(event.target.files)} /></button><span className="new-session-mode-summary">{workspaceSelected ? '工作区实现基座' : '普通会话'}</span></div><button type="submit" className="send-button new-session-submit" aria-label={newSessionGoal.trim() ? '开始会话' : '开始聊天'} disabled={createSession.isPending || !canCreateCurrentSession || !pendingAttachmentsReady}><span>{newSessionGoal.trim() ? '开始会话' : '开始聊天'}</span><Icon name="send" size={15} /></button></div>
               </form>
               </>}
               </section>
            : <>
              <section className="conversation" key={`${selection.sessionId}:${selection.generation}`}>
                <ConversationHeader
                  workspaceAlias={session?.workspaceAlias}
                  status={headerSessionStatus}
                  latestRunState={relatedRun?.state ?? null}
                  gitSelected={selectedPane === 'GIT' && activeSurface === 'WORKSPACE'}
                  statusSelected={activityPanelOpen}
                  evidenceSelected={selectedPane === 'EVIDENCE'}
                  terminalSelected={selectedPane === 'TERMINAL'}
                  exportSelected={exportPanelOpen}
                  evidenceDisabled={!relatedRun}
                  terminalDisabled={!selection || !canUseTerminal}
                  exportDisabled={!session || (session.messages ?? []).length === 0}
                  evidenceTitle={!relatedRun ? '需有可关联的运行记录' : undefined}
                  terminalTitle={!selection ? '打开会话后可用' : !canUseTerminal ? '当前服务不支持终端会话' : undefined}
                  exportTitle={!session || (session.messages ?? []).length === 0 ? '暂无消息可导出' : undefined}
                  onOpenGit={() => openGitOverview(relatedRun?.runId)}
                  onOpenStatus={() => { const runId = selectedActiveRunId ?? relatedRun?.runId ?? null; if (runId) setSelectedRunId(runId); openPane(null); setBuildPlanOpen(false); setCollaborationOpenSession(null); setActivityPanelOpen(true); }}
                  onOpenEvidence={() => { if (relatedRun) { setActivityPanelOpen(false); setSelectedRunId(relatedRun.runId); openPane('EVIDENCE', undefined, relatedRun.runId); } }}
                  onOpenTerminal={() => { setActivityPanelOpen(false); openPane('TERMINAL'); }}
                  onToggleExport={() => { openPane(null); setCollaborationOpenSession(null); setDirectoryPanelOpen(false); setApprovalSettingsOpen(false); setActivityPanelOpen(false); setExportPanelOpen((open) => !open); }}
                  collaborationSelected={collaborationOpenSession === selection?.sessionId}
                  collaborationDisabled={!collaborationAvailable}
                  collaborationTitle={!collaborationAvailable ? '当前服务未提供协作能力' : undefined}
                  onToggleCollaboration={() => { openPane(null); setDirectoryPanelOpen(false); setApprovalSettingsOpen(false); setActivityPanelOpen(false); setBuildPlanOpen(false); setExportPanelOpen(false); setCollaborationOpenSession((current) => current === selection?.sessionId ? null : selection?.sessionId ?? null); }}
                  planSelected={selectedPane === 'PLAN'}
                  missionSelected={selectedPane === 'MISSION'}
                  detailsSelected={selectedPane === 'DETAILS'}
                  onOpenPlan={() => { setActivityPanelOpen(false); openPane('PLAN'); }}
                  onOpenMission={() => { setActivityPanelOpen(false); openPane('MISSION'); }}
                  onOpenDetails={() => { setActivityPanelOpen(false); openPane('DETAILS'); }}
                />
                <div className="conversation-scroll" ref={conversationScrollRef} onScroll={(event) => { const el = event.currentTarget; const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80; pinnedToBottomRef.current = pinned; setConversationUnpinned(!pinned); }}>
                  {/* Plan is an on-demand work surface; it should not push the
                      chat and composer down on every ordinary conversation. */}
                  {historyDetail.channel === 'paginated' && historyDetail.hasOlder ? (
                    <div className="history-load-earlier">
                      {historyNotice ? <span className="run-meta" role="status">{historyNotice}</span> : null}
                      <button type="button" data-testid="load-earlier-messages"
                        disabled={historyDetail.isLoadingOlder}
                        onClick={() => { void handleLoadOlder(); }}>
                        {historyDetail.isLoadingOlder ? '正在加载更早消息…' : '加载更早消息'}
                      </button>
                    </div>
                  ) : null}
                  <div className="messages">
                    <VirtualMessageWindow
                      messages={session?.messages ?? []}
                      containerRef={conversationScrollRef}
                      renderRow={(message) => {

                      const messageRunId = (message as { runId?: string | null }).runId ?? null;
                      const messageRun = message.role === 'assistant' && messageRunId
                        ? (runs.data ?? []).find((run) => run.runId === messageRunId)
                        : undefined;
                      const messageActivities = messageRunId && message.role === 'assistant'
                        ? activitiesByRun.get(messageRunId)
                        : undefined;
                      const messageAttachments = ((message as { attachments?: MessageAttachmentSummary[] | null }).attachments ?? []) as MessageAttachmentSummary[];
                      // Historical assistant turns load their activity when the
                      // row is visible; the live run keeps its inline group.
                      const historicalRun = message.role === 'assistant'
                        && messageRunId !== null && messageRunId !== selectedActiveRunId;
                      return (
                        <div key={message.id} className="message-turn">
                          {messageRun?.failure ? <RunFailureCard run={messageRun} /> : null}
                          {historicalRun
                            ? <HistoricalRunActivity
                              runId={messageRunId as string}
                              canRead={canReadActivities}
                              unavailableReason={canReadActivities ? null : operationReason(props.capabilities, 'run.activity.read') ?? 'run.activity.read 不可用'}
                              items={activitiesByRun.get(messageRunId as string)}
                              onSnapshot={mergeHistoricalSnapshot}
                              workspaceRoot={workspaceRoot}
                              sessionId={selection.sessionId}
                              onOpenFile={openActivityFile}
                            />
                            : null}
                          <ConversationMessage role={message.role} status={message.status ? runStateLabel(message.status) : undefined}>{message.role === 'assistant' && (message as { reasoning?: string | null }).reasoning ? <MessageReasoning text={(message as { reasoning?: string | null }).reasoning as string} truncated={(message as { reasoningTruncated?: boolean | null }).reasoningTruncated} /> : null}{message.role === 'assistant' && historicalRun && !roundTranscriptEnabled() && !(message as { reasoning?: string | null }).reasoning ? <HistoricalRunReasoning runId={messageRunId as string} canRead={canReadActivities} /> : null}<HistoryMessageBody sessionId={selection.sessionId} message={message} /><MessageAttachments sessionId={selection.sessionId} messageId={message.id} attachments={messageAttachments} /></ConversationMessage>
                        </div>
                      )
                      }}
                    />
                    {unboundRunFailures.map((run) => (
                      <div className="message-turn" key={`run-failure-${run.runId}`}>
                        <RunFailureCard run={run} />
                      </div>
                    ))}
                    <WorkspaceConflictEntry
                      runId={relatedRun?.runId ?? null}
                      onOpen={() => { if (relatedRun) openGitSurface(relatedRun.runId, 'DIFF'); }}
                    />
                    <RunContinueEntry run={relatedRun ?? null} />
                    {ordinaryTurnActive ? <p role="status" className="run-meta">正在生成回复…</p> : null}
                    {showPendingTurn ? (
                      <div className="message-turn pending-message-turn" data-testid="pending-message">
                        <ConversationMessage role="user" pending><div className="content"><ContentRenderer text={pendingTurnForSession?.content ?? ''} className="pending-message-text" /></div></ConversationMessage>
                      </div>
                    ) : null}
                    {(selectedActiveRunId || showPendingTurn) ? (
                      <div className="message-turn" data-testid="active-run-activity">
                        <AgentRunBlock
                          run={selectedActiveRun ?? null}
                          activities={activeRunActivities}
                          visibleOutput={selectedVisibleOutput ?? null}
                          outputSnapshot={activeOutputSnapshot.data ?? null}
                          visibleReasoning={selectedVisibleReasoning ?? null}
                          reasoningSnapshot={activeReasoningSnapshot.data ?? null}
                          answerMessagePresent={selectedActiveRunId ? messageRunIds.has(selectedActiveRunId) : false}
                          nowMs={runClock}
                          observedStartedAt={selectedActiveRunId ? runStartedAtRef.current.get(selectedActiveRunId) ?? null : null}
                          phase={runDisplayModel.phase}
                          connection={runDisplayModel.connection}
                          loadedActivityCount={runDisplayModel.loadedActivityCount}
                          activityHistoryComplete={runDisplayModel.activityHistoryComplete}
                          activityHistoryReason={runDisplayModel.activityHistoryReason}
                          activitiesAvailable={canReadActivities}
                          unavailableReason={canReadActivities ? null : operationReason(props.capabilities, 'run.activity.read') ?? 'run.activity.read 不可用'}
                          workspaceRoot={workspaceRoot}
                          sessionId={selection.sessionId}
                          onOpenFile={openActivityFile}
                        />
                      </div>
                    ) : null}
                    {selectedApprovalCard ? <div className="message-turn approval-message-turn" data-testid="approval-panel">{selectedApprovalCard}</div> : null}
                    {(session?.messages ?? []).length === 0 && !selectedVisibleOutput && !showPendingTurn ? <div className="message-empty"><Icon name="spark" size={20} /><p>这段对话还没有消息。</p><span>描述一个问题、目标或需要修改的范围。</span></div> : null}
                  </div>
                  {fetchedSources.map((source, index) => <div className="source-card" data-testid="source-card" key={`${source.fetchedAt ?? 'source'}-${index}`}><div className="source-card-header"><span className="source-untrusted" data-testid="source-untrusted-badge">不可信内容</span><span className="run-meta">{source.sourceType} · {source.finalUri ?? source.sourceUri} · {source.contentBytes} 字节{source.truncated ? ' · 已截断' : ''}{source.contentType ? ` · ${source.contentType}` : ''}</span>{source.contentText ? <button type="button" data-testid="source-attach" onClick={() => attachSource(source)}>附加到消息</button> : null}</div>{source.contentText ? <pre className="source-content" data-testid="source-content">{source.contentText}</pre> : null}</div>)}
                </div>
                    <div className="composer-area">
                      {conversationUnpinned ? <button className="composer-jump" type="button" data-testid="conversation-newer-notice" onClick={() => { pinnedToBottomRef.current = true; setConversationUnpinned(false); scrollConversationToBottom(); }}>回到最新内容</button> : null}
                      {runDisplayModel.phase !== 'IDLE' ? <div className="composer-dock" data-testid="composer-dock" aria-label="运行状态">
                        <RunStatusBar
                          model={runDisplayModel}
                          stopPending={selectedActiveRun?.state === 'QUEUED' ? cancelRunM.isPending : interruptRun.isPending}
                          recoverPending={recoverRunM.isPending}
                          onStop={() => {
                            if (!selectedActiveRun) return;
                            if (selectedActiveRun.state === 'QUEUED') {
                              cancelRunM.mutate(selectedActiveRun.runId);
                            } else if (selectedActiveRun.state === 'RUNNING') {
                              requestStop(selectedActiveRun.runId, selectedActiveRun.stateVersion);
                            }
                          }}
                         onRecover={() => { if (selectedActiveRun?.state === 'PAUSED') recoverRunM.mutate({ runId: selectedActiveRun.runId, expectedStateVersion: selectedActiveRun.stateVersion }); }}
                         approvalSyncing={Boolean(selectedActiveRunId && approvalSyncingRunIds.has(selectedActiveRunId))}
                       />
                     </div> : null}
                      {session ? <aside id="directory-panel" className={`directory-pane-floating ${directoryPanelOpen ? '' : 'is-hidden'}`} aria-label="目录浮动面板" aria-hidden={!directoryPanelOpen}><DirectoryPanel key={session.sessionId} session={session} onClose={() => setDirectoryPanelOpen(false)} /></aside> : null}
                      {latestTerminalRun && canReadDiff ? <ComposerDiffStrip runId={latestTerminalRun.runId} onOpen={() => openGitOverview(latestTerminalRun.runId)} /> : null}
                      {session && exportPanelOpen ? <ExportDrawer session={session} channel={historyDetail.channel} runs={sessionRuns} onClose={() => setExportPanelOpen(false)} /> : null}
                      <form className="composer" onSubmit={(event) => { event.preventDefault(); if (composer.trim().length === 0 || !canSendText || !composerCheck.ok || !pendingAttachmentsReady || sendingSelectedSession) return; startSendMessage({ sessionId: selection.sessionId, content: composer.trim(), attachments: pendingWireAttachments }); }}>
                      {(pendingAttachments.length > 0 || extensionSelection.serverIds.length + extensionSelection.skillIds.length > 0) ? (
                        <div className="composer-chips-row">
                          <PendingAttachments attachments={pendingAttachments} onRemove={removePendingAttachment} testId="composer-attachments" />
                          <ExtensionSelectionChips state={extensionSelection} />
                        </div>
                      ) : null}
                      <div className="composer-main" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={handleAttachmentDrop}><textarea value={composer} onChange={(event) => setComposer(event.target.value)} onPaste={handleAttachmentPaste} onKeyDown={(event) => { const mod = event.ctrlKey || event.metaKey; const submitKey = sendShortcut === 'MOD_ENTER' ? (event.key === 'Enter' && mod) : (event.key === 'Enter' && !event.shiftKey); if (submitKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="输入消息…" aria-label="输入消息…（运行进度会自动刷新）" /></div>
                      <div className="composer-footer">
                        <div className="composer-footer-left">
                          <button type="button" className="composer-icon" title={canSendImage ? '添加文本或图片附件' : '添加文本附件（.txt/.md）'} aria-label="添加附件"><Icon name="paperclip" size={14} /><input type="file" multiple accept={attachmentAccept(canSendImage)} data-testid="composer-attachment" onChange={(event) => handleAttachmentPicked(event.target.files)} /></button>
                          <ExtensionSelectionPicker state={extensionSelection} />
                          <button type="button" className={`composer-chip directory-trigger ${directoryPanelOpen ? 'selected' : ''}`} aria-expanded={directoryPanelOpen} aria-controls="directory-panel" onClick={() => { setApprovalSettingsOpen(false); setDirectoryPanelOpen((open) => !open); }}><Icon name="folder" size={13} />目录</button>
                          <PermissionModeMenu
                            open={approvalSettingsOpen}
                            onToggle={() => { setDirectoryPanelOpen(false); setApprovalSettingsOpen((open) => !open); }}
                            onClose={() => setApprovalSettingsOpen(false)}
                            capabilities={props.capabilities}
                            value={executionPolicy.data?.mode}
                            supportedModes={executionPolicy.data?.supportedModes}
                            lockedModes={(executionPolicy.data?.supportedModes ?? []).filter((mode) =>
                              modeRank(mode) > modeRank(executionPolicy.data?.managedModeCeiling ?? 'STANDARD'))}
                            lockReasons={Object.fromEntries((executionPolicy.data?.supportedModes ?? [])
                              .filter((mode) => modeRank(mode) > modeRank(executionPolicy.data?.managedModeCeiling ?? 'STANDARD'))
                              .map((mode) => [mode, `已锁定：组织上限为 ${PERMISSION_MODE_SHORT_LABELS[executionPolicy.data?.managedModeCeiling as PermissionMode] ?? executionPolicy.data?.managedModeCeiling ?? '标准'}`]))}
                            permissionSemanticsVersion={executionPolicy.data?.permissionSemanticsVersion}
                            activationStatus={executionPolicy.data?.activationStatus}
                            blockingReasons={executionPolicy.data?.blockingReasons}
                            pending={updateExecutionPolicyM.isPending}
                            onChange={(mode) => {
                              if (!selection || !executionPolicy.data) return;
                              updateExecutionPolicyM.mutate({
                                mode,
                                sessionId: selection.sessionId,
                                projectId: executionPolicyProjectId,
                                expectedRevision: executionPolicy.data.revision
                              });
                            }}
                            pendingApprovalCount={sessionPendingApprovalCount}
                            onJumpToApprovals={() => {
                              document.querySelector('[data-testid="approval-panel"]')?.scrollIntoView({ block: 'center' });
                            }}
                            automation={automationControlAvailable && automationControl.data ? {
                              paused: automationControl.data.paused === true,
                              pending: automationControlM.isPending,
                              disabled: !Number.isSafeInteger(automationControl.data.version),
                              onToggle: () => {
                                if (!selection) return;
                                automationControlM.mutate({
                                  sessionId: selection.sessionId,
                                  expectedVersion: automationControl.data?.version ?? 0,
                                  control: automationControl.data?.paused ? 'RESUME_AUTOMATION' : 'PAUSE_AUTOMATION'
                                });
                              }
                            } : undefined}
                            onOpenProjectDefaults={() => openSettingsRoute('PROJECTS_SESSIONS')}
                          />
                        </div>
                        <div className="composer-footer-right">
                      <ComposerModelSelector
                        catalog={modelCatalog.data}
                        value={composerModelAlias}
                        defaultModel={modelCatalog.data?.defaultModel ?? null}
                        disabled={!selection || !session || patchSessionModel.isPending}
                        pending={patchSessionModel.isPending}
                        onChange={handleComposerModelChange}
                        reasoningMode={selection ? composerReasoningMode : undefined}
                        reasoningOptionId={selection ? composerReasoningOptionId : undefined}
                        reasoningOptions={selection ? composerReasoningOptions : undefined}
                        onReasoningChange={selection ? handleComposerReasoningChange : undefined}
                        contextMode={selection ? composerContextMode : undefined}
                        contextPresetId={selection ? composerContextPresetId : undefined}
                        contextOptions={selection ? composerContextOptions : undefined}
                        onContextChange={selection ? handleComposerContextChange : undefined}
                        testId="composer-model-selector"
                      />
                          {composerStoppableRun ? (
                            <button
                              type="button"
                              className="composer-action composer-stop"
                              aria-label="终止运行"
                              title="终止当前运行"
                              data-testid="composer-stop"
                              disabled={interruptRun.isPending || cancelRunM.isPending || stopRequestedRunIds.has(composerStoppableRun.runId)}
                              onClick={() => {
                                if (composerStoppableRun.state === 'QUEUED') {
                                  cancelRunM.mutate(composerStoppableRun.runId);
                                } else {
                                  requestStop(composerStoppableRun.runId, composerStoppableRun.stateVersion);
                                }
                              }}
                            ><Icon name="stop" size={15} /></button>
                          ) : (
                          <button type="submit" className="composer-action" aria-label={composerRunActive ? '排队发送' : '发送'} title={composerRunActive ? '排队到当前运行之后' : (composer && !composerCheck.ok ? (composerCheck.message ?? '超出上限') : '发送')} disabled={sendingSelectedSession || composer.trim().length === 0 || !canSendText || !composerCheck.ok || !pendingAttachmentsReady}><Icon name="send" size={15} /></button>
                          )}
                        </div>
                      </div>
                      </form>
                    </div>
              </section>
            </>}

        {selectedPane && activeSurface === 'WORKSPACE' ? (
          <WorkPane
            label="工作面板"
            title={selectedPane === 'GIT' ? 'Git' : selectedPane === 'EVIDENCE' ? '证据' : selectedPane === 'PLAN' ? '计划' : selectedPane === 'MISSION' ? '任务编排' : selectedPane === 'DETAILS' ? '会话详情' : '活动'}
            closeLabel="关闭面板"
            docked={workPaneDocked}
            floatingWidth={`min(${paneWidth}px, calc(100% - 24px))`}
            onResizeStart={startPaneResize}
            onToggleDock={() => setWorkPaneDocked((docked) => !docked)}
            onClose={() => openPane(null)}
          >
            {selectedPane === 'GIT' ? (
              <GitOverviewPanel
                projects={projects.data ?? []}
                runs={runs.data ?? []}
                selectedRunId={selectedRunId}
                runProjectAlias={runProjectAlias}
                onOpenChanges={(_project, run) => openGitSurface(run.runId, 'DIFF')}
              />
            ) : selectedPane === 'DETAILS' ? (
              <div className="pane-content details-pane">
                <h3>权限摘要</h3>
                <p>本面板只展示 Service 返回的目录，不在本地生成权限。</p>
                <dl>
                  <dt>工作区</dt><dd>{currentWorkspace || '—'}</dd>
                  <dt>写入范围</dt><dd>{session?.writeAllow?.join(', ') || '无写入授权'}</dd>
                  <dt>验证</dt><dd>{session?.status === 'COMPLETED' ? '服务已上报' : '尚未上报'}</dd>
                  <dt>会话版本</dt><dd>{session?.sessionVersion ?? '—'}</dd>
                </dl>
                <button type="button" onClick={() => setDirectoryPanelOpen(true)}>在目录中展开</button>
                {session?.workspaceBinding?.workspaceLaneId ? (
                  <WorkspaceLaneSection
                    laneId={session.workspaceBinding.workspaceLaneId}
                    sessionId={selection?.sessionId ?? ''}
                    runId={selectedRunId ?? relatedRun?.runId ?? null}
                  />
                ) : null}
              </div>
            ) : selectedPane === 'PLAN' ? (
              <div className="pane-content plan-pane">
                <p className="surface-note">Plan 是 revisioned Spec，不是普通消息。需要时在输入区上方处理审批。</p>
                {specQuery.data ? <div className="spec-card" data-testid="spec-card"><div className="approval-heading"><span className="approval-icon"><Icon name="list" size={14} /></span><div><strong>计划 · 修订 {specQuery.data.revision}</strong><span>{specQuery.data.status ?? '草稿'} · 版本化契约</span></div></div><ContentRenderer text={specQuery.data.contractMarkdown ?? '（无 contract 内容）'} className="spec-markdown" /><span className="run-meta">contract {specQuery.data.contractFingerprint ?? '—'} · baseline {specQuery.data.workspaceBaselineFingerprint ?? '—'}</span>{specQuery.data.approvalId ? <span className="run-meta">待审批修订已移至输入区上方</span> : <span className="run-meta">无待审批修订</span>}<div className="spec-actions"><button type="button" onClick={() => convertSpecM.mutate()} disabled={convertSpecM.isPending}>转为 Act</button><button type="button" className="secondary-button" data-testid="spec-revise" onClick={() => setSpecReviseOpen((open) => !open)}>修订</button></div>{specReviseOpen ? <div className="spec-draft spec-revise" data-testid="spec-revise-form"><input value={specReviseGoal} onChange={(event) => setSpecReviseGoal(event.target.value)} placeholder="修订目标（新 revision，预期修订号校验）" aria-label="修订目标" /><button type="button" onClick={() => reviseSpecM.mutate()} disabled={specReviseGoal.trim().length === 0 || reviseSpecM.isPending}>提交修订</button></div> : null}</div> : <div className="spec-draft"><input value={specDraftGoal} onChange={(event) => setSpecDraftGoal(event.target.value)} placeholder="目标（起草 Spec / Task Contract）" /><button type="button" onClick={() => createSpecM.mutate()} disabled={specDraftGoal.trim().length === 0 || createSpecM.isPending}>起草 Spec</button></div>}
              </div>
            ) : selectedPane === 'MISSION' ? (
              <div className="pane-content"><MissionPanel sessionId={selection?.sessionId ?? ''} workspaceAlias={currentWorkspace} onDecide={(mission, decision) => missionDecideM.mutate({ mission, decision })} onCommand={(mission, command) => missionCommandM.mutate({ mission, command })} onCreate={(input) => missionCreateM.mutate({ sessionId: selection?.sessionId ?? '', title: input.title, goal: input.goal, workspaceAlias: currentWorkspace })} pending={missionCreateM.isPending || missionDecideM.isPending || missionCommandM.isPending} /></div>
            ) : selectedPane === 'EVIDENCE' && selectedRunId ? (
              <div className="pane-content evidence-pane" data-testid="evidence-pane">
                <div className="run-context" data-testid="evidence-run-context">
                  <span className={`session-status-dot tone-${runStateTone(selectedRun?.state ?? '')}`} aria-hidden="true" />
                  <span className="run-context-id">run {selectedRunId.slice(0, 8)}</span>
                  <span className={`run-context-state tone-${runStateTone(selectedRun?.state ?? '')}`}>{selectedRun ? runStateLabel(selectedRun.state) : '状态待同步'}</span>
                  {selectedRun?.workspaceAlias ? <span className="run-context-ws">{selectedRun.workspaceAlias}</span> : null}
                </div>
                <EvidenceLayers runId={selectedRunId} runState={selectedRun?.state} enabled={canReadEvidence} unavailableReason={operationReason(props.capabilities, 'evidence.read')} />
                <ReviewFindings runId={selectedRunId} runState={selectedRun?.state} enabled={canReadEvidence} unavailableReason={operationReason(props.capabilities, 'evidence.read')} onCreateFixTask={(finding) => createFixTaskM.mutate(finding)} fixPending={createFixTaskM.isPending} />
              </div>
            ) : (
              <div className="pane-content"><p className="empty">选择一个 Run 查看活动。</p></div>
            )}
          </WorkPane>
        ) : null}
        {selectedPane === 'TERMINAL' && activeSurface === 'WORKSPACE' ? <TerminalDockPane businessSessionId={selection?.sessionId ?? ''} projectId={projects.data?.find((project) => project.workspaceAlias === currentWorkspace)?.projectId ?? null} enabled={canUseTerminal} unavailableReason={operationReason(props.capabilities, 'terminal.session.create')} docked={workPaneDocked} floatingWidth={`min(${paneWidth}px, calc(100% - 24px))`} onResizeStart={startPaneResize} onToggleDock={() => setWorkPaneDocked((docked) => !docked)} onClose={() => openPane(null)} /> : null}
        </main>
      </div>


      {selectedFileRef ? <FileReferenceDialog fileRef={selectedFileRef} startLine={selectedFileLine} query={projectFileQuery} revealPending={revealFileM.isPending} canReveal={canRevealFile} onReveal={(ref) => {
        // Reveal through the same project the preview read resolved — never
        // re-resolve via ambient run selection, which may point at another
        // session's run and land in the wrong workspace.
        if (!canRevealFile) {
          setBanner(`定位文件不可用：${operationReason(props.capabilities, 'file.reveal') ?? 'file.reveal'}`);
          return;
        }
        if (!selectedFileProjectId) {
          setBanner('无法确定项目，未能定位文件。');
          return;
        }
        revealFileM.mutate({ projectId: selectedFileProjectId, fileRef: ref });
      }} onClose={() => { setSelectedFileRef(null); setSelectedFileLine(null); setSelectedFileProjectId(null); }} /> : null}
      {commandPaletteOpen ? <CommandPalette onClose={() => setCommandPaletteOpen(false)} onNewSession={startNewSession} onOpenAttention={() => setActiveSurface('ATTENTION')} onOpenMissions={() => setActiveSurface('MISSIONS')} onOpenExtensions={() => setActiveSurface('EXTENSIONS')} onOpenSettings={openSettingsRoute} onOpenGit={() => openGitOverview(selectedRunId)} {...(selection?.sessionId ? {
        onOpenPlan: () => { setActiveSurface('WORKSPACE'); openPane('PLAN'); },
        onOpenMissionPane: () => { setActiveSurface('WORKSPACE'); openPane('MISSION'); },
        onOpenDetails: () => { setActiveSurface('WORKSPACE'); openPane('DETAILS'); },
        ...(composerStoppableRun ? { onStopRun: () => {
          if (composerStoppableRun.state === 'QUEUED') cancelRunM.mutate(composerStoppableRun.runId);
          else requestStop(composerStoppableRun.runId, composerStoppableRun.stateVersion);
        } } : {}),
        ...(session && (session.messages ?? []).length > 0 ? { onExportSession: () => {
          setActiveSurface('WORKSPACE'); openPane(null); setCollaborationOpenSession(null);
          setDirectoryPanelOpen(false); setApprovalSettingsOpen(false); setActivityPanelOpen(false); setExportPanelOpen(true);
        } } : {})
      } : {})} /> : null}
      {sessionMenu ? (
        <>
          <div className="pane-menu-backdrop" onMouseDown={() => setSessionMenu(null)} />
          <div className="rail-menu-popover session-menu-popover" role="menu" style={{ top: sessionMenu.top, right: sessionMenu.right }} data-testid="session-row-actions">
            {(() => {
              const menuItem = allSessions.find((entry) => entry.sessionId === sessionMenu.sessionId);
              const menuPinned = pinnedSessionIds.has(sessionMenu.sessionId);
              return (
                <>
                  <button type="button" role="menuitem" onClick={() => { togglePinnedSession(sessionMenu.sessionId); setSessionMenu(null); }}>{menuPinned ? '取消置顶' : '置顶会话'}</button>
                  <button type="button" role="menuitem" data-testid="session-action-rename" onClick={() => { setRenameDraft(menuItem?.title ?? ''); setRenamingSessionId(sessionMenu.sessionId); setSessionMenu(null); }}>重命名</button>
                  <button type="button" role="menuitem" data-testid="session-action-fork" onClick={() => { forkSession.mutate(sessionMenu.sessionId); setSessionMenu(null); }}>创建副本</button>
                  <button type="button" role="menuitem" data-testid="session-action-archive" onClick={() => { archiveSession.mutate(sessionMenu.sessionId); setSessionMenu(null); }}>归档</button>
                </>
              );
            })()}
          </div>
        </>
      ) : null}

    </div>
  );
}
