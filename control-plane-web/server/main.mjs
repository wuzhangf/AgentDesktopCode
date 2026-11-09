// /api/v2 read-only observation BFF (§9.1, §10). Loopback only; serves the
// built SPA from dist/ when present. All DB work happens in per-source reader
// worker threads; every combined response is produced inside one short read
// transaction (§10.2).
import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSourceConfig } from './config/sources.mjs';
import { ReaderPool } from './db/workerPool.mjs';
import { ROUTES, buildParams } from './routes/index.mjs';
import { envelope, page } from './lib/dto.mjs';
import { encodeCursor } from './lib/cursor.mjs';
import { toApiError, ApiError, notFound, badRequest, unavailable } from './lib/errors.mjs';
import { toCsv } from './lib/csv.mjs';
import { METRIC_VERSION } from '../shared/contracts/enums.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const DIST = resolve(appRoot, 'dist');
const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? '127.0.0.1';

const config = loadSourceConfig();
const pool = new ReaderPool(config.sources.filter((s) => s.available), config.guiSources);

// ---- response meta plumbing ----

function sourceFromRequest(sp) {
  const id = sp.get('sourceId') ?? config.defaultSourceId;
  const source = config.sources.find((s) => s.id === id);
  if (!source) throw badRequest(`unknown sourceId: ${id}`);
  if (!source.available) throw unavailable(`source ${id} is not available`);
  return source;
}

function matchRoute(method, pathname) {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const seg = r.path.split('/');
    const parts = pathname.split('/');
    if (seg.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < seg.length; i++) {
      if (seg[i].startsWith(':')) {
        try { params[seg[i].slice(1)] = decodeURIComponent(parts[i]); }
        catch { ok = false; break; }
      }
      else if (seg[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, seg: params };
  }
  return null;
}

async function metaSources() {
  const out = [];
  for (const s of config.sources) {
    const base = {
      id: s.id, label: s.label, mode: s.mode, available: s.available,
      sourceEpoch: s.sourceEpoch, isDefault: s.id === config.defaultSourceId,
      schemaVersion: null, dataAsOf: null, scopes: [],
    };
    if (!s.available) {
      out.push({ ...base, unavailableReason: '文件不存在或不可读' });
      continue;
    }
    try {
      const { result: info, dataAsOf } = await pool.exec(s.id, 'obs.metaSourceInfo', {});
      out.push({ ...base, schemaVersion: info.schemaVersion, dataAsOf: info.dataAsOf ?? dataAsOf, scopes: info.scopes });
    } catch (err) {
      out.push({ ...base, unavailableReason: '暂不可读', detail: undefined });
    }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

async function serveStatic(res, pathname) {
  if (!existsSync(DIST)) return false;
  let rel;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  } catch {
    return false;
  }
  let file = join(DIST, rel);
  // Containment check must be separator-aware: 'D:\dist-evil' also starts with 'D:\dist'.
  if (file !== DIST && !file.startsWith(DIST + sep)) return false;
  let st = null;
  try { st = statSync(file); } catch { st = null; }
  if (!st || file.endsWith(sep) || st.isDirectory()) {
    file = join(DIST, 'index.html');
    if (!existsSync(file)) return false;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const send = (status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(obj));
  };
  try {
    // Host allow-list: loopback only (§13.3). IPv6 hosts arrive bracketed.
    const hostHeader = req.headers.host ?? '';
    const host = hostHeader.startsWith('[')
      ? hostHeader.slice(1).split(']')[0]
      : hostHeader.split(':')[0];
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
      throw badRequest('host not allowed');
    }
    const m = matchRoute(req.method, url.pathname);
    if (!m) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        if (await serveStatic(res, url.pathname)) return;
      }
      throw notFound();
    }
    const { route, seg } = m;
    const sp = url.searchParams;

    if (route.handler === 'metaSources') {
      const sources = await metaSources();
      send(200, {
        meta: {
          apiVersion: '2', metricVersion: METRIC_VERSION, sourceId: '', sourceEpoch: '',
          mode: 'SNAPSHOT', scopeId: '', schemaVersion: 1, snapshotId: `meta-${Date.now()}`,
          queriedAt: Date.now(), dataAsOf: null, timezone: 'Asia/Shanghai',
          filtersApplied: {}, warnings: [], queryDurationMs: Date.now() - startedAt,
        },
        data: { sources, defaultSourceId: config.defaultSourceId, guiAvailable: config.guiSources.some((g) => g.available) },
      });
      return;
    }

    const source = route.gui
      ? { id: '__gui__', sourceEpoch: 'gui', mode: 'SNAPSHOT', path: null }
      : sourceFromRequest(sp);
    if (route.gui) {
      const guiSrc = config.guiSources.find((g) => g.available);
      if (!guiSrc) {
        send(200, envelope(
          { source: { id: 'gui', sourceEpoch: '', mode: 'SNAPSHOT' }, scopeId: '', timezone: 'Asia/Shanghai', filtersApplied: {} },
          { available: false, rows: [], note: 'GUI 会话库未配置或不可读；观测页面不受影响。' },
          { startedAt },
        ));
        return;
      }
      // Sessions go through any available reader (gui db attached there).
      const anySource = config.sources.find((s) => s.available);
      if (!anySource) throw unavailable('no observation source available to reach GUI db');
      const guiParams = route.build ? route.build(sp, seg) : {};
      const { result } = await execWithMeta(anySource.id, route.op, guiParams);
      send(200, envelope(
        { source: anySource, scopeId: '', timezone: 'Asia/Shanghai', filtersApplied: {} },
        result ?? { available: false, rows: [], note: 'GUI 会话库未配置或不可读；观测页面不受影响。' }, { startedAt },
      ));
      return;
    }

    const built = buildParams(route, sp, seg, source);
    const { result, dataAsOf, schemaVersion } = await execWithMeta(source.id, route.op, built.params);
    // Split declared filters into applied/ignored so meta never claims a
    // filter took effect when the repository does not implement it.
    const filters = built.params.filters ?? {};
    const appliedKeys = typeof route.applied === 'function' ? route.applied(built.params) : route.applied;
    const filtersApplied = {};
    const filtersIgnored = {};
    for (const [k, v] of Object.entries(filters)) {
      (appliedKeys == null || appliedKeys.includes(k) ? filtersApplied : filtersIgnored)[k] = v;
    }
    const warnings = Object.keys(filtersIgnored).length
      ? [{ code: 'FILTERS_IGNORED', message: `此端点未实现以下筛选参数: ${Object.keys(filtersIgnored).join(', ')}` }]
      : [];
    const reqCtx = {
      source, scopeId: built.params.scopeId ?? '', schemaVersion,
      from: built.params.from ?? built.window?.from,
      to: built.params.to ?? built.window?.to,
      timezone: built.params.timezone ?? built.window?.timezone,
      grain: built.params.grain ?? built.window?.grain,
      filtersApplied, filtersIgnored,
    };
    if (result == null) throw notFound('record not found in current scope');

    if (route.csv) {
      const meta = envelope(reqCtx, null, { dataAsOf, startedAt, warnings }).meta;
      const csv = toCsv({ meta, columns: result.columns, rows: result.rows });
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${route.csv === true ? 'analytics' : route.csv}-${source.id}.csv"`,
      });
      res.end(csv);
      return;
    }

    if (route.paged && result && Array.isArray(result.rows)) {
      const nextCursor = result.hasMore && result.lastId != null
        ? encodeCursor({
          sourceEpoch: source.sourceEpoch, scopeId: built.params.scopeId,
          filterHash: built.filterHash ?? filterHashOf(built),
          sortValues: [result.lastSortValue], entityId: result.lastId,
        })
        : null;
      const data = page(result.rows, nextCursor, { total: result.total, truncated: false });
      send(200, envelope(reqCtx, data, { dataAsOf, startedAt, warnings }));
      return;
    }

    send(200, envelope(reqCtx, result, { dataAsOf, startedAt, warnings }));
  } catch (err) {
    const apiErr = err?.apiError ? workerApiError(err.apiError) : toApiError(err);
    send(apiErr.status ?? 500, apiErr.toBody());
  }
});

