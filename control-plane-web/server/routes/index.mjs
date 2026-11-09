// Route table for /api/v2. Each entry declares which filter params it accepts
// (unsupported filters → 400, §3.2) and maps to a worker op.
import {
  parseWindowParams, parseId, parseLimit, parseBool, parseSort, requireEnum,
} from '../lib/validate.mjs';
import { badRequest, notFound, unprocessable } from '../lib/errors.mjs';
import { decodeCursor, filterHash } from '../lib/cursor.mjs';

const WINDOW_FILTERS = ['product', 'runKind', 'configRevision'];
const MODEL_FILTERS = ['provider', 'model', 'purpose'];

export const ROUTES = [
  {
    method: 'GET', path: '/api/v2/meta/sources', op: null,
    handler: 'metaSources',
  },
  {
    method: 'GET', path: '/api/v2/meta/capabilities', op: 'obs.metaCapabilities',
    build: (sp) => ({ scopeId: requiredScope(sp) }),
  },
  {
    method: 'GET', path: '/api/v2/meta/dimensions', op: 'obs.metaDimensions',
    build: (sp) => ({
      scopeId: requiredScope(sp),
      domain: requiredParam(sp, 'domain'),
      search: sp.get('search') || null,
      limit: parseLimit(sp.get('limit'), { def: 50, max: 200 }),
    }),
  },
  {
    method: 'GET', path: '/api/v2/analytics/overview', op: 'obs.analyticsOverview',
    window: true, supported: WINDOW_FILTERS,
  },
  {
    method: 'GET', path: '/api/v2/analytics/runs', op: 'obs.analyticsRuns',
    window: true, supported: [...WINDOW_FILTERS, 'lifecycle', 'outcome', 'durationBasis'],
  },
  {
    method: 'GET', path: '/api/v2/runs', op: 'obs.listRuns', paged: true,
    supported: [...WINDOW_FILTERS, 'lifecycle', 'outcome', 'taskId', 'sessionId', 'involvesModel', 'state'],
    sortFields: ['registered_at', 'started_at', 'ended_at', 'duration_ms'], defaultSort: 'registered_at',
  },
  {
    method: 'GET', path: '/api/v2/tasks/:id', op: 'obs.taskDetail',
    build: (sp, seg) => ({ scopeId: requiredScope(sp), taskId: parseId(seg.id, 'taskId') }),
  },
  {
    method: 'GET', path: '/api/v2/runs/:id/summary', op: 'obs.runSummary',
    build: (sp, seg) => ({
      scopeId: requiredScope(sp), runId: parseId(seg.id, 'runId'),
      includeDescendants: parseBool(sp.get('includeDescendants')),
      relationPolicy: requireEnum(sp.get('relationPolicy'), ['verified', 'raw'], 'relationPolicy') ?? 'verified',
    }),
  },
  {
    method: 'GET', path: '/api/v2/runs/:id/timeline', op: 'obs.runTimeline',
    build: (sp, seg) => ({
      scopeId: requiredScope(sp), runId: parseId(seg.id, 'runId'),
      limit: parseLimit(sp.get('limit'), { def: 2000, max: 2000 }),
    }),
  },
  {
    method: 'GET', path: '/api/v2/runs/:id/facts', op: 'obs.runFacts', paged: true,
    supported: ['kind'],
    build: (sp, seg, common) => ({
      ...common, runId: parseId(seg.id, 'runId'),
      kind: requiredParam(sp, 'kind'),
    }),
    sortFields: [], defaultSort: null,
  },
  {
    method: 'GET', path: '/api/v2/analytics/models', op: 'obs.analyticsModels',
    window: true, supported: MODEL_FILTERS,
  },
  {
    method: 'GET', path: '/api/v2/model-attempts', op: 'obs.listModelAttempts', paged: true,
    supported: [...MODEL_FILTERS, 'failureClass', 'hasUsage', 'runId', 'callId', 'retried'],
  },
  {
    method: 'GET', path: '/api/v2/model-attempts/:id', op: 'obs.modelAttemptDetail',
    build: (sp, seg) => ({ scopeId: requiredScope(sp), attemptId: parseId(seg.id, 'attemptId') }),
  },
  {
    method: 'GET', path: '/api/v2/analytics/context', op: 'obs.analyticsContext',
    window: true, supported: ['partition', 'basis', 'unit', 'requestRevision'],
  },
  {
    method: 'GET', path: '/api/v2/analytics/collaboration', op: 'obs.analyticsCollaboration',
    window: true, supported: ['planId', 'role', 'definitionRevision'],
    applied: ['planId', 'role'],
  },
  {
    method: 'GET', path: '/api/v2/analytics/tools', op: 'obs.analyticsTools',
    window: true, supported: ['tool', 'domain', 'includeInfra'],
    applied: ['tool'],
  },
  {
    method: 'GET', path: '/api/v2/analytics/efficiency', op: 'obs.analyticsEfficiency',
    window: true, supported: ['currency', 'authorityPolicy', 'cohortBasis'],
    applied: ['currency'],
  },
  {
    method: 'GET', path: '/api/v2/analytics/quality', op: 'obs.analyticsQuality',
    window: true, supported: ['issueCode', 'severity', 'metricFamily'],
    applied: ['issueCode', 'severity'],
  },
  {
    method: 'GET', path: '/api/v2/entities', op: 'obs.listEntities', paged: true,
    supported: ['entityKind', 'entityId', 'lifecycle'],
  },
  {
    method: 'GET', path: '/api/v2/events', op: 'obs.listEvents', paged: true,
    supported: ['entityId', 'eventType'],
  },
  {
    method: 'GET', path: '/api/v2/events/:id', op: 'obs.eventDetail',
    build: (sp, seg) => ({ scopeId: requiredScope(sp), eventId: parseId(seg.id, 'eventId') }),
  },
  {
    method: 'GET', path: '/api/v2/issues', op: 'obs.listIssues', paged: true,
    supported: ['issueCode', 'severity'],
  },
  {
    method: 'GET', path: '/api/v2/artifacts/:id', op: 'obs.artifactDetail',
    build: (sp, seg) => ({ scopeId: requiredScope(sp), artifactId: parseId(seg.id, 'artifactId') }),
  },
  {
    method: 'GET', path: '/api/v2/sessions', op: 'gui.listSessions', gui: true,
    build: (sp) => ({ limit: parseLimit(sp.get('limit'), { def: 100 }) }),
  },
  {
    method: 'GET', path: '/api/v2/sessions/:id', op: 'gui.sessionDetail', gui: true,
    build: (sp, seg) => ({ sessionId: String(seg.id) }),
  },
  {
    method: 'GET', path: '/api/v2/exports/analytics.csv', op: 'obs.exportAnalytics',
    window: true, supported: [...WINDOW_FILTERS, 'metricId'], csv: true,
    applied: (p) => (p.metricId === 'tools.table' ? [] : WINDOW_FILTERS),
  },
];

