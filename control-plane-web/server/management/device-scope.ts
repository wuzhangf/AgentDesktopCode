import {supportedNativeEngine} from '../../../codeagent-desktop/packages/protocol/src/native-task';
import {invalid} from './errors';
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
/** Structural owner DTO validation. The source alone verifies existence and grant CAS. */
export function deviceScopeFields(body:Record<string,unknown>):Record<string,unknown>{
  const actions=body.actions;
  if(!Array.isArray(actions)||!actions.includes('OBSERVE')||actions.some(a=>!['OBSERVE','CONTROL','INTERACT','APPROVE','POLICY','ASSIGN','COLLABORATE','ADOPT','LAUNCH','GRAPHICS_OBSERVE','GRAPHICS_CAPTURE','GRAPHICS_ACT'].includes(a)))return invalid('Explicit device actions required');
  if(actions.includes('GRAPHICS_ACT')&&!actions.includes('CONTROL'))return invalid('GRAPHICS_ACT requires CONTROL');
  if(actions.some(a=>String(a).startsWith('GRAPHICS_'))&&body.resources===undefined)return invalid('Graphics requires exact native scopes');
  if(body.resources!==undefined){
    if(body.sessions!==undefined||!Array.isArray(body.resources)||body.resources.length>100)return invalid('Exact resources required');
    for(const r of body.resources){if(!object(r)||!keys(r,['kind','backendStoreId','sessionId','taskId'])||!id(r.backendStoreId)||!(r.kind==='ACS_SESSION'&&id(r.sessionId)&&r.taskId===undefined||r.kind==='WORKER_LOCAL'&&id(r.taskId)&&r.sessionId===undefined))return invalid('Invalid source resource');}
    const launchScopes=body.launchScopes??[];
    if(!Array.isArray(launchScopes)||launchScopes.length>100||launchScopes.some(s=>!object(s)||!keys(s,['backendStoreId','projectId','engineId'])||!id(s.backendStoreId)||!id(s.projectId)||!supportedNativeEngine(s.engineId)))return invalid('Invalid project engine scope');
    if((launchScopes.length>0)!==actions.includes('LAUNCH')||!body.resources.length&&!launchScopes.length)return invalid('LAUNCH needs explicit project engine scope');
    return {resources:body.resources,launchScopes,actions};
  }
  if(body.launchScopes!==undefined||!Array.isArray(body.sessions)||!body.sessions.length||body.sessions.length>100||!body.sessions.every(id)||actions.includes('LAUNCH'))return invalid('Explicit ACS sessions required');
  return {sessions:body.sessions,actions};
}
