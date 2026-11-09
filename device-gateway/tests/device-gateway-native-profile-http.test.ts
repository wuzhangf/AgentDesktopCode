/** PAC HTTPS consumer → real Devices/LocalTaskAccess → fixture Host HTTP. No model execution. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildContext, type BuiltGateway } from '../src/gateway-main.js';
import { createGatewayListener } from '../src/http.js';
import { provisionTlsMaterial } from '../src/tls.js';
import { hash, secret } from '../src/protocol.js';

type Json = Record<string, any>;
const baseCaps = ['mac.files.list', 'mac.files.read', 'mac.files.write'];
const method = { schemaVersion:'mac-method-binding/1', methodId:'material-report', revision:'1.0.2',
  displayName:'材料报告', requiredCapabilities:baseCaps, instructionsSHA256:'a'.repeat(64) };
const secondMethod = { ...method, methodId:'document-checklist', revision:'1.0.0', displayName:'文档清单' };
const preflight = { projectId:'office', engineId:'macos', optionsRevision:'options-1', profileId:'MAC_MANAGED',
  profileHome:null, loadsUserExtensions:false, workingCopyPolicy:'TASK_OWNED_OUTPUT', headRevision:null,
  treeRevision:null, hasUncommittedChanges:false, macProfile:{ recipeID:'mac.native-work/1',
    protocolVersion:'mac-native-capabilities/1', kind:'OFFICE_WORKSPACE', availability:'AVAILABLE',
    engines:['EXTERNAL_TOOLS','OWNED_FRAMEWORK'], catalogDigest:'b'.repeat(64),
    models:[{modelRef:'service/text',displayName:'Registered text',imageInput:false,apiKey:'PRIVATE_MODEL_KEY',service:{baseURL:'https://private.invalid'}},
      {modelRef:'service/image',displayName:'Registered image',imageInput:true,headers:{Authorization:'PRIVATE_MODEL_KEY'}},
      {modelRef:'bad',displayName:'bad',imageInput:{secret:'PRIVATE_MODEL_KEY'}}],
    methods:[{...method, instructions:'PRIVATE_METHOD_INSTRUCTIONS',path:'/private/runtime/method.md'},secondMethod], defaultMethod:method,
    nativeActionsAvailable:false, reviewAvailable:true, continuousIndexAvailable:true, memoryAvailable:true, engineeringAvailable:true,
    optionalCapabilities:['mac.office.organize','mac.mcp.invoke',{capabilityId:'PRIVATE_CAPABILITY_OBJECT'}],
    runtimeDigest:'c'.repeat(64), extensionDigest:'d'.repeat(64), workspaceBinding:'e'.repeat(64),
    workspaceIdentity:'123:456', workspaceRoot:'/private/workspace', runtimeBinding:{path:'/private/runtime'},
    templates:[{path:'/private/template'}] } };
async function close(server: Server) { await new Promise<void>(resolve=>server.close(()=>resolve())); }

it('preserves public Mac choices and existing NativeWorkSpec contracts over PAC HTTPS', async()=>{
  const root = mkdtempSync(join(tmpdir(),'gateway-native-profile-'));
  let built: BuiltGateway | undefined; let pac: Server | undefined;
  const creates: Json[] = [];
  const host = createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.headers.authorization!=='Bearer fixture-host-token'){res.writeHead(401);res.end('{}');return;}
    let text='';for await(const chunk of req)text+=chunk;
    const body=text?JSON.parse(text):{};
    if(req.url==='/local/v1/identity'){res.end(JSON.stringify({storeId:'mac-store',storeGuard:'HEADER_V1'}));return;}
    if(req.url==='/worker-host/v1/manifest'){res.end(JSON.stringify({contracts:['mac-native-capabilities/1','mac-native-documents/1']}));return;}
    if(req.url==='/local/v1/task-preflights'){res.end(JSON.stringify(preflight));return;}
    if(req.url==='/local/v1/tasks'){
      creates.push(body);res.end(JSON.stringify({taskId:'native-'+creates.length,engineId:'macos',profileId:'MAC_MANAGED',nativeWorkSpec:body.nativeWorkSpec}));return;
    }
    res.writeHead(404);res.end('{"code":"NOT_FOUND"}');
  });
  try {
    await new Promise<void>(resolve=>host.listen(0,'127.0.0.1',resolve));
    const tls=provisionTlsMaterial(join(root,'tls'),{commonName:'localhost'});
    built=buildContext({dataDir:join(root,'store'),storeKey:randomBytes(32),tls,bind:'127.0.0.1',port:9443,
      ownerBind:'127.0.0.1',ownerPort:0,ownerToken:'fixture-owner',ownerClientToken:'fixture-client',
      workerLocal:{connectionId:'this-mac',url:`http://127.0.0.1:${(host.address() as AddressInfo).port}`,token:'fixture-host-token'},
      allowUnlicensedDevelopment:true});
    // Use the real isolated pairing state machine; no fake GatewayAuth or existing grant.
    const inv=built.devices.invitationResources('invite-1',[],[{backendStoreId:'mac-store',projectId:'office',engineId:'macos'}],['OBSERVE','CONTROL','INTERACT','LAUNCH'],'fixture-pin');
    const poll=secret();built.devices.request({pairingRequestId:'pair-1',inviteId:inv.inviteId,inviteSecret:inv.inviteSecret,
      pollingSecretHash:hash(poll),installationId:'fixture-phone',label:'Fixture phone'});
    built.devices.decide('pair-1',true);const issued=built.devices.redeem('pair-1',poll,'redeem-1');
    pac=createGatewayListener({tls,ctx:built.ctx,bind:'127.0.0.1',port:0});
    await new Promise<void>(resolve=>pac!.listen(0,'127.0.0.1',resolve));
    let serial=0;
    async function post(tail:string,body:Json,key?:string,bearer=issued.accessToken as string){
      const port=(pac!.address() as AddressInfo).port;
      return await new Promise<{status:number;body:Json;text:string}>((resolve,reject)=>{
        const request=https.request({hostname:'127.0.0.1',port,path:'/personal/v1/local-tasks/mac-store/'+tail,method:'POST',ca:tls.cert,
          headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})}},res=>{
          let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(text),text}));});
        request.on('error',reject);request.end(JSON.stringify(body));
      });
    }
    const options=await post('task-preflights',{projectId:'office',engineId:'macos'});
    expect(options.status).toBe(200);
    expect(options.body.macProfile.models).toEqual([
      {modelRef:'service/text',displayName:'Registered text',imageInput:false},
      {modelRef:'service/image',displayName:'Registered image',imageInput:true}]);
    expect(options.body.macProfile.methods).toEqual([method,secondMethod]);expect(options.body.macProfile.defaultMethod).toEqual(method);
    expect(options.body.macProfile).toMatchObject({nativeActionsAvailable:false,continuousIndexAvailable:true,memoryAvailable:true,
      reviewAvailable:true,engineeringAvailable:true,optionalCapabilities:['mac.office.organize','mac.mcp.invoke']});
    for(const privateValue of ['PRIVATE_', '/private/', 'workspaceIdentity', 'runtimeBinding','templates','baseURL','apiKey','headers']) expect(options.text).not.toContain(privateValue);
    expect((await post('task-preflights',{projectId:'office',engineId:'macos'},undefined,'invalid-token')).status).toBe(401);
    const base:Json={schemaVersion:'mac-native-work-spec/1',recipeID:'mac.native-work/1',workspaceRef:'office',goal:'Prepare report',
      engine:'EXTERNAL_TOOLS',requiredCapabilities:baseCaps,acceptance:[{name:'report.txt',containsText:'complete'}]};
    const owned:Json={...base,engine:'OWNED_FRAMEWORK',modelRef:'service/image',method:{methodId:'material-report',revision:'1.0.2'},
      preferences:[{frameId:'preference-1',text:'保留来源页码',userConfirmed:true}],
      requiredCapabilities:[...baseCaps,'mac.images.observe','mac.research.review','mac.research.engineering']};
    const continuous:Json={...base,requiredCapabilities:['mac.files.list','mac.files.write','mac.office.organize'],acceptance:[],
      continuousIndex:{maximumVersions:64,durationSeconds:1800}};
    async function create(spec:Json){const key='create-'+(++serial);return await post('tasks',{requestKey:key,projectId:'office',engineId:'macos',
      optionsRevision:'options-1',instruction:spec.goal,nativeWorkSpec:spec},key);}
    for(const spec of [base,owned,continuous]){
      const result=await create(spec);expect(result.status).toBe(200);expect(result.body.state).toBe('OBSERVED');
      expect(creates.at(-1)!.nativeWorkSpec).toEqual(spec);expect(result.body.source.nativeWorkSpec).toEqual(spec);
    }
    const invalid:Json[]=[{...base,unknown:'x'}, {...owned,method:{methodId:'owner-path',revision:'1.0.2'}},
      {...owned,method:{...owned.method,path:'/private/method'}}, {...owned,method:{methodId:'material-report',revision:'latest'}},
      {...base,method:owned.method}, {...owned,preferences:[{...owned.preferences[0],userConfirmed:false}]},
      {...owned,preferences:[{...owned.preferences[0],text:' '.repeat(3)}]}, {...owned,preferences:[{...owned.preferences[0],text:'界'.repeat(667)}]},
      {...owned,preferences:[owned.preferences[0],owned.preferences[0]]}, {...owned,preferences:[{...owned.preferences[0],path:'/private'}]},
      {...base,preferences:[]}, {...owned,preferences:Array.from({length:9},(_,i)=>({...owned.preferences[0],frameId:'pref-'+i}))}, {...base,requiredCapabilities:[...baseCaps,'mac.images.observe']},
      {...base,requiredCapabilities:[...baseCaps,'mac.files.list']}, {...base,requiredCapabilities:['mac.unknown']},
      {...base,acceptance:[]}, {...base,acceptance:[base.acceptance[0],base.acceptance[0]]},
      {...continuous,continuousIndex:{maximumVersions:65,durationSeconds:1800}}, {...continuous,continuousIndex:{maximumVersions:1,durationSeconds:0}},
      {...continuous,continuousIndex:{maximumVersions:1.5,durationSeconds:10}}, {...continuous,continuousIndex:{maximumVersions:true,durationSeconds:10}},
      {...continuous,continuousIndex:{maximumVersions:1,durationSeconds:10,root:'/private'}},
      {...continuous,modelRef:'service/text'}, {...continuous,engine:'OWNED_FRAMEWORK',modelRef:'service/text'},
      {...continuous,requiredCapabilities:['mac.files.list','mac.files.write']}, {...continuous,requiredCapabilities:[...continuous.requiredCapabilities,'mac.documents.extract']}];
    for(const spec of invalid){const result=await create(spec);expect(result.status).toBe(400);expect(result.body.code).toBe('INVALID_NATIVE_WORK_SPEC');}
    expect(creates).toHaveLength(3);
  } finally {
    if(pac)await close(pac);built?.store.close();await close(host);rmSync(root,{recursive:true,force:true});
  }
});
