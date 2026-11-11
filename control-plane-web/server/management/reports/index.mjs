// PAE P7 report submodule — public surface for P5 (repository adapter +
// management.db migration registration) and P8 (router mount).
//
//   createReportsRouter(deps).handle({method, pathname, searchParams, body})
//     → {status, body} | undefined (undefined = not a reports route)
//
// deps: { repository, outputDir, dataDir?, upstreamGateway?, providers?,
//         limits?, controlPlaneId?, instance?, now?, newId? }
//   repository        ReportsRepository (ports.mjs) — P5 sqlite adapter over
//                     the ddl.sql draft; tests may use createMemoryReportsRepository
//   outputDir         install-local report output root (real files, atomic writes)
//   dataDir           registered CSV/JSON data-sources directory (optional)
//   upstreamGateway   ReportSourceGateway — e.g. createServiceClientGateway(client)
//   providers         Record<ref, ReportProvider|null>: extra declared providers
//                     (null = declared but NOT configured — surfaced honestly)
export { createReportsRouter, REPORTS_ROUTES } from './router.mjs';
export { createReportsService, validateReportRequest } from './service.mjs';
export { createLocalReportProvider, parseSourceRef, ReportProviderError, REPORT_DOC_SCHEMA } from './local-provider.mjs';
export {
  createDataFileSource, createAnalysisSource, createServiceClientGateway,
  ReportSourceError, DEFAULT_LIMITS,
} from './sources.mjs';
export { createReportExecutor, ReportQueueFullError, ReportJobTimeoutError } from './executor.mjs';
export { createReportOutputStore, ReportOutputError } from './store.mjs';
export { createMemoryReportsRepository } from './repository-memory.mjs';
export { canonicalJson, digestOf, digestBytes, utcNow } from './canonical.mjs';
export {
  REPORT_STATE, KNOWN_REPORT_STATES, REPORT_OUTPUT_FORMAT, KNOWN_REPORT_OUTPUT_FORMATS,
  DEFAULT_REPORT_OUTPUT_FORMAT, LOCAL_PROVIDER_REF, LOCAL_PROVIDER_VERSION,
  LOCAL_REPORT_PROFILE, KNOWN_REPORT_PROFILES, REPORT_SOURCE_SCHEME,
  KNOWN_REPORT_SOURCE_SCHEMES, REPORT_DATA_SCOPE, REPORT_ERROR,
  META_ACTION_PROVIDER_PREFIX,
} from './ports.mjs';
