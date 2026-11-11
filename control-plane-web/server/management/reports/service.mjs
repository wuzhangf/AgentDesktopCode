// ReportsService — orchestrates the frozen /api/personal/v1/reports* surface:
// idempotent create (persist BEFORE dispatch, original requestKey recoverable
// after restart), bounded execution via ReportExecutor, provider registry
// with real configured/unconfigured state, last-used preference persistence
// and subscription drafts (stored, never scheduled — task §10.4).
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../lib/errors.mjs';
import { PERSONAL_ID_PATTERN, PERSONAL_DIGEST_PATTERN } from '../../../shared/contracts/personal-enums.mjs';
import { digestOf, utcNow } from './canonical.mjs';
import { createReportExecutor, ReportQueueFullError } from './executor.mjs';
import { createReportOutputStore } from './store.mjs';
import { createDataFileSource, createAnalysisSource, DEFAULT_LIMITS } from './sources.mjs';
import { createLocalReportProvider, parseSourceRef } from './local-provider.mjs';
import {
  REPORT_STATE, REPORT_ERROR, DEFAULT_REPORT_OUTPUT_FORMAT,
  KNOWN_REPORT_OUTPUT_FORMATS, LOCAL_REPORT_PROFILE,
  LOCAL_PROVIDER_REF, META_ACTION_PROVIDER_PREFIX, KNOWN_REPORT_SOURCE_SCHEMES,
} from './ports.mjs';

const BODY_KEYS = ['requestKey', 'sourceRef', 'sourceVersion', 'sourceDigest', 'reportProfileRef', 'providerRef', 'outputFormat', 'dataScope'];
// C0+DEL check without a control-char regex literal (mirrors protocol boundedText).
const hasControlChar = (v) => [...v].some((ch) => { const c = ch.codePointAt(0); return c < 32 || c === 127; });
const boundedText = (v, max) => typeof v === "string" && v.length <= max && !hasControlChar(v);

function apiErr(status, code, message, retryable = false) {
  return new ApiError(status, code, message, { retryable });
}

/** Server-side mirror of the frozen REPORT_CREATE body whitelist
 * (protocol personal.ts personalBodyValid). Fail closed on unknown keys —
 * the browser submits registered ids + non-secret selections only. */
