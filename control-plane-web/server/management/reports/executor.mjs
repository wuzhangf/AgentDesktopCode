// Bounded in-process job executor for report generation (design §12: "个人
// 管理服务的有界作业执行器"). One queue, small concurrency, per-job timeout,
// hard queue cap — report work can never grow unboundedly or starve the BFF.
// Deterministic local jobs only; no OS-level scheduled tasks are ever
// created here (task list §10.4).
import { REPORT_ERROR } from './ports.mjs';

export class ReportQueueFullError extends Error {
  constructor(maxQueue) {
    super(`report queue is full (max ${maxQueue})`);
    this.code = REPORT_ERROR.REPORT_QUEUE_FULL;
    this.retryable = true;
  }
}
export class ReportJobTimeoutError extends Error {
  constructor(ms) {
    super(`report job exceeded ${ms}ms`);
    this.code = REPORT_ERROR.JOB_TIMEOUT;
    this.retryable = true;
  }
}

/**
 * @param {object} opts
 * @param {number} [opts.concurrency]  max simultaneous jobs (default 1 — keeps
 *        ordering deterministic and resource use trivially bounded)
 * @param {number} [opts.maxQueue]     max waiting jobs (default 32)
 * @param {number} [opts.jobTimeoutMs] per-job wall clock cap (default 120s)
 * @param {(reportId: string, phase: 'start'|'end', detail?: object) => void} [opts.onJob]
 *        lifecycle hook used by the service to persist state transitions.
 */
export function createReportExecutor({ concurrency = 1, maxQueue = 32, jobTimeoutMs = 120_000, onJob } = {}) {
  const waiting = [];
  let running = 0;
  let drained = null;

  function pump() {
    while (running < concurrency && waiting.length > 0) {
      const job = waiting.shift();
      running += 1;
      runJob(job).finally(() => { running -= 1; pump(); checkDrained(); });
    }
  }

  async function runJob(job) {
    let timer = null;
    try {
      onJob?.(job.reportId, 'start');
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ReportJobTimeoutError(jobTimeoutMs)), jobTimeoutMs);
        if (timer.unref) timer.unref();
      });
      const result = await Promise.race([Promise.resolve().then(job.run), timeout]);
      job.resolve(result);
      onJob?.(job.reportId, 'end', { ok: true });
    } catch (err) {
      job.reject(err);
      onJob?.(job.reportId, 'end', { ok: false, code: err?.code });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function checkDrained() {
    if (running === 0 && waiting.length === 0 && drained) {
      const d = drained; drained = null; d();
    }
  }

  return {
    /** Enqueue a job. Rejects synchronously past maxQueue — the service maps
     * this to REPORT_QUEUE_FULL so the client sees a real bound. */
    submit(reportId, run) {
      if (waiting.length + running >= maxQueue) throw new ReportQueueFullError(maxQueue);
      return new Promise((resolve, reject) => {
        waiting.push({ reportId, run, resolve, reject });
        setImmediate(pump);
      });
    },
    pendingCount() { return waiting.length + running; },
    /** Advisory pre-check so the service can reject BEFORE persisting a row. */
    isFull() { return waiting.length + running >= maxQueue; },
    /** Resolve when the queue is empty (test/shutdown seam). */
    idle() {
      if (running === 0 && waiting.length === 0) return Promise.resolve();
      return new Promise((d) => { drained = d; });
    },
  };
}
