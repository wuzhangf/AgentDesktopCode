/**
 * Windowing math for the message transcript (2026-09-05 design §9.3).
 * Pure functions so the scroll-critical path is unit-testable; the component
 * only wires DOM observation around these results.
 *
 * Constraints from the design: mounted rows stay ≤ the hard cap (default
 * 100), the visible window is always fully rendered even if that exceeds the
 * cap, and heights are estimated for rows that have never been measured.
 */

export const DEFAULT_ROW_ESTIMATE_PX = 120;
export const DEFAULT_MAX_MOUNTED_ROWS = 100;
export const DEFAULT_OVERSCAN_ROWS = 30;

/**
 * offsets[i] = pixel offset of the TOP of row i; offsets[n] = total height.
 * Unmeasured rows use the estimate. O(n) arithmetic, no allocation beyond the
 * returned array.
 */
export function cumulativeOffsets(heights: ReadonlyArray<number | null>,
    estimate: number = DEFAULT_ROW_ESTIMATE_PX): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  let running = 0;
  for (let i = 0; i < heights.length; i += 1) {
    const height = heights[i] ?? estimate;
    running += height > 0 ? height : estimate;
    offsets[i + 1] = running;
  }
  return offsets;
}

/** First row index whose top offset is >= pixel (binary search over offsets). */
export function firstIndexAtOrAfter(offsets: ReadonlyArray<number>, pixel: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid] ?? 0) < pixel) low = mid + 1;
    else high = mid;
  }
  return low;
}

export interface WindowRange {
  start: number;
  /** Exclusive end. */
  end: number;
}

/**
 * Rows to mount for the current scroll position: the visible range plus
 * overscan on both sides, capped at maxMounted. The visible range always
 * wins over the cap — hiding on-screen content is never acceptable.
 */
export function visibleWindow(offsets: ReadonlyArray<number>, scrollTop: number,
    viewportHeight: number, overscan: number = DEFAULT_OVERSCAN_ROWS,
    maxMounted: number = DEFAULT_MAX_MOUNTED_ROWS): WindowRange {
  const rowCount = Math.max(0, offsets.length - 1);
  if (rowCount === 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportHeight);
  // First visible row: its BOTTOM extends past the viewport top.
  let first = firstIndexAtOrAfter(offsets, top + 1) - 1;
  if (first < 0) first = 0;
  // First fully-below row: its TOP is at/after the viewport bottom.
  let last = firstIndexAtOrAfter(offsets, bottom);
  if (last > rowCount) last = rowCount;
  const visibleCount = Math.max(1, last - first);
  // Keep mounted rows within the cap while preserving the whole visible band.
  const budget = Math.max(0, maxMounted - visibleCount);
  const boundedOverscan = Math.max(4, Math.min(overscan, Math.floor(budget / 2)));
  const start = Math.max(0, first - boundedOverscan);
  const end = Math.min(rowCount, last + boundedOverscan);
  return { start, end };
}

/**
 * LRU height cache for measured rows (design §9.3: bounded, never relied on
 * for correctness — an evicted row is simply re-measured on remount).
 */
export class HeightCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxEntries: number = 1500) { }

  get(messageId: string): number | null {
    const height = this.entries.get(messageId);
    if (height === undefined) return null;
    // Refresh recency.
    this.entries.delete(messageId);
    this.entries.set(messageId, height);
    return height;
  }

  set(messageId: string, height: number): void {
    if (this.entries.has(messageId)) this.entries.delete(messageId);
    this.entries.set(messageId, height);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