export function validateReportRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw apiErr(400, REPORT_ERROR.BAD_REQUEST, 'report request body must be an object');
  }
  for (const k of Object.keys(body)) {
    if (!BODY_KEYS.includes(k)) throw apiErr(400, REPORT_ERROR.BAD_REQUEST, `unexpected field ${k}`);
  }
  if (typeof body.requestKey !== 'string' || !PERSONAL_ID_PATTERN.test(body.requestKey)) {
    throw apiErr(400, REPORT_ERROR.BAD_REQUEST, 'requestKey must match the frozen id pattern');
  }
  if (!boundedText(body.sourceRef, 512)) {
    throw apiErr(400, REPORT_ERROR.BAD_REQUEST, 'sourceRef is required (bounded text, <=512 chars)');
  }
  let scheme, ref;
  try {
    ({ scheme, ref } = parseSourceRef(body.sourceRef));
  } catch (err) {
    throw apiErr(400, REPORT_ERROR.REPORT_SOURCE_UNKNOWN, String(err?.message ?? err));
  }
  if (!KNOWN_REPORT_SOURCE_SCHEMES.includes(scheme)) {
    throw apiErr(400, REPORT_ERROR.REPORT_SOURCE_UNKNOWN,
      `unsupported source scheme ${scheme} (supported: ${KNOWN_REPORT_SOURCE_SCHEMES.join(', ')})`);
  }
  // Every scheme's ref must satisfy the frozen id pattern up front — rejects
  // traversal (`../x`) before a row is persisted rather than as a job failure.
  if (!PERSONAL_ID_PATTERN.test(ref)) {
    throw apiErr(400, REPORT_ERROR.BAD_REQUEST, `source ref for ${scheme}: must match the frozen id pattern`);
  }
  for (const f of ['sourceVersion', 'outputFormat']) {
    if (body[f] !== undefined && !boundedText(body[f], 128)) {
      throw apiErr(400, REPORT_ERROR.BAD_REQUEST, `${f} must be bounded text <=128 chars`);
    }
  }
  for (const f of ['reportProfileRef', 'providerRef']) {
    if (body[f] !== undefined && !boundedText(body[f], 512)) {
      throw apiErr(400, REPORT_ERROR.BAD_REQUEST, `${f} must be bounded text <=512 chars`);
    }
  }
  if (body.sourceDigest !== undefined
    && (typeof body.sourceDigest !== 'string' || !PERSONAL_DIGEST_PATTERN.test(body.sourceDigest))) {
    throw apiErr(400, REPORT_ERROR.BAD_REQUEST, 'sourceDigest must be sha256:<64 lowercase hex>');
  }
  if (body.dataScope !== undefined) {
    if (!Array.isArray(body.dataScope) || body.dataScope.length > 64
      || !body.dataScope.every((s) => boundedText(s, 256))) {
      throw apiErr(400, REPORT_ERROR.BAD_REQUEST, 'dataScope must be an array of <=64 bounded strings');
    }
  }
  const normalized = {
    requestKey: body.requestKey,
    sourceRef: body.sourceRef,
    sourceVersion: body.sourceVersion ?? null,
    sourceDigest: body.sourceDigest ?? null,
    reportProfileRef: body.reportProfileRef ?? LOCAL_REPORT_PROFILE,
    providerRef: body.providerRef || LOCAL_PROVIDER_REF,
    outputFormat: body.outputFormat ?? DEFAULT_REPORT_OUTPUT_FORMAT,
    dataScope: Array.isArray(body.dataScope) ? [...body.dataScope] : null,
  };
  if (!KNOWN_REPORT_OUTPUT_FORMATS.includes(normalized.outputFormat)) {
    throw apiErr(400, REPORT_ERROR.BAD_REQUEST,
      `outputFormat must be one of ${KNOWN_REPORT_OUTPUT_FORMATS.join(', ')}`);
  }
  return normalized;
}

function safeJsonArray(v) {
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : undefined; } catch { return undefined; }
}

/** Row → in-memory record: JSON columns arrive as TEXT from sqlite; the
 * provider and descriptor both need real arrays. */
function fromRow(rec) {
  if (!rec) return rec;
  return {
    ...rec,
    dataScope: Array.isArray(rec.dataScope) ? rec.dataScope : safeJsonArray(rec.dataScope) ?? null,
  };
}

function toDescriptor(rec) {
  return {
    reportId: rec.reportId,
    requestKey: rec.requestKey ?? null,
    sourceRef: rec.sourceRef ?? null,
    sourceVersion: rec.sourceVersion ?? null,
    sourceDigest: rec.resolvedSourceDigest ?? rec.sourceDigest ?? null,
    reportProfileRef: rec.reportProfileRef ?? null,
    providerRef: rec.providerRef ?? null,
    outputFormat: rec.outputFormat ?? null,
    state: rec.state,
    dataScope: fromRow(rec).dataScope ?? undefined,
    resultDigest: rec.resultDigest ?? null,
    createdAt: rec.createdAt ?? null,
    updatedAt: rec.updatedAt ?? null,
    error: rec.errorCode ? { code: rec.errorCode, message: rec.errorMessage ?? null } : null,
  };
}

function toFileDescriptor(rec) {
  return {
    fileId: rec.fileId,
    name: rec.name,
    mediaType: rec.mediaType ?? null,
    sizeBytes: rec.sizeBytes ?? null,
    digest: rec.digest ?? null,
  };
}