export function requiredScope(sp) {
  const v = sp.get('scopeId') ?? 'local';
  return parseId(v, 'scopeId');
}

export function requiredParam(sp, name) {
  const v = sp.get(name);
  if (v == null || v === '') badRequest(`missing required parameter: ${name}`);
  return v;
}

/**
 * Build worker params for a route. Returns {params, window, sort, limit, cursorData}.
 */
export function buildParams(route, sp, seg, source) {
  if (route.build) return { params: route.build(sp, seg) };
  if (route.window) {
    const w = parseWindowParams(sp, { supported: route.supported ?? [] });
    const params = { scopeId: requiredScope(sp), ...w };
    if (route.csv) params.metricId = requiredParam(sp, 'metricId');
    return { params, window: w };
  }
  if (route.paged) {
    const w = parseWindowParams(sp, { supported: route.supported ?? [], requireWindow: false });
    const sort = route.sortFields?.length
      ? parseSort(sp.get('sort'), sp.get('dir'), route.sortFields, { field: route.defaultSort })
      : { field: route.defaultSort, direction: 'DESC' };
    const limit = parseLimit(sp.get('limit'), { def: 50, max: 200 });
    const fh = filterHash({ f: w.filters, s: sort.field, d: sort.direction });
    const cursorData = sp.get('cursor')
      ? decodeCursor(sp.get('cursor'), { sourceEpoch: source.sourceEpoch, scopeId: requiredScope(sp), filterHash: fh })
      : null;
    const common = {
      scopeId: requiredScope(sp), filters: w.filters, sort, limit, cursorData, filterHash: fh,
      // Runs/attempts lists treat the window as a created-cohort filter when present.
      from: sp.get('from') != null ? w.from : null,
      to: sp.get('to') != null ? w.to : null,
      timezone: w.timezone,
    };
    const extra = route.build ? route.build(sp, seg, common) : common;
    return { params: extra, window: w, sort, limit, filterHash: fh };
  }
  return { params: {} };
}
