// Report source adapters (task §10.1): two real source kinds.
//
//   data:<name>     — a CSV/JSON file registered inside the configured
//                     data-sources directory. "Registered" means the file is
//                     placed there install-side; the browser only submits the
//                     name, never a path. Reads are bounded (bytes + rows),
//                     never execute anything, never run SQL.
//
//   project:<id>    — project/delivery/run/session facts resolved through
//   delivery:<id>     the ReportSourceGateway seam (P5 adapts ServiceClient
//   run:<id>          public APIs). When the gateway is not wired the source
//   session:<id>      reports REPORT_SOURCE_UNAVAILABLE — real state, no fake.
//
// Every adapter returns SourceFacts {scheme, facts, sourceDigest?, watermark?,
// warnings[], bounds{...}}; facts digest is computed when upstream does not
// supply one, so the report always records what it actually read.
import { statSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { PERSONAL_ID_PATTERN } from '../../../shared/contracts/personal-enums.mjs';
import { digestBytes, digestOf } from './canonical.mjs';
import { REPORT_ERROR, REPORT_SOURCE_SCHEME } from './ports.mjs';

export class ReportSourceError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message); this.code = code; this.retryable = retryable;
  }
}

export const DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 4 * 1024 * 1024,
  maxRows: 20_000,
  maxFields: 512,
  maxSampleRows: 10,
  maxTopValues: 5,
  maxDistinctTracked: 1_000,
  maxJsonNodes: 50_000,
});

// ---------------------------------------------------------------------------
// data:<name> — registered CSV/JSON files
// ---------------------------------------------------------------------------

export function createDataFileSource({ dataDir, limits = {} } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };

  function resolveRegisteredFile(name) {
    if (typeof name !== 'string' || !PERSONAL_ID_PATTERN.test(name)) {
      throw new ReportSourceError(REPORT_ERROR.REPORT_SOURCE_UNKNOWN,
        `invalid data source name: ${String(name)}`);
    }
    if (!dataDir) {
      throw new ReportSourceError(REPORT_ERROR.REPORT_SOURCE_UNAVAILABLE,
        'no data-sources directory configured for this installation', { retryable: true });
    }
    // Compare physical roots: Darwin /var and /private/var are the same directory.
    let root;
    try { root = realpathSync(dataDir); }
    catch { throw new ReportSourceError(REPORT_ERROR.REPORT_SOURCE_UNAVAILABLE,
      'registered data-sources directory is unavailable', { retryable: true }); }
    const candidates = extname(name)
      ? [name]
      : [`${name}.csv`, `${name}.json`, name];
    for (const candidate of candidates) {
      const abs = resolve(root, candidate);
      if (abs !== root && !abs.startsWith(root + sep)) continue; // containment
      let real;
      try { real = realpathSync(abs); } catch { continue; }
      if (real !== root && !real.startsWith(root + sep)) continue; // symlink escape
      if (!statSync(real).isFile()) continue;
      const ext = extname(real).toLowerCase();
      if (ext !== '.csv' && ext !== '.json') {
        throw new ReportSourceError(REPORT_ERROR.REPORT_SOURCE_UNKNOWN,
          `registered data source must be .csv or .json: ${candidate}`);
      }
      return { path: real, ext, registeredName: candidate };
    }
    throw new ReportSourceError(REPORT_ERROR.REPORT_SOURCE_UNKNOWN,
      `no registered data source named ${name} (place <name>.csv|.json in the data-sources directory)`);
  }

  function readBounded(path) {
    const st = statSync(path);
    if (st.size > L.maxInputBytes) {
      throw new ReportSourceError(REPORT_ERROR.SOURCE_TOO_LARGE,
        `data source is ${st.size} bytes, cap is ${L.maxInputBytes}`, { retryable: false });
    }
    return { bytes: readFileSync(path), mtime: st.mtime.toISOString(), sizeBytes: st.size };
  }

  return {
    scheme: REPORT_SOURCE_SCHEME.DATA,
    async fetchFacts({ ref }) {
      const file = resolveRegisteredFile(ref);
      const { bytes, mtime, sizeBytes } = readBounded(file.path);
      const sourceDigest = digestBytes(bytes); // bytes pinned, not just a name
      const warnings = [];
      let facts;
      if (file.ext === '.csv') {
        const table = parseCsv(bytes.toString('utf8'), L);
        facts = tableFacts(table, L, warnings);
      } else {
        facts = jsonFacts(bytes.toString('utf8'), L, warnings);
      }
      return {
        scheme: REPORT_SOURCE_SCHEME.DATA,
        facts: { kind: file.ext === '.csv' ? 'csv' : 'json', fileName: file.registeredName, sizeBytes, ...facts },
        sourceDigest,
        watermark: mtime,
        warnings,
        bounds: { maxInputBytes: L.maxInputBytes, maxRows: L.maxRows, truncated: Boolean(facts.truncated) },
      };
    },
  };
}

