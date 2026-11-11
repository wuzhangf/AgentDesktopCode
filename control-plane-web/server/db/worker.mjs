// Read worker thread (§13.1): owns read-only connections, executes named
// repository ops inside a short read transaction, one task at a time.
import { parentPort, workerData } from 'node:worker_threads';
import { openReadonlyDb, inspectSchema } from './readonly.mjs';
import { personalTaskMetrics } from '../repositories/personalTask.mjs';
import * as obs from '../repositories/sqliteV1.mjs';
import * as gui from '../repositories/optionalGui.mjs';

const OPS = {
  'obs.personalTaskMetrics': personalTaskMetrics,
  'obs.metaSourceInfo': obs.metaSourceInfo,
  'obs.metaCapabilities': obs.metaCapabilities,
  'obs.metaDimensions': obs.metaDimensions,
  'obs.analyticsOverview': obs.analyticsOverview,
  'obs.analyticsRuns': obs.analyticsRuns,
  'obs.listRuns': obs.listRuns,
  'obs.taskDetail': obs.taskDetail,
  'obs.runSummary': obs.runSummary,
  'obs.runTimeline': obs.runTimeline,
  'obs.runFacts': obs.runFacts,
  'obs.analyticsModels': obs.analyticsModels,
  'obs.listModelAttempts': obs.listModelAttempts,
  'obs.modelAttemptDetail': obs.modelAttemptDetail,
  'obs.analyticsContext': obs.analyticsContext,
  'obs.analyticsTools': obs.analyticsTools,
  'obs.analyticsCollaboration': obs.analyticsCollaboration,
  'obs.analyticsEfficiency': obs.analyticsEfficiency,
  'obs.analyticsQuality': obs.analyticsQuality,
  'obs.listEntities': obs.listEntities,
  'obs.listEvents': obs.listEvents,
  'obs.eventDetail': obs.eventDetail,
  'obs.listIssues': obs.listIssues,
  'obs.artifactDetail': obs.artifactDetail,
  'obs.exportAnalytics': obs.exportAnalytics,
  'gui.listSessions': gui.listSessions,
  'gui.sessionDetail': gui.sessionDetail,
};

let db = null;
let guiDb = null;
let schema = null;
let openError = null;

try {
  db = openReadonlyDb(workerData.dbPath);
  schema = inspectSchema(db);
} catch (err) {
  openError = String(err?.message ?? err);
}
if (workerData.guiPath) {
  try {
    guiDb = openReadonlyDb(workerData.guiPath);
  } catch { guiDb = null; }
}

function readSchemaVersion() {
  try {
    return db?.prepare('SELECT MAX(version) v FROM obs_schema_migration').get()?.v ?? null;
  } catch { return null; }
}

parentPort.on('message', (task) => {
  const { taskId, op, params } = task;
  const respond = (payload) => parentPort.postMessage({ taskId, ...payload });
  if (op === '__ping') {
    respond({ ok: true, result: { schemaVersion: readSchemaVersion(), openError } });
    return;
  }
  if (op === '__dataVersion') {
    let dv = null;
    try { dv = db?.prepare('PRAGMA data_version').get()?.data_version ?? null; } catch { dv = null; }
    respond({ ok: true, result: dv });
    return;
  }
  if (!db) {
    respond({ ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: openError || 'db not open', retryable: true } });
    return;
  }
  const fn = OPS[op];
  if (!fn) {
    respond({ ok: false, error: { code: 'BAD_REQUEST', message: `unknown op ${op}`, retryable: false } });
    return;
  }
  const ctx = { db, guiDb, schema, source: workerData.sourceRef ?? { id: workerData.sourceId, mode: workerData.mode } };
  try {
    db.exec('BEGIN');
    const result = fn(ctx, params);
    let dataAsOf = null;
    if (op.startsWith('obs.') && schema?.tables?.has('obs_event')) {
      try {
        dataAsOf = db.prepare('SELECT MAX(recorded_at) m FROM obs_event WHERE scope_id = ?')
          .get(params?.scopeId ?? 'local')?.m ?? null;
      } catch { dataAsOf = null; }
    }
    db.exec('COMMIT');
    respond({ ok: true, result, dataAsOf, schemaVersion: readSchemaVersion() });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    respond({ ok: false, error: { code: 'QUERY_FAILED', message: String(err?.message ?? err), retryable: false } });
  }
});

parentPort.postMessage({ ready: true, openError });