export function createReportsService(deps = {}) {
  const {
    repository,                    // ReportsRepository — required (P5 sqlite adapter, or memory for tests)
    upstreamGateway = null,        // ReportSourceGateway for analysis schemes
    dataDir = null,                // registered CSV/JSON directory
    outputDir,                     // report output root — required
    providers = {},                // Record<ref, ReportProvider|null>: declared catalog
    limits = {},
    controlPlaneId = 'unregistered',
    instance = 'personal-management',
    ownerKey = 'default',          // single install owner; multi-tenant is out of scope
    now = () => Date.now(),
    newId = (p) => `${p}_${randomUUID()}`,
  } = deps;
  if (!repository) throw new Error('ReportsService requires a repository seam (P5 management.db adapter or memory repo)');
  const L = { ...DEFAULT_LIMITS, ...limits };
  const store = deps.store ?? createReportOutputStore({ outputDir, maxFileBytes: L.maxOutputBytes ?? 4 * 1024 * 1024 });
  const executor = deps.executor ?? createReportExecutor({ concurrency: 1, maxQueue: 32, jobTimeoutMs: L.jobTimeoutMs ?? 120_000 });

  // Provider registry: 'local' always configured; deps.providers declares the
  // rest — value null = declared but NOT configured (real state), object =
  // configured implementation. Payment/subscription fields never enter.
  const registry = new Map();
  // Source adapters are shared: provider impls get them in the job ctx so a
  // future external provider resolves the SAME bounded facts locally (then
  // transfers only within the user's declared dataScope).
  const sources = {
    data: createDataFileSource({ dataDir, limits: L }),
    project: createAnalysisSource({ gateway: upstreamGateway, limits: L }),
    delivery: createAnalysisSource({ gateway: upstreamGateway, limits: L }),
    run: createAnalysisSource({ gateway: upstreamGateway, limits: L }),
    session: createAnalysisSource({ gateway: upstreamGateway, limits: L }),
  };
  const localProvider = createLocalReportProvider({ sources, store, now });
  registry.set(LOCAL_PROVIDER_REF, localProvider);
  for (const [ref, impl] of Object.entries(providers)) {
    if (ref === LOCAL_PROVIDER_REF) continue;
    registry.set(ref, impl ?? null);
  }

  function resolveProvider(ref) {
    if (!registry.has(ref)) {
      throw apiErr(400, REPORT_ERROR.REPORT_PROVIDER_UNKNOWN,
        `report provider ${ref} is not declared for this installation`);
    }
    const impl = registry.get(ref);
    if (!impl) {
      throw apiErr(503, REPORT_ERROR.REPORT_PROVIDER_NOT_CONFIGURED,
        `report provider ${ref} is declared but not configured — no report was created`, true);
    }
    return impl;
  }

  async function runJob(reportId) {
    const rec = await repository.getReport(reportId);
    if (!rec || rec.state !== REPORT_STATE.QUEUED) return; // replay/cancel-safe
    await repository.updateReport(reportId, { state: REPORT_STATE.RUNNING, updatedAt: utcNow(now) });
    try {
      const provider = resolveProvider(rec.providerRef);
      const result = await provider.generate({ report: fromRow(rec), sources, store, limits: L, now });
      const t = utcNow(now);
      for (const f of result.files) {
        await repository.putReportFile({
          fileId: newId('f'), reportId, name: f.name, mediaType: f.mediaType,
          sizeBytes: f.sizeBytes, digest: f.digest, relPath: f.relPath, createdAt: t,
        });
      }
      await repository.updateReport(reportId, {
        state: REPORT_STATE.READY, resultDigest: result.resultDigest,
        resolvedSourceDigest: result.resolvedSourceDigest, sourceWatermark: result.sourceWatermark,
        errorCode: null, errorMessage: null, updatedAt: utcNow(now),
      });
    } catch (err) {
      const code = err?.code && Object.values(REPORT_ERROR).includes(err.code) ? err.code : REPORT_ERROR.PROVIDER_FAILED;
      await repository.updateReport(reportId, {
        state: REPORT_STATE.FAILED, errorCode: code,
        errorMessage: String(err?.message ?? err).slice(0, 512), updatedAt: utcNow(now),
      });
    }
  }

  /** Persist-before-dispatch create. Same requestKey+same body replays the
   * original report; same key+different body is a 409 (freeze §3 semantics). */
  async function createReport(body) {
    const req = validateReportRequest(body);
    const provider = resolveProvider(req.providerRef); // fail before persist — never a fake report row
    // Task §10.5: a provider that moves data off this install requires the
    // user's explicit scope selection; nothing uploads by default.
    if (provider.externalTransfer === true && !(req.dataScope && req.dataScope.length)) {
      throw apiErr(400, REPORT_ERROR.BAD_REQUEST,
        `provider ${req.providerRef} transfers data off this installation — an explicit dataScope selection is required`);
    }
    const bodyDigest = digestOf(req);
    const existing = await repository.findReportByRequestKey(req.requestKey);
    if (existing) {
      if (existing.bodyDigest === bodyDigest) return toDescriptor(existing);
      throw apiErr(409, REPORT_ERROR.IDEMPOTENCY_CONFLICT,
        `requestKey ${req.requestKey} was already used with a different body`);
    }
    if (executor.isFull()) {
      throw apiErr(429, REPORT_ERROR.REPORT_QUEUE_FULL,
        'report executor queue is full — retry later', true);
    }
    const t = utcNow(now);
    const rec = {
      reportId: newId('rpt'), requestKey: req.requestKey, bodyDigest,
      sourceRef: req.sourceRef, sourceVersion: req.sourceVersion, sourceDigest: req.sourceDigest,
      resolvedSourceDigest: null, sourceWatermark: null,
      reportProfileRef: req.reportProfileRef, providerRef: req.providerRef,
      outputFormat: req.outputFormat, dataScope: req.dataScope,
      state: REPORT_STATE.QUEUED, errorCode: null, errorMessage: null,
      resultDigest: null, createdAt: t, updatedAt: t,
    };
    await repository.putReportRequest(rec); // persisted BEFORE dispatch (freeze §3)
    // Last-used preferences are real persisted state (report_preferences).
    await repository.putReportPreferences(ownerKey, {
      ownerKey, lastProviderRef: req.providerRef, lastProfileRef: req.reportProfileRef,
      lastOutputFormat: req.outputFormat, lastDataScope: req.dataScope, updatedAt: t,
    });
    try {
      // Fire-and-forget: the report is a queued job; the page polls the
      // descriptor (QUEUED→RUNNING→READY/FAILED). submit() throws only on a
      // full queue; job outcome is persisted by runJob, never thrown here.
      executor.submit(rec.reportId, () => runJob(rec.reportId)).catch(() => {});
    } catch (err) {
      if (err instanceof ReportQueueFullError) {
        // Race with the advisory pre-check: the row is persisted, so record a
        // real FAILED outcome instead of leaving a phantom QUEUED row.
        await repository.updateReport(rec.reportId, {
          state: REPORT_STATE.FAILED, errorCode: REPORT_ERROR.REPORT_QUEUE_FULL,
          errorMessage: 'executor queue filled between accept and dispatch', updatedAt: utcNow(now),
        });
        throw apiErr(429, REPORT_ERROR.REPORT_QUEUE_FULL, err.message, true);
      }
      throw err;
    }
    return toDescriptor(rec);
  }

  async function listReports(query = {}) {
    const rows = await repository.listReports({ limit: query.limit ?? 100, requestKey: query.requestKey, state: query.state });
    return rows.map(toDescriptor);
  }

  async function getReport(reportId) {
    const rec = await repository.getReport(reportId);
    if (!rec) throw apiErr(404, REPORT_ERROR.NOT_FOUND, `report ${reportId} not found`);
    return toDescriptor(rec);
  }

  async function listReportFiles(reportId) {
    const rec = await repository.getReport(reportId);
    if (!rec) throw apiErr(404, REPORT_ERROR.NOT_FOUND, `report ${reportId} not found`);
    const files = await repository.listReportFiles(reportId);
    return files.map(toFileDescriptor);
  }

  /** Restart reconciliation (design §12: resume by original key, never
   * duplicate external effects). Deterministic providers requeue; anything
   * else becomes UNKNOWN — its mid-flight effect cannot be proven. */
  async function reconcile() {
    const pending = (await repository.listReports({ limit: 256 }))
      .filter((r) => r.state === REPORT_STATE.QUEUED || r.state === REPORT_STATE.RUNNING);
    for (const rec of pending) {
      const provider = registry.get(rec.providerRef);
      if (provider && provider.deterministic === true) {
        await repository.updateReport(rec.reportId, { state: REPORT_STATE.QUEUED, updatedAt: utcNow(now) });
        try { executor.submit(rec.reportId, () => runJob(rec.reportId)).catch(() => {}); }
        catch (err) {
          if (err instanceof ReportQueueFullError) break; // rest stay QUEUED for the next trigger
          await repository.updateReport(rec.reportId, {
            state: REPORT_STATE.UNKNOWN, errorCode: REPORT_ERROR.EFFECT_UNKNOWN,
            errorMessage: 'could not requeue after restart', updatedAt: utcNow(now),
          });
        }
      } else {
        await repository.updateReport(rec.reportId, {
          state: REPORT_STATE.UNKNOWN, errorCode: REPORT_ERROR.EFFECT_UNKNOWN,
          errorMessage: `interrupted before completion; provider ${rec.providerRef} is not safely resumable`,
          updatedAt: utcNow(now),
        });
      }
    }
    return pending.length;
  }

  /** Subscription drafts persist intent only. `enabled` is forced false —
   * no scheduler, account or settlement exists in this build, and saving a
   * draft NEVER creates a task (task §10.4, E39). */
  async function saveSubscriptionDraft(draft) {
    const t = utcNow(now);
    const rec = {
      draftId: draft.draftId && PERSONAL_ID_PATTERN.test(draft.draftId) ? draft.draftId : newId('rsub'),
      ownerKey: draft.ownerKey ?? ownerKey,
      sourceRef: boundedText(draft.sourceRef, 512) ? draft.sourceRef : (() => { throw apiErr(400, REPORT_ERROR.BAD_REQUEST, 'draft sourceRef required'); })(),
      reportProfileRef: draft.reportProfileRef ?? null,
      cadence: ['once', 'daily', 'weekly'].includes(draft.cadence) ? draft.cadence : 'once',
      note: boundedText(draft.note ?? '', 512) ? draft.note ?? null : null,
      enabled: false,
      createdAt: t, updatedAt: t,
    };
    await repository.putSubscriptionDraft(rec);
    return rec;
  }

  async function listSubscriptionDrafts() { return repository.listSubscriptionDrafts(ownerKey); }
  async function getPreferences() { return repository.getReportPreferences(ownerKey); }

  /** PersonalMeta for this module's responses. Provider advertisement is REAL:
   * only configured providers appear as REPORT_PROVIDER:<ref>; declared-but-
   * unconfigured ones surface REPORT_PROVIDER_NOT_CONFIGURED in reasonCodes. */
  function buildMeta() {
    const supportedActions = ['REPORTS', 'REPORT_CREATE', 'REPORT', 'REPORT_FILES'];
    const reasonCodes = [];
    for (const [ref, impl] of registry) {
      if (impl) supportedActions.push(`${META_ACTION_PROVIDER_PREFIX}${ref}`);
      else reasonCodes.push(REPORT_ERROR.REPORT_PROVIDER_NOT_CONFIGURED);
    }
    return {
      source: 'management/reports',
      instance,
      controlPlaneId,
      observedAt: utcNow(now),
      revision: '1',
      supportedActions,
      reasonCodes,
    };
  }

  return {
    createReport, listReports, getReport, listReportFiles, reconcile,
    saveSubscriptionDraft, listSubscriptionDrafts, getPreferences, buildMeta,
    toDescriptor, executor, store,
    /** Stable reportId lookup by original requestKey (restart recovery). */
    async findByRequestKey(requestKey) {
      const rec = await repository.findReportByRequestKey(requestKey);
      return rec ? toDescriptor(rec) : null;
    },
  };
}
