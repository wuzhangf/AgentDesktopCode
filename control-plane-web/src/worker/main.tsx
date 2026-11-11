import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { WritableCollaborationPanel } from '../../../codeagent-desktop/src/renderer/app/WritableCollaborationPanel';
import { CollaborationPanel } from '../../../codeagent-desktop/src/renderer/app/CollaborationPanel';
import { Activity, ArrowUpRight, Command, FileText, FlaskConical, GitBranch, MessageSquare, RefreshCw, ShieldCheck } from 'lucide-react';
import { request, workerClient } from './client';
import '../styles/global.css';
import './worker.css';

const queries = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true }, mutations: { retry: false } } });
type Value = Record<string, any>;
const read = async (action: string, fields: object = {}) => await request(action, fields) as Value;
const terminal = new Set(['COMPLETED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'STOPPED']);
const stateLabels: Record<string, string> = { RUNNING: '运行中', PAUSED_FOR_HUMAN: '已暂停', SUCCEEDED: '成功', COMPLETED: '已完成', CANCELLED: '已停止', FAILED: '失败', APPLIED: '已生效', REQUESTED: '等待安全点', ACCEPTED: '已接纳', DISPATCHING: '正在投递', UNKNOWN: '结果待核对' };
const list = (value: any): Value[] => Array.isArray(value) ? value : value?.items ?? value?.activities ?? [];

export function WorkerApp() {
  const [connection, setConnection] = useState<Value>();
  const [sessionId, setSessionId] = useState(''); const [draftId, setDraftId] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Value>(); const [receipt, setReceipt] = useState<Value>();
  const [tab, setTab] = useState('overview');
  const [snapshot, setSnapshot] = useState<Value>();
  const sessions = useQuery({ queryKey: ['worker', 'sessions'], enabled: !!connection,
    queryFn: async () => await request('SESSIONS') as Value[], refetchInterval: 5000 });
  const session = useQuery({ queryKey: ['worker', 'session', sessionId], enabled: !!connection && !!sessionId,
    queryFn: () => read('SESSION', { id: sessionId }), refetchInterval: 1500 });
  const runId = String(session.data?.activeRunId ?? session.data?.messages?.findLast((message: Value) => message.runId)?.runId ?? '');
  const run = useQuery({ queryKey: ['worker', 'run', runId], enabled: !!connection && !!runId,
    queryFn: () => read('RUN', { id: runId }), refetchInterval: 1500 });
  const fixture = useQuery({ queryKey: ['worker', 'fixture'], enabled: connection?.mode === 'FIXTURE',
    queryFn: () => read('FIXTURE_STATUS'), refetchInterval: 1500 });
  const liveModel = fixture.data?.mode === 'REAL_MODEL_REAL_PROJECT';
  const initializing = connection?.mode === 'FIXTURE' && !!runId && !fixture.data?.parentCalls && !terminal.has(run.data?.state);
  const foundation = useQuery({ queryKey: ['worker', 'foundation', sessionId], enabled: !!connection && !!sessionId,
    queryFn: () => read('COLLABORATION', { operation: { action: 'FOUNDATION', subjectId: sessionId } }), refetchInterval: 4000 });
  const activities = useQuery({ queryKey: ['worker', 'activities', runId], enabled: !!connection && !!runId,
    queryFn: () => read('ACTIVITIES', { id: runId }), refetchInterval: 2000 });
  const commandReceipt = useQuery({ queryKey: ['worker', 'receipt', receipt?.commandId], enabled: !!receipt?.commandId,
    queryFn: () => read('COMMAND_RECEIPT', { id: receipt!.runId ?? runId, entityId: receipt!.commandId }),
    refetchInterval: query => ['APPLIED', 'REJECTED', 'FAILED', 'NOOP'].includes(query.state.data?.phase) ? false : 1000 });
  const snapshotItems = useQuery({ queryKey: ['worker', 'snapshot', snapshot?.snapshotId], enabled: !!snapshot?.snapshotId,
    queryFn: () => read('SNAPSHOT_ITEMS', { id: snapshot!.sessionId, entityId: snapshot!.snapshotId }) });
  useEffect(() => { if (!sessionId && fixture.data?.sessionId) { setSessionId(fixture.data.sessionId); setDraftId(fixture.data.sessionId); } }, [fixture.data?.sessionId, sessionId]);
  useEffect(() => { setSnapshot(undefined); setReceipt(undefined); }, [sessionId]);
  const work = async (operation: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError('');
    try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : '操作未确认，请读取原回执'); }
    finally { setBusy(false); }
  };
  const submitCommand = async (command: Value) => {
    setPending(command);
    try {
      const result = await request('COMMAND', command) as Value;
      setReceipt({ ...result, runId: command.runId }); setPending(undefined); await run.refetch();
    } catch (failure) {
      const status = (failure as { details?: { status?: number } }).details?.status;
      if (status && status >= 400 && status < 500) setPending(undefined);
      throw failure;
    }
  };
  const freeze = () => work(async () => {
    const value = await workerClient.collaboration({ action: 'FREEZE_SNAPSHOT', subjectId: sessionId, key: crypto.randomUUID(), body: {} }) as Value;
    setSnapshot({ ...value, sessionId }); setTab('evidence');
  });
  const exportEvidence = () => {
    const payload = { exportedAt: new Date().toISOString(), mode: connection?.mode, session: session.data, run: run.data,
      foundation: foundation.data, activities: activities.data, command: commandReceipt.data ?? receipt, snapshot, snapshotItems: snapshotItems.data };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `worker-lab-${runId || 'session'}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="worker-shell">
    <div className="lab-topline"><a className="lab-brand" href="/worker.html"><Command size={20} /><b>Worker<span>lab</span></b><small>LOCAL</small></a><span className="lab-version">PHASE 01 — 03</span><a className="lab-second" href="/worker.html" target="_blank" rel="noreferrer">第二端打开 <ArrowUpRight size={14} /></a></div>
    <header className="worker-header"><div><div className="worker-eyebrow">YOUR WORKER PLAYGROUND</div><h1>让协作过程看得见。</h1><p className="muted">会话控制、旁路讨论与可写协作，在同一个工作区里验证。</p></div>
      <span className="worker-mode"><span className={`lab-dot ${connection ? 'live' : ''}`} />{connection ? connection.mode === 'FIXTURE' ? liveModel ? `真实模型 · ${fixture.data?.modelName ?? ''}` : '本地协议模型' : '已有 Host' : '尚未连接'}</span></header>
    <section className="worker-card lab-connect"><h2><ShieldCheck size={17} />连接与主任务</h2>
      <p>每个标签页独立注册，共享同一主任务。执行结果、控制回执与候选采纳分别展示。</p>
      <div className="worker-actions"><button className="primary" disabled={busy} onClick={() => void work(async () => {
        setConnection(await request('', {}, 'connect') as Value); await queries.invalidateQueries({ queryKey: ['worker'] });
      })}>{connection ? '重新核对连接' : '连接本机 Host'}</button>
        {connection?.mode === 'FIXTURE' && <button disabled={busy} onClick={() => void work(async () => {
          const result = await read('FIXTURE_START'); setSessionId(result.sessionId); setDraftId(result.sessionId);
          await queries.invalidateQueries({ queryKey: ['worker'] });
        })}>创建 / 打开体验任务</button>}</div>
      {connection && <div className="worker-selection"><label>已有主会话<select value={sessionId} onChange={event => { setSessionId(event.target.value); setDraftId(event.target.value); }}>
        <option value="">选择主会话</option>{sessions.data?.filter(value => !value.sessionPurpose || value.sessionPurpose === 'MAIN').map(value =>
          <option key={value.sessionId} value={value.sessionId}>{value.title || value.sessionId}</option>)}</select></label>
        <label>会话 ID<input value={draftId} onChange={event => setDraftId(event.target.value)} placeholder="已有 Worker 主会话的 sessionId" /></label>
        <button disabled={busy || !!pending || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(draftId)} onClick={() => { setSessionId(draftId); }}>打开会话</button></div>}
      {(session.error || sessions.error || run.error) && <p role="alert">无法读取主会话或运行，请核对连接及会话 ID。</p>}
      {session.data && <dl className="worker-facts"><div><dt>SESSION / 主会话</dt><dd title={sessionId}>{sessionId}</dd></div><div><dt>RUN / 执行</dt><dd title={runId}>{runId || '等待主任务开始'}</dd></div><div><dt>执行状态</dt><dd className="lab-state">{stateLabels[run.data?.sourceStatus ?? run.data?.state] ?? run.data?.sourceStatus ?? run.data?.state ?? '读取中'}</dd></div><div><dt>权威版本</dt><dd>v{run.data?.stateVersion ?? '—'}</dd></div></dl>}
      {run.data && <div className="worker-actions">{(['PAUSE', 'RESUME', 'STOP'] as const).map(intent => <button key={intent}
        disabled={busy || !!pending && intent !== 'STOP' || terminal.has(run.data!.state)} onClick={() => void work(() => submitCommand({ runId, intent, key: crypto.randomUUID(), version: intent === 'STOP' ? -1 : run.data!.stateVersion }))}>
        {{ PAUSE: '暂停主任务', RESUME: '明确恢复主任务', STOP: '停止主任务与子执行' }[intent]}</button>)}</div>}
      {pending && <button disabled={busy} onClick={() => void work(() => submitCommand(pending))}>按原 key 核对未决主命令</button>}
      {receipt && <p className="lab-receipt" aria-live="polite"><ShieldCheck size={16} />主命令回执：{receipt.intent} · {stateLabels[(commandReceipt.data ?? receipt).phase] ?? (commandReceipt.data ?? receipt).phase} · {receipt.commandId}</p>}
    </section>
    {initializing && <p role="status" className="lab-receipt">Worker 已绑定；正在初始化项目与语言工具。模型就绪后可创建协作计划。</p>}
    {!runId && <div className="lab-intro-grid"><article><Activity /><b>01 · 会话与控制</b><p>双端观察、暂停恢复、冻结快照。</p></article><article><MessageSquare /><b>02 · 旁路与接管</b><p>独立问答、明确建议、画像切换。</p></article><article><GitBranch /><b>03 · 协作与采纳</b><p>隔离子任务、固定预览、验证接续。</p></article></div>}
    {runId && <><nav className="lab-tabs" aria-label="能力面板">{[{ id: 'overview', name: '运行现场', icon: Activity }, { id: 'sidecar', name: '旁路与接管', icon: MessageSquare }, { id: 'writable', name: '可写协作', icon: GitBranch }, { id: 'evidence', name: '快照与证据', icon: FileText }].map(item => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><item.icon size={16} />{item.name}</button>)}<button className="lab-refresh" onClick={() => void queries.invalidateQueries({ queryKey: ['worker'] })}><RefreshCw size={14} />刷新</button></nav>
    <div hidden={tab !== 'overview'} className="lab-overview"><section className="worker-card"><h2><MessageSquare size={17} />主会话</h2><div className="lab-conversation">{list(session.data?.messages).map((message, index) => <article key={message.messageId ?? index}><small>{message.role?.toLowerCase() === 'user' ? '你' : message.role?.toLowerCase() === 'assistant' ? 'Agent' : message.role}</small><p>{typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}</p></article>)}{!list(session.data?.messages).length && <p className="muted">会话消息加载中…</p>}</div></section><section className="worker-card"><h2><Activity size={17} />执行活动</h2><div className="lab-timeline">{list(activities.data).slice(-14).map((value, index) => <article key={value.activityId ?? index}><span className="lab-dot live" /><div><b>{value.toolName ?? value.capabilityId ?? value.kind ?? value.type ?? '执行活动'}</b><p>{typeof value.summary === 'string' ? value.summary : value.resultSummary ?? value.status ?? value.message ?? value.title}</p></div></article>)}{!list(activities.data).length && <p className="muted">主模型等待响应。推进一步后，这里会出现实际执行活动。</p>}</div></section></div>
    <section hidden={tab !== 'sidecar'} className="worker-card"><h2><MessageSquare size={17} />旁路问答与受控接管 <small>PHASE 02</small></h2><CollaborationPanel key={sessionId} sessionId={sessionId} runId={runId} client={workerClient} includeWritable={false} defaultOpen /></section>
    <section hidden={tab !== 'evidence'} className="worker-card"><h2><FileText size={17} />观测快照与证据 <small>PHASE 01</small></h2><p>固定当前可见材料，保留来源、完整性与捕获时间。</p><div className="worker-actions"><button disabled={busy || foundation.data?.capabilities?.observationSnapshotV1 !== 'READY'} onClick={() => void freeze()}>创建观测快照</button><button onClick={exportEvidence}>导出当前证据 JSON</button></div>{snapshot && <><p className="lab-receipt"><ShieldCheck size={16} />快照已冻结 · {snapshot.snapshotId} · {list(snapshotItems.data).length} 条材料</p><table><thead><tr><th>材料类型</th><th>来源</th><th>捕获时间</th></tr></thead><tbody>{list(snapshotItems.data).map((item, index) => <tr key={index}><td>{item.kind}</td><td>{item.sourceRef}</td><td>{new Date(item.capturedAt).toLocaleTimeString('zh-CN')}</td></tr>)}</tbody></table><details><summary>查看冻结内容</summary><pre>{JSON.stringify(snapshotItems.data ?? snapshot, null, 2)}</pre></details></>}<details><summary>会话绑定与实际能力</summary><pre>{JSON.stringify(foundation.data, null, 2)}</pre></details></section></>}
    {runId && connection?.mode === 'FIXTURE' && <section className="worker-card lab-fixture"><h2><FlaskConical size={17} />你来掌握执行节奏</h2>
      <p>主模型在响应前等待；“推进一步”让真实工具和安全边界继续执行。旁路与子任务独立运行。</p>
      <button disabled={busy || !runId || terminal.has(run.data?.state)} onClick={() => void work(async () => { await request('FIXTURE_RELEASE'); await fixture.refetch(); })}>推进一步</button>
      <button disabled={busy || !runId || terminal.has(run.data?.state)} onClick={() => void work(async () => { await request('FIXTURE_FINISH'); await fixture.refetch(); })}>{liveModel ? '允许主任务连续执行' : '结束体验任务'}</button>
      {fixture.data && <dl className="worker-facts"><div><dt>实际执行链</dt><dd>{fixture.data.executionPath === 'DAEMON_PROVIDER_ACS_PRODUCT' ? 'Daemon → ACS → Product' : 'ACS → Product'}</dd></div><div><dt>{liveModel ? '真实项目' : '主目录 x.txt'}</dt><dd data-testid="parent-content">{liveModel ? fixture.data.sourceProject?.split(/[\\/]/).at(-1) : fixture.data.parentContent ?? '未开始'}</dd></div><div><dt>模型请求总数</dt><dd>{liveModel ? `${fixture.data.forwardedCalls} / ${fixture.data.requestLimit}` : fixture.data.modelCalls}</dd></div><div><dt>Worker 交付</dt><dd>{fixture.data.workerFinish?.finishState ?? '等待终态'}</dd></div></dl>}
      {fixture.error && <p role="alert">无法读取测试夹具状态。</p>}
    </section>}
    {runId && session.data?.sessionPurpose !== 'AUXILIARY_READ_ONLY' && session.data?.sessionPurpose !== 'DELEGATED_WRITE_CANDIDATE'
      ? <section hidden={tab !== 'writable'} className="worker-card"><h2><GitBranch size={17} />协作、固定预览与明确采纳 <small>PHASE 03</small></h2><div className="lab-instruction"><b>{liveModel ? '真实 Spring Boot 项目' : '先体验一个单元'}</b><p>{liveModel ? '已预填员工计数接口及回归测试的目标与范围。' : '已预填 x.txt 从 v1 改为 v2 的目标与范围。'}创建计划 → 授权 → 开始 → 推进一步 → 选择候选 → 预览 → 采纳 → 推进一步。</p></div><WritableCollaborationPanel key={`${runId}:${liveModel}`} sessionId={sessionId} runId={runId} client={workerClient} defaultOpen initialUnit={liveModel ? fixture.data?.scenario : connection?.mode === 'FIXTURE' ? { objective: 'CHILD_WRITE_X: 将 x.txt 从 v1 修改为 v2', read: 'x.txt', write: 'x.txt' } : undefined} /></section> : null}
    {error && <div className="worker-error" role="alert">{error}</div>}
    <footer className="muted"><ShieldCheck size={13} />本机隔离体验 · 每个标签页独立注册<span>WORKER LAB / 2026</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={queries}><WorkerApp /></QueryClientProvider></StrictMode>);
