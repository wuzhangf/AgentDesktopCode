import { personalControlHeaders } from './client';
export interface DeviceConnection { connectionId: string; displayName: string }
export type DeviceResource = {kind:'ACS_SESSION';backendStoreId:string;sessionId:string} | {kind:'WORKER_LOCAL';backendStoreId:string;taskId:string};
export interface DeviceLaunchScope {backendStoreId:string;projectId:string;engineId:import('../../../codeagent-desktop/packages/protocol/src/native-task').NativeEngineId}
export interface DeviceGrant {
  deviceGrantId: string; label: string; grantRevision: string; state: string;
  sessions: string[]; actions: string[];
  resources?:DeviceResource[];launchScopes?:DeviceLaunchScope[];
}
export interface PairingRequest {
  pairingRequestId: string; label: string; state: string; checkWords: string;
  sessions: string[]; actions: string[];
  resources?:DeviceResource[];launchScopes?:DeviceLaunchScope[];
}
export interface DeviceCapabilities {
  origin: string; storeId: string; enabled: boolean; supportedActions?: string[];
  certificateNotAfter: number; certificateSha256: string;
  certificateNotBefore?:number;certificateNames?:[number,string][];bindAddress?:string;port?:number;
  sessions: { sessionId: string; title: string }[];
  resourceScopeVersion?:number;
  localTasks?:{kind:'WORKER_LOCAL';backendStoreId:string;taskId:string;displayName:string}[];
  localSource?:{available:boolean;reasonCode?:string;backendStoreId:string;projects:{projectId:string;displayName:string;headRevision:string;hasUncommittedChanges:boolean}[];engines:{engineId:import('../../../codeagent-desktop/packages/protocol/src/native-task').NativeEngineId;version:string}[]};
}
export type NotificationState = 'UNCONFIGURED'|'DISABLED'|'READY'|'DEGRADED'|'ERROR'|'REVOKED' | (string & {});
/** Safe provider projection. Credential refs and publish secrets never cross this type. */
export interface NotificationProviderStatus {
  providerRef: 'ntfy' | (string & {});
  state: NotificationState;
  enabled: boolean;
  serverOrigin?: string;
  credentialConfigured?: boolean;
  revision?: string;
  lastCheckedAt?: string | null;
  lastAcceptedAt?: string | null;
  lastErrorCode?: string | null;
}
export interface NotificationRouteStatus {
  deviceGrantId: string;
  providerRef: 'ntfy' | (string & {});
  state: NotificationState;
  enabled: boolean;
  grantRevision?: string;
  topicConfigured?: boolean;
  lastAcceptedAt?: string | null;
  lastErrorCode?: string | null;
  updatedAt?: string | null;
}
/** One-time, owner-protected subscription material. It may contain a read
 * credential for the paired ntfy client, never a publish credential. */
export interface NotificationSubscription {
  schemaVersion: 'personal-ntfy-subscription/1' | (string & {});
  providerRef: 'ntfy' | (string & {});
  state: NotificationState;
  serverOrigin?: string;
  topic?: string;
  subscriptionToken?: string;
  subscriptionUsername?: string;
  subscriptionPassword?: string;
  instructions?: string[];
  expiresAt?: string | null;
}
export function deviceNetworkFacts(caps:DeviceCapabilities,now=Date.now()) {
  let hostname='';try{hostname=new URL(caps.origin).hostname.replace(/^\[|\]$/g,'').toLowerCase();}catch{/* The source remains unavailable for trust review. */}
  const names=(caps.certificateNames??[]).filter(row=>[2,7].includes(row[0])&&typeof row[1]==='string');
  const canonical=(name:string)=>{try{return new URL(`https://${name.includes(':')?'['+name+']':name}`).hostname.replace(/^\[|\]$/g,'').toLowerCase();}catch{return name.toLowerCase();}};
  const ipHost=hostname.includes(':')||/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname);
  const nameMatches=names.length===0?null:names.some(([kind,name])=>{
    if(kind===7)return ipHost&&canonical(name)===canonical(hostname);
    if(ipHost)return false;
    const dns=name.toLowerCase();return dns===hostname || dns.startsWith('*.')&&hostname.endsWith(dns.slice(1))&&hostname.split('.').length===dns.split('.').length;
  });
  const loopback=(host:string)=>host==='localhost'||host==='::1'||/^127\./.test(host);
  return {hostname,names:names.map(row=>row[1]),nameMatches,
    certificateTimeValid:caps.certificateNotBefore==null?null:Number.isFinite(caps.certificateNotBefore)&&Number.isFinite(caps.certificateNotAfter)&&caps.certificateNotBefore<=now&&now<caps.certificateNotAfter,
    loopbackOrigin:loopback(hostname),loopbackBind:caps.bindAddress!=null&&loopback(caps.bindAddress.replace(/^\[|\]$/g,'')),
  };
}
export async function deviceAccess<T>(connection?: string, operation: 'connections' | 'capabilities' | 'devices' | 'pairing-requests' | 'invitations' | 'decide' | 'revoke' | 'scope' | 'notification-provider' | 'notification-provider-update' | 'notification-routes' | 'notification-route' | 'notification-route-update' | 'notification-subscription' = 'connections', body?: Record<string, unknown>, target?: string): Promise<T> {
  const valid = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
  if (connection && !valid(connection) || target && !valid(target)) throw new Error('无效来源');
  const root = '/api/personal/v1/device-access' + (connection ? '/' + connection : '');
  const routes = {
    connections: ['GET', root], capabilities: ['GET', root + '/capabilities'],
    devices: ['GET', root + '/devices'], 'pairing-requests': ['GET', root + '/pairing-requests'],
    invitations: ['POST', root + '/invitations'], decide: ['POST', `${root}/pairing-requests/${target}/decisions`],
    revoke: ['DELETE', `${root}/devices/${target}`], scope: ['PUT', `${root}/devices/${target}/scope`],
    'notification-provider': ['GET', root + '/notification-provider'],
    'notification-provider-update': ['PUT', root + '/notification-provider'],
    'notification-routes': ['GET', root + '/notification-routes'],
    'notification-route': ['GET', `${root}/devices/${target}/notification-route`],
    'notification-route-update': ['PUT', `${root}/devices/${target}/notification-route`],
    'notification-subscription': ['GET', `${root}/devices/${target}/notification-subscription`],
  } as const;
  const [method, path] = routes[operation];
  const response = await fetch(path, {method, credentials: 'same-origin', cache: 'no-store',
    headers: {...personalControlHeaders(), 'content-type': 'application/json'},
    body: body ? JSON.stringify(body) : undefined});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.code ?? '连接未完成');
  return result as T;
}