// Worker task failures arrive as {apiError:{code,message,retryable}}. Map the
// known codes to real statuses and route QUERY_FAILED through the same
// sanitization as direct errors (raw SQLite messages stay server-side).
function workerApiError(e) {
  if (e.code === 'QUERY_FAILED') {
    console.warn(`[worker] query failed: ${e.message}`);
    return toApiError(new Error(e.message));
  }
  const status = { SOURCE_UNAVAILABLE: 503, BAD_REQUEST: 400 }[e.code] ?? 500;
  return new ApiError(status, e.code, e.message, { retryable: Boolean(e.retryable) });
}

function filterHashOf(built) {
  return built.params.filterHash ?? '';
}

async function execWithMeta(sourceId, op, params) {
  // Worker returns {result, dataAsOf, schemaVersion} (post-processed below).
  const raw = await pool.exec(sourceId, op, params);
  if (raw && typeof raw === 'object' && 'result' in raw && 'dataAsOf' in raw) return raw;
  return { result: raw, dataAsOf: null, schemaVersion: null };
}

server.listen(PORT, HOST, () => {
  console.log(`[observation-api v2] http://${HOST}:${PORT}`);
  for (const s of config.sources) {
    console.log(`  source ${s.id} [${s.mode}] ${s.available ? s.path : '(missing: ' + s.path + ')'}`);
  }
  const gui = config.guiSources.find((g) => g.available);
  console.log(`  gui: ${gui ? gui.path : '(none)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await pool.destroy();
    process.exit(0);
  });
}
