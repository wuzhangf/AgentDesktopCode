import { resolve } from 'node:path';
import { createPersonalGateway } from './personal-control';
import { createServiceClientGateway } from './reports/index.mjs';
import { ServiceClient } from '../../../codeagent-desktop/packages/service-client/src/index';
import type { ConnectionProvision } from './upstream';
import type { PersonalConnectionKind } from '../../../codeagent-desktop/packages/protocol/src/personal';

export function personalInstall(dataDir: string, dist: string) {
const connections: ConnectionProvision[] = [];
if (process.env.PERSONAL_ACS_URL) {
  const kind = (process.env.PERSONAL_ACS_KIND ?? 'ACS_DIRECT') as PersonalConnectionKind;
  if (!['ACS_DIRECT', 'CORE_LOCAL'].includes(kind)) {
    throw new Error('PERSONAL_ACS_KIND must be ACS_DIRECT or CORE_LOCAL');
  }
  connections.push({
    connectionId: 'acs-local',
    kind,
    displayName: kind === 'CORE_LOCAL' ? 'Local core service' : 'Attached ACS service',
    baseUrl: process.env.PERSONAL_ACS_URL,
    tokenRef: 'env:PERSONAL_ACS_TOKEN',
  });
}
if (process.env.PERSONAL_ENV_URL) {
  connections.push({
    connectionId: 'worker-daemon',
    kind: 'DAEMON',
    displayName: 'Local worker daemon',
    envBaseUrl: process.env.PERSONAL_ENV_URL,
    envTokenRef: 'env:PERSONAL_ENV_TOKEN',
  });
}
if(process.env.PERSONAL_WORKER_LOCAL_URL){
  connections.push({connectionId:'native-local',kind:'WORKER_LOCAL',displayName:'Local native agent',baseUrl:process.env.PERSONAL_WORKER_LOCAL_URL,tokenRef:'env:WORKER_LOCAL_TOKEN'});
}
for(const [key,url] of Object.entries(process.env)){
  const match=/^PERSONAL_WORKER_LOCAL_URL_([A-Z][A-Z0-9_]*)$/.exec(key);
  if(match&&url) connections.push({connectionId:`native-${match[1].toLowerCase().replace(/_/g,'-')}`,kind:'WORKER_LOCAL',displayName:`Local native agent (${match[1].toLowerCase()})`,baseUrl:url,tokenRef:'env:WORKER_LOCAL_TOKEN'});
}
if (!connections.length) {
  console.warn('[personal] no upstream connections provisioned (set PERSONAL_ACS_URL / PERSONAL_ENV_URL); serving registry-only mode');
}

// P8 mount: the real P7 reports surface — sqlite repository over
// management.db (p7-reports migration), local deterministic provider and the
// data: file source always on; project:/delivery:/run:/session: refs resolve
// through the provisioned ACS ServiceClient (absent → REPORT_SOURCE_UNAVAILABLE).
const reportsOutputDir = resolve(process.env.PERSONAL_REPORTS_DIR ?? resolve(dataDir, 'reports'));
const reportsDataDir = resolve(process.env.PERSONAL_REPORTS_DATA_DIR ?? resolve(dataDir, 'report-sources'));
let reportsGateway: unknown;
if (process.env.PERSONAL_ACS_URL && process.env.PERSONAL_ACS_TOKEN) {
  reportsGateway = createServiceClientGateway(new ServiceClient({
    baseUrl: process.env.PERSONAL_ACS_URL,
    token: process.env.PERSONAL_ACS_TOKEN,
  }));
} else if (process.env.PERSONAL_ACS_URL) {
  console.warn('[personal] PERSONAL_ACS_TOKEN unset — analysis report sources stay unconfigured');
}

return createPersonalGateway({
  dataDir, connections, dist,
  observationSourceId: process.env.PERSONAL_OBSERVATION_SOURCE_ID,
  observationScopeId: process.env.PERSONAL_OBSERVATION_SCOPE_ID,
  reports: process.env.PERSONAL_REPORTS_ENABLED === '0' ? undefined : {
    outputDir: reportsOutputDir,
    dataDir: reportsDataDir,
    upstreamGateway: reportsGateway,
  },
});
}
