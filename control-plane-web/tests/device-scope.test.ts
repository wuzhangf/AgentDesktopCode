import {it,expect} from 'vitest';
import {deviceScopeFields} from '../server/management/device-scope';
it('preserves exact tagged native scope and refuses unbounded launch or mixed legacy shape',()=>{
  const scope={resources:[{kind:'WORKER_LOCAL',backendStoreId:'native-store',taskId:'native-one'}],launchScopes:[{backendStoreId:'native-store',projectId:'project-one',engineId:'pi'}],actions:['OBSERVE','LAUNCH','CONTROL']};
  expect(deviceScopeFields(scope)).toEqual(scope);
  expect(()=>deviceScopeFields({...scope,sessions:['legacy']})).toThrow();
  expect(()=>deviceScopeFields({...scope,launchScopes:[]})).toThrow();
  expect(()=>deviceScopeFields({...scope,resources:[{kind:'WORKER_LOCAL',backendStoreId:'native-store',taskId:'native-one',url:'http://unregistered'}]})).toThrow();
  expect(()=>deviceScopeFields({sessions:['legacy'],actions:['OBSERVE','LAUNCH']})).toThrow();
});

it('explicitly adopts Mac scope without widening actions or accepting unknown engines',()=>{
  const scope={resources:[],launchScopes:[{backendStoreId:'mac-store',projectId:'apple-project',engineId:'macos'}],actions:['OBSERVE','LAUNCH']};
  expect(deviceScopeFields(scope)).toEqual(scope);
  expect(()=>deviceScopeFields({...scope,actions:['OBSERVE']})).toThrow();
  expect(()=>deviceScopeFields({...scope,launchScopes:[{...scope.launchScopes[0],engineId:'future'}]})).toThrow();
});

it('does not upgrade ordinary observation/control into graph rights and requires explicit ACT control',()=>{
 const scope={resources:[{kind:'WORKER_LOCAL',backendStoreId:'mac-store',taskId:'native-graphics'}],launchScopes:[{backendStoreId:'mac-store',projectId:'registered-graphics',engineId:'macos'}]};
 expect(deviceScopeFields({...scope,actions:['OBSERVE','CONTROL','LAUNCH']})).toMatchObject({actions:['OBSERVE','CONTROL','LAUNCH']});
 expect(deviceScopeFields({...scope,actions:['OBSERVE','CONTROL','LAUNCH','GRAPHICS_OBSERVE','GRAPHICS_CAPTURE','GRAPHICS_ACT']})).toHaveProperty('actions');
 expect(()=>deviceScopeFields({...scope,actions:['OBSERVE','LAUNCH','GRAPHICS_ACT']})).toThrow();
 expect(()=>deviceScopeFields({sessions:['acs'],actions:['OBSERVE','GRAPHICS_OBSERVE']})).toThrow();
});

it('persistent policy management is explicit and does not follow ordinary approval rights',()=>{
 const ordinary={sessions:['session-one'],actions:['OBSERVE','APPROVE','CONTROL']};
 expect(deviceScopeFields(ordinary).actions).not.toContain('POLICY');
 const managed={...ordinary,actions:[...ordinary.actions,'POLICY']};
 expect(deviceScopeFields(managed)).toEqual(managed);
 expect(()=>deviceScopeFields({...managed,actions:['OBSERVE','AUTO_WHITELIST']})).toThrow();
});
