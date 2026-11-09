import { WritableCollaborationPanel, type WritableCollaborationClient } from './WritableCollaborationPanel';
import { Icon } from './Icon';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import type { AssignmentTransitionRequest, AuxiliarySessionRequest, AuxiliaryTurnRequest, BoundaryInputRequest, CollaborationOperation, CollaborationResource } from '../../../packages/protocol/src/collaboration';
import { unwrap } from '../../../packages/protocol/src/proxy-result';
import type { AgentProfilesResponse, ModelCatalogResponse } from '../../../packages/protocol/src/index';

function field(value: CollaborationResource | undefined, key: string): string {
  const raw = value?.[key]; return typeof raw === 'string' ? raw : '';
}
const settled = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'OUTCOME_UNKNOWN', 'ANSWERED', 'CONSUMED', 'ACTIVE', 'ABORTED', 'REJECTED', 'SUPERSEDED']);
const labels: Record<string, string> = { PENDING: '已提交，等待主 Agent 安全点', DELIVERED: '已投递，尚未证明消费', CONSUMED: '主 Agent 已持久消费', ANSWERED: '主 Agent 已回答',
  QUEUED: '独立预算排队中', RUNNING: '旁路分析中', SUCCEEDED: '旁路回答已保存', CANCEL_REQUESTED: '正在取消', CANCELLED: '已取消', OUTCOME_UNKNOWN: '结果未知；可能已产生费用',
  ACCEPTED: '接管已接纳', QUIESCING: '等待原执行者退出', PREPARED: '恢复证据已核验', ACTIVATING: '目标启动中', ACTIVE: '目标启动已证明', UNKNOWN: '结果未知，保持围栏', BLOCKED: '接管受阻，保留暂停' };

