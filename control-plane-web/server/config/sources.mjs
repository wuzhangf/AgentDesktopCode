// Data-source whitelist (§10.1). Clients only ever pass a sourceId alias —
// never a path. OBS_DB / OBS_MODE remain as a single-source override.
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', '..');
const repoRoot = resolve(appRoot, '..', '..');

const MODES = new Set(['SNAPSHOT', 'LIVE', 'DEMO']);

function defaultSources() {
  return [
    {
      id: 'specified-snapshot',
      label: '用户指定快照',
      path: resolve(appRoot, 'data/observations.db'),
      mode: 'SNAPSHOT',
    },
    {
      id: 'local-state',
      label: '本地运行数据',
      path: resolve(repoRoot, 'busi-agent-config/state/observations/observations.db'),
      altPaths: [
        process.env.OBSERVATIONS_DB_PATH ?? 'busi-agent-config/state/observations/observations.db',
      ],
      mode: 'LIVE',
    },
    {
      id: 'demo',
      label: '演示数据',
      path: resolve(appRoot, 'demo-data/agent-operations-demo.db'),
      mode: 'DEMO',
      optional: true,
    },
  ];
}

function defaultGuiSources() {
  return [
    {
      id: 'gui-local',
      label: 'GUI 会话库',
      path: resolve(appRoot, 'data/gui-sessions.db'),
      optional: true,
    },
  ];
}

function resolvePath(p, altPaths = []) {
  if (p && existsSync(p)) return p;
  for (const alt of altPaths) {
    const ap = isAbsolute(alt) ? alt : resolve(repoRoot, alt);
    if (existsSync(ap)) return ap;
  }
  return p;
}

export function loadSourceConfig() {
  let fileConfig = null;
  const configPath = resolve(here, 'data-sources.json');
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.warn(`[sources] failed to parse ${configPath}: ${err.message}`);
    }
  }

  let sources = fileConfig?.sources ?? defaultSources();
  let guiSources = fileConfig?.guiSources ?? defaultGuiSources();
  let defaultSourceId = fileConfig?.defaultSourceId ?? 'specified-snapshot';

  // Single-source env override (backwards compat with OBS_DB).
  if (process.env.OBS_DB) {
    sources = [{
      id: 'env-obs-db',
      label: 'OBS_DB 指定源',
      path: process.env.OBS_DB,
      mode: MODES.has(process.env.OBS_MODE) ? process.env.OBS_MODE : 'LIVE',
    }];
    defaultSourceId = 'env-obs-db';
  }
  if (process.env.GUI_DB) {
    guiSources = [{ id: 'gui-env', label: 'GUI_DB 指定源', path: process.env.GUI_DB, optional: true }];
  }

  const epoch = randomUUID();
  const normalized = sources.map((s, i) => {
    if (!s.id || !/^[\w-]{1,64}$/.test(s.id)) throw new Error(`source #${i} has invalid id`);
    if (!MODES.has(s.mode)) throw new Error(`source ${s.id} has invalid mode ${s.mode}`);
    const path = resolvePath(s.path, s.altPaths);
    return {
      id: s.id,
      label: s.label || s.id,
      path,
      mode: s.mode,
      optional: Boolean(s.optional),
      available: path ? existsSync(path) : false,
      sourceEpoch: `${epoch}:${s.id}`,
      costAuthorityPolicy: s.costAuthorityPolicy ?? null,
    };
  });
  const gui = guiSources.map((g) => {
    const path = resolvePath(g.path, g.altPaths);
    return { id: g.id, label: g.label || g.id, path, optional: true, available: path ? existsSync(path) : false };
  });
  if (!normalized.some((s) => s.id === defaultSourceId)) {
    defaultSourceId = normalized[0]?.id ?? null;
  }
  return { sources: normalized, guiSources: gui, defaultSourceId };
}
