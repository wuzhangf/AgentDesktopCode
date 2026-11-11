import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Card, ErrorBanner, Skeleton } from '../../components/ui/primitives';
import { usePersonal, usePersonalGateway, usePersonalSurface } from '../hooks';
import { TaskConversationCard } from '../components/TaskConversationCard';
import { TaskControlCard } from '../components/TaskControlCard';
import { TaskCollaborationCard } from '../components/TaskCollaborationCard';
import { NativeTaskCard } from '../components/NativeTaskCard';
import type { MetricValue } from '../../../../codeagent-desktop/packages/protocol/src/metrics';

const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const states: Record<string,string> = {QUEUED:'排队中',RUNNING:'执行中',WAITING_APPROVAL:'等待审批',PAUSE_REQUESTED:'正在暂停',PAUSED:'已暂停',CANCEL_REQUESTED:'正在取消',VALIDATING:'验证中',NEEDS_ATTENTION:'需要处理',COMPLETED:'已完成',FAILED:'执行失败',CANCELLED:'已取消',UNKNOWN:'状态未知'};
const names: Record<string,string> = {'model.logical_calls':'逻辑调用','model.transports':'网络尝试','model.dispatch_unconfirmed':'派发未证实','model.usage.input':'输入 token','model.usage.output':'输出 token','model.usage.total':'总 token','model.cost':'费用'};
const metricReasons: Record<string,string> = {OBSERVED_SUBTOTAL:'仅统计当前任务已采集记录',OBSERVATION_NOT_BOUND:'尚未接入任务观测，运行不受影响',OBSERVATION_BINDING_CHANGED:'观测连接已改变，未使用其他数据替代',RUN_NOT_BOUND:'等待源端分配运行',RUN_NOT_COLLECTED:'当前运行暂无采集记录',OBSERVATION_UNAVAILABLE:'观测数据暂不可读'};
const costSources: Record<string,string> = {PROVIDER_REPORTED:'服务商报告',ROUTER_REPORTED:'路由器报告',LOCAL_ESTIMATE:'本机估算'};
const measurements = {MEASURED:'实测',REPORTED:'源报告',ESTIMATED:'估算',DERIVED:'派生',UNKNOWN:'未知'};
function Metric({metric: m}: {metric: MetricValue}) {
  const base = m.metricId.replace(/\.(reported|estimated|unknown|PROVIDER_REPORTED|ROUTER_REPORTED|LOCAL_ESTIMATE)$/, '');
  return <div className="card" style={{padding:12}}><strong>{names[base] ?? m.metricId}</strong><p>{m.value == null ? '未知／未采集' : `${m.value} ${m.currency ?? ''}`} · {measurements[m.measurement]}</p><small className="muted">{m.completeness === 'COMPLETE' ? '完整' : m.completeness === 'PARTIAL' ? '已知小计' : '完整性未知'}；样本 {m.knownCount}/{m.sampleCount}{m.unknownCount ? `，未知 ${m.unknownCount}` : ''}</small>{base === 'model.cost' && <p className="muted">{costSources[m.metricId.split('.').at(-1) ?? ''] ?? '尚无计价事实'}；分来源金额不相加</p>}</div>;
}
export default function TaskDetailPage() {
  const { taskId = '' } = useParams();
  const gateway = usePersonalGateway(), surface = usePersonalSurface();
  const [selectedRun, setSelectedRun] = useState<string>();
  const [selectionTask,setSelectionTask] = useState(taskId);
  if(selectionTask!==taskId){setSelectionTask(taskId);setSelectedRun(undefined);}
  const task = usePersonal(['task',taskId,selectedRun], g => g.task(taskId, selectedRun), {refetchInterval:3000});
  const t = task.data?.data, run = t?.run;
  const poll = terminal.has(run?.state ?? '') ? false : 5000;
  const [activityCursor, setActivityCursor] = useState<number>();
  const [cursorRun,setCursorRun] = useState(t?.runId);
  if(cursorRun!==t?.runId){setCursorRun(t?.runId);setActivityCursor(undefined);}
  const activities = usePersonal(['taskActivities', taskId, t?.sourceStoreId, t?.runId, activityCursor], g => g.taskActivities(taskId, activityCursor, t?.runId), {enabled:!!t?.runId, refetchInterval:poll});
  const output = usePersonal(['taskOutput', taskId, t?.sourceStoreId, t?.runId], g => g.taskOutput(taskId, t?.runId), {enabled:!!t?.runId, refetchInterval:poll});
  const metrics = usePersonal(['taskMetrics', taskId, t?.sourceStoreId, t?.runId], g => g.taskMetrics(taskId, t?.runId), {enabled:!!t&&t.executionBinding?.kind!=='WORKER_LOCAL', refetchInterval:poll});
  const [now,setNow] = useState(Date.now()), [busy,setBusy] = useState(false), [error,setError] = useState('');
  useEffect(() => { if (terminal.has(run?.state ?? '')) return; const id=setInterval(() => setNow(Date.now()),1000); return () => clearInterval(id); },[run?.state]);
  // 控制可用意图跟随源端运行投影：任务查询已在非终态轮询，任何
  // 状态/版本跃迁顺带失效控制视图一次，控制卡自身不另设常驻轮询。
  const qc = useQueryClient(), runState = run?.state, runVersion = run?.stateVersion;
  useEffect(() => { void qc.invalidateQueries({ queryKey: ['personal', 'taskCommands'] }); }, [qc, runState, runVersion]);
  const resume = async () => { if (!t?.request || busy) return; setBusy(true); setError(''); try { await gateway.createTask(t.request); await task.refetch(); } catch(e) {setError((e as Error).message);} finally {setBusy(false);} };
  if (task.isPending) return <Skeleton h={200} />;
  if (task.isError) return <ErrorBanner error={task.error} onRetry={() => task.refetch()} />;
  if(t?.executionBinding?.kind==='WORKER_LOCAL')return <div className="col" style={{gap:16}}><Link to="/tasks">返回任务列表</Link><h1>{t.displayName??'原生任务'}</h1><Card title="任务要求"><p style={{whiteSpace:'pre-wrap'}}>{t.instruction??t.instructionNotice??'来源未公开原任务要求'}</p>{!t.accepted&&!!t.request&&!surface.readonly&&<button disabled={busy} onClick={()=>void resume()}>核对原提交</button>}</Card><NativeTaskCard key={taskId} taskId={taskId} detail={t}/></div>;
  const items = activities.data?.data?.items ?? [];
  const current = [...items].reverse().find(a => ['RUNNING','WAITING_APPROVAL'].includes(a.status));
  const nextActivityCursor = Math.max(0,...items.map(a => a.endCursor ?? 0));
  const started = run?.startedAt ? Date.parse(run.startedAt) : null, finished = run?.finishedAt ? Date.parse(run.finishedAt) : null;
  const duration = started != null && Number.isFinite(started) ? Math.max(0,Math.floor(((finished ?? now)-started)/1000)) : null;
  return <div className="col" style={{gap:16}}><Link to="/tasks">返回任务列表</Link><h1 className="page-title">{t?.displayName ?? '历史任务'}</h1>
    <Card title="任务要求"><p style={{whiteSpace:'pre-wrap'}}>{t?.instruction ?? '历史索引没有保存执行要求'}</p></Card>
    <Card title="运行详情">
      <p>状态：{run ? states[run.state] ?? run.state : t?.accepted ? '消息已受理，等待源端分配运行' : t?.request ? '提交尚待核对' : '历史记录未绑定 ACS 运行'}</p>
      {t?.sourceError && <p role="alert">{t.sourceError}（观察于 {t.observedAt}）</p>}
      <p>{terminal.has(run?.state ?? '') ? '结果' : '正在做'}：{current ? `${current.kind} · ${current.detail ?? current.toolName ?? current.status}` : run?.summary ?? (run?.state === 'RUNNING' ? 'Agent 正在处理，尚未报告当前活动' : '尚未报告活动')}</p>
      <p>等待原因：{(terminal.has(run?.state ?? '') ? '无（运行已结束）' : run?.scheduling?.primaryReason) ?? (run?.state === 'WAITING_APPROVAL' ? '等待用户审批' : run?.state === 'PAUSED' ? '源端已暂停' : run?.state === 'NEEDS_ATTENTION' ? String(run.attention?.reason ?? '源端要求处理') : '尚未报告')}</p>
      <p>Agent：{t?.session?.agentProfileName ?? t?.session?.agentProfileId ?? 'ACS 默认 Agent'}　核心：ACS</p>
      <p>配置模型：{t?.session?.modelSettings?.modelAlias ?? t?.request?.modelSettings?.modelAlias ?? (t?.launchDefaultModel ? `${t.launchDefaultModel}（提交时默认值）` : '沿用宿主默认值（源未报告有效模型）')}</p>
      <p>运行时长：{duration == null ? '尚未开始／未报告' : `${duration} 秒${finished ? '（源起止时间）' : '（截至当前，含等待）'}`}</p>
      {!started && run?.queuedAt && <p>入队时间：{run.queuedAt}</p>}
      {run?.failureMessage && <p role="alert">{run.failureMessage}</p>}
      {t?.submissionError && !t.accepted && <p role="alert">{t.submissionError.message}（{t.submissionError.code}）</p>}
      {error && <p role="alert">{error}</p>}
      {!surface.readonly && t?.request && !t.accepted && <button disabled={busy} onClick={() => void resume()}>核对并继续原提交</button>}
      <details><summary>运行标识与验证／交付</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify({taskId,sessionId:t?.sessionId,runId:t?.runId,stateVersion:run?.stateVersion,verification:run?.verificationV2,delivery:run?.delivery},null,2)}</pre></details>
    </Card>
    <TaskConversationCard key={taskId+':'+t?.sourceStoreId} taskId={taskId} detail={t} selectedRun={selectedRun} onSelectRun={id => {setSelectedRun(id); setActivityCursor(undefined);}} />
    <TaskControlCard key={taskId + ':' + t?.runId} taskId={taskId} runId={t?.runId} />
    <TaskCollaborationCard taskId={taskId} runId={t?.runId} sessionId={t?.sessionId} storeId={t?.sourceStoreId}/>
    <Card title="选中运行用量" sub="实测、源报告、估算分别展示；采集小计不代表最终账单">
      {metrics.isError && <ErrorBanner error={metrics.error} onRetry={() => metrics.refetch()} />}
      <div className="row wrap" style={{gap:8}}>{metrics.data?.data.metrics.map(m => <Metric key={m.metricId+(m.currency??'')} metric={m} />)}</div>
      {metrics.data?.data.models.map((m,i) => <p key={i}>已观测模型：{m.providerId ?? '未知服务商'}；请求 {m.requestedModel ?? '未知'}；路由 {m.resolvedModel ?? '未知'}；响应 {m.responseModel ?? '尚未报告'}</p>)}
      <p className="muted">{metrics.data?.data.reasonCodes.map(code => metricReasons[code] ?? '用量完整性尚未确认').join(' · ')} {metrics.data?.data.observedAt ? `采集截至 ${metrics.data.data.observedAt}` : ''}</p>
    </Card>
    <Card title="活动" sub={activities.data?.data?.summary.completeness ?? (activities.isPending && t?.runId ? '正在读取活动' : '尚无活动')}>
      {activities.isError && <ErrorBanner error={activities.error} onRetry={() => activities.refetch()} />}
      {items.map(a => <p key={a.activityId}>{a.kind} · {a.status}　{a.detail ?? a.toolName ?? ''} {a.resultSummary ?? ''}</p>)}
      {activityCursor !== undefined && <button onClick={() => setActivityCursor(undefined)}>回到首批活动</button>}
      {activities.data?.data?.truncated && nextActivityCursor > (activityCursor ?? 0) && <button onClick={() => setActivityCursor(nextActivityCursor)}>后续活动</button>}
      {activities.data?.data?.truncated && <p>活动已截断；当前页面只展示有界采样。</p>}
    </Card>
    <Card title="公开输出" sub={output.data?.data?.complete ? '源端完整输出' : '当前输出可能不完整'}>
      {output.isError && <ErrorBanner error={output.error} onRetry={() => output.refetch()} />}
      <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{output.data?.data?.text ?? '尚未报告输出'}</pre>
    </Card></div>;
}
