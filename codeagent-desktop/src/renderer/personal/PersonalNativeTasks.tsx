import {useEffect, useState, useRef} from 'react';
import {validPersonalEnvelope} from '../../../packages/protocol/src/personal';
import type {AvailableProject, PersonalTaskCreate, PersonalTaskDetail, PersonalTaskOptions} from '../../../packages/protocol/src/personal-task';
import {supportedNativeProfile, type NativeInputRequest, type NativeInput, type NativeRequestView} from '../../../packages/protocol/src/native-task';
import {personalCall, readStored} from './personalGateway';
import {NativeQuestion} from './NativeQuestion';
export {personalCall};
interface Artifacts {items: {artifactId: string; path: string; status: string; sha256?: string}[]; reasonCode?: string}

/** Explicit personal gateway surface. All network traffic remains in main,
 * through the production fixed operation whitelist and the real preload. */
export function PersonalNativeTasks(props: {onOpenTask?: (taskId: string) => void}) {
  const [projects, setProjects] = useState<AvailableProject[]>([]), [project, setProject] = useState(''), [sourceId, setSourceId] = useState('');
  const [tasks,setTasks]=useState<{taskId:string;displayName?:string}[]>([]);
  const [sourceTasks,setSourceTasks]=useState<{localTaskId:string;title:string;state:string}[]>([]);
  const [options, setOptions] = useState<PersonalTaskOptions>(), [creationAllowed, setCreationAllowed] = useState(false);
  const [model,setModel]=useState('');
  const [instruction, setInstruction] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState(() => readStored<PersonalTaskCreate>('desktop.personal.create'));
  const [requestKey, setRequestKey] = useState(() => readStored<PersonalTaskCreate>('desktop.personal.create')?.requestKey ?? '');
  const [taskId, setTaskId] = useState(() => readStored<string>('desktop.personal.task') ?? '');
  const [detail, setDetail] = useState<PersonalTaskDetail>(), [output, setOutput] = useState<unknown>();
  const [activity, setActivity] = useState<unknown>(), [artifacts, setArtifacts] = useState<Artifacts>();
  const [verified, setVerified] = useState<Record<string, string>>({});
  const [stopRequest, setStopRequest] = useState<NativeInput | undefined>(() => {const id = readStored<string>('desktop.personal.task'); return id ? readStored<NativeInput>('desktop.personal.stop.' + id) : undefined;}), [stopReceipt, setStopReceipt] = useState<NativeRequestView>();
  const [stopHistory,setStopHistory]=useState<NativeRequestView[]>(()=>{const id=readStored<string>('desktop.personal.task');const rows=id?readStored<NativeRequestView[]>('desktop.personal.stop-history.'+id):[];return Array.isArray(rows)?rows:[];});
  const canPrepareStop=stopRequest?.kind==='STOP'&&stopReceipt?.state==='REJECTED'&&stopReceipt.requestKey===stopRequest.requestKey&&stopReceipt.request?.requestKey===stopRequest.requestKey&&stopReceipt.request.kind==='STOP'&&stopReceipt.request.generation===stopRequest.generation&&stopReceipt.request.targetCommandId===stopRequest.targetCommandId&&stopReceipt.request.nativeSessionId===stopRequest.nativeSessionId&&stopReceipt.request.nativeTurnId===stopRequest.nativeTurnId;
  const selectedTask=useRef(taskId);
  const refreshSequence=useRef(0),appliedSequence=useRef(0);
  const [content,setContent]=useState(''),[inputs,setInputs]=useState<NativeInputRequest[]>([]);
  const [inputPending,setInputPending]=useState<NativeInput|undefined>(()=>readStored<NativeInput>('desktop.personal.input.'+taskId)),[inputReceipt,setInputReceipt]=useState<NativeRequestView>();
  const native = detail?.native;
  const mac = options?.native?.engines.find(value => supportedNativeProfile(value.engineId, value));
  const canCreate = creationAllowed && !!mac && !options?.issues.some(value => value.blocking);
  async function work(fn: () => Promise<void>) {setBusy(true); setError(''); try {await fn();} catch (e) {setError((e as Error).message);} finally {setBusy(false);}}
  function selectTask(id: string) {selectedTask.current=id; setInputs([]);setContent('');setInputPending(readStored<NativeInput>('desktop.personal.input.'+id));setInputReceipt(undefined);localStorage.setItem('desktop.personal.task', JSON.stringify(id)); setTaskId(id); setDetail(undefined); setOutput(undefined); setActivity(undefined); setArtifacts(undefined); setVerified({}); setStopRequest(readStored<NativeInput>('desktop.personal.stop.' + id)); setStopReceipt(undefined);const rows=readStored<NativeRequestView[]>('desktop.personal.stop-history.'+id);setStopHistory(Array.isArray(rows)?rows:[]);}
  async function refresh(id: string) {
    const sequence=++refreshSequence.current;
    const value = await personalCall<PersonalTaskDetail>({action: 'TASK', taskId: id});
    if(selectedTask.current!==id||sequence<appliedSequence.current)return;
    appliedSequence.current=sequence;
    setDetail(value);
    if (!value.native) return;
    const [out, events, files, questions] = await Promise.all([
      personalCall({action: 'TASK_OUTPUT', taskId: id}),
      personalCall({action: 'TASK_ACTIVITY', taskId: id, limit: '30'}),
      personalCall<Artifacts>({action: 'NATIVE_ARTIFACTS', taskId: id}),
      personalCall<{items?:NativeInputRequest[]}>({action:'NATIVE_INPUTS',taskId:id}),
    ]);
    if(selectedTask.current!==id||sequence<appliedSequence.current)return;
    setInputs(questions.items??[]); setOutput(out); setActivity(events); setArtifacts(files);
  }
  useEffect(() => {void personalCall<AvailableProject[]>({action: 'PROJECTS_AVAILABLE'}).then(setProjects).catch(e => setError(e.message));}, []);
  useEffect(()=>{void personalCall<{items?:{taskId:string;displayName?:string}[]}>({action:'TASKS',limit:'30'}).then(v=>setTasks(v.items??[])).catch(e=>setError(e.message));},[]);
  useEffect(() => {
    if (!taskId) return;
    selectedTask.current=taskId;
    let active = true;
    let timer:ReturnType<typeof setTimeout>;
    const poll = async () => {if(!active)return;try{await refresh(taskId);}catch(e){if(active)setError((e as Error).message);}finally{if(active)timer=setTimeout(()=>void poll(),2500);}};
    void poll();
    return () => {active = false; clearTimeout(timer); if(selectedTask.current===taskId)selectedTask.current='';};
  }, [taskId]);
  async function choose(id: string) {
    setSourceTasks([]);
    setSourceId(id); setProject(''); setOptions(undefined); setCreationAllowed(false); setModel('');
    if (!id) return;
    await work(async () => {
      const source = projects.find(value => value.projectId === id)!;
      const key = 'desktop-register-' + crypto.randomUUID();
      const registered = await personalCall<{projectId: string}>({action: 'REGISTER_PROJECT', key, body: {requestKey: key, projectRef: source.sourceProjectRef ?? id, ...(source.connectionId ? {connectionId: source.connectionId} : {}), ...(source.displayName ? {displayName: source.displayName} : {})}});
      setProject(registered.projectId);
      const response = await window.codeAgentDesktop.personalOperation?.({action: 'TASK_OPTIONS', projectId: registered.projectId});
      if (!validPersonalEnvelope(response)) throw new Error('任务预检响应无效');
      setOptions(response.data as PersonalTaskOptions);
      setCreationAllowed(Array.isArray(response.meta.supportedActions) && response.meta.supportedActions.includes('TASK_CREATE'));
    });
  }
  async function create() {
    if (!mac || pending && !detail?.accepted) return;
    await work(async () => {
      const body: PersonalTaskCreate = {requestKey: 'desktop-launch-' + crypto.randomUUID(), projectId: project, engineId: mac.engineId, optionsRevision: mac.optionsRevision, instruction,...(model?{executionOptions:{model,accessMode:'WORKSPACE' as const}}:{})};
      localStorage.setItem('desktop.personal.create', JSON.stringify(body)); setPending(body); setRequestKey(body.requestKey);
      const accepted = await personalCall<{taskId: string}>({action: 'TASK_CREATE', key: body.requestKey, body});
      selectTask(accepted.taskId); props.onOpenTask?.(accepted.taskId);
    });
  }
  async function discoverOriginals() {await work(async()=>{
    const result=await personalCall<{items:{localTaskId:string;title:string;state:string}[]}>({action:'NATIVE_SOURCE_TASKS',projectId:project});
    setSourceTasks(result.items);
  });}
  async function adoptOriginal(localTaskId:string) {await work(async()=>{
    const storageKey='desktop.personal.adopt.'+project+'.'+localTaskId;
    const request=readStored<{requestKey:string;localTaskId:string}>(storageKey)??{requestKey:'desktop-adopt-'+crypto.randomUUID(),localTaskId};
    localStorage.setItem(storageKey,JSON.stringify(request));
    const result=await personalCall<{taskId:string}>({action:'NATIVE_TASK_ADOPT',projectId:project,key:request.requestKey,body:request});
    selectTask(result.taskId);await refresh(result.taskId);props.onOpenTask?.(result.taskId);
    const index=await personalCall<{items:{taskId:string;displayName?:string}[]}>({action:'TASKS',limit:'30'});setTasks(index.items);
  });}
  async function recover() {await work(async () => {const original = await personalCall<{taskId: string}>({action: 'TASK_REQUEST', requestKey}); selectTask(original.taskId); await refresh(original.taskId); props.onOpenTask?.(original.taskId);});}
  async function continueOriginal() {await work(async () => {
    if (!detail?.request || detail.request.requestKey !== requestKey || detail.accepted || detail.submissionError) throw new Error('原请求未满足恢复条件');
    const original = detail.request;
    const accepted = await personalCall<{taskId: string}>({action: 'TASK_CREATE', key: original.requestKey, body: original});
    selectTask(accepted.taskId); await refresh(accepted.taskId); props.onOpenTask?.(accepted.taskId);
  });}
  async function stop() {
    const id=taskId;
    if (stopRequest) {await work(async () => {const receipt=await personalCall<NativeRequestView>({action:'TASK_INTERACTION_REQUEST',taskId:id,requestKey:stopRequest.requestKey});if(selectedTask.current===id)setStopReceipt(receipt);}); return;}
    if (!native || !native.capabilities?.stop || !native.generation || !native.currentCommandId) return;
    await work(async () => {
      const request = {requestKey: 'desktop-stop-' + crypto.randomUUID(), kind: 'STOP' as const, generation: native.generation!, nativeSessionId: native.nativeSessionId ?? null, nativeTurnId: native.nativeTurnId ?? null, targetCommandId: native.currentCommandId!};
      localStorage.setItem('desktop.personal.stop.' + taskId, JSON.stringify(request)); setStopRequest(request);
      const receipt=await personalCall<NativeRequestView>({action:'TASK_COMMAND_CREATE',taskId:id,key:request.requestKey,body:request as Extract<NativeInput,{kind:'STOP'}>});if(selectedTask.current===id)setStopReceipt(receipt);
      await refresh(taskId);
    });
  }
  async function prepareNewStop(){await work(async()=>{
    if(!canPrepareStop||!stopReceipt)throw Error('必须先确认原停止请求已被来源拒绝');
    const history=[...stopHistory,stopReceipt];localStorage.setItem('desktop.personal.stop-history.'+taskId,JSON.stringify(history));
    localStorage.removeItem('desktop.personal.stop.'+taskId);setStopHistory(history);setStopRequest(undefined);setStopReceipt(undefined);
  });}
  async function send(kind:'NATIVE_STEER'|'NATIVE_FOLLOW_UP',question?:NativeInputRequest,response?:{value?:string;confirmed?:boolean;decision?:string}) {
    if(!native?.generation||!native.nativeSessionId||!native.currentCommandId||inputPending)return;
    const id=taskId;
    await work(async()=>{
      const guard=question?{generation:question.generation,nativeSessionId:question.nativeSessionId,nativeTurnId:question.nativeTurnId,targetCommandId:question.targetCommandId}:{generation:native.generation!,nativeSessionId:native.nativeSessionId!,nativeTurnId:native.nativeTurnId??undefined,targetCommandId:native.currentCommandId!};
      const request:NativeInput=question?{...guard,requestKey:'desktop-input-'+crypto.randomUUID(),kind:'INPUT_RESPONSE',inputRequestId:question.inputRequestId,response:response!}:{...guard,requestKey:'desktop-input-'+crypto.randomUUID(),kind,content};
      localStorage.setItem('desktop.personal.input.'+id,JSON.stringify(request));setInputPending(request);
      const receipt=await personalCall<NativeRequestView>(request.kind==='INPUT_RESPONSE'?{action:'NATIVE_INPUT_RESPONSE',taskId:id,entityId:request.inputRequestId,key:request.requestKey,body:request}:{action:'NATIVE_MESSAGE_CREATE',taskId:id,key:request.requestKey,body:request as Extract<NativeInput,{kind:'NATIVE_STEER'|'NATIVE_FOLLOW_UP'}>});
      if(selectedTask.current===id)setInputReceipt(receipt);
      await refresh(id);
    });
  }
  async function control(kind:'PAUSE'|'RESUME'){
    if(inputPending||!native?.generation||!native.nativeSessionId||!native.currentCommandId||!native.capabilities?.[kind==='PAUSE'?'pause':'resume'])return;
    const id=taskId;
    await work(async()=>{
      const request:Extract<NativeInput,{kind:'PAUSE'|'RESUME'}>={requestKey:'desktop-control-'+crypto.randomUUID(),kind,generation:native.generation!,nativeSessionId:native.nativeSessionId!,nativeTurnId:native.nativeTurnId??undefined,targetCommandId:native.currentCommandId!};
      localStorage.setItem('desktop.personal.input.'+id,JSON.stringify(request));setInputPending(request);
      const receipt=await personalCall<NativeRequestView>({action:'TASK_COMMAND_CREATE',taskId:id,key:request.requestKey,body:request});if(selectedTask.current===id)setInputReceipt(receipt);await refresh(id);
    });
  }
  async function reconcileInput(){if(!inputPending)return;const id=taskId,key=inputPending.requestKey;await work(async()=>{const receipt=await personalCall<NativeRequestView>({action:'TASK_INTERACTION_REQUEST',taskId:id,requestKey:key});if(selectedTask.current===id)setInputReceipt(receipt);});}
  async function save(artifact:Artifacts['items'][number]){await work(async()=>{
    if(!detail?.sourceStoreId||!artifact.sha256||!window.codeAgentDesktop.saveNativeArtifact)throw new Error('成果保存尚不可用');
    const result=await window.codeAgentDesktop.saveNativeArtifact({taskId,artifactId:artifact.artifactId,sourceStoreId:detail.sourceStoreId,sha256:artifact.sha256,path:artifact.path});
    if('error'in result)throw new Error(String(result.error));
    if(!result.canceled)setVerified(v=>({...v,[artifact.artifactId]:'已保存 '+result.sha256}));
  });}
  async function verify(artifact: Artifacts['items'][number]) {await work(async () => {
    const file = await personalCall<{path: string; encoding: string; bytes: string; sha256: string}>({action: 'NATIVE_ARTIFACT', taskId, entityId: artifact.artifactId});
    if (file.encoding !== 'base64' || file.path !== artifact.path) throw new Error('成果路径或编码不一致');
    const bytes = Uint8Array.from(atob(file.bytes), value => value.charCodeAt(0));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== file.sha256 || artifact.sha256 && digest !== artifact.sha256) throw new Error('成果 SHA-256 不一致');
    setVerified(value => ({...value, [artifact.artifactId]: digest}));
  });}
  return <main style={{padding: 24, overflow: 'auto', height: '100vh'}} aria-label="个人原生任务">
    <h1>原生任务</h1><p>通过本机管理网关执行已登记的 Pi、Codex 或 Mac 配置。未知能力保持不可操作。</p>
    <nav aria-label="已有原生任务">{tasks.map(t=><button key={t.taskId} onClick={()=>selectTask(t.taskId)}>{t.displayName??t.taskId}</button>)}</nav>
    <fieldset disabled={busy || !!pending && !detail?.accepted}><legend>新建任务</legend>
      <label>项目<select aria-label="原生项目" value={sourceId} onChange={event => void choose(event.target.value)}><option value="">选择已登记项目</option>{projects.map(value => <option key={value.projectId} value={value.projectId}>{value.displayName ?? value.workspaceAlias ?? value.projectId}</option>)}</select></label>
      {mac && <div data-testid="mac-preflight"><p>{mac.engineId} · {mac.profileId} · {mac.engineVersion}</p><p>{mac.macProfile?.recipeID==='mac.local-work/1'?'独立任务工作目录':'已提交基线：'+mac.headRevision}；工作区策略：{mac.workingCopyPolicy}；原项目{mac.hasUncommittedChanges ? '存在' : '没有'}未提交修改。</p><details><summary>预检诊断</summary><p>配置版本：{mac.optionsRevision}</p></details></div>}
      {options?.issues.map(value => <p key={value.code}>{value.code}：{value.message}</p>)}
      {options?.native?.localModels&&<label>模型<select aria-label="Mac 模型" value={model} onChange={e=>setModel(e.target.value)}><option value="">运行时默认模型</option>{options.native.localModels.map(m=><option key={m.id} value={m.id}>{m.displayName}{m.provider?' · '+m.provider:''}</option>)}</select></label>}
      <label>任务要求<textarea aria-label="原生任务要求" rows={4} value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={16384} /></label>
      <button disabled={!canCreate || !instruction.trim()} onClick={() => void create()}>开始原生任务</button>
    </fieldset>
    {project&&<section aria-label="接续其他端任务"><button disabled={busy} onClick={()=>void discoverOriginals()}>查找手机和其他端任务</button>
      <p>接续只登记原任务，不重新启动或重发要求；列表为来源最近 50 项任务中的当前项目范围。</p>
      {sourceTasks.map(t=><div key={t.localTaskId}><span>{t.title} · {t.state}</span><button disabled={busy} onClick={()=>void adoptOriginal(t.localTaskId)}>接续此任务 {t.localTaskId.slice(-8)}</button></div>)}
    </section>}
    <label>原请求键<input aria-label="原请求键" value={requestKey} onChange={event => setRequestKey(event.target.value)} /></label><button disabled={busy || !requestKey} onClick={() => void recover()}>只读恢复原请求</button>
    {detail && !detail.accepted && !detail.submissionError && <button disabled={busy || detail.request?.requestKey !== requestKey} onClick={() => void continueOriginal()}>使用原键继续核对提交</button>}
    <p data-testid="task-id">{taskId}</p>
    {detail && <section><h2>任务事实</h2>
      <p>状态：{detail.sourceError ? '观察中断，保留上次事实' : native?.state ?? (detail.accepted ? '已受理，等待来源观察' : '原提交待核对')}；任务：{detail.taskId}</p>
      <p>来源：{detail.executionBinding?.kind === 'WORKER_LOCAL' ? detail.executionBinding.workerId ?? detail.executionBinding.connectionId : '尚未绑定'}；存储：{detail.sourceStoreId ?? '未知'}；原生会话：{native?.nativeSessionId ?? '尚未报告'}</p>
      <p>选择模型：{native?.executionOptions?.model??native?.configuredModel??'来源尚未报告'}</p>
      <p>本机效果已静止：{fact(native?.localQuiescent)}；远端停止已确认：{fact(native?.remoteStopConfirmed)}；所有效果已静止：{fact(native?.quiescent)}</p>
      {native?.reasonCode && <p>原因：{native.reasonCode}</p>}
      {detail.submissionError && <p role="alert">{detail.submissionError.message}</p>}
      <details><summary>任务诊断</summary><pre data-testid="task-facts">{JSON.stringify(detail, null, 2)}</pre></details>
      <button disabled={busy || !stopRequest && (!native?.capabilities?.stop || !native.generation || !native.currentCommandId)} onClick={() => void stop()}>{stopRequest ? '查看停止状态' : '停止原生任务'}</button>
      {stopRequest && <pre data-testid="stop-facts">{JSON.stringify({request: stopRequest, receipt: stopReceipt}, null, 2)}</pre>}
      {canPrepareStop&&<button disabled={busy} onClick={()=>void prepareNewStop()}>保留拒绝回执并准备新停止</button>}
      {stopHistory.length>0&&<details><summary>已保留的停止拒绝回执</summary><pre>{JSON.stringify(stopHistory,null,2)}</pre></details>}
      {native?.capabilities?.pause&&<button disabled={busy||!!inputPending} onClick={()=>void control('PAUSE')}>请求边界暂停</button>}
      {native?.capabilities?.resume&&<button disabled={busy||!!inputPending} onClick={()=>void control('RESUME')}>按来源方式继续</button>}
      {native && ['codex','codep'].includes(native.engineId)&&<p>此来源未提供严格暂停；停止后可用的下一轮操作以源能力为准。</p>}
      <label>补充要求<textarea aria-label="原生任务补充" value={content} onChange={e=>setContent(e.target.value)} maxLength={16384}/></label>
      <button disabled={busy||!!inputPending||!content.trim()||!native?.capabilities?.steer} onClick={()=>void send('NATIVE_STEER')}>补充当前任务</button>
      <button disabled={busy||!!inputPending||!content.trim()||!native?.capabilities?.followUp} onClick={()=>void send('NATIVE_FOLLOW_UP')}>下一轮继续</button>
      {inputs.filter(q=>q.state==='PENDING').map(q=><NativeQuestion key={q.inputRequestId} question={q} disabled={busy||!!inputPending} answer={r=>void send('NATIVE_STEER',q,r)}/>)}
      {inputPending&&<div role="status">原输入请求：{inputPending.requestKey} · {String(inputReceipt?.source?.state??inputReceipt?.state??'待核对')}<button disabled={busy} onClick={()=>void reconcileInput()}>只读核对原输入</button>{inputReceipt&&['OBSERVED','REJECTED'].includes(inputReceipt.state)&&<button onClick={()=>{localStorage.removeItem('desktop.personal.input.'+taskId);setInputPending(undefined);setInputReceipt(undefined);setContent('');}}>保留回执并继续</button>}</div>}
      <h2>公开输出</h2><pre data-testid="native-output">{JSON.stringify(output, null, 2)}</pre>
      <details><summary>公开活动</summary><pre data-testid="native-activity">{JSON.stringify(activity, null, 2)}</pre></details>
      <h2>成果</h2><p>{artifacts?.reasonCode}</p>{artifacts?.items.map(value => <p key={value.artifactId}>{value.path} · {value.status} <button disabled={busy || value.status !== 'AVAILABLE'} onClick={() => void verify(value)}>核验成果 {value.path}</button><button disabled={busy||value.status!=='AVAILABLE'||!value.sha256} onClick={()=>void save(value)}>保存成果 {value.path}</button>{verified[value.artifactId] && <span data-testid="verified-artifact">{value.artifactId} SHA-256 {verified[value.artifactId]}</span>}</p>)}
    </section>}
    {error && <p role="alert">{error}</p>}
  </main>;
}

function fact(value: boolean | undefined): string {return value === true ? '是' : value === false ? '否' : '未知';}

