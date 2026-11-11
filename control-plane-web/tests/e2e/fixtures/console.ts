/**
 * E2E console fixture — one isolated personal console per test.
 *
 * Real BFF in-process (createManagementServer) + real SQLite + random port +
 * mkdtemp state root; managed workers spawn the node fake daemon through the
 * documented `lifecycleDeps.planSpawn` seam, so no java and no release tree are
 * required and every state transition is deterministic.
 *
 * Run from the package root (`pnpm e2e`): the built SPA in ./dist is the app
 * under test, so `pnpm build` must have run first.
 */
import { test as base, expect } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createManagementServer, type ManagementHandle } from '../../../server/management/server';
import type { LifecycleDeps, SpawnSpec } from '../../../server/management/lifecycle';
import type { ManagedConfig, WorkerRow } from '../../../server/management/store';

const APP_ROOT = process.cwd();
const DIST = resolve(APP_ROOT, 'dist');
const STUB_DAEMON = resolve(APP_ROOT, 'tests', 'e2e', 'fixtures', 'bin', 'fake-daemon.mjs');

/** Spawn plan for a managed worker: `<stateDir> <healthPort>` into the fake daemon. */
export function stubPlan(env: Record<string, string> = {}) {
  return (w: WorkerRow): SpawnSpec[] => {
    const cfg = w.config as ManagedConfig;
    return [{
      role: 'daemon',
      command: process.execPath,
      args: [STUB_DAEMON, cfg.dirs.state, String(cfg.ports.health)],
      env,
    }];
  };
}

export interface ConsoleOptions {
  /** Extra env for the fake daemon (e.g. STUB_READY=0). */
  stubEnv?: Record<string, string>;
  /** Lifecycle budget overrides — keep them small so failures are fast. */
  deps?: Omit<LifecycleDeps, 'planSpawn'>;
}

export interface ConsoleFixture {
  /** http://127.0.0.1:<port> — page.goto(`${url}/#/manage…`) */
  readonly url: string;
  /** mkdtemp state root: management.db + workers/ */
  readonly root: string;
  readonly handle: ManagementHandle;
  /** Every handle created so far (restart() adds one). */
  readonly handles: ManagementHandle[];
  /**
   * Restart the console process semantics: close server + db, leave worker
   * children alive (product behaviour), reopen the same state root and re-listen
   * on the same port so `console.url` stays valid.
   */
  restart(): Promise<void>;
}

/**
 * Close the BFF for real: `server.close()` alone waits for idle keep-alive
 * sockets (Chromium keeps them open), which would hang teardown.
 */
async function closeServer(handle: ManagementHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      handle.server.close(() => resolve());
      handle.server.closeAllConnections?.();
    } catch { resolve(); }
    setTimeout(resolve, 2_000).unref?.();
  });
}

async function listenOn(handle: ManagementHandle, port: number): Promise<number> {  const tryListen = (p: number) => new Promise<number>((res, rej) => {
    const onError = (e: Error) => { handle.server.off('listening', onListening); rej(e); };
    const onListening = () => { handle.server.off('error', onError); res((handle.server.address() as any).port); };
    handle.server.once('error', onError);
    handle.server.once('listening', onListening);
    handle.server.listen(p, '127.0.0.1');
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    try { return await tryListen(port); } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  return tryListen(0);   // give up on the old port, take any
}

export const test = base.extend<{ consoleOptions: ConsoleOptions; console: ConsoleFixture }>({
  consoleOptions: [{}, { option: true }],

  console: async ({ consoleOptions }, use) => {
    if (!existsSync(join(DIST, 'index.html'))) {
      throw new Error(`[e2e] ${join(DIST, 'index.html')} 不存在 —— 先运行 pnpm build（E2E 打的是构建产物，不是 dev server）`);
    }
    if (!existsSync(STUB_DAEMON)) throw new Error(`[e2e] 缺少 fake daemon: ${STUB_DAEMON}`);

    const root = mkdtempSync(join(tmpdir(), 'pc-e2e-'));
    const handles: ManagementHandle[] = [];
    let port = 0;

    const deps: LifecycleDeps = {
      planSpawn: stubPlan(consoleOptions.stubEnv),
      readyBudgetMs: 8_000,
      liveBudgetMs: 6_000,
      controlBudgetMs: 6_000,
      stopWaitMs: 3_000,
      ...consoleOptions.deps,
    };

    const boot = async () => {
      const handle = createManagementServer({ root, dist: DIST, lifecycleDeps: deps });
      handles.push(handle);
      await handle.ready;
      port = await listenOn(handle, port);
      return handle;
    };

    let handle = await boot();

    const fixture: ConsoleFixture = {
      get url() { return `http://127.0.0.1:${port}`; },
      get root() { return root; },
      get handle() { return handle; },
      get handles() { return handles; },
      async restart() {
        // Console restart, not worker restart: children keep running and the
        // next boot re-adopts them by pid + command-line ownership.
        await closeServer(handle);
        try { handle.store.close(); } catch { /* already closed */ }
        handle = await boot();
      },
    };

    try {
      await use(fixture);
    } finally {
      for (const h of handles) {
        await h.lifecycle.stopChildren().catch(() => {});
        await closeServer(h);
        try { h.store.close(); } catch { /* already closed */ }
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
});

export { expect };
