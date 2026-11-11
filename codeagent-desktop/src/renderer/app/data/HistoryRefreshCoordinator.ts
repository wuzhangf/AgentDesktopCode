import type { DirtyReason, DirtyResource } from './historyRefreshTypes';

export type { DirtyReason, DirtyResource };

/**
 * Coalescing refresh scheduler for the history read path
 * (2026-09-05 session-history performance design §8.2).
 *
 * Durable events mark resources dirty instead of triggering one HTTP
 * invalidation per frame. Ordinary marks drain on a 500 ms window (≤2
 * refreshes/second per resource, design R-gate) with a 1 s max wait so
 * sustained event streams still get flushed. Terminal/approval marks carry
 * `priority` and may jump the queue; call sites stay responsible for
 * deduplicating repeats of the same {runId, stateVersion, type}.
 *
 * The scheduler owns no React state and never performs requests itself; the
 * subscriber translates resources into exact query-key invalidations.
 */
const DEFAULT_FLUSH_WINDOW_MS = 500;
const DEFAULT_MAX_WAIT_MS = 1000;

interface DirtyEntry {
  resource: DirtyResource;
  reason: DirtyReason;
  /** Earliest mark time; bounds how long a continuously-dirty resource waits. */
  firstDirtyAt: number;
}

export function resourceKey(resource: DirtyResource): string {
  return resource.kind === 'session-detail'
    ? `session:${resource.sessionId}`
    : resource.kind;
}

export class HistoryRefreshCoordinator {
  private pending = new Map<string, DirtyEntry>();
  /** Resources whose flush is currently being issued; guards reentrancy. */
  private issuing = new Set<string>();
  private rerunNeeded = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private listener: ((resources: DirtyResource[]) => void) | null = null;

  constructor(
    private readonly flushWindowMs = DEFAULT_FLUSH_WINDOW_MS,
    private readonly maxWaitMs = DEFAULT_MAX_WAIT_MS
  ) { }

  /**
   * Registers the flush sink. The returned unsubscribe clears the listener,
   * the pending timer and every queued mark (design §8.2.5).
   */
  subscribe(listener: (resources: DirtyResource[]) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.pending.clear();
      this.issuing.clear();
      this.rerunNeeded.clear();
    };
  }

  /**
   * Page hidden / panel collapsed / service disconnected: ordinary refreshes
   * wait; priority marks still drain (design §8.2.4).
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) this.drain();
  }

  markDirty(resource: DirtyResource, reason: DirtyReason = 'ordinary'): void {
    if (this.listener === null) return;
    const key = resourceKey(resource);
    if (this.issuing.has(key)) {
      // Design §8.2.2: a dirty mark during an in-flight flush schedules at
      // most one successor instead of cancelling or looping the request.
      this.rerunNeeded.add(key);
      return;
    }
    const existing = this.pending.get(key);
    if (existing) {
      if (reason === 'priority') existing.reason = 'priority';
      return; // keep the earliest firstDirtyAt as the max-wait anchor
    }
    this.pending.set(key, { resource, reason, firstDirtyAt: Date.now() });
    this.schedule();
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private schedule(): void {
    if (this.listener === null) return;
    const now = Date.now();
    let earliest = Infinity;
    let hasPriority = false;
    for (const entry of this.pending.values()) {
      if (entry.firstDirtyAt < earliest) earliest = entry.firstDirtyAt;
      if (entry.reason === 'priority') hasPriority = true;
    }
    // Terminal/approval refreshes may preempt the window (design §8.2.3).
    if (hasPriority) {
      this.drain();
      return;
    }
    if (now - earliest >= this.maxWaitMs) {
      this.drain();
      return;
    }
    if (this.timer !== null) return; // existing timer is never later than the bound
    const delay = Math.max(0, Math.min(this.flushWindowMs, this.maxWaitMs - (now - earliest)));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, delay);
  }

  private drain(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.listener === null || this.pending.size === 0) return;
    const batch: DirtyResource[] = [];
    for (const [key, entry] of this.pending) {
      if (this.paused && entry.reason !== 'priority') continue;
      this.pending.delete(key);
      this.issuing.add(key);
      batch.push(entry.resource);
    }
    if (batch.length === 0) return;
    try {
      this.listener(batch);
    } finally {
      for (const resource of batch) {
        const key = resourceKey(resource);
        this.issuing.delete(key);
        if (this.rerunNeeded.delete(key)) this.markDirty(resource, 'ordinary');
      }
    }
  }
}
