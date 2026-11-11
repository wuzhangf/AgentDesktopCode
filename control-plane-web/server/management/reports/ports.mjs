// PAE P7 report seams: narrow ports + module-owned vocabularies.
//
// This directory is the single owner of the reports submodule
// (task list §3 owner table). P5 owns server/management/** otherwise and
// registers the management.db migrations; it adapts `ReportsRepository`
// (below) onto that database. P8 mounts `createReportsRouter` from
// ./index.mjs. Nothing here opens a second database, reads env files or
// stores credential values — only refs/digests.
//
// Wire contract (frozen, P0 §4): personal.ts ReportDescriptor /
// PersonalReportRequest / PersonalReportFile. This module adds NO wire
// fields; everything below is server-internal.

// ---------------------------------------------------------------------------
// Report state vocabulary (ReportDescriptor.state is an open string in the
// frozen contract; this module freezes its own values and documents them).
// READY = result files written + digests recorded; nothing else claims done.
// FAILED/UNKNOWN are written only by this module: FAILED when the provider
// returned a proven failure, UNKNOWN when an in-flight job was interrupted
// and its effect cannot be proven (e.g. restart mid-RUNNING for a provider
// that does not support safe requeue).
export const REPORT_STATE = Object.freeze({
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  READY: 'READY',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});
export const KNOWN_REPORT_STATES = Object.freeze(Object.values(REPORT_STATE));

// Output formats this build supports (PersonalReportRequest.outputFormat is
// an open string in the contract; unknown values are rejected, not coerced).
export const REPORT_OUTPUT_FORMAT = Object.freeze({
  MARKDOWN_JSON: 'markdown+json',
  MARKDOWN: 'markdown',
  JSON: 'json',
});
export const KNOWN_REPORT_OUTPUT_FORMATS = Object.freeze(Object.values(REPORT_OUTPUT_FORMAT));
export const DEFAULT_REPORT_OUTPUT_FORMAT = REPORT_OUTPUT_FORMAT.MARKDOWN_JSON;

// The local deterministic provider is built in and always configured.
export const LOCAL_PROVIDER_REF = 'local';
export const LOCAL_PROVIDER_VERSION = 'local-report-provider/v1';

// Report profiles shipped in this build. reportProfileRef is validated
// against this list; unknown profile refs are rejected, never substituted.
export const LOCAL_REPORT_PROFILE = 'local/summary';
export const KNOWN_REPORT_PROFILES = Object.freeze([LOCAL_REPORT_PROFILE]);

// sourceRef scheme vocabulary. `data:` resolves to a file registered inside
// the configured data-sources directory (install-side placement, never an
// upload); the analysis schemes resolve through ReportSourceGateway, which
// P5 backs with ServiceClient public deliveries/projects/run APIs.
export const REPORT_SOURCE_SCHEME = Object.freeze({
  DATA: 'data',
  PROJECT: 'project',
  DELIVERY: 'delivery',
  RUN: 'run',
  SESSION: 'session',
});
export const KNOWN_REPORT_SOURCE_SCHEMES = Object.freeze(Object.values(REPORT_SOURCE_SCHEME));

// dataScope tokens the local provider understands and honours. The contract
// carries dataScope as a free string[] (user-chosen scope for external
// providers); locally these tokens change the rendered output and are
// always echoed back verbatim so the declared scope is auditable.
//   SUMMARY_ONLY  — aggregate output only; no record-level samples (default
//                   behaviour when dataScope is absent)
//   SAMPLE_ROWS   — include a bounded first-N record sample in outputs
//   INCLUDE_SCHEMA— include per-column/field type and distinct-value detail
export const REPORT_DATA_SCOPE = Object.freeze({
  SUMMARY_ONLY: 'SUMMARY_ONLY',
  SAMPLE_ROWS: 'SAMPLE_ROWS',
  INCLUDE_SCHEMA: 'INCLUDE_SCHEMA',
});

