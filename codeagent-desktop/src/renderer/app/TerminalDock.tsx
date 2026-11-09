import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  TerminalCloseRequest,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalSessionCreateRequest,
  TerminalSessionResponse,
  TerminalSignalRequest,
  TerminalControlAcquireRequest,
  TerminalControlRenewRequest,
  TerminalControlReleaseRequest,
  TerminalOutputResponse,
  WorkspaceExecutionResponse
} from '../../../electron/shared/api-types';
import { unwrap } from './queries';
import type { WorkspaceExecutionLike } from './queries';
import { useWorkspaceExecutions } from './queries';
import { TerminalView } from './TerminalView';
import type { TerminalViewHandle } from './TerminalView';
import { Icon } from './Icon';
import { Menu, MenuItem, Popover } from './ui/Popover';
import { StatusBadge } from './ui/StatusBadge';
import { terminalStateLabel } from './ui/labels';

const OUTPUT_READ_BYTES = 64 * 1024;
const OUTPUT_WAIT_MILLIS = 1000;
const POLL_RETRY_MILLIS = 750;
const SNAPSHOT_INTERVAL_MILLIS = 2000;
const CONTROL_RENEW_BEFORE_MILLIS = 15_000;
const RESIZE_SEND_DEBOUNCE_MILLIS = 300;
const URL_TAIL_CHARS = 64 * 1024;

const TERMINAL_STATES = new Set(['EXITED', 'TERMINATED', 'FAILED', 'LOST', 'CLOSED']);

export interface TerminalDockProps {
  businessSessionId: string;
  projectId: string | null;
  enabled: boolean;
  unavailableReason?: string | null;
  /** Reports the workspace one-liner so the panel chrome can show it once (U5 §9). */
  onWorkspaceSummary?: (summary: string | null) => void;
}

/** User preference for the VS Code-style "open a shell with the panel" flow (U5 T4). */
const AUTO_START_KEY = 'codeagent.terminal.autoStart';

function terminalAutoStartEnabled(): boolean {
  try {
    return window.localStorage.getItem(AUTO_START_KEY) !== '0';
  } catch {
    return true;
  }
}

type Delivery = 'APPLIED' | 'PENDING' | 'REPLAY' | 'NOT_APPLIED' | 'UNKNOWN' | 'REJECTED' | string;

interface CreateParams {
  executable: string;
  arguments: string[];
  terminalMode: 'FULL_VT' | 'LINE_STREAM';
  label: string;
}

function operationId(): string {
  return crypto.randomUUID();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : '';
}

