/**
 * Personal UI fixture — 每例一个真实 BFF 进程（构建产物
 * `.local/management-server/management-server.mjs`）+ 真实 SQLite +
 * 真实 ServiceClient + 本机 scripted ACS。
 *
 * 为什么用子进程而不是 import 源码：`server/management/reports-sqlite.ts`
 * 用 `import ddl from './reports/ddl.sql?raw'`，那是 Vite 的 `?raw` 能力；
 * Playwright 的转译器没有该插件。构建产物已内联该 SQL，也正是生产装配方式。
 */
import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startScriptedAcs, type ScriptedAcs } from './scripted-acs';

const APP_ROOT = process.cwd();
const DIST = resolve(APP_ROOT, 'dist');
const BUNDLE = resolve(APP_ROOT, '.local/management-server/management-server.mjs');

export interface PersonalUiOptions {
  /** 覆盖 scripted ACS 的项目列表（空数组 = 源端没有可用项目）。 */
  projects?: Record<string, unknown>[];
}

export interface PersonalUiFixture {
  readonly url: string;
  readonly root: string;
  readonly source: ScriptedAcs;
  /** 关闭并重建 BFF 进程：同端口、同状态目录。 */
  restartBff(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

const ALLOWED_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'NUMBER_OF_PROCESSORS',
]);

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ALLOWED_ENV.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

export const test = base.extend<{ personalUiOptions: PersonalUiOptions; personalUi: PersonalUiFixture }>({
  personalUiOptions: [{}, { option: true }],

  personalUi: async ({ personalUiOptions }, use, testInfo) => {
    if (!existsSync(join(DIST, 'index.html'))) {
      throw new Error(`[personal-e2e] ${join(DIST, 'index.html')} 不存在 —— 先运行 pnpm build（打的是构建产物，不是 dev server）`);
    }
    if (!existsSync(BUNDLE)) {
      throw new Error(`[personal-e2e] ${BUNDLE} 不存在 —— 先运行 pnpm management:build（UI 打的是构建后的 BFF）`);
    }

    const root = mkdtempSync(join(tmpdir(), 'personal-ui-'));
    const source = await startScriptedAcs();
    if (personalUiOptions.projects) source.setProjects(personalUiOptions.projects);
    const logPath = testInfo.outputPath('bff.log');
    const logs: string[] = [];
    let child: ChildProcess | undefined;
    let port = 0;
    let url = '';

    const stop = async () => {
      if (!child || child.exitCode !== null) return;
      const dying = child;
      child = undefined;
      await new Promise<void>((done) => {
        const timer = setTimeout(() => { try { process.kill(dying.pid!, 'SIGKILL'); } catch { /* gone */ } done(); }, 8_000);
        dying.once('exit', () => { clearTimeout(timer); done(); });
        try { dying.kill('SIGTERM'); } catch { clearTimeout(timer); done(); }
      });
    };

    const boot = async () => {
      const env: Record<string, string> = {
        ...baseEnv(),
        PERSONAL_ACS_URL: source.baseUrl,
        PERSONAL_ACS_TOKEN: source.token,
        PERSONAL_ACS_KIND: 'ACS_DIRECT',
        PERSONAL_CONSOLE_PORT: String(port),
        PERSONAL_CONSOLE_ROOT: root,
        PERSONAL_DATA_DIR: join(root, 'personal'),
        PERSONAL_REPORTS_ENABLED: '0',
        NODE_NO_WARNINGS: '1',
      };
      child = spawn(process.execPath, [BUNDLE], { cwd: APP_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString('utf8')));
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (child.exitCode !== null) {
          writeFileSync(logPath, logs.join(''), 'utf8');
          throw new Error(`[personal-e2e] BFF 提前退出（${child.exitCode}）；日志：${logPath}\n${logs.join('').slice(-2000)}`);
        }
        try {
          const response = await fetch(`${url}/personal.html`, { signal: AbortSignal.timeout(1_500) });
          if (response.ok) return;
        } catch { /* not ready yet */ }
        if (Date.now() > deadline) {
          writeFileSync(logPath, logs.join(''), 'utf8');
          throw new Error(`[personal-e2e] BFF 就绪超时；日志：${logPath}`);
        }
        await new Promise((done) => setTimeout(done, 150));
      }
    };

    port = await freePort();
    url = `http://127.0.0.1:${port}`;
    await boot();

    const fixture: PersonalUiFixture = {
      get url() { return url; },
      get root() { return root; },
      get source() { return source; },
      async restartBff() {
        await stop();
        await boot();
      },
    };

    try {
      await use(fixture);
    } finally {
      await stop();
      writeFileSync(logPath, logs.join(''), 'utf8');
      await source.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  },
});

export { expect };
