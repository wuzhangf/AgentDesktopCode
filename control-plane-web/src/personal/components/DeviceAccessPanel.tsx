import { useEffect, useState } from 'react';
import {InvitationQr} from './InvitationQr';
import { Card } from '../../components/ui/primitives';
import { deviceAccess, deviceNetworkFacts, type DeviceCapabilities, type DeviceConnection, type DeviceGrant, type PairingRequest, type NotificationProviderStatus, type NotificationRouteStatus, type NotificationSubscription } from '../device-access';

type Intent = {connection: string; operation: 'invitations' | 'decide' | 'scope' | 'revoke' | 'notification-provider-update' | 'notification-route-update'; body?: Record<string, unknown>; target?: string};
export function DeviceAccessPanel() {
  const [connections, setConnections] = useState<DeviceConnection[]>([]);
  const [connection, setConnection] = useState('');
  const [caps, setCaps] = useState<DeviceCapabilities>();
  const [devices, setDevices] = useState<DeviceGrant[]>([]);
  const [requests, setRequests] = useState<PairingRequest[]>([]);
  const [sessions, setSessions] = useState<string[]>([]);
  const [nativeTasks,setNativeTasks]=useState<string[]>([]);
  const [launchKeys,setLaunchKeys]=useState<string[]>([]);
  const [actions, setActions] = useState(['OBSERVE']);
  const [invite, setInvite] = useState('');
  const [notificationProvider, setNotificationProvider] = useState<NotificationProviderStatus>();
  const [notificationRoutes, setNotificationRoutes] = useState<NotificationRouteStatus[]>([]);
  const [subscription, setSubscription] = useState<{deviceGrantId: string; value: NotificationSubscription}>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<Intent>();
  useEffect(() => {let current = true;
    void deviceAccess<DeviceConnection[]>().then(rows => {if (current) setConnections(rows);}).catch(e => {if (current) setError(String(e.message));});
    return () => {current = false;};
  }, []);
  useEffect(() => {let current = true;
    setCaps(undefined); setInvite(''); setDevices([]); setRequests([]); setSessions([]); setNativeTasks([]);setLaunchKeys([]);setActions(['OBSERVE']); setNotificationProvider(undefined); setNotificationRoutes([]); setSubscription(undefined); setError('');
    if (connection) void Promise.all([
      deviceAccess<DeviceCapabilities>(connection, 'capabilities'),
      deviceAccess<DeviceGrant[]>(connection, 'devices'),
      deviceAccess<PairingRequest[]>(connection, 'pairing-requests'),
    ]).then(([c, d, r]) => {if (current) {setCaps(c); setDevices(d); setRequests(r);}})
      .catch(e => {if (current) setError(String(e.message));});
    // Notification state is an optional ACS extension. A source that has not
    // rolled out the provider contract must not hide the existing pairing UI.
    if (connection) void Promise.all([
      deviceAccess<NotificationProviderStatus>(connection, 'notification-provider').catch(() => undefined),
      deviceAccess<NotificationRouteStatus[] | {items?: NotificationRouteStatus[]}>(connection, 'notification-routes').catch(() => undefined),
    ]).then(([provider, routes]) => {if (!current) return; setNotificationProvider(provider); setNotificationRoutes(Array.isArray(routes) ? routes : routes?.items ?? []);});
    return () => {current = false;};
  }, [connection]);
  useEffect(()=>{
    if(!invite)return;
    let expires:number;try{expires=Number(JSON.parse(invite).expiresAt);}catch{return;}
    if(!Number.isFinite(expires))return;
    const timer=setTimeout(()=>setInvite(''),Math.max(0,Math.min(2147483647,expires-Date.now())));
    return()=>clearTimeout(timer);
  },[invite]);
  async function refresh() {
    try {
      const [d, r] = await Promise.all([deviceAccess<DeviceGrant[]>(connection, 'devices'), deviceAccess<PairingRequest[]>(connection, 'pairing-requests')]);
      setDevices(d); setRequests(r); setError('');
      const [provider, routes] = await Promise.all([
        deviceAccess<NotificationProviderStatus>(connection, 'notification-provider').catch(() => undefined),
        deviceAccess<NotificationRouteStatus[] | {items?: NotificationRouteStatus[]}>(connection, 'notification-routes').catch(() => undefined),
      ]);
      setNotificationProvider(provider); setNotificationRoutes(Array.isArray(routes) ? routes : routes?.items ?? []);
    } catch (e) {setError(e instanceof Error ? e.message : '连接未完成');}
  }
  async function run(next: Intent) {
    setIntent(next); setBusy(true); setError('');
    try {
      const result = await deviceAccess(next.connection, next.operation, next.body, next.target);
      if (next.operation === 'invitations') setInvite(JSON.stringify(result));
      setIntent(undefined); await refresh();
    } catch (e) {setError(e instanceof Error ? e.message : '结果未知，保留原请求核对');}
    finally {setBusy(false);}
  }
  const toggle = (rows: string[], value: string) => rows.includes(value) ? rows.filter(r => r !== value) : [...rows, value];
  const network=caps?deviceNetworkFacts(caps):undefined;
  const native=caps?.localSource;
  // Every reachable worker-local backend gets a launch row, not just the one
  // mirrored at the top level — cli-supervisor registers each detected stock
  // CLI as its own backend (`cli:pi`, `cli:codex`, …) in `backends[]`.
  const localBackends=native?.available?[native,...(native.backends??[])]:[];
  const launchRowKey=(b:string,p:string,e:string)=>`${b}:${p}:${e}`;
  const launchScopes=localBackends.flatMap(b=>(b.projects??[]).flatMap(p=>(b.engines??[]).flatMap(e=>launchKeys.includes(launchRowKey(b.backendStoreId,p.projectId,e.engineId))?[{backendStoreId:b.backendStoreId,projectId:p.projectId,engineId:e.engineId}]:[])));
  const cliBackends=localBackends.filter(b=>(b.engines??[]).length>0&&b.engines.every(e=>e.sourceKind==='cli'));
  const managedBackends=localBackends.filter(b=>!cliBackends.includes(b));
  const projectName=(backendStoreId:string,projectId:string)=>localBackends.find(b=>b.backendStoreId===backendStoreId)?.projects.find(p=>p.projectId===projectId)?.displayName??projectId;
  const scopeFields=()=>caps?.resourceScopeVersion===2?{resources:[
    ...sessions.map(sessionId=>({kind:'ACS_SESSION',backendStoreId:caps.storeId,sessionId})),
    ...(caps.localTasks??[]).filter(t=>nativeTasks.includes(`${t.backendStoreId}:${t.taskId}`)).map(({kind,backendStoreId,taskId})=>({kind,backendStoreId,taskId})),
  ],launchScopes,actions}:{sessions,actions};
  const invalidScope=(!sessions.length&&!nativeTasks.length&&!launchScopes.length)||actions.includes('LAUNCH')!==(launchScopes.length>0)||actions.includes('GRAPHICS_ACT')&&!actions.includes('CONTROL');
  const routeFor=(deviceGrantId:string) => notificationRoutes.find(route => route.deviceGrantId === deviceGrantId);
  async function toggleProvider() {
    if (!connection || !notificationProvider) return;
    await run({connection, operation: 'notification-provider-update', body: {requestKey: crypto.randomUUID(), enabled: !notificationProvider.enabled, expectedRevision: notificationProvider.revision}});
    const next = await deviceAccess<NotificationProviderStatus>(connection, 'notification-provider').catch(() => undefined);
    if (next) setNotificationProvider(next);
  }
  async function toggleRoute(device: DeviceGrant) {
    if (!connection) return;
    const current = routeFor(device.deviceGrantId);
    await run({connection, operation: 'notification-route-update', target: device.deviceGrantId, body: {requestKey: crypto.randomUUID(), enabled: !(current?.enabled ?? false), expectedGrantRevision: device.grantRevision}});
    const routes = await deviceAccess<NotificationRouteStatus[] | {items?: NotificationRouteStatus[]}>(connection, 'notification-routes').catch(() => undefined);
    setNotificationRoutes(Array.isArray(routes) ? routes : routes?.items ?? []);
  }
  async function showSubscription(deviceGrantId: string) {
    if (!connection) return;
    setError('');
    try {
      const value = await deviceAccess<NotificationSubscription>(connection, 'notification-subscription', undefined, deviceGrantId);
      setSubscription({deviceGrantId, value});
    } catch (e) {setError(e instanceof Error ? e.message : '订阅说明暂不可用');}
  }
  return <Card title="连接手机" sub="从已登记的本机 ACS 配对，电脑核对设备和校验词后明确批准">
    <div className="col" style={{gap: 12}}>
      <label>执行来源 <select aria-label="手机配对来源" value={connection} disabled={busy || !!intent} onChange={e => setConnection(e.target.value)}>
        <option value="">选择已登记电脑服务</option>{connections.map(c => <option key={c.connectionId} value={c.connectionId}>{c.displayName}</option>)}
      </select></label>
      {error && <p role="alert">{error}</p>}
      {caps && <>
        <p>手机连接地址：{caps.origin} · 证书有效至 {new Date(caps.certificateNotAfter).toLocaleDateString()}</p>
        <details><summary>信任与网络核对</summary><p>证书摘要：{caps.certificateSha256}</p>
          <p>监听地址：{caps.bindAddress??'源未提供'}{caps.port?`:${caps.port}`:''}；证书名称：{network?.names.join('、')||'源未提供'}</p>
          <p>证书名称与连接地址：{network?.nameMatches==null?'待核对':network.nameMatches?'匹配':'不匹配，请先修正宿主配置'}；有效期：{network?.certificateTimeValid==null?'待核对':network.certificateTimeValid?'当前有效':'尚未生效或已过期，请先修正宿主配置'}</p>
          {(network?.loopbackBind||network?.loopbackOrigin)&&<p>当前监听或连接地址仅本机可达。真实手机需要可达的 HTTPS 私网入口与对应证书；此信息不证明手机网络已连通。</p>}
          <p>手机须能到达此 HTTPS 地址。局域网与蜂窝私网分别验证；更换地址或证书需重新确认配对。手机连接时仍执行正常 TLS 校验。</p></details>
        {notificationProvider && <section aria-label="后台提醒通道" style={{borderTop:'1px solid var(--border,#334155)',paddingTop:10}}>
          <b>后台提醒通道</b>
          <p>固定 provider：{notificationProvider.providerRef} · 状态：{notificationProvider.state} · {notificationProvider.enabled ? '已启用' : '未启用'}</p>
          {notificationProvider.serverOrigin && <p>服务地址：{notificationProvider.serverOrigin}</p>}
          {notificationProvider.credentialConfigured === false && <p>发布凭据尚未配置；请在电脑安装配置中完成后再启用。凭据不会从此页面提交或显示。</p>}
          {notificationProvider.lastErrorCode && <p role="status">最近错误：{notificationProvider.lastErrorCode}</p>}
          <button disabled={busy || !!intent || notificationProvider.credentialConfigured === false || notificationProvider.state === 'UNCONFIGURED'} onClick={() => void toggleProvider()}>{notificationProvider.enabled ? '停用后台提醒' : '启用后台提醒'}</button>
          <p>启用只改变已登记通道的开关；任务授权、provider 地址和发布凭据仍由电脑/ACS 管理。</p>
        </section>}
        <fieldset disabled={busy || !!intent}><legend>明确授权的任务</legend>
          {caps.sessions.map(s => <label key={s.sessionId} style={{display: 'block'}}><input type="checkbox" checked={sessions.includes(s.sessionId)} onChange={() => setSessions(toggle(sessions, s.sessionId))}/>{s.title}</label>)}
          {!caps.sessions.length && <p>{native?.available&&caps.resourceScopeVersion===2?'暂无可授予的 ACS 会话；可以在下方选择原生项目的启动范围。':'先在电脑创建任务；当前来源尚未开放手机从零启动授权。'}</p>}
        </fieldset>
        {native?.available&&caps.resourceScopeVersion===2&&<fieldset disabled={busy||!!intent}><legend>本机 worker 与已装 CLI 的明确范围</legend>
          {(caps.localTasks??[]).map(t=><label key={`${t.backendStoreId}:${t.taskId}`} style={{display:'block'}}><input type="checkbox" checked={nativeTasks.includes(`${t.backendStoreId}:${t.taskId}`)} onChange={()=>setNativeTasks(toggle(nativeTasks,`${t.backendStoreId}:${t.taskId}`))}/>已有原生任务：{t.displayName}</label>)}
          <p>创建权限只限所选项目与 engine；不会开放该项目的全部既有任务。创建受理后仅追加原请求产生的任务。</p>
          {managedBackends.length>0&&<p><b>托管 worker</b></p>}
          {managedBackends.flatMap(b=>b.projects.flatMap(p=>b.engines.map(e=><label key={launchRowKey(b.backendStoreId,p.projectId,e.engineId)} style={{display:'block'}}><input type="checkbox" checked={launchKeys.includes(launchRowKey(b.backendStoreId,p.projectId,e.engineId))} onChange={()=>setLaunchKeys(toggle(launchKeys,launchRowKey(b.backendStoreId,p.projectId,e.engineId)))}/>{p.displayName} · {e.engineId} {e.version} · 按来源登记配置与预检策略{p.hasUncommittedChanges?'（当前有未提交修改，不会自动带入）':''}</label>)))}
          {cliBackends.length>0&&<><p><b>已装 CLI</b></p><p>扫描到的本机原装 CLI；发起走你自己的 CLI 订阅与模型配置，不走托管 worker。</p></>}
          {cliBackends.flatMap(b=>b.projects.flatMap(p=>b.engines.map(e=><label key={launchRowKey(b.backendStoreId,p.projectId,e.engineId)} style={{display:'block'}}><input type="checkbox" checked={launchKeys.includes(launchRowKey(b.backendStoreId,p.projectId,e.engineId))} onChange={()=>setLaunchKeys(toggle(launchKeys,launchRowKey(b.backendStoreId,p.projectId,e.engineId)))}/>{p.displayName} · {e.engineId} {e.version} · 已装 CLI{p.hasUncommittedChanges?'（当前有未提交修改，不会自动带入）':''}</label>)))}
        </fieldset>}
        {native&&!native.available&&<p>原生宿主暂不可用：{native.reasonCode}。现有 ACS 授权仍可使用。</p>}
        <fieldset disabled={busy || !!intent}><legend>动作范围</legend>
          <label><input type="checkbox" checked disabled/>查看授权任务</label>
          <label><input type="checkbox" checked={actions.includes('CONTROL')} onChange={() => setActions(toggle(actions, 'CONTROL'))}/>暂停／继续／停止</label>
          <label><input type="checkbox" checked={actions.includes('INTERACT')} onChange={() => setActions(toggle(actions, 'INTERACT'))}/>发送普通消息（可能产生模型用量）</label>
          <label><input type="checkbox" checked={actions.includes('APPROVE')} disabled={!caps?.supportedActions?.includes('APPROVE')} onChange={() => setActions(toggle(actions, 'APPROVE'))}/>批准／拒绝授权任务的具体请求（独立审批权限）</label>
          <label><input type="checkbox" checked={actions.includes('POLICY')} disabled={!caps?.supportedActions?.includes('POLICY')} onChange={() => setActions(toggle(actions, 'POLICY'))}/>管理已授权 ACS 会话及所属项目的权限模式（独立 POLICY，可持久减少审批；不等于仅批准一次）</label>
          <label><input type="checkbox" checked={actions.includes('ASSIGN')} disabled={!caps?.supportedActions?.includes('ASSIGN')} onChange={() => setActions(toggle(actions, 'ASSIGN'))}/>兼容画像／模型接管（独立 ASSIGN 权限）</label>
          <label><input type="checkbox" checked={actions.includes('COLLABORATE')} disabled={!caps?.supportedActions?.includes('COLLABORATE')} onChange={() => setActions(toggle(actions, 'COLLABORATE'))}/>分工、授权与启动（独立 COLLABORATE 权限）</label>
          <label><input type="checkbox" checked={actions.includes('ADOPT')} disabled={!caps?.supportedActions?.includes('ADOPT')} onChange={() => setActions(toggle(actions, 'ADOPT'))}/>选择、预览与采纳（独立 ADOPT 权限）</label>
          {(['GRAPHICS_OBSERVE','GRAPHICS_CAPTURE','GRAPHICS_ACT'] as const).map(action=><label key={action}><input type="checkbox" checked={actions.includes(action)} disabled={!caps?.supportedActions?.includes(action)} onChange={()=>setActions(toggle(actions,action))}/>{({GRAPHICS_OBSERVE:'读取登记应用AX节点',GRAPHICS_CAPTURE:'读取登记窗口截图',GRAPHICS_ACT:'设置值／按下登记节点（另需CONTROL）'})[action]}（独立 {action}）</label>)}
          {native?.available&&<label><input type="checkbox" checked={actions.includes('LAUNCH')} disabled={!caps.supportedActions?.includes('LAUNCH')} onChange={()=>setActions(toggle(actions,'LAUNCH'))}/>在所选项目／engine 发起新原生任务（独立 LAUNCH，可能产生模型用量）</label>}
        </fieldset>
        {actions.includes('LAUNCH')!==(launchScopes.length>0)&&<p>请选择项目／engine，并明确勾选对应的 LAUNCH 动作后再提交。</p>}
        <button disabled={busy || !!intent || invalidScope} onClick={() => void run({connection, operation: 'invitations', body: {requestKey: crypto.randomUUID(), ...scopeFields()}})}>生成配对邀请</button>
        {invite && <div><InvitationQr invitation={invite}/><p>从可信电脑复制完整邀请到手机。邀请短期有效，不保存到浏览器；过期后重新生成。</p>
          <textarea aria-label="完整配对邀请" readOnly value={invite} rows={5}/>
          <button onClick={() => {void navigator.clipboard.writeText(invite).catch(() => setError('请在文本框中手动复制完整邀请'));}}>复制完整邀请</button>
          <button onClick={() => setInvite('')}>隐藏邀请</button></div>}
        <button disabled={busy} onClick={() => void refresh()}>刷新申请与设备</button>
        {requests.filter(r => r.state === 'PENDING').map(r => <div key={r.pairingRequestId}>
          <b>{r.label}</b><p>两端校验词：{r.checkWords}</p>
          <p>任务：{r.sessions.map(id => caps.sessions.find(s => s.sessionId === id)?.title ?? '已授权任务').join('、')} · 动作：{r.actions.join('、')}</p>
          {r.resources?.filter(v=>v.kind==='WORKER_LOCAL').map(v=><p key={`${v.backendStoreId}:${v.taskId}`}>原生任务：{caps.localTasks?.find(t=>t.backendStoreId===v.backendStoreId&&t.taskId===v.taskId)?.displayName??v.taskId}</p>)}
          {r.launchScopes?.map(s=><p key={`${s.backendStoreId}:${s.projectId}:${s.engineId}`}>创建范围：{projectName(s.backendStoreId,s.projectId)} · {s.engineId}</p>)}
          {[true, false].map(approve => <button key={String(approve)} disabled={busy || !!intent} onClick={() => void run({connection, operation: 'decide', target: r.pairingRequestId, body: {requestKey: crypto.randomUUID(), approve}})}>{approve ? '已核对，批准' : '拒绝'}</button>)}
        </div>)}
        {devices.map(d => <div key={d.deviceGrantId}><b>{d.label}</b><p>{d.state} · 授权版本 {d.grantRevision} · {d.actions.join('、')}</p>
          {notificationProvider && <div style={{margin:'8px 0'}}><p>提醒 route：{routeFor(d.deviceGrantId)?.state ?? 'UNCONFIGURED'} · {routeFor(d.deviceGrantId)?.enabled ? '已启用' : '未启用'}{routeFor(d.deviceGrantId)?.lastErrorCode ? ` · ${routeFor(d.deviceGrantId)?.lastErrorCode}` : ''}</p>
            {d.state === 'ACTIVE' && <><button disabled={busy || !!intent || notificationProvider.enabled === false} onClick={() => void toggleRoute(d)}>{routeFor(d.deviceGrantId)?.enabled ? '停用此设备提醒' : '启用此设备提醒'}</button>
              <button disabled={busy || !!intent || routeFor(d.deviceGrantId)?.enabled !== true} onClick={() => void showSubscription(d.deviceGrantId)}>查看受保护订阅说明</button></>}
            {subscription?.deviceGrantId === d.deviceGrantId && <div><p>以下内容仅用于已配对设备配置 ntfy，不含发布凭据；关闭页面后不再保留。</p><textarea aria-label="ntfy 订阅说明" readOnly value={JSON.stringify(subscription.value, null, 2)} rows={6}/><button onClick={() => setSubscription(undefined)}>隐藏订阅说明</button></div>}
          </div>}
          {d.state === 'ACTIVE' && <>
            <button disabled={busy || !!intent || invalidScope} onClick={() => {
              if (confirm(`将设备授权替换为上方明确选择的范围？\nACS ${sessions.length} 项、原生任务 ${nativeTasks.length} 项、项目／engine ${launchScopes.length} 项。\n动作：${actions.join('、')}`)) void run({connection, operation: 'scope', target: d.deviceGrantId, body: {requestKey: crypto.randomUUID(), expectedGrantRevision: d.grantRevision, ...scopeFields()}});
            }}>用所选范围更新授权</button>
            <button disabled={busy || !!intent} onClick={() => {if (confirm('撤销这台手机的访问？')) void run({connection, operation: 'revoke', target: d.deviceGrantId});}}>撤销设备</button>
          </>}
        </div>)}
      </>}
      {intent && <div><p>保留原请求，重试不会更换设备、范围或请求键。</p>
        <button disabled={busy} onClick={() => void run(intent)}>核对／重试原请求</button>
        <button disabled={busy} onClick={() => {setIntent(undefined); setError('请先刷新权威设备状态再进行其他操作');}}>结束本次核对</button></div>}
    </div>
  </Card>;
}
