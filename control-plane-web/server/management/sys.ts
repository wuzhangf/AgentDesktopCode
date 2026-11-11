/** Process + loopback HTTP primitives shared by probe and lifecycle. */
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === 'EPERM'; }
}

/** Run a helper binary, bounded; resolves stdout, rejects never throws past caller. */
export function run(command: string, args: string[], timeoutMs = 10_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error as any).code ?? null : 0, stdout: String(stdout), stderr: String(stderr) });
      });
  });
}

/** Command line of a live pid. null when dead/unreadable. */
export async function commandLineOf(pid: number): Promise<string | null> {
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe',
      ['-NoProfile', '-Command', `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], 10_000);
    const line = stdout.trim();
    return line ? line : null;
  }
  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const line = raw.replace(/\0/g, ' ').trim();
      if (line) return line;
    } catch { /* fall through to ps */ }
  }
  const { stdout } = await run('ps', ['-o', 'command=', '-p', String(pid)], 10_000);
  const line = stdout.trim();
  return line ? line : null;
}

/**
 * Terminate a pid — graceful first, optionally the whole tree, optionally
 * forced. Never throws; callers verify exit via pidAlive waits.
 * POSIX: spawned workers are detached group leaders, so -pid hits the tree.
 */
export async function terminatePid(pid: number, opts: { tree?: boolean; force?: boolean } = {}): Promise<void> {
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid),
      ...(opts.tree ? ['/T'] : []), ...(opts.force ? ['/F'] : [])]);
    return;
  }
  const sig = opts.force ? 'SIGKILL' : 'SIGTERM';
  if (opts.tree) { try { process.kill(-pid, sig); } catch { /* not a group leader */ } }
  try { process.kill(pid, sig); } catch { /* already gone */ }
}

const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();

/**
 * recorded pid + a path marker that must appear on the real command line
 * (the worker's config file or state dir — both unique per worker).
 * A live pid whose cmdline carries no marker is a FOREIGN process: never kill.
 */
export async function verifyOwnership(pid: number | null, markers: (string | null | undefined)[])
  : Promise<{ alive: boolean; verified: boolean; detail: string }> {
  if (pid == null) return { alive: false, verified: false, detail: '无记录的 pid' };
  if (!pidAlive(pid)) return { alive: false, verified: false, detail: `pid ${pid} 已退出` };
  const wanted = markers.filter((m): m is string => typeof m === 'string' && m.length > 0).map(norm);
  if (wanted.length === 0) return { alive: true, verified: false, detail: `pid ${pid} 存活，无校验标记` };
  const cmdline = await commandLineOf(pid);
  if (cmdline == null) return { alive: true, verified: false, detail: `pid ${pid} 存活，命令行不可读` };
  const ok = wanted.some(m => norm(cmdline).includes(m));
  return { alive: true, verified: ok,
    detail: ok ? `pid ${pid} 命令行匹配` : `pid ${pid} 命令行不匹配（可能是外部进程）` };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as any).port as number;
      srv.close(() => resolve(port));
    });
  });
}

export interface HttpResult { status: number; body: string }
/** Bounded plain GET — redirect:error, default 3s. Throws on transport failure. */
export async function httpGet(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<HttpResult> {
  const response = await fetch(url, { redirect: 'error', headers: opts.headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 3000) });
  return { status: response.status, body: await response.text() };
}

export async function httpJson(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {})
  : Promise<{ status: number; json: Record<string, any> | null }> {
  const { status, body } = await httpGet(url, opts);
  try { return { status, json: JSON.parse(body) }; } catch { return { status, json: null }; }
}

/** Poll until fn() returns truthy or budget lapses; returns the last value. */
export async function waitFor<T>(fn: () => Promise<T> | T, budgetMs: number, everyMs = 250): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let value = await fn();
  while (!value && Date.now() < deadline) { await sleep(everyMs); value = await fn(); }
  return value;
}
