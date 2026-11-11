import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {nativeSourceTasks} from '../native-tasks';
import {registeredGraphicsPreflight} from '../../../../codeagent-desktop/packages/protocol/src/native-task';
import { PersonalClientError } from '../client';
import { Card, ErrorBanner } from '../../components/ui/primitives';
import { usePersonal, usePersonalGateway, usePersonalSurface } from '../hooks';
import type { PersonalTaskCreate } from '../../../../codeagent-desktop/packages/protocol/src/personal-task';

export function TaskLaunchCard() {
  const gateway = usePersonalGateway(), surface = usePersonalSurface(), nav = useNavigate();
  const projects = usePersonal(['availableProjects'], g => g.availableProjects());
  const [sourceId, setSourceId] = useState(''), [projectId, setProjectId] = useState('');
  const [instruction, setInstruction] = useState(''), [profile, setProfile] = useState(''), [model, setModel] = useState('');
  const [engine,setEngine]=useState('');
  const [originalTasks,setOriginalTasks]=useState<{localTaskId:string;title:string;state:string}[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState(() => { try { return localStorage.getItem('personal.task.request') ?? ''; } catch { return ''; } });
  const options = usePersonal(['taskOptions', projectId], g => g.taskOptions(projectId), { enabled: !!projectId });
  const profiles = (options.data?.data.profiles as {profiles?: {id: string; name: string; revision: string}[]})?.profiles ?? [];
  const catalog = options.data?.data.models as {revision?: string; items?: {providerId?: string; modelAlias: string; availability: string}[]} | null;
  const choose = async (id: string) => {
    setOriginalTasks([]);setSourceId(id); setProjectId(''); setProfile(''); setModel(''); setEngine(''); setError('');
    if (!id) return;
    setBusy(true);
    try {
      const source = projects.data?.data.find(p => p.projectId === id);
      const registered = await gateway.registerProject({ projectRef: source?.sourceProjectRef ?? id, connectionId:source?.connectionId, displayName: source?.displayName ?? undefined });
      setProjectId(registered.data.projectId);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const launch = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      let request: PersonalTaskCreate;
      if (pending) {
        const original = await gateway.taskRequest(pending);
        const detail = await gateway.task(original.data.taskId);
        if (detail.data.accepted) { localStorage.removeItem('personal.task.request'); setPending(''); nav(`/tasks/${original.data.taskId}`); return; }
        if (!detail.data.request) throw new Error('原请求不可读，请从任务列表核对');
        request = detail.data.request;
      } else {
        request = { requestKey: `web-launch-${crypto.randomUUID()}`, projectId, instruction };
        const native=options.data?.data.native?.engines.find(e=>e.engineId===(engine||options.data?.data.native?.engines[0]?.engineId));
        if(native){request.engineId=native.engineId;request.optionsRevision=native.optionsRevision;if((native.macProfile?.recipeID==='mac.local-work/1'||native.macProfile?.modelRepair?.profile==='CODE_CANDIDATE_FILES_ONLY/1')&&model)request.executionOptions={model,accessMode:'WORKSPACE'};}
        const selectedProfile = profiles.find(p => p.id === profile);
        if (selectedProfile) { request.agentProfileId = selectedProfile.id; request.agentProfileRevision = selectedProfile.revision; }
        const selectedModel = catalog?.items?.find(m => `${m.providerId}/${m.modelAlias}` === model);
        if (selectedModel?.providerId && catalog?.revision) request.modelSettings = { providerId: selectedModel.providerId, modelAlias: selectedModel.modelAlias, catalogRevision: catalog.revision };
        localStorage.setItem('personal.task.request', request.requestKey); setPending(request.requestKey);
      }
      const result = await gateway.createTask(request);
      localStorage.removeItem('personal.task.request'); setPending(''); nav(`/tasks/${result.data.taskId}`);
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof PersonalClientError && e.code === 'REQUEST_NOT_FOUND') { localStorage.removeItem('personal.task.request'); setPending(''); }
    } finally { setBusy(false); }
  };
  const graphicsPreflight=options.data?.data.native?.engines.find(e=>registeredGraphicsPreflight(e));
  const allowed = options.data?.meta.supportedActions.includes('TASK_CREATE') === true;
  return <Card title="新建任务" sub={options.data?.data.native?.engines.some(e=>e.macProfile?.recipeID==='mac.local-work/1')?'使用这台 Mac 的独立任务工作目录':graphicsPreflight?"仅操作来源可信登记的应用与窗口":"在隔离工作区中从已提交基线执行，不导入未提交修改"}>
    {projects.isError && <ErrorBanner error={projects.error} onRetry={() => projects.refetch()} />}
    <label className="col">项目<select aria-label="项目" value={sourceId} disabled={busy || !!pending || surface.readonly} onChange={e => void choose(e.target.value)}><option value="">选择项目</option>{(projects.data?.data ?? []).map(p => <option key={p.projectId} value={p.projectId}>{p.displayName ?? p.workspaceAlias} {p.branchDisplay ?? ''} {p.headShortRevision ?? ''}{p.backend==='WORKER_LOCAL'?` · ${p.connectionId}`:''}</option>)}</select></label>
    {!projects.isPending && !projects.isError && !projects.data?.data.length && <p>暂无项目，请在本机项目管理入口登记项目后刷新。</p>}
    <label className="col" style={{marginTop: 12}}>任务要求<textarea aria-label="任务要求" rows={5} value={instruction} disabled={busy || !!pending || surface.readonly} onChange={e => setInstruction(e.target.value)} maxLength={16384} /></label>
    {options.data?.data.native ? <div><label>原生程序<select aria-label="原生程序" value={engine||options.data.data.native.engines[0]?.engineId||''} disabled={busy||!!pending} onChange={e=>setEngine(e.target.value)}>{options.data.data.native.engines.map(e=><option key={e.engineId} value={e.engineId}>{e.engineId} · {e.engineVersion}</option>)}</select></label>{options.data.data.native.engines.filter(e=>e.engineId===(engine||options.data.data.native!.engines[0]?.engineId)).map(e=><p key={e.engineId}>使用已确认的原生配置：{e.profileId==='MAC_MANAGED'?(registeredGraphicsPreflight(e)?'Mac登记应用配置':e.macProfile?.recipeID==='mac.local-work/1'?'Mac工作任务配置':'Mac受管验证配置'):e.profileId==='MANAGED'?'受管配置':e.profileHome}；{e.loadsUserExtensions?'会加载该配置下的扩展。':'未加载用户扩展。'}{e.profileId==='MAC_MANAGED'?(registeredGraphicsPreflight(e)?'范围仅登记应用与窗口；本机权限由这台Mac的用户处理。':e.macProfile?.recipeID==='mac.local-work/1'?'使用独立工作目录，模型与受控工具由这台Mac执行。':'验证与代码委派按已登记的Mac profile运行；模型用量由来源实际报告。'):'模型沿用原生配置。'}{e.hasUncommittedChanges?'项目有未提交修改，本任务仅使用已提交基线。':''}</p>)}</div> : <details style={{marginTop: 12}}><summary>Agent 与模型（默认沿用 ACS 配置）</summary>
      <select aria-label="Agent" value={profile} disabled={busy || !!pending} onChange={e => setProfile(e.target.value)}><option value="">默认 Agent</option>{profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      <select aria-label="模型" value={model} disabled={busy || !!pending} onChange={e => setModel(e.target.value)}><option value="">默认模型</option>{catalog?.items?.filter(m => m.availability === 'AVAILABLE').map(m => <option key={`${m.providerId}/${m.modelAlias}`} value={`${m.providerId}/${m.modelAlias}`}>{m.providerId} / {m.modelAlias}</option>)}</select>
    </details>}
    {options.data?.data.native?.localModels&&<label>Mac 模型<select aria-label="Mac 模型" value={model} disabled={busy||!!pending||surface.readonly} onChange={e=>setModel(e.target.value)}><option value="">运行时默认模型</option>{options.data.data.native.localModels.map(m=><option key={m.id} value={m.id}>{m.displayName}{m.provider?' · '+m.provider:''}</option>)}</select></label>}
    {options.data?.data.native?.host&&<details><summary>宿主来源与能力</summary><p style={{overflowWrap:'anywhere'}}>宿主：{options.data.data.native.host.manifest.workerId}；存储：{options.data.data.native.host.manifest.storeId}</p><ul>{options.data.data.native.host.capabilities.map(c=><li key={c.id}>{c.id}：{c.availability}；实现 {c.implementation}；验收 {c.qualification}{c.reasonCode?`（${c.reasonCode}）`:''}</li>)}</ul></details>}
    {graphicsPreflight&&<div><p>登记应用图形配置；不使用 Git 基线。远端不能代替本机授权。</p><button disabled={busy||surface.readonly} onClick={()=>{setBusy(true);void nativeSourceTasks(projectId).then(v=>setOriginalTasks(v.items??[])).catch(e=>setError((e as Error).message)).finally(()=>setBusy(false));}}>查看登记来源原任务</button>{originalTasks.map(t=><p key={t.localTaskId}>{t.title} · {t.state}<button aria-label={'打开原任务 '+t.localTaskId} disabled={busy||surface.readonly} onClick={()=>{setBusy(true);void nativeSourceTasks(projectId,t.localTaskId).then(v=>nav('/tasks/'+v.taskId)).catch(e=>setError((e as Error).message)).finally(()=>setBusy(false));}}>打开原任务</button></p>)}</div>}
    {options.isError && <ErrorBanner error={options.error} onRetry={() => options.refetch()} />}
    {options.data?.data.issues.map(i => <p key={i.code} role={i.blocking ? 'alert' : 'status'}>{i.message}</p>)}
    {error && <p role="alert">{error}</p>}
    {pending && <p>有一笔提交尚未核对。继续将使用原请求。</p>}
    {!surface.readonly && <button className="primary" style={{marginTop: 12}} disabled={busy || (!pending && (!allowed || !instruction.trim()))} onClick={() => void launch()}>{busy ? '正在提交…' : pending ? '核对并继续原提交' : '开始任务'}</button>}
  </Card>;
}