/** Every main-agent mutation requires a separate explicit user action. */
export function CollaborationPanel({ sessionId, runId, client: suppliedClient, includeWritable = true, defaultOpen = false, open: controlledOpen, onOpenChange }: {
  sessionId: string; runId?: string | null; client?: WritableCollaborationClient; includeWritable?: boolean; defaultOpen?: boolean;
  /** Controlled mode: the conversation header owns the toggle and the in-panel summary hides. */
  open?: boolean; onOpenChange?: (open: boolean) => void;
}): React.JSX.Element | null {
  const client = suppliedClient ?? (window as unknown as { codeAgentDesktop: WritableCollaborationClient }).codeAgentDesktop;
  const [openState, setOpenState] = useState(defaultOpen);
  const open = controlledOpen ?? openState;
  const setOpen = (value: boolean) => { setOpenState(value); onOpenChange?.(value); };
  const [newConversation, setNewConversation] = useState(0);
  const [adviceSources, setAdviceSources] = useState<string[]>([]);
  const [child, setChild] = useState<CollaborationResource>();
  const [pack, setPack] = useState<CollaborationResource>();
  const [turnId, setTurnId] = useState('');
  const [boundaryId, setBoundaryId] = useState('');
  const [transitionId, setTransitionId] = useState('');
  const [question, setQuestion] = useState('');
  const [advice, setAdvice] = useState('');
  const [researchCount, setResearchCount] = useState(0);
  const [textOnlyResearch, setTextOnlyResearch] = useState(false);
  const [targetProfile, setTargetProfile] = useState('');
  const [targetRevision, setTargetRevision] = useState('');
  const [auxModel, setAuxModel] = useState('');
  const [targetModel, setTargetModel] = useState('');
  const [handoff, setHandoff] = useState<AssignmentTransitionRequest>();
  const [error, setError] = useState('');
  const keys = useRef(new Map<string, string>());
  const admittedTurns = useRef(new Map<string, AuxiliaryTurnRequest>());
  const admittedAuxiliary = useRef(new Map<string, AuxiliarySessionRequest>());
  const admittedBoundaries = useRef(new Map<string, BoundaryInputRequest>());
  const keyFor = (intent: string): string => { let key = keys.current.get(intent); if (!key) { key = crypto.randomUUID(); keys.current.set(intent, key); } return key; };
  const call = async (operation: CollaborationOperation): Promise<CollaborationResource> => unwrap(await client.collaboration(operation));
  const foundation = useQuery({ queryKey: ['collaboration-foundation', sessionId], enabled: open, queryFn: () => call({ action: 'FOUNDATION', subjectId: sessionId }) });
  const capabilities = foundation.data?.capabilities as Record<string, string> | undefined;
  const auxiliarySessions = useQuery({ queryKey: ['collaboration-auxiliary-list', sessionId], enabled: open, queryFn: () => call({ action: 'AUX_LIST', subjectId: sessionId }), refetchInterval: 5000 });
  const turns = useQuery({ queryKey: ['collaboration-turn-list', field(child, 'sessionId')], enabled: open && !!child, queryFn: () => call({ action: 'TURN_LIST', subjectId: field(child, 'sessionId') }) });
  const oldBoundaries = useQuery({ queryKey: ['collaboration-boundaries', runId], enabled: open && !!runId, queryFn: () => call({ action: 'BOUNDARIES', subjectId: runId! }), refetchInterval: 5000 });
  const oldHandoffs = useQuery({ queryKey: ['collaboration-handoffs', runId], enabled: open && !!runId, queryFn: () => call({ action: 'HANDOFFS', subjectId: runId! }), refetchInterval: 5000 });
  const rows = (value: CollaborationResource | undefined): CollaborationResource[] => Array.isArray(value?.items) ? value.items as CollaborationResource[] : [];
  const profiles = useQuery({ queryKey: ['collaboration-profiles'], enabled: open, queryFn: async () => unwrap<AgentProfilesResponse>(await client.listAgentProfiles!()) });
  const catalog = useQuery({ queryKey: ['collaboration-models'], enabled: open, queryFn: async () => unwrap<ModelCatalogResponse>(await client.getModelCatalog!()) });
  const modelChoices = (catalog.data?.items ?? []).filter((entry) => entry.configured && entry.availability === 'AVAILABLE');
  const segments = useQuery({ queryKey: ['collaboration-segments', runId], enabled: open && !!runId && capabilities?.['boundary.contextAdvice'] === 'READY',
    queryFn: () => call({ action: 'SEGMENTS', subjectId: runId! }) });
  const epoch = field(segments.data?.current as CollaborationResource | undefined, 'executionEpoch');
  const turn = useQuery({ queryKey: ['collaboration-turn', field(child, 'sessionId'), turnId], enabled: !!child && !!turnId,
    queryFn: () => call({ action: 'TURN_RESULT', subjectId: field(child, 'sessionId'), entityId: turnId }),
    refetchInterval: (query) => settled.has(field(query.state.data, 'state')) ? false : 1000 });
  const boundary = useQuery({ queryKey: ['collaboration-boundary', runId, boundaryId], enabled: !!runId && !!boundaryId,
    queryFn: () => call({ action: 'BOUNDARY_RESULT', subjectId: runId!, entityId: boundaryId }),
    refetchInterval: (query) => field(query.state.data, 'state') === 'CONSUMED' && field(query.state.data, 'kind') === 'REQUEST_REPORT' ? 1000 : settled.has(field(query.state.data, 'state')) ? false : 1000 });
  const transition = useQuery({ queryKey: ['collaboration-handoff', runId, transitionId], enabled: !!runId && !!transitionId,
    queryFn: () => call({ action: 'HANDOFF_RESULT', subjectId: runId!, entityId: transitionId }),
    refetchInterval: (query) => settled.has(field(query.state.data, 'state')) ? false : field(query.state.data, 'state') === 'UNKNOWN' ? 5000 : 1000 });
  const work = useMutation({ mutationFn: async (action: () => Promise<void>) => { setError(''); await action(); }, onError: (e) => setError(e instanceof Error ? e.message : '操作失败') });
  const busy = work.isPending;
  const askHelpId = useId();
  const askBlockedReason = busy ? '正在处理操作，请稍候。'
    : foundation.isPending ? '正在检查旁路能力，请稍候。'
    : capabilities?.['auxiliary.question'] !== 'READY' ? '当前服务的旁路问答能力尚未就绪。'
    : !pack ? '请先点击“冻结当前可见材料”，为旁路提供本次问答的上下文。'
    : !question.trim() ? '材料已就绪，请填写旁路问题。' : '';
  const adviceBytes = new TextEncoder().encode(advice).length;
  const freeze = async (): Promise<void> => {
    const snapshotKey = keyFor(`snapshot:${sessionId}:${field(pack, 'packageId')}`);
    const snapshot = await call({ action: 'FREEZE_SNAPSHOT', subjectId: sessionId, key: snapshotKey, body: {} });
    const packageKey = keyFor(`package:${snapshotKey}`);
    const value = await call({ action: 'CREATE_PACKAGE', subjectId: sessionId, key: packageKey, body: { schemaVersion: 'context-package-request/1', requestId: packageKey, snapshotId: field(snapshot, 'snapshotId'), profile: 'RESEARCH' } });
    setPack(value);
  };
  const submitTurn = async (auxiliaryId: string, key: string, content: Omit<AuxiliaryTurnRequest, 'turnId' | 'expectedSessionVersion'>): Promise<void> => {
    let body = admittedTurns.current.get(key);
    if (!body) { const current = await call({ action: 'FOUNDATION', subjectId: auxiliaryId }); body = { ...content, turnId: key, expectedSessionVersion: field(current, 'sessionVersion') }; admittedTurns.current.set(key, body); }
    try { await call({ action: 'TURN', subjectId: auxiliaryId, key, body }); }
    catch (failure) { if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 'SESSION_VERSION_CONFLICT') admittedTurns.current.delete(key); throw failure; }
    setTurnId(key); await turns.refetch();
  };
  const ask = async (retryOfTurnId?: string): Promise<void> => {
    if (retryOfTurnId && child && turn.data?.request && typeof turn.data.request === 'object') {
      const original = turn.data.request as AuxiliaryTurnRequest;
      const key = keyFor(`retry:${field(child, 'sessionId')}:${retryOfTurnId}`);
      await submitTurn(field(child, 'sessionId'), key, { ...original, retryOfTurnId }); return;
    }
    if (!pack || !question.trim()) return;
    let auxiliary = child;
    if (!auxiliary) {
      const key = keyFor(`auxiliary:${sessionId}:${newConversation}`);
      let body = admittedAuxiliary.current.get(key);
      if (!body) { body = { schemaVersion: 'auxiliary-session-create/1', purpose: 'SIDECAR_QUESTION', requestId: key, basePackageId: field(pack, 'packageId'), title: '旁路讨论' }; admittedAuxiliary.current.set(key, body); }
      auxiliary = await call({ action: 'CREATE_AUX', subjectId: sessionId, key, body }); setChild(auxiliary); await auxiliarySessions.refetch();
    }
    const key = keyFor(`turn:${field(auxiliary, 'sessionId')}:${question}:${field(pack, 'packageId')}:${researchCount}:${textOnlyResearch}:${auxModel}:${turnId}`);
    await submitTurn(field(auxiliary, 'sessionId'), key, { schemaVersion: 'auxiliary-turn/1', packageId: field(pack, 'packageId'), question, textOnlyResearch, ...(auxModel ? { modelAlias: auxModel } : {}),
      researchTasks: Array.from({ length: researchCount }, (_, i) => ({ taskId: `research-${i + 1}`, role: (['repo-explorer', 'test-impact-reviewer', 'risk-reviewer'] as const)[i]!, question })) });
  };
  const send = async (kind: 'REQUEST_REPORT' | 'CONTEXT_ADVICE'): Promise<void> => {
    if (!runId || !epoch) return;
    const text = kind === 'REQUEST_REPORT' ? '请在下个安全点汇报已完成事项、阻塞与下一步，然后继续原任务。' : advice;
    const key = keyFor(`${kind}:${runId}:${text}:${boundaryId}`);
    let body = admittedBoundaries.current.get(key);
    if (!body) { const fresh = await call({ action: 'SEGMENTS', subjectId: runId });
      body = { schemaVersion: 'run-boundary-request/1', requestId: key, kind, expectedExecutionEpoch: field(fresh.current as CollaborationResource, 'executionEpoch'), text, sourceRefs: kind === 'CONTEXT_ADVICE' ? adviceSources : [] }; admittedBoundaries.current.set(key, body); }
    await call({ action: 'BOUNDARY', subjectId: runId, key, body }); setBoundaryId(key); await oldBoundaries.refetch();
  };
  const preflight = async (): Promise<void> => {
    if (!runId) return;
    const request: AssignmentTransitionRequest = { schemaVersion: 'assignment-transition-request/1', target: { harnessId: 'product-code', agentProfileId: targetProfile, agentProfileRevision: targetRevision,
      modelSelection: targetModel ? { mode: 'EXPLICIT', settings: { modelAlias: targetModel } } : { mode: 'KEEP_EFFECTIVE' } }, pendingInputPolicy: 'CANCEL_PENDING' };
    const checked = await call({ action: 'PREFLIGHT', subjectId: runId, body: request });
    const id = keyFor(`handoff:${runId}:${field(checked, 'preflightDigest')}:${transitionId}`);
    setHandoff({ ...request, transitionId: id, expectedExecutionEpoch: field(checked, 'sourceEpoch'), expectedRunStateVersion: field(checked, 'runStateVersion'),
      expectedModelSettingsRevision: field(checked, 'modelSettingsRevision'), preflightDigest: field(checked, 'preflightDigest') });
  };
  if (typeof client?.collaboration !== 'function') return null;
  const status = (value: CollaborationResource | undefined): string => labels[field(value, 'state')] ?? field(value, 'state');
  return <details className={`collaboration-panel${controlledOpen !== undefined ? ' controlled' : ''}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary hidden={controlledOpen !== undefined}>旁路讨论与主 Agent 协作</summary>
    {controlledOpen !== undefined ? <button type="button" className="icon-button collaboration-panel-close" aria-label="关闭旁路讨论" title="关闭" onClick={() => setOpen(false)}><Icon name="x" size={14} /></button> : null}
    <p>旁路使用冻结材料和独立预算。查看回答不会把建议自动发送给主 Agent。</p>
    {foundation.error ? <p role="alert">当前服务未提供协作能力。</p> : null}
    <button disabled={busy || capabilities?.['auxiliary.question'] !== 'READY'} onClick={() => work.mutate(freeze)}>{pack ? '显式刷新材料' : '冻结当前可见材料'}</button>
    {pack ? <p>材料 {field(pack, 'packageId')} · 信息时间 {field(pack, 'capturedTo')} · {String((pack.coverage as Record<string, unknown> | undefined)?.completeWithinSelection ? '所选材料完整' : '部分材料；请留意缺失信息')}</p> : null}
    <label>旁路会话<select value={field(child, 'sessionId')} onChange={(e) => work.mutate(async () => {
      const selected = rows(auxiliarySessions.data).find((value) => field(value, 'sessionId') === e.target.value);
      setTurnId(''); setChild(selected); if (!selected) { setNewConversation((value) => value + 1); return; }
      setPack(await call({ action: 'PACKAGE', subjectId: sessionId, entityId: field(selected, 'basePackageId') }));
    })}><option value="">新建独立旁路会话</option>{rows(auxiliarySessions.data).map((value) => <option key={field(value, 'sessionId')} value={field(value, 'sessionId')}>{field(value, 'title') || '旁路讨论'}</option>)}</select></label>
    {rows(turns.data).length > 0 ? <label>已保存的旁路 turn<select value={turnId} onChange={(e) => setTurnId(e.target.value)}><option value="">选择历史回答或未决作业</option>{rows(turns.data).map((value) => <option key={field(value, 'turnId')} value={field(value, 'turnId')}>{field(value, 'turnId')} · {labels[field(value, 'state')] ?? field(value, 'state')}</option>)}</select></label> : null}
    <label>旁路问题<textarea value={question} maxLength={1200} onChange={(e) => setQuestion(e.target.value)} /></label>
    <label>旁路模型（本次 turn 单独冻结）<select value={auxModel} onChange={(e) => setAuxModel(e.target.value)}><option value="">沿用旁路会话模型</option>{modelChoices.map((entry) => <option key={`${entry.providerId}/${entry.modelAlias}`} value={`${entry.providerId}/${entry.modelAlias}`}>{entry.providerId} / {entry.modelAlias}</option>)}</select></label>
    <label>研究批次<select value={researchCount} onChange={(e) => setResearchCount(Number(e.target.value))}><option value={0}>独立问答</option><option value={1}>1 位只读研究者</option><option value={2}>2 位只读研究者</option><option value={3}>3 位只读研究者</option></select></label>
    {researchCount > 0 ? <label><input type="checkbox" checked={textOnlyResearch} onChange={(e) => setTextOnlyResearch(e.target.checked)} />明确允许仅依据快照文本研究（无封存文件时）</label> : null}
    <p id={askHelpId} role="status">{askBlockedReason || '材料与问题已就绪，可以向旁路提问。'}{researchCount > 0 ? ' 只想了解当前任务进展时，可选择“独立问答”；只读研究者用于进一步研究，缺少封存文件时需明确允许仅依据快照文本研究。' : ''}</p>
    <button disabled={!!askBlockedReason} aria-describedby={askHelpId} title={askBlockedReason || undefined} onClick={() => work.mutate(() => ask())}>向旁路提问</button>
    {turnId ? <><p aria-live="polite">{status(turn.data)}</p><p>独立预留模型调用：{String(turn.data?.reservedModelCalls ?? '待确认')} · token 预留上限：{String(turn.data?.reservedTokenUnits ?? '待确认')} · 尝试 {String(turn.data?.attemptNo ?? 1)}</p>
      {field(turn.data, 'state') === 'OUTCOME_UNKNOWN' ? <button disabled={busy} onClick={() => work.mutate(() => ask(turnId))}>明确重试：新尝试可能再次产生费用</button> : null}
      <p>来源 epoch：{field(turn.data, 'sourceEpoch') || 'UNKNOWN'} · 材料：{field(turn.data, 'packageId')}</p><pre>{field(turn.data, 'answer')}</pre><button disabled={!field(turn.data, 'answer')} onClick={() => { setAdvice(field(turn.data, 'answer')); setAdviceSources([`auxiliary-turn:${field(child, 'sessionId')}/${turnId}`, `context-package:${field(turn.data, 'packageId')}`]); }}>选作建议草稿</button>
      <button disabled={busy || settled.has(field(turn.data, 'state'))} onClick={() => work.mutate(async () => { await call({ action: 'CANCEL_TURN', subjectId: field(child, 'sessionId'), entityId: turnId, key: keyFor(`cancel:${turnId}`) }); await turn.refetch(); })}>取消旁路作业</button></> : null}
    {runId ? <><label>给主 Agent 的建议<textarea maxLength={8192} value={advice} onChange={(e) => setAdvice(e.target.value)} /></label>
      {adviceBytes > 8192 ? <p role="alert">建议超过 8 KiB，请编辑后再明确发送；原回答已保留。</p> : null}
      <button disabled={busy || !advice.trim() || adviceBytes > 8192 || !epoch || capabilities?.['boundary.contextAdvice'] !== 'READY'} onClick={() => work.mutate(() => send('CONTEXT_ADVICE'))}>明确发送给主 Agent</button>
      <button disabled={busy || !epoch || capabilities?.['boundary.report'] !== 'READY'} onClick={() => work.mutate(() => send('REQUEST_REPORT'))}>请主 Agent 汇报后继续</button>
      <p aria-live="polite">{status(boundary.data)} {field(boundary.data, 'reasonCode') === 'BOUNDARY_CONTEXT_BUDGET' ? '等待可用上下文容量，尚未消费。' : field(boundary.data, 'reasonCode') === 'BOUNDARY_PROOF_BUDGET' ? '持久报告容量已满，尚未消费；可取消本请求。' : ''}</p>
      <button disabled={busy || !['PENDING', 'DELIVERED'].includes(field(boundary.data, 'state'))} onClick={() => work.mutate(async () => { await call({ action: 'CANCEL_BOUNDARY', subjectId: runId, entityId: boundaryId, key: keyFor(`cancel-boundary:${runId}:${boundaryId}`) }); await boundary.refetch(); await oldBoundaries.refetch(); })}>取消主请求</button>
      <details><summary>受控画像接管</summary><p>保留原任务、权限、预算和截止时间。默认取消尚未消费的建议；预检不会暂停任务。</p>
        <label>目标智能体<select value={targetProfile} onChange={(e) => { const selected = profiles.data?.profiles?.find((p) => p.id === e.target.value); setTargetProfile(selected?.id ?? ''); setTargetRevision(selected?.revision ?? ''); setHandoff(undefined); }}><option value="">选择已授权的画像</option>{profiles.data?.profiles?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label>目标模型<select value={targetModel} onChange={(e) => { setTargetModel(e.target.value); setHandoff(undefined); }}><option value="">保留当前生效模型</option>{modelChoices.map((entry) => <option key={`${entry.providerId}/${entry.modelAlias}`} value={`${entry.providerId}/${entry.modelAlias}`}>{entry.providerId} / {entry.modelAlias}</option>)}</select></label>
        <button disabled={busy || !targetProfile || !targetRevision || capabilities?.['assignment.handoff.productCodeProfile'] !== 'READY'} onClick={() => work.mutate(preflight)}>检查兼容性</button>
        <button disabled={busy || !handoff} onClick={() => work.mutate(async () => { if (!handoff?.transitionId) return; await call({ action: 'HANDOFF', subjectId: runId, key: handoff.transitionId, body: handoff }); setTransitionId(handoff.transitionId); })}>确认接管</button>
        <button disabled={busy || !['ACCEPTED', 'QUIESCING', 'BLOCKED', 'PREPARED'].includes(field(transition.data, 'state'))} onClick={() => work.mutate(async () => { await call({ action: 'CANCEL_HANDOFF', subjectId: runId, entityId: transitionId, key: keyFor(`cancel-handoff:${runId}:${transitionId}`) }); await transition.refetch(); await oldHandoffs.refetch(); })}>取消此次接管</button>
        <p aria-live="polite">{status(transition.data)} {field(transition.data, 'reasonCode')}</p>
      </details></> : null}
    {runId && (rows(oldBoundaries.data).length > 0 || rows(oldHandoffs.data).length > 0) ? <details><summary>已接纳的协作回执</summary>
      {rows(oldBoundaries.data).map((value) => <button key={field(value, 'requestId')} onClick={() => setBoundaryId(field(value, 'requestId'))}>{field(value, 'requestId')} · {labels[field(value, 'state')] ?? field(value, 'state')}</button>)}
      {rows(oldHandoffs.data).map((value) => <button key={field(value, 'transitionId')} onClick={() => setTransitionId(field(value, 'transitionId'))}>{field(value, 'transitionId')} · {labels[field(value, 'state')] ?? field(value, 'state')}</button>)}
    </details> : null}
    {runId && includeWritable ? <WritableCollaborationPanel key={runId} sessionId={sessionId} runId={runId} client={client} /> : null}
    {error ? <p role="alert">{error}</p> : null}
  </details>;
}
