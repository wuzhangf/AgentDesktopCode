/**
 * Personal access surface (UCA-001 C4): the desktop's `client-access/1` view.
 *
 * Design rules this panel follows:
 * - it never branches on `sourceKind`/`engineId`; those are display labels;
 * - replies are POLLed and a snapshot replaces a snapshot, an unchanged poll
 *   never erases text the user is reading;
 * - a send/action failure is never silently retried: the original request id
 *   stays on screen so the user can look up the source receipt;
 * - an approval shape shows the full question context before it can be used;
 * - unavailable actions stay visible with their reason code instead of
 *   disappearing, so a missing capability is legible rather than mysterious.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { unwrap } from '../../../packages/protocol/src/proxy-result';
import {
  applyReplies,
  visibleText,
  type AgentDescriptor,
  type ConversationPage,
  type ConversationSummary,
  type ConversationView,
  type Reply,
  type ReplyPage,
  type ActionDescriptor
} from '../../../packages/client-access/src/index';
import type { PersonalAccessStatus } from '../../../packages/client-access/src/status';

interface Failure { code: string; message: string; requestId?: string }

const REFRESH_MS = 2000;
const MAX_CONTENT_PAGES = 20;

function toFailure(error: unknown): Failure {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    const message = error instanceof Error ? error.message : code;
    return { code, message };
  }
  return { code: 'PERSONAL_ACCESS_FAILED', message: error instanceof Error ? error.message : String(error) };
}

export function PersonalAccessPanel(props: { onBack: () => void }): React.JSX.Element {
  const api = window.codeAgentDesktop;
  const available = typeof api.personalAccess === 'function';

  const [status, setStatus] = useState<PersonalAccessStatus | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [showBindingForm, setShowBindingForm] = useState(false);
  const [origin, setOrigin] = useState('');
  const [basePath, setBasePath] = useState('/personal/v1/client');
  const [caPemPath, setCaPemPath] = useState('');
  const [token, setToken] = useState('');

  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [directory, setDirectory] = useState<ConversationPage | null>(null);
  const [conversationRef, setConversationRef] = useState<string | null>(null);
  const [view, setView] = useState<ConversationView | null>(null);
  const [page, setPage] = useState<ReplyPage | undefined>(undefined);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [composer, setComposer] = useState('');
  const [draft, setDraft] = useState<{ descriptor: ActionDescriptor; text: string } | null>(null);
  const [lastRequestId, setLastRequestId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const call = useCallback(async <T,>(operation: Record<string, unknown>): Promise<T> => {
    if (!api.personalAccess) throw Object.assign(new Error('此构建不含个人接入通道'), { code: 'CHANNEL_ABSENT' });
    return unwrap<T>(await api.personalAccess(operation as never));
  }, [api]);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await call<PersonalAccessStatus>({ action: 'STATUS' });
      setStatus(next);
      if (next.origin) setOrigin(next.origin);
      if (next.basePath) setBasePath(next.basePath);
      return next;
    } catch (error) {
      setFailure(toFailure(error));
      return null;
    }
  }, [call]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const loadAgents = useCallback(async () => {
    try {
      const list = await call<{ items: AgentDescriptor[] }>({ action: 'AGENTS' });
      setAgents(list.items ?? []);
      setFailure(null);
    } catch (error) {
      setFailure(toFailure(error));
    }
  }, [call]);

  const openAgent = useCallback(async (agentRef: string) => {
    setSelectedAgent(agentRef);
    setConversationRef(null);
    setView(null);
    setPage(undefined);
    setContents({});
    setBusy(true);
    try {
      const next = await call<ConversationPage>({ action: 'CONVERSATIONS', agentRef });
      setDirectory(next);
      setFailure(null);
    } catch (error) {
      setFailure(toFailure(error));
      setDirectory(null);
    } finally {
      setBusy(false);
    }
  }, [call]);

  const openConversation = useCallback(async (ref: string) => {
    setConversationRef(ref);
    setPage(undefined);
    setContents({});
    setDraft(null);
    setBusy(true);
    try {
      const next = await call<ConversationView>({ action: 'CONVERSATION', conversationRef: ref });
      setView(next);
      const first = await call<ReplyPage>({ action: 'REPLIES', conversationRef: ref });
      setPage(applyReplies(undefined, first));
      setFailure(null);
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(false);
    }
  }, [call]);

  // POLL: replies are pull-only, so the panel owns the cadence. A failed poll
  // stops the loop and surfaces the code; it never re-sends anything.
  const pollErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!conversationRef || !status?.connected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      try {
        const next = await call<ReplyPage>({ action: 'REPLIES', conversationRef });
        if (cancelled) return;
        setPage((previous) => applyReplies(previous, next));
        pollErrorRef.current = null;
      } catch (error) {
        if (cancelled) return;
        const failed = toFailure(error);
        pollErrorRef.current = failed.code;
        setFailure(failed);
        return;
      }
      if (!cancelled) timer = setTimeout(() => { void tick(); }, REFRESH_MS);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [call, conversationRef, status?.connected]);

  const connect = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await call<PersonalAccessStatus>({
        action: 'CONFIGURE',
        origin: origin.trim(),
        basePath: basePath.trim(),
        ...(caPemPath.trim() ? { caPemPath: caPemPath.trim() } : {}),
        ...(token ? { token } : {})
      });
      const next = await call<PersonalAccessStatus>({ action: 'CONNECT' });
      setStatus(next);
      setToken('');
      setShowBindingForm(false);
      setNotice(next.tokenPersisted ? '已连接，令牌由系统加密保存。' : '已连接；系统加密不可用，令牌只在本次进程内有效。');
      await loadAgents();
    } catch (error) {
      setFailure(toFailure(error));
      setStatus((previous) => previous ? { ...previous, connected: false } : previous);
    } finally {
      setBusy(false);
    }
  }, [basePath, caPemPath, call, loadAgents, origin, token]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      const next = await call<PersonalAccessStatus>({ action: 'DISCONNECT' });
      setStatus(next);
      setAgents([]);
      setDirectory(null);
      setConversationRef(null);
      setView(null);
      setPage(undefined);
      setNotice(null);
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(false);
    }
  }, [call]);

  const send = useCallback(async () => {
    const text = composer.trim();
    if (!text || !conversationRef) return;
    const requestId = crypto.randomUUID();
    setBusy(true);
    setFailure(null);
    setLastRequestId(requestId);
    try {
      await call({ action: 'SEND', conversationRef, text, requestId });
      setComposer('');
      setNotice('消息已受理，回复通过轮询到达。');
      const next = await call<ConversationView>({ action: 'CONVERSATION', conversationRef });
      setView(next);
    } catch (error) {
      setFailure({ ...toFailure(error), requestId });
    } finally {
      setBusy(false);
    }
  }, [call, composer, conversationRef]);

  const submitAction = useCallback(async () => {
    if (!draft || !conversationRef) return;
    const requestId = crypto.randomUUID();
    const kind = draft.descriptor.inputKind;
    const input: Record<string, unknown> = kind === 'TEXT' ? { text: draft.text.trim() }
      : kind === 'SELECT' ? { value: draft.text.trim() }
        : kind === 'DECISION' ? { decision: draft.text.trim() }
          : kind === 'CONFIRM' ? { confirmed: true }
            : {};
    setBusy(true);
    setFailure(null);
    setLastRequestId(requestId);
    try {
      await call({
        action: 'ACTION', conversationRef, actionId: draft.descriptor.actionId, input, requestId
      });
      setDraft(null);
      setNotice('动作已受理。');
      const next = await call<ConversationView>({ action: 'CONVERSATION', conversationRef });
      setView(next);
    } catch (error) {
      setFailure({ ...toFailure(error), requestId });
    } finally {
      setBusy(false);
    }
  }, [call, conversationRef, draft]);

  const lookup = useCallback(async (requestId: string) => {
    setBusy(true);
    try {
      const receipt = await call<Record<string, unknown>>({ action: 'LOOKUP', requestId });
      setNotice(`回执：${String(receipt.sourceStatus ?? '未知')}（已消费：${String(receipt.consumed ?? '未知')}）`);
      setFailure(null);
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(false);
    }
  }, [call]);

  const loadContent = useCallback(async (reply: Reply) => {
    if (!conversationRef) return;
    setBusy(true);
    try {
      let cursor: string | undefined;
      let text = '';
      for (let index = 0; index < MAX_CONTENT_PAGES; index += 1) {
        const chunk = await call<{ text: string; nextCursor: string | null; complete: boolean }>({
          action: 'CONTENT', conversationRef, replyRef: reply.replyRef, ...(cursor ? { cursor } : {})
        });
        text += chunk.text;
        if (chunk.complete || !chunk.nextCursor) break;
        cursor = chunk.nextCursor;
      }
      setContents((previous) => ({ ...previous, [reply.replyRef]: text }));
    } catch (error) {
      setFailure(toFailure(error));
    } finally {
      setBusy(false);
    }
  }, [call, conversationRef]);

  const replyItems = useMemo<Reply[]>(() => {
    if (!page) return [];
    if (page.representation === 'TEXT_SNAPSHOT') return page.snapshot ? [page.snapshot] : [];
    return page.items ?? [];
  }, [page]);

  const statusLabel = !available ? '通道不可用'
    : status?.connected ? '已连接' : status?.configured ? '已配置，未连接' : '未配置';

  return (
    <section className="surface-screen personal-access-screen" data-testid="personal-access-surface">
      <div className="surface-heading">
        <div>
          <span className="eyebrow">个人接入</span>
          <h1>个人接入</h1>
          <p>按 client-access/1 连接个人访问服务：连接、发消息、收回复，并按来源声明的能力执行明确动作。</p>
        </div>
        <div className="personal-access-heading-actions">
          <span className={`personal-access-chip ${status?.connected ? 'is-connected' : ''}`} data-testid="personal-access-status">{statusLabel}</span>
          <button type="button" className="secondary-button" onClick={props.onBack}>返回会话</button>
        </div>
      </div>

      {!available ? (
        <p className="surface-note">此构建不含个人接入通道（app/personal-access）。</p>
      ) : null}

      {available && status && (!status.connected || showBindingForm) ? (
        <form className="personal-access-binding" onSubmit={(event) => { event.preventDefault(); void connect(); }}>
          <label>服务地址<input value={origin} placeholder="https://127.0.0.1:9443" onChange={(event) => setOrigin(event.target.value)} /></label>
          <label>基础路径<input value={basePath} placeholder="/personal/v1/client" onChange={(event) => setBasePath(event.target.value)} /></label>
          <label>CA 证书路径（可选）<input value={caPemPath} placeholder="D:\\...\\pac-cert.pem" onChange={(event) => setCaPemPath(event.target.value)} /></label>
          <label>访问令牌<input type="password" value={token} placeholder={status.hasToken ? '已保存，留空则沿用' : 'Bearer 令牌'} onChange={(event) => setToken(event.target.value)} /></label>
          <div className="personal-access-binding-actions">
            <button type="submit" className="primary-button" disabled={busy || origin.trim().length === 0}>{busy ? '连接中…' : '保存并连接'}</button>
            {status.configured ? <button type="button" className="secondary-button" onClick={() => setShowBindingForm(false)}>取消</button> : null}
            <span className="surface-note">{status.encryptionAvailable ? '令牌可加密保存' : '系统加密不可用：令牌只在本次进程内有效'}</span>
          </div>
        </form>
      ) : null}

      {status?.connected ? (
        <div className="personal-access-toolbar">
          <span className="surface-note" data-testid="personal-access-manifest">
            {status.manifest ? `store ${status.manifest.storeId.slice(0, 12)} · ${status.manifest.protocolVersion} · 会话创建${status.manifest.features.conversationCreate ? '可用' : '不可用'} · 正文读取${status.manifest.features.replyContent ? '可用' : '不可用'}` : ''}
          </span>
          <button type="button" className="secondary-button" onClick={() => void loadAgents()} disabled={busy}>刷新来源</button>
          <button type="button" className="secondary-button" onClick={() => setShowBindingForm(true)}>连接设置</button>
          <button type="button" className="secondary-button" onClick={() => void disconnect()} disabled={busy}>断开</button>
        </div>
      ) : null}

      {failure ? (
        <div className="personal-access-failure" role="alert" data-testid="personal-access-failure">
          <strong>{failure.code}</strong>
          <span>{failure.message}</span>
          {failure.requestId ? (
            <button type="button" className="secondary-button" onClick={() => void lookup(failure.requestId!)} disabled={busy}>
              查询回执（{failure.requestId.slice(0, 8)}）
            </button>
          ) : null}
        </div>
      ) : null}

      {notice ? <p className="personal-access-notice" data-testid="personal-access-notice">{notice}</p> : null}
      {lastRequestId && !failure ? <p className="surface-note">最近请求 id：{lastRequestId.slice(0, 8)}</p> : null}

      {status?.connected ? (
        <div className="personal-access-grid">
          <section className="personal-access-column" aria-label="来源">
            <h2>来源</h2>
            <ul className="personal-access-list" data-testid="personal-access-agents">
              {agents.map((agent) => (
                <li key={agent.agentRef}>
                  <button
                    type="button"
                    className={`personal-access-row ${selectedAgent === agent.agentRef ? 'is-selected' : ''}`}
                    onClick={() => void openAgent(agent.agentRef)}
                  >
                    <span className="personal-access-row-title">{agent.displayName}</span>
                    <span className="personal-access-row-meta">{agent.sourceKind}{agent.engineId ? ` · ${agent.engineId}` : ''}</span>
                    <span className={`personal-access-availability is-${agent.availability.toLowerCase()}`}>{agent.availability}{agent.reasonCode ? ` · ${agent.reasonCode}` : ''}</span>
                  </button>
                </li>
              ))}
              {agents.length === 0 ? <li className="empty">没有可访问的来源。</li> : null}
            </ul>
          </section>

          <section className="personal-access-column" aria-label="会话">
            <h2>会话</h2>
            <ul className="personal-access-list" data-testid="personal-access-conversations">
              {(directory?.items ?? []).map((conversation: ConversationSummary) => (
                <li key={conversation.conversationRef}>
                  <button
                    type="button"
                    className={`personal-access-row ${conversationRef === conversation.conversationRef ? 'is-selected' : ''}`}
                    onClick={() => void openConversation(conversation.conversationRef)}
                  >
                    <span className="personal-access-row-title">{conversation.title || '未命名会话'}</span>
                    <span className="personal-access-row-meta">{conversation.conversationRef.slice(0, 10)}</span>
                  </button>
                </li>
              ))}
              {selectedAgent && (directory?.items ?? []).length === 0 ? <li className="empty">该来源当前没有已授权的会话。</li> : null}
              {!selectedAgent ? <li className="empty">先选择一个来源。</li> : null}
            </ul>
          </section>

          <section className="personal-access-column personal-access-detail" aria-label="对话">
            <h2>{view?.title || '对话'}</h2>
            {view ? (
              <>
                <div className="personal-access-state">
                  <span>来源状态：{view.sourceState ?? '未知'}</span>
                  <span>发信：{view.message.availability}{view.message.reasonCode ? ` · ${view.message.reasonCode}` : ''}</span>
                  <span>正文覆盖：{page?.coverage ?? '未知'}</span>
                </div>
                <div className="personal-access-actions" data-testid="personal-access-actions">
                  {view.actions.map((action) => (
                    <button
                      key={`${action.actionId}:${action.binding ?? ''}`}
                      type="button"
                      className="secondary-button"
                      disabled={busy || action.availability !== 'AVAILABLE'}
                      title={action.reasonCode ?? action.label ?? action.actionId}
                      onClick={() => setDraft({ descriptor: action, text: '' })}
                    >
                      {action.label ?? action.actionId}
                      {action.availability !== 'AVAILABLE' ? `（${action.availability}${action.reasonCode ? ` · ${action.reasonCode}` : ''}）` : ''}
                    </button>
                  ))}
                  {view.actionsTruncated ? <span className="surface-note">动作已截断，仅显示前若干项。</span> : null}
                </div>

                {draft ? (
                  <div className="personal-access-draft" data-testid="personal-access-draft">
                    <h3>{draft.descriptor.label ?? draft.descriptor.actionId}</h3>
                    {draft.descriptor.context ? (
                      <pre className="personal-access-context">{JSON.stringify(draft.descriptor.context, null, 2)}</pre>
                    ) : null}
                    {draft.descriptor.inputKind === 'TEXT' || draft.descriptor.inputKind === 'SELECT' || draft.descriptor.inputKind === 'DECISION' ? (
                      <input
                        value={draft.text}
                        placeholder={draft.descriptor.inputKind === 'TEXT' ? '补充说明' : draft.descriptor.inputKind === 'SELECT' ? '选项值' : '决定'}
                        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                      />
                    ) : null}
                    <div className="personal-access-binding-actions">
                      <button type="button" className="primary-button" onClick={() => void submitAction()} disabled={busy}>{draft.descriptor.inputKind === 'CONFIRM' ? '确认执行' : '提交'}</button>
                      <button type="button" className="secondary-button" onClick={() => setDraft(null)}>取消</button>
                    </div>
                  </div>
                ) : null}

                <div className="personal-access-replies" data-testid="personal-access-replies">
                  {replyItems.map((reply) => (
                    <article key={reply.replyRef} className={`personal-access-reply ${reply.role === 'assistant' ? 'is-assistant' : ''}`}>
                      <header>
                        <span>{reply.role === 'assistant' ? '助手' : reply.role === 'user' ? '我' : '来源'}</span>
                        {reply.textComplete === false ? (
                          <button type="button" className="link-button" onClick={() => void loadContent(reply)} disabled={busy}>读取完整正文</button>
                        ) : null}
                      </header>
                      <p>{contents[reply.replyRef] ?? reply.text}</p>
                    </article>
                  ))}
                  {replyItems.length === 0 ? <p className="empty">还没有公开回复；轮询会继续。</p> : null}
                </div>
                {page?.representation === 'TEXT_SNAPSHOT' ? <p className="surface-note">来源以整体快照提供公开输出，快照整体替换。</p> : null}

                <form className="personal-access-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
                  <textarea
                    value={composer}
                    rows={3}
                    placeholder={view.message.availability === 'AVAILABLE' ? '输入消息…' : `该来源当前不可发信：${view.message.reasonCode ?? view.message.availability}`}
                    disabled={view.message.availability !== 'AVAILABLE'}
                    onChange={(event) => setComposer(event.target.value)}
                  />
                  <button type="submit" className="primary-button" disabled={busy || view.message.availability !== 'AVAILABLE' || composer.trim().length === 0}>发送</button>
                </form>
                <p className="surface-note">发送失败时保留原请求 id，用「查询回执」确认来源是否已受理，不会自动重发。</p>
              </>
            ) : <p className="empty">选择一个会话查看回复与动作。</p>}
          </section>
        </div>
      ) : null}

      {!status?.connected && available ? (
        <p className="surface-note">未连接。个人接入是独立端点，不会因为你没有本地 Service 而自动改指向。</p>
      ) : null}
      <span hidden data-testid="personal-access-text">{visibleText(page)}</span>
    </section>
  );
}
