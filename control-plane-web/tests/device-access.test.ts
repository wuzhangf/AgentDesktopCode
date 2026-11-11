import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalGateway } from '../server/management/personal-control';

describe('mobile owner BFF fixed routes', () => {
  it('keeps native launch scopes exact when the ACS session catalog is unavailable', async () => {
    const dir=mkdtempSync(join(tmpdir(),'device-native-'));
    let accepted:unknown;
    const gateway=createPersonalGateway({dataDir:dir,connections:[{connectionId:'registered',kind:'ACS_DIRECT',baseUrl:'http://127.0.0.1:1',tokenRef:'env:TEST_OWNER'}],secretResolver:()=> 'test-owner-only',fetchImpl:(async(input,init)=>{
      const path=new URL(String(input)).pathname;
      if(path==='/api/v2/client-sessions')return Response.json({clientSessionId:'web-client',clientSessionToken:'registration-only-000000000000000000000000',storeId:'source-one',bootId:'boot',acceptedProtocols:['v2']});
      if(path.endsWith('/capabilities'))return Response.json({storeId:'source-one',resourceScopeVersion:2,localSource:{available:true,backendStoreId:'native-store',tasks:[{kind:'WORKER_LOCAL',backendStoreId:'native-store',taskId:'native-one',displayName:'Native task'}]}});
      if(path==='/api/v2/sessions')return Response.json({code:'MODEL_NOT_CONFIGURED'},{status:503});
      if(path.endsWith('/pairing-invitations')){accepted=JSON.parse(String(init?.body));return Response.json({inviteId:'invite-one'});}
      throw new Error('Unexpected owner route '+path);
    }) as typeof fetch});
    await new Promise<void>(resolve=>gateway.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${(gateway.server.address() as {port:number}).port}/api/personal/v1/device-access/registered`;
    const headers={'x-personal-control':'1','x-personal-tab':'native-tab','content-type':'application/json'};
    try {
      const caps=await fetch(base+'/capabilities',{headers});expect(caps.status).toBe(200);
      expect(await caps.json()).toMatchObject({sessions:[],localTasks:[{taskId:'native-one',backendStoreId:'native-store'}]});
      const scope={resources:[],launchScopes:[{backendStoreId:'native-store',projectId:'project-one',engineId:'codex'}],actions:['OBSERVE','LAUNCH']};
      const reply=await fetch(base+'/invitations',{headers,method:'POST',body:JSON.stringify({requestKey:'original-native',...scope})});
      expect(reply.status).toBe(201);expect(accepted).toEqual({requestId:'original-native',...scope});
    } finally {await gateway.close();rmSync(dir,{recursive:true,force:true});}
  });
  it('keeps owner secrets server-side, checks store and preserves exact scope request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'device-access-'));
    const calls: {method: string; path: string; body?: Record<string, unknown>}[] = [];
    let storeId = 'source-one';
    const upstream = async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-owner-only');
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({method: init?.method ?? 'GET', path, body});
      if (path === '/api/v2/client-sessions') return Response.json({clientSessionId:'web-client', clientSessionToken:'registration-only-000000000000000000000000', storeId:'source-one', bootId:'boot',acceptedProtocols:['v2']});
      if (path.includes('/personal-access/')) expect(new Headers(init?.headers).get('x-codeagent-client-token')).toBe('registration-only-000000000000000000000000');
      if (path.endsWith('/capabilities')) return Response.json({storeId, origin:'https://computer.example', enabled:true});
      if (path === '/api/v2/sessions') return Response.json([{sessionId:'s1', title:'真实任务', messages:[{content:'must not leak into list'}]}]);
      if (path.endsWith('/scope')) return Response.json({grantRevision:'2'});
      if (path.endsWith('/pairing-invitations')) return Response.json({schemaVersion:'personal-pairing-invite/1', inviteSecret:'ephemeral-invite'});
      return Response.json([]);
    };
    const gateway = createPersonalGateway({dataDir:dir, connections:[{connectionId:'registered',kind:'ACS_DIRECT',baseUrl:'http://127.0.0.1:1',tokenRef:'env:TEST_OWNER'}],secretResolver:()=> 'test-owner-only',fetchImpl:upstream as typeof fetch});
    await new Promise<void>(resolve => gateway.server.listen(0,'127.0.0.1',resolve));
    const base = `http://127.0.0.1:${(gateway.server.address() as {port:number}).port}/api/personal/v1/device-access`;
    const headers = {'x-personal-control':'1','x-personal-tab':'test-tab','content-type':'application/json'};
    try {
      const rejected = await fetch(base); expect(rejected.status).toBe(403);
      const listed = await fetch(base,{headers}); const list = await listed.text();
      expect(list).not.toContain('test-owner-only'); expect(list).not.toContain('tokenRef');
      const caps = await fetch(base+'/registered/capabilities',{headers});
      expect(caps.status).toBe(200); expect(await caps.json()).toMatchObject({sessions:[{sessionId:'s1',title:'真实任务'}]});
      const request = {requestKey:'scope-original',expectedGrantRevision:'1',sessions:['s1'],actions:['OBSERVE','INTERACT']};
      const updated = await fetch(base+'/registered/devices/device-one/scope',{method:'PUT',headers,body:JSON.stringify(request)});
      expect(updated.status).toBe(200); expect(calls.at(-1)).toMatchObject({method:'PUT',path:'/api/v2/personal-access/devices/device-one/scope',body:{requestId:'scope-original',expectedGrantRevision:'1',sessions:['s1'],actions:['OBSERVE','INTERACT']}});
      const bad = await fetch(base+'/registered/invitations',{method:'POST',headers,body:JSON.stringify({requestKey:'k',sessions:['s1'],actions:['OBSERVE'],baseUrl:'http://evil.example'})});
      expect(bad.status).toBe(400);
      storeId = 'different-store';
      const mismatch = await fetch(base+'/registered/devices',{headers});
      expect(mismatch.status).toBe(409); expect((await mismatch.json()).error.code).toBe('HOST_IDENTITY_CHANGED');
    } finally {await gateway.close(); rmSync(dir,{recursive:true,force:true});}
  });

  it('exposes only fixed ntfy owner controls and protected subscription material', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'device-notice-'));
    const calls: {method: string; path: string; body?: Record<string, unknown>}[] = [];
    const upstream = async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      calls.push({method: init?.method ?? 'GET', path, body});
      if (path === '/api/v2/client-sessions') return Response.json({clientSessionId:'web-client', clientSessionToken:'registration-only-000000000000000000000000', storeId:'source-one', bootId:'boot', acceptedProtocols:['v2']});
      if (path.endsWith('/capabilities')) return Response.json({storeId:'source-one', origin:'https://computer.example', enabled:true});
      if (path.endsWith('/notification-provider')) {
        if ((init?.method ?? 'GET') === 'PUT') return Response.json({providerRef:'ntfy', state:'READY', enabled:body?.enabled === true, revision:'2', credentialConfigured:true});
        return Response.json({providerRef:'ntfy', state:'READY', enabled:false, serverOrigin:'https://notify.example', revision:'1', credentialConfigured:true});
      }
      if (path.endsWith('/notification-routes')) return Response.json([{deviceGrantId:'device-one', providerRef:'ntfy', state:'DISABLED', enabled:false, grantRevision:'3'}]);
      if (path.endsWith('/notification-route')) return Response.json({deviceGrantId:'device-one', providerRef:'ntfy', state:'READY', enabled:true, grantRevision:'3', topicConfigured:true});
      if (path.endsWith('/notification-subscription')) return Response.json({schemaVersion:'personal-ntfy-subscription/1', providerRef:'ntfy', state:'READY', serverOrigin:'https://notify.example', topic:'private-topic', subscriptionToken:'read-only-token'});
      if (path.endsWith('/devices')) return Response.json([]);
      if (path.endsWith('/pairing-requests')) return Response.json([]);
      throw new Error('Unexpected owner route '+path);
    };
    const gateway = createPersonalGateway({dataDir:dir, connections:[{connectionId:'registered',kind:'ACS_DIRECT',baseUrl:'http://127.0.0.1:1',tokenRef:'env:TEST_OWNER'}], secretResolver:()=> 'test-owner-only', fetchImpl:upstream as typeof fetch});
    await new Promise<void>(resolve => gateway.server.listen(0,'127.0.0.1',resolve));
    const base = `http://127.0.0.1:${(gateway.server.address() as {port:number}).port}/api/personal/v1/device-access/registered`;
    const headers = {'x-personal-control':'1','x-personal-tab':'notice-tab','content-type':'application/json'};
    try {
      const provider = await fetch(base+'/notification-provider',{headers});
      expect(provider.status).toBe(200); expect(await provider.json()).toMatchObject({providerRef:'ntfy',serverOrigin:'https://notify.example'});
      const changed = await fetch(base+'/notification-provider',{method:'PUT',headers,body:JSON.stringify({requestKey:'provider-toggle',enabled:true,expectedRevision:'1'})});
      expect(changed.status).toBe(200);
      expect(calls.at(-1)).toMatchObject({method:'PUT',path:'/api/v2/personal-access/notification-provider',body:{requestId:'provider-toggle',enabled:true,expectedRevision:'1'}});
      expect(calls.at(-1)?.body).not.toHaveProperty('requestKey');
      const routes = await fetch(base+'/notification-routes',{headers}); expect(routes.status).toBe(200);
      const route = await fetch(base+'/devices/device-one/notification-route',{method:'PUT',headers,body:JSON.stringify({requestKey:'route-toggle',enabled:true,expectedGrantRevision:'3'})});
      expect(route.status).toBe(200);
      expect(calls.at(-1)).toMatchObject({method:'PUT',path:'/api/v2/personal-access/devices/device-one/notification-route',body:{requestId:'route-toggle',enabled:true,expectedGrantRevision:'3'}});
      const subscription = await fetch(base+'/devices/device-one/notification-subscription',{headers});
      expect(subscription.status).toBe(200); expect(await subscription.json()).toMatchObject({schemaVersion:'personal-ntfy-subscription/1',topic:'private-topic'});
      const forbidden = await fetch(base+'/notification-provider',{method:'PUT',headers,body:JSON.stringify({requestKey:'bad-provider',enabled:true,baseUrl:'https://evil.example'})});
      expect(forbidden.status).toBe(400);
    } finally {await gateway.close(); rmSync(dir,{recursive:true,force:true});}
  });
});
