/**
 * Personal REAL fixture — 真实链路：构建后的 Web → 构建后的 BFF → 当前源码
 * ACS/Product（`verification/personal-web/build-runtime.py` 产出的运行时）
 * + `PersonalWebFixture` 的本机协议模型与确定性 gate。
 *
 * 与 `personal-ui.ts` 的差别只在「源端」：这里没有 scripted ACS，模型调用
 * 由夹具按 `request-<n>` / `allow-<n>` 文件闸门放行，因此「模型调用在飞行中」
 * 是确定事件，控制命令可以打在一个真实 RUNNING 的 Run 上。
 *
 * 不修改任何产品代码：夹具复用既有 `verification/personal-web` 资产，
 * 只负责进程编排与取证。
 */
import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { ARTIFACTS_ROOT } from './run-artifacts';
import { startAcsProxy, type AcsProxy } from './acs-proxy';

const APP_ROOT = process.cwd();
const DIST = resolve(APP_ROOT, 'dist');
const BUNDLE = resolve(APP_ROOT, '.local/management-server/management-server.mjs');

export interface PersonalRealOptions {
  /** 观测开启（夹具 `-Dobservation.mode=REQUIRED` + BFF OBS_DB）。 */
  observation?: boolean;
  collaboration?: boolean;
  writable?: boolean;
  /** Session foundation 开启（PAUSE/RESUME 能力来源）。 */
  foundation?: boolean;
  /** BFF→ACS 之间挂故障注入代理（PRE-004/005 的传输时序需要）。 */
  proxy?: boolean;
}

export interface GateControl {
  /** 等夹具模型发起第 n 次调用（该调用已被闸门挂起）。 */
  waitForRequest(n: number, timeoutMs?: number): Promise<void>;
  /** 放行第 n 次模型调用。 */
  allow(n: number): void;
  /** 放行此后到达的每个模型调用（PRE-001/003 这类「只关心跑完」的场景）；返回停止函数。 */
  autoRelease(): () => void;
  /** 下一次应放行的序号（用例自己维护）。 */
  readonly seq: { value: number };
}

export interface PersonalRealFixture {
  readonly url: string;
  readonly root: string;
  readonly acsUrl: string;
  readonly acsToken: string;
  readonly gate: GateControl;
  readonly observation: boolean;
  /** 关掉并重建 BFF 进程：同端口、同状态目录（PRE-002 的中途重启）。 */
  restartBff(): Promise<void>;
  /** 非正常结束 BFF（SIGKILL），模拟进程被杀而不是优雅退出。 */
  killBffHard(): Promise<void>;
  /** 故障注入代理；未开启时为 undefined。 */
  readonly proxy?: AcsProxy;
  /** 直接读源端（取证用，不经 BFF）。 */
  acs<T = unknown>(path: string): Promise<{ status: number; body: T }>;
  /**
   * 以「已登记的客户端会话」读源端：`/runs/{id}/commands` 等端点要求
   * client session 注册（否则 428 CLIENT_REGISTRATION_REQUIRED）。
   */
  acsSession<T = unknown>(path: string): Promise<{ status: number; body: T }>;
  /** 从 Node 侧读 BFF（取证用，避免被页面路由/焦点时序影响）。 */
  bff<T = unknown>(path: string, options?: {method:'POST';body:Record<string,unknown>}): Promise<{ status: number; body: T }>;
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
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE',
  'NUMBER_OF_PROCESSORS', 'JAVA_HOME',
]);

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && ALLOWED_ENV.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

/** 找到 classpath.txt：显式 `PERSONAL_E2E_RUNTIME` 优先，否则取最新构建。 */
function resolveRuntime(): string {
  const explicit = process.env.PERSONAL_E2E_RUNTIME;
  if (explicit) {
    const file = join(resolve(explicit), 'classpath.txt');
    if (!existsSync(file)) throw new Error(`[personal-real] PERSONAL_E2E_RUNTIME 缺少 classpath.txt：${file}`);
    return file;
  }
  const local = resolve(APP_ROOT, '.local');
  if (!existsSync(local)) throw new Error('[personal-real] 缺少 .local/，先构建运行时（见下）');
  const candidates = readdirSync(local)
    .filter(name => name.startsWith('personal-web-runtime'))
    .map(name => join(local, name, 'classpath.txt'))
    .filter(file => existsSync(file))
    // 取最新构建：夹具源码会变（例如 gate 协议），旧 classpath 仍能启动但行为不同。
    .map(file => ({ file, at: statSync(file).mtimeMs }))
    .sort((a, b) => a.at - b.at)
    .map(item => item.file);
  if (!candidates.length) {
    throw new Error([
      '[personal-real] 找不到真实运行时 classpath.txt。',
      '先执行：python verification/personal-web/build-runtime.py --workspace <your-workspace> --output .local/personal-web-runtime-new',
      '或设置 PERSONAL_E2E_RUNTIME=<该输出目录>。',
    ].join('\n'));
  }
  return candidates[candidates.length - 1];
}