/** Decode service-owned bytes without interpreting them as HTML or markup. */
export function decodeTerminalOutput(dataBase64: string | null | undefined): string {
  if (!dataBase64) return '';
  try {
    const binary = atob(dataBase64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return '⟦终端输出无法解码⟧';
  }
}

function decodeTerminalBytes(dataBase64: string | null | undefined): Uint8Array | null {
  if (!dataBase64) return null;
  try {
    const binary = atob(dataBase64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function isAcceptedDelivery(delivery: Delivery): boolean {
  return delivery === 'APPLIED' || delivery === 'PENDING' || delivery === 'REPLAY';
}

function workspaceLabel(workspace: WorkspaceExecutionLike): string {
  return workspace.workspaceRef ?? `${workspace.kind ?? 'workspace'} · ${workspace.workspaceExecutionId}`;
}

const ANSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const LOOPBACK_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s"'<>)]*)?/g;

/** Loopback URLs seen in terminal output become a one-click browser action. */
function detectLoopbackUrl(plainTail: string): string | null {
  const stripped = plainTail.replace(ANSI_SEQUENCE, '');
  let match: RegExpExecArray | null;
  let last: string | null = null;
  LOOPBACK_URL.lastIndex = 0;
  while ((match = LOOPBACK_URL.exec(stripped)) !== null) last = match[0];
  if (!last) return null;
  return last.replace('0.0.0.0', '127.0.0.1');
}

function isAgentSession(session: TerminalSessionResponse): boolean {
  return session.profile === 'DIRECT_PROCESS' || session.profile === 'AGENT_SHELL'
    || session.profile === 'DEBUGGER_CLI' || Boolean(session.createdByRunId);
}

function sessionTabLabel(session: TerminalSessionResponse, index: number, names: Map<string, string>): string {
  return names.get(session.terminalSessionId) ?? `终端 ${index + 1}`;
}

/**
 * Service-backed terminal dock. The Java Service owns the PTY; the renderer
 * owns only the emulator view, a bounded output cursor, and a control lease.
 */
export function TerminalDock(props: TerminalDockProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [executable, setExecutable] = useState('powershell');
  const [argumentsText, setArgumentsText] = useState('-NoLogo -NoProfile');
  const [createMode, setCreateMode] = useState<'FULL_VT' | 'LINE_STREAM'>('FULL_VT');
  const [workspaceExecutionId, setWorkspaceExecutionId] = useState('');
  const [showCreateOptions, setShowCreateOptions] = useState(false);
  const [showCommandInput, setShowCommandInput] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [commandText, setCommandText] = useState('');
  const [hasLease, setHasLease] = useState(false);
  const [controlCanInput, setControlCanInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [streamBlocked, setStreamBlocked] = useState(false);
  const [detectedUrl, setDetectedUrl] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const viewRef = useRef<TerminalViewHandle | null>(null);
  const newMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const autoStartedRef = useRef(false);
  const serviceInstanceRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollTimerRef = useRef<number | null>(null);
  const pollActiveRef = useRef(false);
  const outputCursorRef = useRef<string | undefined>(undefined);
  const replayFallbackRef = useRef(false);
  const leaseRef = useRef<{ id: string; epoch: number } | null>(null);
  const acquiringRef = useRef<Promise<boolean> | null>(null);
  const snapshotRef = useRef<TerminalSessionResponse | null>(null);
  const resizeSequenceRef = useRef(0);
  const resizeTimerRef = useRef<number | null>(null);
  const lastSentSizeRef = useRef<{ columns: number; rows: number } | null>(null);
  const pendingSizeRef = useRef<{ columns: number; rows: number } | null>(null);
  const inputQueueRef = useRef<string[]>([]);
  const inputFlushRef = useRef(false);
  const lastImplicitAcquireRef = useRef(0);
  const urlTailRef = useRef('');
  const createParamsRef = useRef(new Map<string, CreateParams>());
  const sessionNamesRef = useRef(new Map<string, string>());
  const createdSessionsRef = useRef(new Map<string, TerminalSessionResponse>());

  const terminalsQuery = useQuery({
    queryKey: ['terminal-sessions', props.businessSessionId],
    enabled: props.enabled && props.businessSessionId.length > 0,
    retry: false,
    refetchInterval: SNAPSHOT_INTERVAL_MILLIS,
    queryFn: async () => unwrap(await window.codeAgentDesktop.listTerminalSessions(props.businessSessionId)) as TerminalSessionResponse[]
  });
  const workspacesQuery = useWorkspaceExecutions(props.projectId);
  const availableWorkspaces = useMemo(
    // Long-lived user terminals must stay in this session's service-owned
    // worktree. A CHECKOUT points at the shared authoritative directory, so
    // keeping a BUSINESS_SESSION PTY there blocks unrelated Agent Runs.
    () => (workspacesQuery.data ?? []).filter(
        (workspace) => workspace.kind === 'WORKTREE'
          && workspace.ownerType === 'SESSION'
          && workspace.ownerId === props.businessSessionId
          && workspace.state === 'IN_USE'
          && !workspace.leaseExpired),
    [props.businessSessionId, workspacesQuery.data]
  );
  // A terminal runtime cannot be reattached after its Service instance dies,
  // and a user-closed terminal is no longer an active tab. Keep both states
  // out of the active tabs; the primary action remains available and creates
  // a fresh terminal instead.
  const terminalList = useMemo(
    () => (terminalsQuery.data ?? []).filter((session) => session.state !== 'LOST' && session.state !== 'CLOSED'),
    [terminalsQuery.data]
  );
  const lostTerminalCount = useMemo(
    () => (terminalsQuery.data ?? []).filter((session) => session.state === 'LOST').length,
    [terminalsQuery.data]
  );
  const selected = useMemo(
    () => terminalList.find((session) => session.terminalSessionId === selectedId)
        ?? (() => {
          const cached = createdSessionsRef.current.get(selectedId ?? '');
          return cached && cached.state !== 'LOST' && cached.state !== 'CLOSED' ? cached : null;
        })(),
    [selectedId, terminalList]
  );
  const terminalIds = useMemo(() => terminalList.map((session) => session.terminalSessionId), [terminalList]);

  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({ queryKey: ['terminal-sessions', props.businessSessionId] });
    if (selectedId) void queryClient.invalidateQueries({ queryKey: ['terminal-session', selectedId] });
  }, [props.businessSessionId, queryClient, selectedId]);

  const rememberSnapshot = useCallback((snapshot: TerminalSessionResponse): boolean => {
    if (serviceInstanceRef.current === null) {
      serviceInstanceRef.current = snapshot.serviceInstanceId;
    } else if (serviceInstanceRef.current !== snapshot.serviceInstanceId) {
      setStreamBlocked(true);
      setError('Service 已重启；旧终端不可恢复，请重新启动一个终端。');
      return false;
    }
    snapshotRef.current = snapshot;
    if (leaseRef.current && snapshot.controlEpoch !== leaseRef.current.epoch) {
      leaseRef.current = null;
      setHasLease(false);
      setControlCanInput(false);
      setNotice('控制租约已变化，请重新接管输入。');
    }
    return true;
  }, []);

  const refreshSelected = useCallback(async (id: string): Promise<TerminalSessionResponse | null> => {
    try {
      const snapshot = unwrap(await window.codeAgentDesktop.getTerminalSession(id)) as TerminalSessionResponse;
      if (!mountedRef.current || !rememberSnapshot(snapshot)) return null;
      queryClient.setQueryData(['terminal-session', id], snapshot);
      return snapshot;
    } catch (refreshError) {
      if (mountedRef.current) setError(errorMessage(refreshError));
      return null;
    }
  }, [queryClient, rememberSnapshot]);

  const stopPolling = useCallback((): void => {
    pollActiveRef.current = false;
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const schedulePoll = useCallback((id: string, delay: number): void => {
    if (!pollActiveRef.current) return;
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = window.setTimeout(() => { void pollOutputRef.current(id); }, delay);
  }, []);

  const noteOutput = useCallback((response: TerminalOutputResponse): void => {
    const view = viewRef.current;
    if (response.gap || response.historyIncomplete) {
      // §10.4: a gap means the emulator state is no longer reconstructible.
      view?.reset();
      view?.write('⟦输出历史不完整；从 Service 当前保留的位置继续⟧\r\n');
      setNotice('输出历史不完整；已从 Service 保留的位置继续。');
      urlTailRef.current = '';
    }
    if (response.mode === 'RAW_VT') {
      const bytes = decodeTerminalBytes(response.dataBase64);
      if (bytes?.length) {
        view?.write(bytes);
        urlTailRef.current = `${urlTailRef.current}${new TextDecoder().decode(bytes)}`.slice(-URL_TAIL_CHARS);
      }
    } else {
      const text = response.plainText ?? decodeTerminalOutput(response.dataBase64);
      if (text) {
        view?.write(text);
        urlTailRef.current = `${urlTailRef.current}${text}`.slice(-URL_TAIL_CHARS);
      }
    }
    const url = detectLoopbackUrl(urlTailRef.current);
    if (url !== detectedUrl) setDetectedUrl(url);
  }, [detectedUrl]);

  const pollOutput = useCallback(async (id: string): Promise<void> => {
    if (!pollActiveRef.current || !mountedRef.current || streamBlocked
        || snapshotRef.current?.terminalSessionId !== id) return;
    const snapshot = snapshotRef.current;
    const mode = snapshot?.terminalMode === 'FULL_VT' ? 'RAW_VT' : 'PLAIN_TEXT';
    try {
      const response = unwrap(await window.codeAgentDesktop.getTerminalOutput(id, {
        cursor: outputCursorRef.current,
        maxBytes: OUTPUT_READ_BYTES,
        waitMillis: OUTPUT_WAIT_MILLIS,
        mode
      })) as TerminalOutputResponse;
      // The selection can change while this request is in flight; never write
      // another terminal's bytes into the emulator that now owns the view.
      if (!mountedRef.current || !pollActiveRef.current
          || snapshotRef.current?.terminalSessionId !== id) return;
      if (serviceInstanceRef.current !== null && response.serviceInstanceId !== serviceInstanceRef.current) {
        setStreamBlocked(true);
        setError('Service 已重启；输出游标已失效，未自动重放。');
        stopPolling();
        return;
      }
      noteOutput(response);
      if (response.nextCursor) outputCursorRef.current = response.nextCursor;
      if (response.eof) {
        stopPolling();
        return;
      }
      schedulePoll(id, 100);
    } catch (pollError) {
      if (!mountedRef.current || !pollActiveRef.current
          || snapshotRef.current?.terminalSessionId !== id) return;
      const message = errorMessage(pollError);
      // §10.4: a FULL_VT session whose retained history is gone cannot be
      // replayed from offset 0. Re-anchor at Service's retained boundary.
      if (!replayFallbackRef.current && (/SCREEN_REPLAY_UNAVAILABLE|REPLAY_UNAVAILABLE/i.test(errorCode(pollError))
          || /SCREEN_REPLAY_UNAVAILABLE|REPLAY_UNAVAILABLE/i.test(message))) {
        replayFallbackRef.current = true;
        // `TerminalSessionResponse.outputCursor` is the Product snapshot's
        // PLAIN_TEXT cursor. FULL_VT polling uses a mode-bound RAW_VT cursor,
        // so reusing the snapshot cursor makes the next request fail with
        // TERMINAL_CURSOR_INVALID. An omitted cursor asks Service to anchor
        // at the currently retained boundary and returns a cursor for this mode.
        outputCursorRef.current = undefined;
        viewRef.current?.reset();
        setNotice('历史画面已不可用；从当前输出位置继续。');
        schedulePoll(id, 0);
        return;
      }
      // A cursor can become invalid when an older recovery path left a
      // mode-bound cursor in the renderer (for example PLAIN_TEXT after a
      // FULL_VT attach). Re-anchor once from Service instead of retrying the
      // same invalid cursor forever.
      if (outputCursorRef.current !== undefined
          && /TERMINAL_CURSOR_INVALID|terminal output cursor is invalid/i.test(`${errorCode(pollError)} ${message}`)) {
        replayFallbackRef.current = true;
        outputCursorRef.current = undefined;
        viewRef.current?.reset();
        setNotice('输出游标已重新对齐；从当前保留位置继续。');
        schedulePoll(id, 0);
        return;
      }
      setError(message);
      if (/WORKSPACE_LEASE_LOST/i.test(`${errorCode(pollError)} ${message}`)) {
        stopPolling();
        setNotice('该终端的工作区租约已失效（服务重启或工作区被回收）；只能关闭它。');
      } else if (/LOST|CLOSED|NOT_FOUND|FORBIDDEN|DENIED|UNAVAILABLE|RECONCILE/i.test(message)) {
        stopPolling();
      } else {
        schedulePoll(id, POLL_RETRY_MILLIS);
      }
    }
  }, [noteOutput, schedulePoll, stopPolling, streamBlocked]);

  // Armed poll timers dispatch through this ref so a delayed callback invokes
  // the latest closure (fresh streamBlocked/noteOutput), not the instance
  // captured when the timer was created.
  const pollOutputRef = useRef(pollOutput);
  pollOutputRef.current = pollOutput;

  const releaseLease = useCallback(async (): Promise<void> => {
    const lease = leaseRef.current;
    const snapshot = snapshotRef.current;
    if (!lease || !snapshot || snapshot.controlState === 'CLOSED') return;
    leaseRef.current = null;
    setHasLease(false);
    setControlCanInput(false);
    try {
      const body: TerminalControlReleaseRequest = {
        operationId: operationId(),
        leaseId: lease.id,
        controlEpoch: lease.epoch,
        expectedControlVersion: snapshot.controlVersion
      };
      const response = unwrap(await window.codeAgentDesktop.releaseTerminalControl(snapshot.terminalSessionId, body)) as { delivery: Delivery };
      if (response.delivery === 'UNKNOWN' && mountedRef.current) {
        setNotice('控制释放结果未知；已停止本端输入，等待 Service 对账。');
      }
    } catch {
      // Cleanup is best effort; the Service TTL owns the lease otherwise.
    }
  }, []);

  const sendResize = useCallback(async (columns: number, rows: number): Promise<void> => {
    const snapshot = snapshotRef.current;
    const lease = leaseRef.current;
    // The snapshot captured before acquire still reports canResize=false
    // while the terminal is FREE. Once this client owns the control lease,
    // the resize is valid; gating on that stale projection leaves the PTY at
    // its create-time 120x32 size and makes long prompts wrap at the wrong
    // column in the narrower dock.
    if (!snapshot || !lease || TERMINAL_STATES.has(snapshot.state)) {
      pendingSizeRef.current = { columns, rows };
      return;
    }
    const last = lastSentSizeRef.current;
    if (last && last.columns === columns && last.rows === rows) return;
    const nextSequence = resizeSequenceRef.current + 1;
    const body: TerminalResizeRequest = {
      operationId: operationId(),
      expectedStateVersion: snapshot.stateVersion,
      columns,
      rows,
      resizeSequence: nextSequence,
      leaseId: lease.id,
      controlEpoch: lease.epoch
    };
    try {
      const response = unwrap(await window.codeAgentDesktop.resizeTerminalSession(snapshot.terminalSessionId, body)) as {
        columns: number; rows: number; resizeSequence: number;
      };
      resizeSequenceRef.current = Math.max(resizeSequenceRef.current, response.resizeSequence);
      lastSentSizeRef.current = { columns: response.columns, rows: response.rows };
      const pending = pendingSizeRef.current;
      if (pending && pending.columns === columns && pending.rows === rows) {
        pendingSizeRef.current = null;
      }
    } catch (resizeError) {
      if (mountedRef.current) setError(errorMessage(resizeError));
    }
  }, []);

  const scheduleResize = useCallback((columns: number, rows: number): void => {
    pendingSizeRef.current = { columns, rows };
    if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      const pending = pendingSizeRef.current;
      if (pending) void sendResize(pending.columns, pending.rows);
    }, RESIZE_SEND_DEBOUNCE_MILLIS);
  }, [sendResize]);

  /**
   * Single-client convenience: when control is FREE the dock takes the input
   * lease on attach and on first keystroke instead of requiring a button.
   * A session HELD by another controller is never stolen implicitly — the
   * explicit 接管 button stays for that case.
   */
  const ensureLease = useCallback(async (implicit: boolean): Promise<boolean> => {
    if (leaseRef.current) return true;
    if (acquiringRef.current) return acquiringRef.current;
    const snapshot = snapshotRef.current;
    // `canUserWrite` describes the current controller, so it is false while
    // the terminal is FREE. A FREE terminal is exactly when this client may
    // acquire the input lease; checking canUserWrite here made every fresh
    // terminal permanently read-only even though canAcquire was true.
    if (!snapshot || !snapshot.canAcquire || snapshot.inputPolicy === 'NONE'
        || TERMINAL_STATES.has(snapshot.state) || streamBlocked) return false;
    if (implicit && snapshot.controlState === 'HELD') return false;
    acquiringRef.current = (async () => {
      try {
        const body: TerminalControlAcquireRequest = {
          operationId: operationId(),
          expectedControlVersion: snapshot.controlVersion
        };
        const response = unwrap(await window.codeAgentDesktop.acquireTerminalControl(snapshot.terminalSessionId, body)) as {
          delivery: Delivery; leaseId?: string | null; controlEpoch: number; canInput?: boolean;
        };
        if (!isAcceptedDelivery(response.delivery) || !response.leaseId) {
          if (response.delivery === 'NOT_APPLIED') {
            // Version raced with a control change; reconcile once.
            const fresh = await refreshSelected(snapshot.terminalSessionId);
            if (fresh && fresh.canAcquire && fresh.controlState !== 'HELD') {
              const retryBody: TerminalControlAcquireRequest = {
                operationId: operationId(),
                expectedControlVersion: fresh.controlVersion
              };
              const retry = unwrap(await window.codeAgentDesktop.acquireTerminalControl(snapshot.terminalSessionId, retryBody)) as {
                delivery: Delivery; leaseId?: string | null; controlEpoch: number; canInput?: boolean;
              };
              if (isAcceptedDelivery(retry.delivery) && retry.leaseId) {
                leaseRef.current = { id: retry.leaseId, epoch: retry.controlEpoch };
                if (mountedRef.current) {
                  setHasLease(true);
                  setControlCanInput(Boolean(retry.canInput ?? true));
                }
                const pendingRetry = pendingSizeRef.current;
                if (pendingRetry) void sendResize(pendingRetry.columns, pendingRetry.rows);
                return true;
              }
            }
          }
          if (mountedRef.current && !implicit) setNotice(`控制权未确认（${response.delivery}）；未启用输入。`);
          return false;
        }
        leaseRef.current = { id: response.leaseId, epoch: response.controlEpoch };
        if (mountedRef.current) {
          setHasLease(true);
          setControlCanInput(Boolean(response.canInput ?? true));
          setError(null);
        }
        // A fit() that landed while the lease was in flight gets flushed now.
        const pending = pendingSizeRef.current;
        if (pending) void sendResize(pending.columns, pending.rows);
        return true;
      } catch (acquireError) {
        if (mountedRef.current && !implicit) setError(errorMessage(acquireError));
        return false;
      } finally {
        acquiringRef.current = null;
        invalidate();
      }
    })();
    return acquiringRef.current;
  }, [invalidate, refreshSelected, sendResize, streamBlocked]);

  const flushInput = useCallback(async (): Promise<void> => {
    if (inputFlushRef.current) return;
    inputFlushRef.current = true;
    let retries = 0;
    try {
      while (inputQueueRef.current.length > 0) {
        const snapshot = snapshotRef.current;
        if (!snapshot || TERMINAL_STATES.has(snapshot.state) || streamBlocked) {
          inputQueueRef.current.length = 0;
          return;
        }
        if (!(await ensureLease(true))) {
          inputQueueRef.current.length = 0;
          if (mountedRef.current) {
            setNotice(snapshot.controlState === 'HELD'
              ? `终端正由${snapshot.safeHolderLabel ?? '其他端'}控制；先点“接管控制”再输入。`
              : snapshot.terminalCause === 'WORKSPACE_LEASE_LOST'
                ? '该终端的工作区租约已失效，只能关闭；可新建一个终端。'
                : '暂时无法接管终端输入，请稍后再试。');
          }
          return;
        }
        const lease = leaseRef.current;
        if (!lease) return;
        // ensureLease/refreshSelected may have advanced the snapshot while the
        // lease was in flight; send against the freshest versions we hold.
        const fresh = snapshotRef.current ?? snapshot;
        const text = inputQueueRef.current.splice(0).join('');
        const body: TerminalInputRequest = {
          operationId: operationId(),
          expectedStateVersion: fresh.stateVersion,
          expectedInputVersion: fresh.inputVersion,
          encoding: 'UTF8',
          text,
          controller: 'USER',
          leaseId: lease.id,
          controlEpoch: lease.epoch
        };
        try {
          const response = unwrap(await window.codeAgentDesktop.writeTerminalInput(snapshot.terminalSessionId, body)) as {
            delivery: Delivery; inputVersion: number;
          };
          if (response.delivery === 'NOT_APPLIED' && retries < 1) {
            // NOT_APPLIED is a definitive rejection (nothing was written), so
            // re-queue the bytes, resync versions, and retry exactly once.
            retries += 1;
            inputQueueRef.current.unshift(text);
            await refreshSelected(snapshot.terminalSessionId);
            continue;
          }
          if (response.delivery !== 'APPLIED' && response.delivery !== 'PENDING'
              && response.delivery !== 'REPLAY') {
            if (mountedRef.current) setNotice(`输入未确认（${response.delivery}）；不会自动重试。`);
            void refreshSelected(snapshot.terminalSessionId);
          } else if (snapshotRef.current) {
            snapshotRef.current = { ...snapshotRef.current, inputVersion: response.inputVersion };
          }
        } catch (inputError) {
          const combined = `${errorCode(inputError)} ${errorMessage(inputError)}`;
          if (retries < 1 && /TERMINAL_STATE_CONFLICT|TERMINAL_INPUT_VERSION/i.test(combined)) {
            // A version conflict means the write never reached the PTY.
            retries += 1;
            inputQueueRef.current.unshift(text);
            await refreshSelected(snapshot.terminalSessionId);
            continue;
          }
          if (mountedRef.current) setError(errorMessage(inputError));
          void refreshSelected(snapshot.terminalSessionId);
        }
      }
    } finally {
      inputFlushRef.current = false;
    }
  }, [ensureLease, refreshSelected, streamBlocked]);

  const onViewData = useCallback((data: string): void => {
    inputQueueRef.current.push(data);
    void flushInput();
  }, [flushInput]);

  const onViewResize = useCallback((columns: number, rows: number): void => {
    if (columns < 1 || rows < 1) return;
    scheduleResize(columns, rows);
  }, [scheduleResize]);

  const onViewIntent = useCallback((): void => {
    void ensureLease(true).then((acquired) => {
      if (!acquired) return;
      const pending = pendingSizeRef.current ?? viewRef.current?.dimensions() ?? null;
      if (pending) void sendResize(pending.columns, pending.rows);
    });
  }, [ensureLease, sendResize]);

  // BUSINESS_SESSION terminals are long-lived, so give them their own
  // service-managed worktree. Capture current WIP into that worktree instead
  // of taking a writer lease on the shared authoritative checkout.
  const ensureSessionWorkspace = useCallback(async (): Promise<string> => {
    if (!props.projectId) throw new Error('没有可用工作区。');
    // The workspace query can still be loading when the user immediately
    // clicks the primary action after opening a session. Refresh once before
    // provisioning so an already-live session worktree is reused instead of
    // sending a duplicate-owner create request.
    const refreshed = await workspacesQuery.refetch();
    const existing = (refreshed.data ?? []).find(
      (workspace) => workspace.kind === 'WORKTREE'
        && workspace.ownerType === 'SESSION'
        && workspace.ownerId === props.businessSessionId
        && workspace.state === 'IN_USE'
        && !workspace.leaseExpired
    );
    if (existing) {
      setWorkspaceExecutionId(existing.workspaceExecutionId);
      return existing.workspaceExecutionId;
    }
    const created = unwrap(await window.codeAgentDesktop.createWorkspaceExecution({
      workspaceAlias: props.projectId,
      kind: 'WORKTREE',
      ownerType: 'SESSION',
      ownerId: props.businessSessionId,
      startPolicy: 'USER_WIP_SNAPSHOT'
    })) as WorkspaceExecutionResponse;
    void queryClient.invalidateQueries({ queryKey: ['workspace-executions'] });
    setNotice(`终端将在隔离工作树中运行：${created.workspaceRef ?? created.workspaceExecutionId}`);
    return created.workspaceExecutionId;
  }, [props.businessSessionId, props.projectId, queryClient, workspacesQuery]);

  const createSession = useCallback(async (params: CreateParams): Promise<void> => {
    setBusyAction('create');
    try {
      let targetWorkspaceId = workspaceExecutionId;
      const chosen = availableWorkspaces.find((workspace) => workspace.workspaceExecutionId === targetWorkspaceId);
      if (!chosen) {
        try {
          targetWorkspaceId = await ensureSessionWorkspace();
          setWorkspaceExecutionId(targetWorkspaceId);
        } catch (provisionError) {
          setError(`隔离终端工作区创建失败：${errorMessage(provisionError)}`);
          return;
        }
      }
      const body: TerminalSessionCreateRequest = {
        workspaceExecutionId: targetWorkspaceId,
        profile: 'USER_SHELL',
        executable: params.executable,
        arguments: params.arguments,
        columns: viewRef.current?.dimensions()?.columns ?? 120,
        rows: viewRef.current?.dimensions()?.rows ?? 32,
        lifetimeScope: 'BUSINESS_SESSION',
        inputPolicy: 'USER_ONLY',
        terminalMode: params.terminalMode,
        networkIntent: 'INHERIT'
      };
      let created: TerminalSessionResponse;
      try {
        created = unwrap(await window.codeAgentDesktop.createTerminalSession(props.businessSessionId, body)) as TerminalSessionResponse;
      } catch (firstError) {
        // A stale selection can still lose its lease between list and create;
        // provision a fresh session workspace once and retry.
        if (/WORKSPACE_LEASE_LOST/i.test(`${errorCode(firstError)} ${errorMessage(firstError)}`)) {
          try {
            const recovered = await ensureSessionWorkspace();
            setWorkspaceExecutionId(recovered);
            created = unwrap(await window.codeAgentDesktop.createTerminalSession(props.businessSessionId, {
              ...body, workspaceExecutionId: recovered
            })) as TerminalSessionResponse;
          } catch (retryError) {
            throw retryError;
          }
        } else if (params.terminalMode === 'FULL_VT') {
          // Older gates may only allow LINE_STREAM; degrade once, visibly.
          created = unwrap(await window.codeAgentDesktop.createTerminalSession(props.businessSessionId, {
            ...body, terminalMode: 'LINE_STREAM'
          })) as TerminalSessionResponse;
          setNotice('服务未接受 FULL_VT，已降级为 LINE_STREAM 行模式。');
        } else {
          throw firstError;
        }
      }
      createParamsRef.current.set(created.terminalSessionId, params);
      sessionNamesRef.current.set(created.terminalSessionId, params.label);
      createdSessionsRef.current.set(created.terminalSessionId, created);
      setError(null);
      setNotice((current) => current ?? '终端已启动；可直接输入。');
      setShowCreateOptions(false);
      setCommandText('');
      // Seed the list so the fresh session is selectable before the next
      // refetch lands; otherwise the not-in-list guard drops the selection.
      queryClient.setQueryData(
        ['terminal-sessions', props.businessSessionId],
        (old: TerminalSessionResponse[] | undefined) => [...(old ?? []).filter((s) => s.terminalSessionId !== created.terminalSessionId), created]
      );
      void queryClient.invalidateQueries({ queryKey: ['terminal-sessions', props.businessSessionId] });
      setSelectedId(created.terminalSessionId);
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setBusyAction(null);
    }
  }, [props.businessSessionId, queryClient, workspaceExecutionId, availableWorkspaces, ensureSessionWorkspace]);

  const runShellCommand = useCallback((): void => {
    const command = commandText.trim();
    if (!command) return;
    void createSession({
      executable: 'powershell',
      arguments: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', command],
      terminalMode: 'FULL_VT',
      label: command.length > 24 ? `${command.slice(0, 24)}…` : command
    });
  }, [commandText, createSession]);

  const createPowerShell = useCallback((): void => {
    void createSession({
      executable: 'powershell',
      arguments: ['-NoLogo', '-NoProfile'],
      terminalMode: createMode,
      label: 'PowerShell'
    });
  }, [createMode, createSession]);

  // U5 T4: like VS Code, opening the panel on a session with no usable
  // terminal starts one PowerShell automatically (opt-out in settings →
  // 通用 → 打开终端面板时自动启动 Shell). Evaluated once per session.
  useEffect(() => {
    autoStartedRef.current = false;
  }, [props.businessSessionId]);
  useEffect(() => {
    if (autoStartedRef.current || !props.enabled || !terminalAutoStartEnabled()) return;
    if (!terminalsQuery.isSuccess || terminalsQuery.isError) return;
    autoStartedRef.current = true;
    if (terminalList.length === 0 && props.projectId) createPowerShell();
  }, [props.enabled, props.projectId, terminalsQuery.isSuccess, terminalsQuery.isError, terminalList.length, createPowerShell]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPolling();
      void releaseLease();
    };
  }, [releaseLease, stopPolling]);

  useEffect(() => {
    if (!props.enabled) {
      stopPolling();
      void releaseLease();
      return;
    }
    if (selectedId && !terminalIds.includes(selectedId)
        && !createdSessionsRef.current.has(selectedId)) {
      setSelectedId(null);
      stopPolling();
    }
    if (!selectedId && terminalIds[0]) setSelectedId(terminalIds[0]);
  }, [props.enabled, selectedId, stopPolling, terminalIds]);

  // The current project is the default context. A user should not have to
  // pick the only valid workspace before opening a terminal.
  useEffect(() => {
    if (!props.enabled) return;
    if (!workspaceExecutionId) {
      if (availableWorkspaces[0]) setWorkspaceExecutionId(availableWorkspaces[0].workspaceExecutionId);
      return;
    }
    if (!availableWorkspaces.some((workspace) => workspace.workspaceExecutionId === workspaceExecutionId)) {
      setWorkspaceExecutionId(availableWorkspaces[0]?.workspaceExecutionId ?? '');
    }
  }, [availableWorkspaces, props.enabled, workspaceExecutionId]);

  // Attach on selection: fresh emulator, replay retained spool from offset 0,
  // then implicit lease for FREE sessions so typing works without ceremony.
  useEffect(() => {
    if (!selectedId || !selected) return;
    stopPolling();
    serviceInstanceRef.current = selected.serviceInstanceId;
    snapshotRef.current = selected;
    setStreamBlocked(selected.state === 'LOST');
    setError(selected.state === 'LOST' ? '该终端已因 Service 重启而 LOST，不能附着或重放。' : null);
    setNotice(null);
    viewRef.current?.reset();
    urlTailRef.current = '';
    setDetectedUrl(null);
    outputCursorRef.current = undefined;
    replayFallbackRef.current = false;
    leaseRef.current = null;
    setHasLease(false);
    setControlCanInput(false);
    resizeSequenceRef.current = 0;
    lastSentSizeRef.current = null;
    pendingSizeRef.current = null;
    inputQueueRef.current.length = 0;
    if (selected.state !== 'LOST') {
      // Terminal states still drain the retained spool once — a crashed dev
      // server leaves its final log readable; eof ends the loop.
      pollActiveRef.current = true;
      void pollOutput(selected.terminalSessionId);
    }
    return () => {
      stopPolling();
      void releaseLease();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || !props.enabled) return;
    const timer = window.setInterval(() => {
      void refreshSelected(selectedId);
    }, SNAPSHOT_INTERVAL_MILLIS);
    return () => window.clearInterval(timer);
  }, [props.enabled, refreshSelected, selectedId]);

  // Keep the dock's selected snapshot fresh for lease/version reads.
  useEffect(() => {
    if (selected) snapshotRef.current = selected;
  }, [selected]);

  // Implicit lease: take control whenever the snapshot says the terminal is
  // FREE (canAcquire is only true while FREE). Sessions that were STARTING at
  // attach become acquireable on a later refresh, so this must watch the
  // snapshot, not just run once at attach. Throttled so a persistently
  // failing acquire does not hammer the service on every refresh.
  useEffect(() => {
    if (!selected || !props.enabled) return;
    if (leaseRef.current || acquiringRef.current) return;
    if (selected.state === 'LOST' || TERMINAL_STATES.has(selected.state)) return;
    if (selected.terminalCause === 'WORKSPACE_LEASE_LOST') return;
    if (!selected.canAcquire || selected.controlState === 'HELD') return;
    const now = Date.now();
    if (now - lastImplicitAcquireRef.current < 10_000) return;
    lastImplicitAcquireRef.current = now;
    void ensureLease(true);
  }, [selected, props.enabled, ensureLease]);

  useEffect(() => {
    if (!selected || !leaseRef.current || selected.controlState === 'CLOSED') return;
    if (selected.remainingControlTtlMillis > CONTROL_RENEW_BEFORE_MILLIS) return;
    const lease = leaseRef.current;
    const body: TerminalControlRenewRequest = {
      operationId: operationId(),
      leaseId: lease.id,
      controlEpoch: lease.epoch,
      expectedControlVersion: selected.controlVersion
    };
    void (async () => {
      try {
        const response = unwrap(await window.codeAgentDesktop.renewTerminalControl(selected.terminalSessionId, body)) as {
          delivery: Delivery; leaseId?: string | null; controlEpoch: number; canInput?: boolean;
        };
        if (!isAcceptedDelivery(response.delivery) || !response.leaseId) {
          if (mountedRef.current) setNotice(`控制续租未确认（${response.delivery}）。`);
          return;
        }
        leaseRef.current = { id: response.leaseId, epoch: response.controlEpoch };
        if (mountedRef.current) {
          setHasLease(true);
          setControlCanInput(Boolean(response.canInput));
        }
        invalidate();
      } catch (renewError) {
        if (mountedRef.current) setError(errorMessage(renewError));
      }
    })();
  }, [invalidate, selected]);

  const sendSignal = useCallback(async (signal: TerminalSignalRequest['signal']): Promise<void> => {
    const snapshot = snapshotRef.current;
    if (!snapshot) return;
    setBusyAction(signal);
    try {
      if (!(await ensureLease(false))) {
        setError('当前终端没有可用的用户输入控制。');
        return;
      }
      const lease = leaseRef.current;
      if (!lease) return;
      const fresh = snapshotRef.current ?? snapshot;
      const body: TerminalSignalRequest = {
        operationId: operationId(),
        expectedStateVersion: fresh.stateVersion,
        signal,
        graceMillis: signal === 'INTERRUPT' ? 1000 : undefined,
        forceAfterGrace: signal === 'TERMINATE',
        leaseId: lease.id,
        controlEpoch: lease.epoch
      };
      const response = unwrap(await window.codeAgentDesktop.signalTerminalSession(snapshot.terminalSessionId, body)) as { delivery: Delivery; accepted: boolean };
      if (response.delivery === 'UNKNOWN') setError('停止信号结果未知；不会自动重试。');
      else setNotice(response.accepted ? '停止信号已接受。' : `停止信号未接受（${response.delivery}）。`);
      invalidate();
    } catch (signalError) {
      setError(errorMessage(signalError));
    } finally {
      setBusyAction(null);
    }
  }, [ensureLease, invalidate]);

  const closeSession = useCallback(async (): Promise<void> => {
    // Bind the click to the terminal actually rendered. The child emulator can
    // mount (and its close button can be used) before the passive attach effect
    // initializes snapshotRef, or while it still describes the previous tab.
    const snapshot = selected;
    if (!snapshot) return;
    setBusyAction('close');
    try {
      // An orphaned terminal (dead workspace lease) can never issue a control
      // lease again; the service treats close on it as pure cleanup.
      const orphaned = snapshot.terminalCause === 'WORKSPACE_LEASE_LOST';
      if (!orphaned && (snapshotRef.current?.terminalSessionId !== snapshot.terminalSessionId
          || snapshotRef.current.serviceInstanceId !== snapshot.serviceInstanceId)) {
        setNotice('所选终端仍在连接；未发送关闭请求，请稍后重试。');
        return;
      }
      if (!orphaned && !(await ensureLease(false))) {
        setError('当前终端没有可用的控制权限。');
        return;
      }
      const lease = orphaned ? null : leaseRef.current;
      const observed = snapshotRef.current;
      const fresh = observed?.terminalSessionId === snapshot.terminalSessionId
        && observed.serviceInstanceId === snapshot.serviceInstanceId ? observed : snapshot;
      const body: TerminalCloseRequest = {
        operationId: operationId(),
        leaseId: lease?.id ?? 'orphan',
        controlEpoch: lease?.epoch ?? fresh.controlEpoch,
        expectedStateVersion: fresh.stateVersion
      };
      const response = unwrap(await window.codeAgentDesktop.closeTerminalSession(snapshot.terminalSessionId, body)) as { accepted: boolean; finalState: string };
      if (response.accepted) {
        // Only forget the lease once the close landed: on rejection the
        // Service still holds it, and re-acquiring would hit control-busy.
        leaseRef.current = null;
        setHasLease(false);
        setControlCanInput(false);
        stopPolling();
        const closedId = snapshot.terminalSessionId;
        createdSessionsRef.current.delete(closedId);
        createParamsRef.current.delete(closedId);
        sessionNamesRef.current.delete(closedId);
        queryClient.setQueryData(
          ['terminal-sessions', props.businessSessionId],
          (sessions: TerminalSessionResponse[] | undefined) => (sessions ?? []).filter((session) => session.terminalSessionId !== closedId)
        );
        setSelectedId(null);
      }
      setNotice(response.accepted ? `终端已关闭（${response.finalState}）。` : '终端关闭未接受。');
      invalidate();
    } catch (closeError) {
      setError(errorMessage(closeError));
    } finally {
      setBusyAction(null);
    }
  }, [ensureLease, invalidate, selected, stopPolling]);

  const hasTerminals = terminalList.length > 0;
  const selectedWorkspace = availableWorkspaces.find((workspace) => workspace.workspaceExecutionId === workspaceExecutionId) ?? null;
  const workspaceSummary = selectedWorkspace
    ? workspaceLabel(selectedWorkspace)
    : workspacesQuery.isLoading
      ? '正在查找执行工作区…'
      : props.projectId
        ? '将自动创建会话隔离工作区（含当前改动快照）'
        : '没有可用执行工作区';
  const canCreate = Boolean(props.projectId);
  const onWorkspaceSummary = props.onWorkspaceSummary;
  // T2: the workspace one-liner lives on the panel chrome (WorkPane.subtitle),
  // reported up instead of duplicated inside the dock (U5 §9.1).
  useEffect(() => {
    onWorkspaceSummary?.(props.enabled ? workspaceSummary : null);
  }, [onWorkspaceSummary, workspaceSummary, props.enabled]);

  if (!props.enabled) {
    return (
      <section className="terminal-dock terminal-unavailable" data-testid="terminal-dock">
        <p className="surface-note">Service 未报告可用的 PTY 能力，已 fail-closed。</p>
        {props.unavailableReason ? <p className="run-meta">原因：{props.unavailableReason}</p> : null}
        <p className="run-meta">开发环境可在服务配置中开启 terminal.enabled、terminal.user-shell-enabled 与 terminal.local-debug-readiness；packaged 环境需要 readiness manifest。</p>
      </section>
    );
  }

  const terminalClosed = selected === null || TERMINAL_STATES.has(selected.state);
  const restartParams = selected ? createParamsRef.current.get(selected.terminalSessionId) : undefined;
  const heldByOther = selected?.controlState === 'HELD' && !hasLease;
  const controlLabel = heldByOther
    ? `${selected?.safeHolderLabel ?? (selected?.controller === 'AGENT' ? 'Agent' : '其他端')}控制中`
    : hasLease
      ? '本端控制'
      : '未接管';
  const copyOutput = (): void => {
    const text = viewRef.current?.copyText() ?? '';
    if (!text) return;
    if (!navigator.clipboard) {
      setError('当前环境不支持复制终端输出。');
      return;
    }
    void navigator.clipboard.writeText(text)
      .then(() => setNotice('终端输出已复制。'))
      .catch(() => setError('终端输出复制失败。'));
  };
  const openDetectedUrl = (): void => {
    if (!detectedUrl) return;
    void window.codeAgentDesktop.openExternalHttps(detectedUrl).catch(() => setError('无法在浏览器中打开链接。'));
  };

  return (
    <section className="terminal-dock" data-testid="terminal-dock">
      {terminalsQuery.isError ? <p className="error-text" role="alert">终端列表加载失败：{errorMessage(terminalsQuery.error)}</p> : null}
      <div className="terminal-tabbar">
        <div className="terminal-tabs" role="tablist" aria-label="终端会话">
          {terminalList.map((session, index) => {
            const exited = TERMINAL_STATES.has(session.state)
              && session.exitCode !== null && session.exitCode !== undefined;
            return (
              <button
                key={session.terminalSessionId}
                type="button"
                role="tab"
                aria-selected={session.terminalSessionId === selectedId}
                className={`terminal-tab${session.terminalSessionId === selectedId ? ' terminal-tab-active' : ''}`}
                onClick={() => setSelectedId(session.terminalSessionId)}
              >
                {isAgentSession(session) ? <span className="terminal-badge-agent">Agent</span> : null}
                <span className="terminal-tab-label">{sessionTabLabel(session, index, sessionNamesRef.current)}</span>
                <span className={`terminal-tab-dot terminal-state-${session.state}`} title={terminalStateLabel(session.state)} aria-hidden="true" />
                {exited ? <span className="terminal-tab-exit">已退出 ({session.exitCode})</span> : null}
              </button>
            );
          })}
        </div>
        <span className="terminal-new popover-anchor">
          <button
            type="button"
            className="terminal-new-button"
            aria-label={hasTerminals ? '新建 PowerShell' : '打开 PowerShell'}
            title={hasTerminals ? '新建 PowerShell' : '打开 PowerShell'}
            disabled={!canCreate || busyAction === 'create'}
            onClick={createPowerShell}
          ><Icon name="plus" size={13} /></button>
          <button
            type="button"
            ref={newMenuButtonRef}
            className="terminal-new-menu-button"
            aria-label="更多终端选项"
            aria-haspopup="menu"
            aria-expanded={newMenuOpen}
            disabled={!canCreate}
            onClick={() => setNewMenuOpen((open) => !open)}
          ><Icon name="chevron" size={12} className="rotate-90" /></button>
          <Popover open={newMenuOpen} onClose={() => setNewMenuOpen(false)} anchorRef={newMenuButtonRef} placement="bottom" align="end" ariaLabel="新建终端">
            <Menu ariaLabel="新建终端" autoFocus={false}>
              <MenuItem
                icon="terminal"
                title="PowerShell"
                description="在会话隔离工作区打开交互式 Shell"
                disabled={!canCreate || busyAction === 'create'}
                onSelect={() => { setNewMenuOpen(false); createPowerShell(); }}
              />
              <MenuItem
                icon="play"
                title="运行命令…"
                description="以命令命名并启动一个新终端"
                disabled={!canCreate || busyAction === 'create'}
                onSelect={() => { setNewMenuOpen(false); setShowCommandInput(true); }}
              />
              <MenuItem
                icon="settings"
                title="自定义启动…"
                description="选择工作区、可执行文件、参数与模式"
                disabled={!canCreate}
                onSelect={() => { setNewMenuOpen(false); setShowCreateOptions(true); }}
              />
            </Menu>
          </Popover>
        </span>
      </div>
      {showCommandInput ? (
        <form className="terminal-run-command" onSubmit={(event) => { event.preventDefault(); runShellCommand(); }}>
          <input
            aria-label="在终端中运行命令"
            value={commandText}
            onChange={(event) => setCommandText(event.target.value)}
            maxLength={512}
            placeholder="运行命令，如 pnpm dev…"
            autoFocus
          />
          <button type="submit" disabled={!canCreate || !commandText.trim() || busyAction === 'create'}>运行</button>
          <button type="button" aria-label="关闭命令输入" onClick={() => setShowCommandInput(false)}><Icon name="x" size={12} /></button>
        </form>
      ) : null}
      {showCreateOptions ? <div className="terminal-dock-create">
        <label>执行工作区<select aria-label="终端 workspace" value={workspaceExecutionId} onChange={(event) => setWorkspaceExecutionId(event.target.value)}>
          <option value="">没有可用工作区</option>
          {availableWorkspaces.map((workspace) => <option key={workspace.workspaceExecutionId} value={workspace.workspaceExecutionId}>{workspaceLabel(workspace)}</option>)}
        </select></label>
        <label>可执行文件<input value={executable} onChange={(event) => setExecutable(event.target.value)} maxLength={256} /></label>
        <label>参数<input value={argumentsText} onChange={(event) => setArgumentsText(event.target.value)} maxLength={1024} /></label>
        <label>模式<select aria-label="终端模式" value={createMode} onChange={(event) => setCreateMode(event.target.value === 'LINE_STREAM' ? 'LINE_STREAM' : 'FULL_VT')}>
          <option value="FULL_VT">FULL_VT（完整终端）</option>
          <option value="LINE_STREAM">LINE_STREAM（行模式）</option>
        </select></label>
        <button
          type="button"
          disabled={!canCreate || !executable.trim() || busyAction === 'create'}
          onClick={() => void createSession({
            executable: executable.trim(),
            arguments: argumentsText.trim() ? argumentsText.trim().split(/\s+/) : [],
            terminalMode: createMode,
            label: executable.trim()
          })}
        >自定义启动</button>
        <button type="button" onClick={() => setShowCreateOptions(false)}>收起</button>
      </div> : null}
      {workspacesQuery.isError ? <p className="surface-note">Workspace execution 不可用：{errorMessage(workspacesQuery.error)}</p> : null}
      {selected ? <>
        <TerminalView
          ref={viewRef}
          onData={onViewData}
          onResize={onViewResize}
          onUserIntent={onViewIntent}
        />
        <div className="terminal-dock-statusbar">
          <span className="terminal-dock-meta">
            <span>{controlLabel}</span>
            <span>{terminalStateLabel(selected.state)}</span>
            <span>{selected.terminalMode === 'FULL_VT' ? '完整终端' : '行模式'}</span>
            <span>{selected.columns}×{selected.rows}</span>
            {isAgentSession(selected) ? <span className="terminal-badge-agent">Agent{selected.createdByRunId ? ` · ${selected.createdByRunId.slice(0, 8)}` : ''}</span> : null}
            {selected.terminalCause === 'WORKSPACE_LEASE_LOST' ? <StatusBadge tone="warn" label="工作区租约失效" /> : null}
            {selected.exitCode !== null && selected.exitCode !== undefined ? <span>退出码 {selected.exitCode}</span> : null}
          </span>
          <span className="terminal-dock-controls">
            {detectedUrl ? <button type="button" className="terminal-open-url" onClick={openDetectedUrl}>打开 {detectedUrl}</button> : null}
            <button type="button" className="terminal-copy-button" onClick={copyOutput}>复制输出</button>
            {heldByOther && selected.canAcquire ? (
              <button type="button" onClick={() => void ensureLease(false)}>接管控制</button>
            ) : null}
            {hasLease ? (
              <button type="button" onClick={() => { void releaseLease(); setNotice('已释放本端控制。'); invalidate(); }}>释放控制</button>
            ) : null}
            <button type="button" onClick={() => void sendSignal('INTERRUPT')} disabled={terminalClosed || busyAction !== null || (!selected.allowedActions.canInterrupt && !(selected.canAcquire && selected.inputPolicy !== 'NONE'))}>中断 (Ctrl+C)</button>
            <button type="button" onClick={() => void sendSignal('TERMINATE')} disabled={terminalClosed || busyAction !== null || (!selected.allowedActions.canTerminate && !(selected.canAcquire && selected.inputPolicy !== 'NONE'))}>终止</button>
            {terminalClosed && restartParams ? (
              <button type="button" onClick={() => void createSession(restartParams)} disabled={busyAction !== null}>重启</button>
            ) : null}
            <button type="button" onClick={() => void closeSession()} disabled={terminalClosed || busyAction !== null || (!selected.allowedActions.canClose && !(selected.canAcquire && selected.inputPolicy !== 'NONE') && selected.terminalCause !== 'WORKSPACE_LEASE_LOST')}>关闭</button>
          </span>
        </div>
      </> : <div className="terminal-empty-state">
        <strong>{hasTerminals ? '正在打开终端…' : '还没有终端'}</strong>
        {hasTerminals ? null : <>
          <button
            className="terminal-primary-action"
            type="button"
            disabled={!canCreate || busyAction === 'create'}
            onClick={createPowerShell}
          >{busyAction === 'create' ? '启动中…' : '启动 PowerShell'}</button>
          <span>{canCreate
            ? lostTerminalCount > 0
              ? '旧终端已随 Service 重启失效；启动一个新的 PowerShell 即可在当前会话继续使用终端。'
              : '终端用来跑需要持续运行或交互的进程：开发服务器、watcher、REPL、命令行工具。'
            : '当前项目没有可用的执行工作区。'}</span>
        </>}
      </div>}
      {streamBlocked ? <p className="error-text" role="alert">输出流已停止：旧终端不会自动附着或重放。</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="surface-note" role="status">{notice}</p> : null}
      {selected?.controlState === 'RECONCILE_REQUIRED' ? <p className="error-text">控制状态需要 Service 对账；本端输入已禁用。</p> : null}
      {selected?.state === 'LOST' ? <p className="error-text">Service 重启后终端为 LOST，只能重新启动新会话。</p> : null}
    </section>
  );
}