// Machine codes used in {error:{code}} responses and ReportDescriptor.error.
export const REPORT_ERROR = Object.freeze({
  // request-level (HTTP response codes)
  BAD_REQUEST: 'BAD_REQUEST',                    // 400 malformed/unknown field
  NOT_FOUND: 'NOT_FOUND',                        // 404 report id
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',  // 409 same requestKey, different body
  REPORT_PROVIDER_UNKNOWN: 'REPORT_PROVIDER_UNKNOWN',            // 400 ref not declared
  REPORT_PROVIDER_NOT_CONFIGURED: 'REPORT_PROVIDER_NOT_CONFIGURED', // 503 declared, no impl
  REPORT_SOURCE_UNKNOWN: 'REPORT_SOURCE_UNKNOWN',                // 400 bad scheme/ref
  REPORT_SOURCE_UNAVAILABLE: 'REPORT_SOURCE_UNAVAILABLE',        // 503 upstream not wired
  REPORT_QUEUE_FULL: 'REPORT_QUEUE_FULL',                        // 429 bounded executor
  // job-level (ReportDescriptor.error.code, surfaced inside 200 envelope)
  SOURCE_READ_FAILED: 'SOURCE_READ_FAILED',
  SOURCE_TOO_LARGE: 'SOURCE_TOO_LARGE',
  RENDER_FAILED: 'RENDER_FAILED',
  OUTPUT_WRITE_FAILED: 'OUTPUT_WRITE_FAILED',
  JOB_TIMEOUT: 'JOB_TIMEOUT',
  PROVIDER_FAILED: 'PROVIDER_FAILED',
  EFFECT_UNKNOWN: 'EFFECT_UNKNOWN', // reused frozen reasonCode (freeze §2)
});

// Meta advertisement: configured providers surface as REPORT_PROVIDER:<ref>
// inside PersonalMeta.supportedActions so the page renders a REAL provider
// list instead of a hard-coded one. Declared-but-unconfigured providers set
// REPORT_PROVIDER_NOT_CONFIGURED in meta.reasonCodes.
export const META_ACTION_PROVIDER_PREFIX = 'REPORT_PROVIDER:';

/**
 * ReportsRepository — the ONLY persistence seam. P5 implements this on
 * management.db using ddl.sql; every method may return the value or a
 * Promise of it (callers always await). All records are plain JSON-safe
 * objects; timestamps are UTC RFC-3339 strings.
 *
 * @typedef {object} ReportRecord
 * @property {string} reportId          PK, PERSONAL_ID_PATTERN
 * @property {string} requestKey        original idempotency key (unique)
 * @property {string} bodyDigest        sha256 of canonical request body
 * @property {string} sourceRef
 * @property {string|null} sourceVersion
 * @property {string|null} sourceDigest        caller-declared pin (may be null)
 * @property {string|null} resolvedSourceDigest digest of the facts actually read
 * @property {string|null} sourceWatermark     source freshness marker (mtime/updatedAt/max endedAt)
 * @property {string|null} reportProfileRef
 * @property {string} providerRef
 * @property {string} outputFormat
 * @property {string[]|null} dataScope
 * @property {string} state              REPORT_STATE
 * @property {string|null} errorCode
 * @property {string|null} errorMessage
 * @property {string|null} resultDigest  digest of the canonical report.json
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {object} ReportFileRecord
 * @property {string} fileId      PK
 * @property {string} reportId    FK → report_request.report_id
 * @property {string} name        output file name (report.md / report.json)
 * @property {string} mediaType
 * @property {number} sizeBytes
 * @property {string} digest      sha256 of file bytes
 * @property {string} relPath     path relative to reports output dir
 * @property {string} createdAt
 *
 * @typedef {object} ReportPreferencesRecord
 * @property {string} ownerKey    install-local owner ('default')
 * @property {string|null} lastProviderRef
 * @property {string|null} lastProfileRef
 * @property {string|null} lastOutputFormat
 * @property {string[]|null} lastDataScope
 * @property {string} updatedAt
 *
 * @typedef {object} SubscriptionDraftRecord
 * @property {string} draftId
 * @property {string} ownerKey
 * @property {string} sourceRef
 * @property {string|null} reportProfileRef
 * @property {string} cadence     intent only ('once'|'daily'|'weekly') — never scheduled
 * @property {string|null} note
 * @property {boolean} enabled    forced false by the service; UI shows 未启用
 * @property {string} createdAt
 * @property {string} updatedAt
 *
 * @typedef {object} ReportsRepository
 * @property {(rec: ReportRecord) => unknown} putReportRequest          insert-or-fail on first persist
 * @property {(requestKey: string) => ReportRecord|null|Promise<ReportRecord|null>} findReportByRequestKey
 * @property {(reportId: string) => ReportRecord|null|Promise<ReportRecord|null>} getReport
 * @property {(reportId: string, patch: Partial<ReportRecord>) => unknown} updateReport
 * @property {(query: {limit?: number, requestKey?: string, state?: string}) => ReportRecord[]|Promise<ReportRecord[]>} listReports
 * @property {(rec: ReportFileRecord) => unknown} putReportFile          insert-or-replace by fileId
 * @property {(reportId: string) => ReportFileRecord[]|Promise<ReportFileRecord[]>} listReportFiles
 * @property {(ownerKey: string) => ReportPreferencesRecord|null|Promise<ReportPreferencesRecord|null>} getReportPreferences
 * @property {(ownerKey: string, prefs: ReportPreferencesRecord) => unknown} putReportPreferences upsert
 * @property {(draft: SubscriptionDraftRecord) => unknown} putSubscriptionDraft
 * @property {(ownerKey: string) => SubscriptionDraftRecord[]|Promise<SubscriptionDraftRecord[]>} listSubscriptionDrafts
 */