export const test = base.extend<{ personalRealOptions: PersonalRealOptions; personalReal: PersonalRealFixture }>({
  personalRealOptions: [{ observation: true, foundation: true }, { option: true }],

  personalReal: async ({ personalRealOptions }, use, testInfo) => {
    if (!existsSync(join(DIST, 'index.html'))) {
      throw new Error(`[personal-real] ${join(DIST, 'index.html')} 不存在 —— 先运行 pnpm build`);
    }
    if (!existsSync(BUNDLE)) {
      throw new Error(`[personal-real] ${BUNDLE} 不存在 —— 先运行 pnpm management:build`);
    }
    const classpath = resolveRuntime();
    // 根目录必须全 ASCII：夹具要在里面跑 `git init/commit`，而 Playwright 的
    // outputPath 会把用例标题（中文、箭头）带进路径，Windows 上的 git 子进程
    // 会因此返回非零。用例 id 用作可读前缀，其余用数字保证唯一。
    const caseId = /PRE-\d+|PUI-\d+/.exec(testInfo.title)?.[0] ?? 'case';
    const root = resolve(APP_ROOT, '.local', 'pr', `${caseId}-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const gateDir = join(root, 'gate');
    mkdirSync(gateDir, { recursive: true });
    const observation = personalRealOptions.observation !== false;
    const foundation = personalRealOptions.foundation !== false;

    const hostLog = join(testInfo.outputPath('acs.log'));
    const bffLogPath = join(testInfo.outputPath('bff.log'));
    writeFileSync(hostLog, '', 'utf8');
    writeFileSync(bffLogPath, '', 'utf8');

    const javaArgs = [
      '-Duser.language=en', '-Dfile.encoding=UTF-8',
      `-Duser.home=${join(root, 'isolated-home')}`,
      `-Dobservation.mode=${observation ? 'REQUIRED' : 'DISABLED'}`,
      `-Dpersonal.fixture.foundation=${foundation ? 'true' : 'false'}`,
      `-Dpersonal.fixture.gate=${gateDir}`,
      `-Dpersonal.fixture.collaboration=${personalRealOptions.collaboration===true}`,
      `-Dpersonal.fixture.writable=${personalRealOptions.writable===true}`,
      '-cp', readFileSync(classpath, 'utf8').trim(),
      'com.sage.business.code.bootstrap.PersonalWebFixture',
      join(root, 'host'),
    ];
    const host = spawn('java', javaArgs, { env: baseEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    // stdout carries a transient credential in PERSONAL_WEB_READY; the ready parser consumes it without logging.

    host.stderr?.on('data', (chunk: Buffer) => appendFileSync(hostLog, chunk));

    let acsUrl = '';
    let acsToken = '';
    const ready = new Promise<void>((done, fail) => {
      const deadline = setTimeout(() => fail(new Error(`[personal-real] ACS 就绪超时；日志：${hostLog}`)), 120_000);
      let buffer = '';
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.startsWith('PERSONAL_WEB_READY ')) {
            const payload = JSON.parse(line.slice('PERSONAL_WEB_READY '.length)) as { baseUrl: string; token: string };
            acsUrl = payload.baseUrl;
            acsToken = payload.token;
            clearTimeout(deadline);
            done();
            return;
          }
          index = buffer.indexOf('\n');
        }
      };
      host.stdout?.on('data', onData);
      host.once('exit', (code) => {
        clearTimeout(deadline);
        fail(new Error(`[personal-real] ACS 提前退出（${code}）；日志：${hostLog}`));
      });
    });

    const seq = { value: 0 };
    const gate: GateControl = {
      seq,
      async waitForRequest(n, timeoutMs = 150_000) {
        const file = join(gateDir, `request-${n}`);
        const deadline = Date.now() + timeoutMs;
        while (!existsSync(file)) {
          if (Date.now() > deadline) throw new Error(`[personal-real] 等第 ${n} 次模型调用超时`);
          await new Promise((done) => setTimeout(done, 100));
        }
      },
      allow(n) { writeFileSync(join(gateDir, `allow-${n}`), ''); },
      autoRelease() {
        let stopped = false;
        const timer = setInterval(() => {
          if (stopped) return;
          let names: string[] = [];
          try { names = readdirSync(gateDir); } catch { return; }
          for (const name of names) {
            const matched = /^request-(\d+)$/.exec(name);
            if (!matched) continue;
            const allow = join(gateDir, `allow-${matched[1]}`);
            if (!existsSync(allow)) { try { writeFileSync(allow, ''); } catch { /* racing */ } }
          }
        }, 200);
        return () => { stopped = true; clearInterval(timer); };
      },
    };

    let child: ChildProcess | undefined;
    let port = 0;
    let url = '';
    let proxy: AcsProxy | undefined;
    let sessionToken: string | undefined;

    const bffEnv = (): Record<string, string> => ({
      ...baseEnv(),
      PERSONAL_ACS_URL: proxy?.url ?? acsUrl,
      PERSONAL_ACS_TOKEN: acsToken,
      PERSONAL_ACS_KIND: 'ACS_DIRECT',
      PERSONAL_CONSOLE_PORT: String(port),
      PERSONAL_CONSOLE_ROOT: root,
      PERSONAL_DATA_DIR: join(root, 'personal'),
      PERSONAL_REPORTS_ENABLED: '0',
      NODE_NO_WARNINGS: '1',
      ...(observation ? {
        OBS_DB: join(root, 'host', 'state', 'observations', 'observations.db'),
        OBS_MODE: 'LIVE',
        PERSONAL_OBSERVATION_SOURCE_ID: 'env-obs-db',
      } : {}),
    });

    const stopBff = async () => {
      if (!child || child.exitCode !== null) return;
      const dying = child;
      child = undefined;
      await new Promise<void>((done) => {
        const timer = setTimeout(() => { try { process.kill(dying.pid!, 'SIGKILL'); } catch { /* gone */ } done(); }, 10_000);
        dying.once('exit', () => { clearTimeout(timer); done(); });
        try { dying.kill('SIGTERM'); } catch { clearTimeout(timer); done(); }
      });
    };

    const bootBff = async () => {
      const log = appendFileSync;
      child = spawn(process.execPath, [BUNDLE], { cwd: APP_ROOT, env: bffEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk: Buffer) => log(bffLogPath, chunk));
      child.stderr?.on('data', (chunk: Buffer) => log(bffLogPath, chunk));
      child.once('exit', (code, signal) => log(bffLogPath, `\n[bff-exit] code=${code} signal=${signal}\n`));
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (child.exitCode !== null) {
          throw new Error(`[personal-real] BFF 提前退出（${child.exitCode}）；日志：${bffLogPath}\n${readFileSync(bffLogPath, 'utf8').slice(-2000)}`);
        }
        try {
          const response = await fetch(`${url}/personal.html`, { signal: AbortSignal.timeout(1_500) });
          if (response.ok) break;
        } catch { /* not ready */ }
        if (Date.now() > deadline) throw new Error(`[personal-real] BFF 就绪超时；日志：${bffLogPath}`);
        await new Promise((done) => setTimeout(done, 200));
      }
      // 静态页可读不等于个人网关已挂载：首个 /api/personal 请求若早于挂载
      // 会被直接断连（浏览器侧表现为 “Failed to fetch”）。以真实读取作为就绪条件。
      for (;;) {
        try {
          const response = await fetch(`${url}/api/personal/v1/projects/available`, {
            headers: { 'x-personal-control': '1', 'x-personal-tab': 'fixture-readiness' },
            signal: AbortSignal.timeout(10_000),
          });
          if (response.ok) break;
        } catch { /* gateway still mounting */ }
        if (Date.now() > deadline + 60_000) {
          throw new Error(`[personal-real] 个人网关就绪超时；日志：${bffLogPath}`);
        }
        await new Promise((done) => setTimeout(done, 250));
      }
    };

    try {
      await ready;
      if (personalRealOptions.proxy) proxy = await startAcsProxy(acsUrl);
      port = await freePort();
      url = `http://127.0.0.1:${port}`;
      await bootBff();

      const fixture: PersonalRealFixture = {
        get url() { return url; },
        get root() { return root; },
        get acsUrl() { return acsUrl; },
        get acsToken() { return acsToken; },
        get proxy() { return proxy; },
        gate,
        observation,
        async restartBff() {
          await stopBff();
          await bootBff();
        },
        async killBffHard() {
          if (!child || child.exitCode !== null) return;
          const dying = child;
          child = undefined;
          dying.kill('SIGKILL');
          await new Promise<void>((done) => {
            const timer = setTimeout(done, 10_000);
            dying.once('exit', () => { clearTimeout(timer); done(); });
          });
        },
        async acs<T>(path: string) {
          const response = await fetch(`${acsUrl}${path}`, {
            headers: { authorization: `Bearer ${acsToken}`, 'content-type': 'application/json' },
            signal: AbortSignal.timeout(20_000),
          });
          const text = await response.text();
          let body: unknown = text;
          try { body = JSON.parse(text); } catch { /* keep text */ }
          return { status: response.status, body: body as T };
        },
        async acsSession<T>(path: string) {
          if (!sessionToken) {
            const key = randomUUID();
            const response = await fetch(`${acsUrl}/api/v2/client-sessions`, {
              method: 'POST',
              headers: { authorization: `Bearer ${acsToken}`, 'content-type': 'application/json', 'idempotency-key': key },
              body: JSON.stringify({
                registrationKey: key, clientId: key, processInstanceId: key,
                clientKind: 'WEB_TAB', protocols: ['run-command/1'], displayLabel: 'personal-e2e-evidence',
              }),
              signal: AbortSignal.timeout(20_000),
            });
            const registered = await response.json().catch(() => null) as { clientSessionToken?: string } | null;
            if (!response.ok || !registered?.clientSessionToken) {
              throw new Error(`[personal-real] 客户端会话登记失败：HTTP ${response.status} ${JSON.stringify(registered)}`);
            }
            sessionToken = registered.clientSessionToken;
          }
          const response = await fetch(`${acsUrl}${path}`, {
            // 会话令牌走独立头，Authorization 仍是连接级 token（见 ServiceClient）。
            headers: {
              authorization: `Bearer ${acsToken}`,
              'x-codeagent-client-token': sessionToken,
              'content-type': 'application/json',
            },
            signal: AbortSignal.timeout(20_000),
          });
          const text = await response.text();
          let body: unknown = text;
          try { body = JSON.parse(text); } catch { /* keep text */ }
          return { status: response.status, body: body as T };
        },
        async bff<T>(path: string, options?: {method:'POST';body:Record<string,unknown>}) {
          const response = await fetch(`${url}${path}`, {
            method:options?.method??'GET',
            body:options?JSON.stringify(options.body):undefined,
            headers: { 'x-personal-control': '1', 'x-personal-tab': 'fixture-evidence', ...(options?{'content-type':'application/json','idempotency-key':String(options.body.requestKey)}:{}) },
            signal: AbortSignal.timeout(30_000),
          });
          const text = await response.text();
          let body: unknown = text;
          try { body = JSON.parse(text); } catch { /* keep text */ }
          return { status: response.status, body: body as T };
        },
      };

      await use(fixture);
    } finally {
      await stopBff();
      await proxy?.close().catch(() => undefined);
      if (host.exitCode === null) {
        try { host.stdin?.write('\n'); host.stdin?.end(); } catch { /* ignore */ }
        await new Promise<void>((done) => {
          const timer = setTimeout(() => { try { host.kill('SIGKILL'); } catch { /* gone */ } done(); }, 20_000);
          host.once('exit', () => { clearTimeout(timer); done(); });
        });
      }
      if (!testInfo.errors.length) {
        // 不删运行目录：里面是真实工作树、状态库与 gate 记录，正是取证材料。
        // （同时也避开批量删除保护对测试收尾的干扰。）
      }
    }
  },
});

export { expect };
