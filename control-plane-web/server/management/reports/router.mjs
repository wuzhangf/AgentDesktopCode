// Framework-agnostic router for the frozen /api/personal/v1/reports* surface.
// P5/P8 mount it however the management server composes routes: call
// router.handle({method, pathname, searchParams, body}) — it returns
// {status, body} or undefined when the path is not a reports route.
// Responses are the frozen {meta,data} envelope; errors are
// {error:{code,message,retryable,requestId}} (same shape as server/lib/errors).
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../lib/errors.mjs';
import { PERSONAL_API_PREFIX, PERSONAL_ID_PATTERN } from '../../../shared/contracts/personal-enums.mjs';
import { createReportsService } from './service.mjs';
import { REPORT_ERROR } from './ports.mjs';

export const REPORTS_ROUTES = Object.freeze([
  { method: 'GET', path: `${PERSONAL_API_PREFIX}/reports`, op: 'reports.list' },
  { method: 'POST', path: `${PERSONAL_API_PREFIX}/reports`, op: 'reports.create' },
  { method: 'GET', path: `${PERSONAL_API_PREFIX}/reports/:reportId`, op: 'reports.get' },
  { method: 'GET', path: `${PERSONAL_API_PREFIX}/reports/:reportId/files`, op: 'reports.files' },
]);

const MAX_BODY_BYTES = 65_536; // same cap as validPersonalOperation

// searchParams may be URLSearchParams or a plain {key: string} object.
function getParamFrom(searchParams, name) {
  if (!searchParams) return undefined;
  if (typeof searchParams.get === 'function') return searchParams.get(name) ?? undefined;
  const v = searchParams[name];
  return typeof v === 'string' ? v : undefined;
}

function matchReports(method, pathname) {
  for (const route of REPORTS_ROUTES) {
    if (route.method !== method) continue;
    const segs = route.path.split('/');
    const parts = pathname.split('/');
    if (segs.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith(':')) {
        let v;
        try { v = decodeURIComponent(parts[i]); } catch { ok = false; break; }
        if (!PERSONAL_ID_PATTERN.test(v)) { ok = false; break; }
        params[segs[i].slice(1)] = v;
      } else if (segs[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

/** Translate module errors into the frozen {error:{...}} body. */
function toErrorBody(err) {
  if (err instanceof ApiError) return { status: err.status, body: err.toBody() };
  const code = err?.code;
  const retryable = Boolean(err?.retryable);
  const map = {
    [REPORT_ERROR.BAD_REQUEST]: 400,
    [REPORT_ERROR.REPORT_SOURCE_UNKNOWN]: 400,
    [REPORT_ERROR.REPORT_PROVIDER_UNKNOWN]: 400,
    [REPORT_ERROR.NOT_FOUND]: 404,
    [REPORT_ERROR.IDEMPOTENCY_CONFLICT]: 409,
    [REPORT_ERROR.REPORT_PROVIDER_NOT_CONFIGURED]: 503,
    [REPORT_ERROR.REPORT_SOURCE_UNAVAILABLE]: 503,
    [REPORT_ERROR.REPORT_QUEUE_FULL]: 429,
    [REPORT_ERROR.SOURCE_TOO_LARGE]: 422,
  };
  const status = map[code] ?? 500;
  const finalCode = map[code] ? code : 'INTERNAL';
  const message = map[code] ? String(err?.message ?? 'request failed') : 'internal report error';
  return { status, body: { error: { code: finalCode, message, retryable, requestId: randomUUID() } } };
}

/**
 * @param {object} deps — see createReportsService deps, plus:
 *   service?: pre-built ReportsService (tests / custom wiring)
 * @returns router with handle(), the underlying service and the route table.
 */
export function createReportsRouter(deps = {}) {
  const service = deps.service ?? createReportsService(deps);
  let reconciled = false;

  // Restart reconciliation runs once, lazily on first traffic OR explicitly
  // via reconcile() at mount time. QUEUED/RUNNING local reports requeue;
  // non-resumable ones become UNKNOWN (no repeated external effects).
  const reconcileOnce = () => {
    if (!reconciled) { reconciled = true; return service.reconcile(); }
    return Promise.resolve(0);
  };

  async function handle({ method, pathname, searchParams: sp, body }) {
    const m = matchReports(method, pathname);
    if (!m) return undefined;
    try {
      await reconcileOnce().catch(() => {}); // recovery failure must not 500 the request
      let data;
      if (m.route.op === 'reports.list') {
        const requestKey = getParamFrom(sp, 'requestKey');
        const state = getParamFrom(sp, 'state');
        const limitRaw = getParamFrom(sp, 'limit');
        const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 100, 1), 500) : 100;
        if (requestKey !== undefined && !PERSONAL_ID_PATTERN.test(requestKey)) {
          throw new ApiError(400, REPORT_ERROR.BAD_REQUEST, 'requestKey filter must match the frozen id pattern');
        }
        data = await service.listReports({ limit, requestKey, state });
      } else if (m.route.op === 'reports.create') {
        if (body === undefined || body === null) {
          throw new ApiError(400, REPORT_ERROR.BAD_REQUEST, 'request body is required');
        }
        if (typeof body === 'string') {
          if (body.length > MAX_BODY_BYTES) {
            throw new ApiError(400, REPORT_ERROR.BAD_REQUEST, 'request body exceeds 64 KiB');
          }
          try { body = JSON.parse(body); }
          catch { throw new ApiError(400, REPORT_ERROR.BAD_REQUEST, 'request body must be valid JSON'); }
        }
        data = await service.createReport(body);
      } else if (m.route.op === 'reports.get') {
        data = await service.getReport(m.params.reportId);
      } else if (m.route.op === 'reports.files') {
        data = await service.listReportFiles(m.params.reportId);
      }
      return { status: 200, body: { meta: service.buildMeta(), data } };
    } catch (err) {
      const mapped = toErrorBody(err);
      return { status: mapped.status, body: mapped.body };
    }
  }

  return { routes: REPORTS_ROUTES, handle, service, reconcile: reconcileOnce };
}