// --- bounded CSV parsing (RFC-4180 subset: quotes, escaped quotes, CRLF/LF) --

function parseCsv(text, L) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let truncated = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { pushField(); continue; }
    if (c === '\r') { if (text[i + 1] === '\n') i++; pushRow(); }
    else if (c === '\n') pushRow();
    else field += c;
    if (rows.length >= L.maxRows) { truncated = true; break; }
  }
  if (field.length > 0 || row.length > 0) { if (rows.length < L.maxRows) pushRow(); else truncated = true; }
  // drop a trailing fully-empty row produced by a final newline
  if (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  if (rows.length && rows[0].length > L.maxFields) {
    throw new ReportSourceError(REPORT_ERROR.REPORT_SOURCE_UNKNOWN,
      `csv has ${rows[0].length} fields, cap is ${L.maxFields}`);
  }
  return { rows, truncated };
}

function isFiniteNumberString(s) {
  if (s === '' || s == null) return false;
  const n = Number(s);
  return Number.isFinite(n);
}

/** Deterministic column summary. First row is the header (documented in the
 * report; this adapter never guesses semantics). */
function tableFacts({ rows, truncated }, L, warnings) {
  if (rows.length === 0) return { columns: [], rowCount: 0, truncated };
  const header = rows[0];
  const dataRows = rows.slice(1);
  const columns = header.map((name, ci) => {
    const values = dataRows.map((r) => r[ci] ?? '');
    const nonEmpty = values.filter((v) => v !== '');
    const distinct = new Set(nonEmpty);
    const numericCount = nonEmpty.filter(isFiniteNumberString).length;
    const numeric = nonEmpty.length > 0 && numericCount / nonEmpty.length >= 0.9;
    const col = {
      name: name === '' ? `column_${ci + 1}` : name,
      nonEmpty: nonEmpty.length,
      empty: values.length - nonEmpty.length,
      distinct: distinct.size > L.maxDistinctTracked ? `>${L.maxDistinctTracked}` : distinct.size,
    };
    if (numeric) {
      let min = Infinity, max = -Infinity, sum = 0;
      for (const v of nonEmpty) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (n < min) min = n;
        if (n > max) max = n;
        sum += n;
      }
      col.numeric = { min, max, mean: Number((sum / Math.max(numericCount, 1)).toFixed(6)) };
    } else if (distinct.size <= L.maxDistinctTracked) {
      const freq = new Map();
      for (const v of nonEmpty) freq.set(v, (freq.get(v) ?? 0) + 1);
      col.topValues = [...freq.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, L.maxTopValues)
        .map(([value, count]) => ({ value: value.slice(0, 128), count }));
    }
    return col;
  });
  if (truncated) warnings.push(`input truncated at ${L.maxRows} rows`);
  return {
    columns, rowCount: dataRows.length, truncated,
    sampleRows: dataRows.slice(0, L.maxSampleRows).map((r) => r.slice(0, L.maxFields).map((c) => c.slice(0, 256))),
  };
}

