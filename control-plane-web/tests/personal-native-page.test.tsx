// @vitest-environment jsdom
import {afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {webcrypto,createHash} from 'node:crypto';
import {MemoryRouter} from 'react-router-dom';
import {PersonalGatewayProvider} from '../src/personal/hooks';
import {personalGateway} from '../src/personal/port';
import {NativeTaskCard} from '../src/personal/components/NativeTaskCard';
import type {PersonalTaskDetail} from '../../codeagent-desktop/packages/protocol/src/personal-task';
import type {PersonalTransport} from '../src/personal/client';

afterEach(()=>{cleanup();vi.unstubAllGlobals();sessionStorage.clear();localStorage.clear();});
const detail:PersonalTaskDetail={taskId:'task-1',accepted:true,createdAt:'2026-10-19T00:00:00Z',updatedAt:'2026-10-19T00:00:00Z',core:'PI',executionBinding:{kind:'WORKER_LOCAL',connectionId:'native',storeId:'fixture-store',localTaskId:'native-1',engineId:'pi',engineVersion:'0.73.1'},observedAt:'2026-10-19T00:00:00Z',native:{taskId:'native-1',engineId:'pi',engineVersion:'0.73.1',state:'RUNNING',generation:'generation-1',nativeSessionId:'session-1',currentCommandId:'first-command',capabilities:{stop:true,steer:true,followUp:false,pause:false,resume:false}}};
function show(readonly=false,value=detail){const transport:PersonalTransport=async()=>({data:{},meta:{} as never});const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});return render(<QueryClientProvider client={qc}><PersonalGatewayProvider surface={{kind:'web',readonly,transport,gateway:personalGateway(transport),label:'test'}}><MemoryRouter><NativeTaskCard taskId="task-1" detail={value}/></MemoryRouter></PersonalGatewayProvider></QueryClientProvider>);}
describe('native task UI keeps STOP independent of uncertain inputs',()=>{
  it('answers a native approval with its original question guards and decision shape',async()=>{
    const writes:any[]=[];const question={inputRequestId:'approval-one',method:'item/commandExecution/requestApproval',title:'Write fixture file',state:'PENDING',generation:'generation-1',nativeSessionId:'session-1',nativeTurnId:'turn-1',targetCommandId:'first-command',options:['accept','decline','cancel'],scope:{cwd:'D:\\test-owned',commandActions:'known fixture command'}};
    vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{const body=init?.body?JSON.parse(String(init.body)):undefined;if(body)writes.push(body);return new Response(JSON.stringify({data:body?{kind:'WORKER_LOCAL',requestKey:body.requestKey,request:body,state:'OBSERVED',source:{state:'REQUESTED'}}:input.endsWith('/input-requests')?{items:[question]}:{items:[]},meta:{}}),{status:200});}));
    show();await screen.findByText('Write fixture file');expect(screen.getByText(/known fixture command/)).toBeTruthy();fireEvent.click(screen.getByText('accept'));
    await waitFor(()=>expect(writes).toHaveLength(1));expect(writes[0]).toMatchObject({kind:'INPUT_RESPONSE',inputRequestId:'approval-one',generation:'generation-1',nativeSessionId:'session-1',nativeTurnId:'turn-1',targetCommandId:'first-command',response:{decision:'accept'}});
  });
  it('allows guarded STOP while the native session is still preparing',async()=>{
    const writes:any[]=[];vi.stubGlobal('fetch',vi.fn(async(_input:string,init?:RequestInit)=>{const body=init?.body?JSON.parse(String(init.body)):undefined;if(body)writes.push(body);return new Response(JSON.stringify({data:body?{kind:'WORKER_LOCAL',requestKey:body.requestKey,request:body,state:'OBSERVED',source:{state:'APPLIED'}}:{items:[]},meta:{}}),{status:200});}));
    show(false,{...detail,native:{...detail.native!,state:'PREPARING',nativeSessionId:null,nativeTurnId:null}});
    expect(screen.queryByLabelText('原生任务补充')).toBeNull();fireEvent.click(screen.getByText('停止原生任务'));
    await waitFor(()=>expect(writes).toHaveLength(1));expect(writes[0]).toMatchObject({kind:'STOP',generation:'generation-1',targetCommandId:'first-command',nativeSessionId:null,nativeTurnId:null});
  });
  it('retains an ambiguous input while independently sending and recovering original STOP',async()=>{
    const writes:any[]=[];vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{
      const request=init?.body?JSON.parse(String(init.body)):undefined;if(request)writes.push(request);
      const data=request?{kind:'WORKER_LOCAL',requestKey:request.requestKey,request,state:request.kind==='STOP'?'OBSERVED':'UNKNOWN',source:request.kind==='STOP'?{state:'ACCEPTED'}:undefined}:input.endsWith('/output')?{text:'public text',coverage:'BOUNDED'}:{items:[]};
      return new Response(JSON.stringify({data,meta:{source:'fixture'}}),{status:200});
    }));
    const first=show();fireEvent.change(screen.getByLabelText('原生任务补充'),{target:{value:'More context'}});fireEvent.click(screen.getByText('补充当前任务'));await screen.findByText('只读核对原请求');await waitFor(()=>expect((screen.getByText('停止原生任务') as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByText('停止原生任务'));await screen.findByText('只读核对停止请求');await waitFor(()=>expect(writes).toHaveLength(2));expect(writes.map(v=>v.kind)).toEqual(['NATIVE_STEER','STOP']);const key=writes[1].requestKey;
    first.unmount();show();await screen.findByText('只读核对原请求');await screen.findByText('只读核对停止请求');expect(localStorage.getItem('native.stop.task-1')).toContain(key);expect(writes).toHaveLength(2);
  });
  it.each(['hash','path'])('rejects artifact %s mismatch against the published list before download',async mismatch=>{
    const bytes=Buffer.from('actual artifact'),digest=createHash('sha256').update(bytes).digest('hex'),id='file-'+'a'.repeat(64);
    vi.stubGlobal('crypto',webcrypto);
    vi.stubGlobal('fetch',vi.fn(async(input:string)=>{const data=input.endsWith('/artifacts')?{items:[{artifactId:id,path:'proof.txt',status:'AVAILABLE',sha256:mismatch==='hash'?'b'.repeat(64):digest}]}:input.endsWith('/artifacts/'+id)?{path:mismatch==='path'?'other.txt':'proof.txt',encoding:'base64',bytes:bytes.toString('base64'),sha256:digest}:{items:[]};return new Response(JSON.stringify({data,meta:{}}),{status:200});}));
    show();fireEvent.click(await screen.findByText('下载文件'));await screen.findByText('结果文件摘要不一致');
  });
  it.each(['durable','legacy'])('recovers %s STOP after session loss without another POST',async mode=>{
    const request={kind:'STOP',requestKey:'durable-stop',generation:'generation-1',nativeSessionId:'session-1',nativeTurnId:null,targetCommandId:'first-command'};
    (mode==='legacy'?sessionStorage:localStorage).setItem('native.stop.task-1',JSON.stringify(request));const calls:any[]=[];
    vi.stubGlobal('fetch',vi.fn(async(input:string,init?:RequestInit)=>{calls.push({input,method:init?.method??'GET'});return new Response(JSON.stringify({data:input.includes('/interaction-requests/')?{kind:'WORKER_LOCAL',requestKey:request.requestKey,request,state:'OBSERVED',source:{state:'REQUESTED'}}:{items:[]},meta:{}}),{status:200});}));
    const first=show();first.unmount();sessionStorage.clear();show();fireEvent.click(await screen.findByText('只读核对停止请求'));await screen.findByText(/REQUESTED/);expect(calls.every(c=>c.method==='GET')).toBe(true);expect(calls.some(c=>c.input.endsWith('/interaction-requests/durable-stop'))).toBe(true);
  });
  it.each([
    [true,true,true,'所有效果已静止；本地：已静止；远端停止：已确认'],
    [false,false,true,'仍有未证结束的效果；本地：尚未证实静止；远端停止：已确认'],
    [undefined,undefined,undefined,'总静止状态未知；本地：未知；远端停止：未知'],
  ])('renders Mac aggregate/local/remote facts independently (%s, %s, %s)',(quiescent,localQuiescent,remoteStopConfirmed,label)=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:{items:[]},meta:{}}),{status:200})));
    show(false,{...detail,core:'MACOS',native:{...detail.native!,engineId:'macos',state:'RECOVERY_REQUIRED',quiescent:quiescent as boolean|undefined,localQuiescent:localQuiescent as boolean|undefined,remoteStopConfirmed:remoteStopConfirmed as boolean|undefined}});
    expect(screen.getByText('效果核对：'+label)).toBeTruthy();
    expect(screen.getByText('原任务：native-1；原会话：session-1')).toBeTruthy();
  });
  it.each(['SUCCEEDED','RECOVERY_REQUIRED'])('keeps missing Mac execution facts unknown after %s',async state=>{
    vi.stubGlobal('fetch',vi.fn(async(input:string)=>new Response(JSON.stringify({data:input.endsWith('/metrics')?{native:{coverage:'NO_MODEL',usage:{}}}:{items:[]},meta:{}}),{status:200})));
    show(false,{...detail,core:'MACOS',native:{...detail.native!,engineId:'macos',state}});
    expect(screen.getByText('工作目录：来源未公开；基线：来源未公开')).toBeTruthy();
    expect(screen.getByText('程序：0.73.1；执行／推理信息：尚未报告，以来源实报为准')).toBeTruthy();
    await screen.findByText('来源报告 NO_MODEL；委派来源的用量须另按其实报核对。');
    expect(screen.queryByText(/工作目录：准备中/)).toBeNull();
    expect(screen.queryByText(/原生默认值，尚未报告/)).toBeNull();
    expect(screen.queryByText('来源报告本任务没有模型用量。')).toBeNull();
  });
  it('preserves reported Mac execution facts verbatim and keeps legacy fallbacks',()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:{items:[]},meta:{}}),{status:200})));
    const mac=show(false,{...detail,core:'MACOS',native:{...detail.native!,engineId:'macos',state:'SUCCEEDED',executionOptions:{model:'reported-provider/model'},workingDirectory:'public-workspace',baseCommit:'reported-revision'}});
    expect(screen.getByText('工作目录：public-workspace；基线：reported-revision')).toBeTruthy();
    expect(screen.getByText('程序：0.73.1；执行／推理信息：reported-provider/model')).toBeTruthy();
    mac.unmount();show();
    expect(screen.getByText('工作目录：准备中；基线：尚未报告')).toBeTruthy();
    expect(screen.getByText('程序：0.73.1；配置模型：原生默认值，尚未报告')).toBeTruthy();
  });
  it('shows no native write controls on a read-only surface',()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({data:{items:[]},meta:{}}),{status:200})));show(true);expect(screen.queryByText('停止原生任务')).toBeNull();expect(screen.queryByLabelText('原生任务补充')).toBeNull();
  });
});