/**
 * ReportProvider — replaceable generation SPI (design §12). Implementations
 * MUST NOT contain payment/subscription fields; billing never enters this
 * port. `generate` receives a persisted request + resolved deps and returns
 * written outputs with digests; it throws a coded Error on failure.
 *
 * @typedef {object} ReportJobContext
 * @property {ReportRecord} report
 * @property {object} sources     scheme → source adapter ({fetchFacts})
 * @property {object} store       ReportOutputStore
 * @property {object} limits      resolved bounds for the job
 * @property {() => string} now   UTC RFC-3339 clock
 *
 * @typedef {object} ReportProviderResult
 * @property {{name: string, mediaType: string, sizeBytes: number, digest: string, relPath: string}[]} files
 *        outputs already written via ctx.store (post-write metadata rows)
 * @property {string} resultDigest        digest representing the whole result (canonical report.json or file-set)
 * @property {string|null} resolvedSourceDigest  digest of the facts actually read
 * @property {string|null} sourceWatermark
 * @property {object} [summaryMeta] small JSON-safe facts merged into the result record
 *
 * @typedef {object} ReportProvider
 * @property {string} providerRef           registry key, e.g. 'local'
 * @property {string} providerVersion       implementation version string
 * @property {boolean} deterministic        true ⇒ safe to requeue after restart
 * @property {boolean} [externalTransfer]   true ⇒ provider sends data off-machine
 * @property {(ctx: ReportJobContext) => Promise<ReportProviderResult>|ReportProviderResult} generate
 */

/**
 * ReportSourceGateway — seam to public deliveries/projects/run APIs
 * (ServiceClient, same as P5's adapters). Server-side only; the browser
 * never supplies URLs or credentials. P5 wires
 * createServiceClientGateway(serviceClient) when a real upstream exists.
 *
 * @typedef {object} SourceFacts
 * @property {string} scheme      one of REPORT_SOURCE_SCHEME
 * @property {object} facts       structured, JSON-safe, bounded
 * @property {string} [sourceDigest] authoritative upstream digest when available
 * @property {string|null} [watermark] freshness marker (updatedAt/endedAt/mtime)
 * @property {string[]} [warnings]
 * @property {object} [bounds]    applied read bounds {maxBytes,maxRows,truncated}
 *
 * @typedef {object} ReportSourceGateway
 * @property {(query: {scheme: string, ref: string, version?: string|null, limits: object}) => Promise<SourceFacts>|SourceFacts} fetchSourceFacts
 */
export const PORTS_DOC = true;