function jsonFacts(text, L, warnings) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (err) {
    throw new ReportSourceError(REPORT_ERROR.SOURCE_READ_FAILED,
      `data source is not valid JSON: ${String(err?.message ?? err)}`);
  }
  let nodes = 0;
  const out = { jsonKind: Array.isArray(parsed) ? 'array' : typeof parsed === 'object' && parsed !== null ? 'object' : 'scalar' };
  const walk = (v, depth) => {
    if (depth > 12 || nodes > L.maxJsonNodes) return '[truncated]';
    nodes += 1;
    if (Array.isArray(v)) return v.slice(0, 100).map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).slice(0, L.maxFields)) o[k] = walk(v[k], depth + 1);
      return o;
    }
    return v;
  };
  if (Array.isArray(parsed)) {
    out.itemCount = parsed.length;
    const keyFreq = new Map();
    for (const item of parsed.slice(0, 1000)) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        for (const k of Object.keys(item)) keyFreq.set(k, (keyFreq.get(k) ?? 0) + 1);
      }
    }
    out.itemKeys = [...keyFreq.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 64).map(([key, count]) => ({ key, count }));
    out.sampleItems = parsed.slice(0, L.maxSampleRows).map((x) => walk(x, 0));
    if (parsed.length > L.maxRows) { out.truncated = true; warnings.push(`array longer than ${L.maxRows} items`); }
  } else if (parsed && typeof parsed === 'object') {
    out.topLevelKeys = Object.keys(parsed).slice(0, L.maxFields)
      .map((k) => ({ key: k, type: Array.isArray(parsed[k]) ? `array(${parsed[k].length})` : typeof parsed[k] }));
    out.sampleItems = [walk(parsed, 0)];
  } else {
    out.scalarValue = parsed;
  }
  if (nodes > L.maxJsonNodes) warnings.push(`json walk truncated at ${L.maxJsonNodes} nodes`);
  return out;
}

// ---------------------------------------------------------------------------
// analysis schemes — resolved through the ReportSourceGateway seam
// ---------------------------------------------------------------------------

export function createAnalysisSource({ gateway, limits = {} } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  return {
    scheme: 'analysis', // virtual label; per-scheme dispatch happens in service
    async fetchFacts({ scheme, ref, version }) {
      if (!gateway) {
        throw new ReportSourceError(REPORT_ERROR.REPORT_SOURCE_UNAVAILABLE,
          'upstream deliveries/projects API is not wired for this installation', { retryable: true });
      }
      const res = await gateway.fetchSourceFacts({ scheme, ref, version, limits: L });
      if (!res || typeof res !== 'object' || !res.facts) {
        throw new ReportSourceError(REPORT_ERROR.SOURCE_READ_FAILED,
          `gateway returned no facts for ${scheme}:${ref}`);
      }
      return {
        scheme,
        facts: res.facts,
        sourceDigest: typeof res.sourceDigest === 'string' ? res.sourceDigest : digestOf(res.facts),
        watermark: typeof res.watermark === 'string' ? res.watermark : null,
        warnings: Array.isArray(res.warnings) ? res.warnings : [],
        bounds: res.bounds ?? { maxItems: L.maxRows },
      };
    },
  };
}

/**
 * ServiceClient-backed gateway (P5 wires this in production). `client` is a
 * structural subset of ServiceClient — only public, non-secret read APIs are
 * called: getProject / listProjectDeliveries / getDelivery /
 * getDeliveryChanges / getRun / listRuns. Facts are assembled defensively;
 * absent fields stay absent — never fabricated.
 */
