// Per-source reader worker pool (§13.1): one worker per source, serialized
// tasks, hard timeout → terminate + recreate. HTTP threads never block on
// synchronous DatabaseSync calls.
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { timeoutError, unavailableError, unavailable } from '../lib/errors.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = resolve(here, 'worker.mjs');

const HARD_LIMIT_MS = Number(process.env.OBS_QUERY_TIMEOUT_MS ?? 5000);
const QUEUE_WAIT_MS = Number(process.env.OBS_QUEUE_WAIT_MS ?? 2000);

class SourceReader {
  constructor(source, guiPath) {
    this.source = source;
    this.guiPath = guiPath;
    this.worker = null;
    this.queue = [];
    this.busy = false;
    this.current = null;
    this.openError = null;
    this.schemaVersion = null;
  }

  ensureWorker() {
    if (this.worker) return;
    const w = new Worker(WORKER_PATH, {
      workerData: {
        dbPath: this.source.path,
        guiPath: this.guiPath,
        sourceId: this.source.id,
        mode: this.source.mode,
        sourceRef: this.source,
      },
    });
    w.once('message', (m) => {
      if (m?.ready) {
        this.openError = m.openError ?? null;
        this.pump();
      }
    });
    w.on('error', () => this.crash());
    w.on('exit', (code) => { if (code !== 0) this.crash(); });
    this.worker = w;
  }

  crash() {
    // Worker died: reject everything queued + in-flight; next exec() spawns a fresh worker.
    const pending = [...this.queue, ...(this.current ? [this.current] : [])];
    this.queue = [];
    this.busy = false;
    this.current = null;
    this.worker = null;
    for (const t of pending) {
      clearTimeout(t.timer);
      t.reject(unavailableError('reader worker restarted; retry the request'));
    }
  }

  exec(op, params, { timeoutMs = HARD_LIMIT_MS } = {}) {
    return new Promise((resolvePromise, reject) => {
      const task = { op, params, timeoutMs, resolve: resolvePromise, reject, timer: null, enqueuedAt: Date.now() };
      this.queue.push(task);
      this.ensureWorker();
      this.pump();
    });
  }

  pump() {
    if (this.busy || !this.queue.length || !this.worker) return;
    const task = this.queue.shift();
    const waited = Date.now() - task.enqueuedAt;
    if (waited > QUEUE_WAIT_MS) {
      task.reject(timeoutError('query queue wait exceeded'));
      return this.pump();
    }
    this.busy = true;
    this.current = task;
    const w = this.worker;
    const handler = (m) => {
      if (m?.taskId !== task.taskId) return;
      w.off('message', handler);
      clearTimeout(task.timer);
      this.busy = false;
      this.current = null;
      if (m.ok) task.resolve({ result: m.result, dataAsOf: m.dataAsOf ?? null, schemaVersion: m.schemaVersion ?? null });
      else task.reject(Object.assign(new Error(m.error.message), { apiError: m.error }));
      this.pump();
    };
    task.taskId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    w.on('message', handler);
    task.timer = setTimeout(() => {
      // Synchronous SQLite call cannot be cancelled; kill + rebuild the worker.
      if (this.worker === w) this.worker = null;
      w.terminate();
      this.busy = false;
      this.current = null;
      task.reject(timeoutError());
      this.pump();
    }, task.timeoutMs);
    w.postMessage({ taskId: task.taskId, op: task.op, params: task.params });
  }

  async ping() {
    const r = await this.exec('__ping', {});
    return r?.result ?? r;
  }

  async dataVersion() {
    try {
      return await this.exec('__dataVersion', {}, { timeoutMs: 1000 });
    } catch { return null; }
  }

  async destroy() {
    const w = this.worker;
    this.worker = null;
    const pending = [...this.queue, ...(this.current ? [this.current] : [])];
    this.queue = [];
    this.current = null;
    this.busy = false;
    for (const t of pending) {
      clearTimeout(t.timer);
      t.reject(unavailableError('reader pool shutting down'));
    }
    if (w) await w.terminate();
  }
}

export class ReaderPool {
  constructor(sources, guiSources) {
    this.readers = new Map();
    const guiPath = guiSources.find((g) => g.available)?.path ?? null;
    for (const s of sources) {
      this.readers.set(s.id, new SourceReader(s, s.mode === 'DEMO' ? null : guiPath));
    }
  }

  reader(sourceId) {
    return this.readers.get(sourceId) ?? null;
  }

  async exec(sourceId, op, params, opts) {
    const r = this.readers.get(sourceId);
    if (!r) unavailable(`unknown or unavailable source: ${sourceId}`);
    return r.exec(op, params, opts);
  }

  async destroy() {
    await Promise.all([...this.readers.values()].map((r) => r.destroy()));
  }
}
