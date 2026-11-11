import { describe, expect, it } from 'vitest';
import {
  cumulativeOffsets,
  DEFAULT_MAX_MOUNTED_ROWS,
  firstIndexAtOrAfter,
  HeightCache,
  visibleWindow
} from '../../src/renderer/app/conversation/virtualWindow';

/** HP-6 windowing math (2026-09-05 design §9.3): offsets, windows and the height cache. */

describe('cumulativeOffsets', () => {
  it('uses estimates for unmeasured rows and keeps the total as last offset', () => {
    const offsets = cumulativeOffsets([100, null, 300], 50);
    expect(offsets).toEqual([0, 100, 150, 450]);
  });

  it('treats zero and negative measured heights as the estimate', () => {
    const offsets = cumulativeOffsets([0, -5], 80);
    expect(offsets).toEqual([0, 80, 160]);
  });
});

describe('firstIndexAtOrAfter', () => {
  it('binary searches the monotone offset array', () => {
    const offsets = [0, 100, 200, 300, 400];
    expect(firstIndexAtOrAfter(offsets, 0)).toBe(0);
    expect(firstIndexAtOrAfter(offsets, 100)).toBe(1);
    expect(firstIndexAtOrAfter(offsets, 250)).toBe(3);
    expect(firstIndexAtOrAfter(offsets, 999)).toBe(4);
  });
});

describe('visibleWindow', () => {
  const build = (heights: number[]) => cumulativeOffsets(heights, 100);

  it('mounts the visible band plus bounded overscan only', () => {
    // 200 rows of 100px; viewport 500px at the top.
    const offsets = build(new Array(200).fill(100));
    const { start, end } = visibleWindow(offsets, 0, 500, 30, DEFAULT_MAX_MOUNTED_ROWS);
    expect(start).toBe(0);
    expect(end).toBeLessThanOrEqual(DEFAULT_MAX_MOUNTED_ROWS);
    expect(end).toBeGreaterThan(5); // visible 5 rows + overscan
  });

  it('slides the window with the scroll position', () => {
    const offsets = build(new Array(200).fill(100));
    const deep = visibleWindow(offsets, 10_000, 500, 30, DEFAULT_MAX_MOUNTED_ROWS);
    // scrollTop 10000 sits inside row 100..105.
    expect(deep.start).toBeGreaterThanOrEqual(70);
    expect(deep.start).toBeLessThanOrEqual(100);
    expect(deep.end).toBeGreaterThan(deep.start);
    const total = offsets[offsets.length - 1] ?? 0;
    const tail = visibleWindow(offsets, total, 500, 30, DEFAULT_MAX_MOUNTED_ROWS);
    expect(tail.end).toBe(200);
  });

  it('never hides visible rows even when they exceed the cap', () => {
    // One giant row taller than the cap: it must still be mounted.
    const offsets = cumulativeOffsets([50_000], 100);
    const { start, end } = visibleWindow(offsets, 0, 800, 30, DEFAULT_MAX_MOUNTED_ROWS);
    expect(start).toBe(0);
    expect(end).toBe(1);
  });

  it('handles empty transcripts', () => {
    expect(visibleWindow([0], 0, 500, 30, 100)).toEqual({ start: 0, end: 0 });
  });

  it('clamps negative scroll positions', () => {
    const offsets = build(new Array(50).fill(100));
    const { start, end } = visibleWindow(offsets, -500, 500, 30, 100);
    expect(start).toBe(0);
    expect(end).toBeGreaterThan(0);
  });
});

describe('HeightCache', () => {
  it('evicts the least recently used entries beyond its bound', () => {
    const cache = new HeightCache(3);
    cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
    expect(cache.get('a')).toBe(1); // refresh a
    cache.set('d', 4); // evicts b
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });
});
