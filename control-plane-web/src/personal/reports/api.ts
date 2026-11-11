// PAE P7 reports page — typed client for the frozen /api/personal/v1/reports*
// surface (P0 §4; shapes owned by protocol/personal.ts, imported type-only).
// P8 mount note: this leaf delegates to the shared PersonalGateway port
// (../port) so the page works identically on all resolved surfaces —
// same-origin fetch (with the P5 gateway's x-personal-control/x-personal-tab
// guard headers), the Desktop `app/personal` IPC bridge, and ?demo=1 fixture
// transport. The page still submits only registered refs/keys — never URLs,
// host paths or credentials.
import type {
  PersonalEnvelope, ReportDescriptor, PersonalReportFile,
  PersonalReportInput, PersonalProjectView,
} from '../../../../codeagent-desktop/packages/protocol/src/personal';
import { resolvePersonalSurface, type PersonalGateway } from '../port';

// Same lazily-resolved gateway the rest of the personal shell uses
// (resolvePersonalSurface reads ?demo/?readonly and the desktop bridge once).
let gateway: PersonalGateway | undefined;
function reportsGateway(): PersonalGateway {
  return (gateway ??= resolvePersonalSurface().gateway);
}

export function listReports(signal?: AbortSignal): Promise<PersonalEnvelope<ReportDescriptor[]>> {
  void signal; // gateway transport has no abort seam yet — polling only.
  return reportsGateway().listReports();
}

export function getReport(reportId: string): Promise<PersonalEnvelope<ReportDescriptor>> {
  return reportsGateway().getReport(reportId);
}

export function listReportFiles(reportId: string): Promise<PersonalEnvelope<PersonalReportFile[]>> {
  return reportsGateway().listReportFiles(reportId);
}

export function createReport(input: PersonalReportInput): Promise<PersonalEnvelope<ReportDescriptor>> {
  // requestKey passthrough keeps the page's displayed key identical to the
  // body key and the Idempotency-Key header (freeze §4 write semantics).
  return reportsGateway().createReport(input);
}

/** Optional: project list for sourceRef suggestions. Belongs to the same
 * frozen surface (P5 mounts it); failure degrades to free-text input. */
export function listProjects(): Promise<PersonalEnvelope<PersonalProjectView[]>> {
  return reportsGateway().listProjects();
}