export function createServiceClientGateway(client) {
  const watermarkOf = (...vals) => {
    const times = vals.filter((v) => typeof v === 'string' && v.length >= 10).sort();
    return times.length ? times[times.length - 1] : null;
  };
  return {
    async fetchSourceFacts({ scheme, ref, limits }) {
      if (scheme === REPORT_SOURCE_SCHEME.PROJECT) {
        const project = await client.getProject(ref);
        const deliveries = await safe(() => client.listProjectDeliveries(ref, { limit: limits.maxRows }), null);
        const runs = await safe(() => client.listRuns({ projectId: ref, limit: limits.maxRows }), null);
        const deliveryItems = itemsOf(deliveries);
        const runItems = itemsOf(runs);
        return {
          facts: {
            kind: 'project',
            project: pickPlain(project, ['projectId', 'id', 'name', 'displayName', 'projectRef', 'state', 'updatedAt', 'createdAt']),
            deliveries: {
              count: deliveryItems.length,
              states: histogram(deliveryItems, (d) => d?.state ?? d?.status ?? 'unknown'),
              recent: deliveryItems.slice(0, 25).map((d) => pickPlain(d, ['deliveryId', 'id', 'state', 'status', 'updatedAt', 'createdAt'])),
            },
            runs: {
              count: runItems.length,
              states: histogram(runItems, (r) => r?.state ?? r?.lifecycle ?? 'unknown'),
              recent: runItems.slice(0, 25).map((r) => pickPlain(r, ['runId', 'id', 'state', 'lifecycle', 'outcome', 'endedAt', 'updatedAt', 'createdAt'])),
            },
          },
          watermark: watermarkOf(project?.updatedAt, ...deliveryItems.map((d) => d?.updatedAt), ...runItems.map((r) => r?.endedAt ?? r?.updatedAt)),
        };
      }
      if (scheme === REPORT_SOURCE_SCHEME.DELIVERY) {
        const delivery = await client.getDelivery(ref);
        const changes = await safe(() => client.getDeliveryChanges(ref), null);
        const changeItems = itemsOf(changes);
        return {
          facts: {
            kind: 'delivery',
            delivery: pickPlain(delivery, ['deliveryId', 'id', 'state', 'status', 'projectId', 'title', 'updatedAt', 'createdAt', 'revision']),
            changes: {
              count: changeItems.length,
              kinds: histogram(changeItems, (c) => c?.kind ?? c?.changeKind ?? 'unknown'),
              items: changeItems.slice(0, 200).map((c) => pickPlain(c, ['path', 'kind', 'changeKind', 'summary', 'artifactRef'])),
            },
          },
          watermark: watermarkOf(delivery?.updatedAt),
        };
      }
      if (scheme === REPORT_SOURCE_SCHEME.RUN) {
        const run = await client.getRun(ref);
        return {
          facts: {
            kind: 'run',
            run: pickPlain(run, ['runId', 'id', 'state', 'lifecycle', 'outcome', 'projectId', 'startedAt', 'endedAt', 'updatedAt']),
            steps: Array.isArray(run?.steps) ? run.steps.slice(0, 200).map((s) => pickPlain(s, ['stepId', 'name', 'state', 'outcome', 'endedAt'])) : [],
            totals: pickPlain(run?.totals ?? run?.summary ?? null, ['stepCount', 'callCount', 'toolCallCount', 'knownTotalTokens']),
          },
          watermark: watermarkOf(run?.endedAt, run?.updatedAt),
        };
      }
      if (scheme === REPORT_SOURCE_SCHEME.SESSION) {
        const session = await client.getSessionSummary(ref);
        return {
          facts: {
            kind: 'session',
            session: pickPlain(session, ['sessionId', 'id', 'title', 'state', 'updatedAt', 'createdAt', 'messageCount']),
          },
          watermark: watermarkOf(session?.updatedAt),
        };
      }
      throw new ReportSourceError(REPORT_ERROR.REPORT_SOURCE_UNKNOWN, `unsupported source scheme ${scheme}`);
    },
  };
}

async function safe(fn, fallback) { try { return await fn(); } catch { return fallback; } }
function itemsOf(pageOrList) {
  if (Array.isArray(pageOrList)) return pageOrList;
  if (pageOrList && Array.isArray(pageOrList.items)) return pageOrList.items;
  if (pageOrList && Array.isArray(pageOrList.deliveries)) return pageOrList.deliveries;
  if (pageOrList && Array.isArray(pageOrList.runs)) return pageOrList.runs;
  if (pageOrList && Array.isArray(pageOrList.changes)) return pageOrList.changes;
  return [];
}
function pickPlain(obj, keys) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && (obj[k] === null || ['string', 'number', 'boolean'].includes(typeof obj[k]))) out[k] = obj[k];
  return out;
}
function histogram(items, keyOf) {
  const h = {};
  for (const it of items) { const k = String(keyOf(it)); h[k] = (h[k] ?? 0) + 1; }
  return h;
}
