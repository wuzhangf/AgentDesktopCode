import { useEffect, useReducer, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  cumulativeOffsets,
  DEFAULT_MAX_MOUNTED_ROWS,
  DEFAULT_OVERSCAN_ROWS,
  DEFAULT_ROW_ESTIMATE_PX,
  HeightCache,
  visibleWindow
} from './virtualWindow';

/** Minimal row contract: any conversation source (ACS or native) that can
 * supply a stable display id can mount inside this window. */
export interface VirtualMessageRow {
  id: string;
}

/**
 * Windowed transcript body (2026-09-05 design §9.3): only the visible band
 * plus a bounded overscan mounts (hard cap 100 rows), with top/bottom spacers
 * sized from measured heights. The container stays the App-owned scroll
 * element — no second scroll surface, so keyboard paging, IME and text
 * selection keep native behavior. Height changes above the viewport shift
 * scrollTop by the delta so prepended pages and loaded media do not yank the
 * reading position; a bottom-pinned view re-sticks instead.
 */
export function VirtualMessageWindow<T extends VirtualMessageRow>(props: {
  messages: ReadonlyArray<T>;
  /** App-owned scrolling element that this body renders inside. */
  containerRef: RefObject<HTMLDivElement | null>;
  renderRow: (message: T, index: number) => ReactNode;
  estimate?: number;
  overscan?: number;
  maxMounted?: number;
}): React.JSX.Element {
  const cache = useRef<HeightCache>(new HeightCache());
  const observerRef = useRef<ResizeObserver | null>(null);
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const [scroll, setScroll] = useState({ top: 0, height: 800 });

  // Follow the shared container's scroll and size changes.
  useEffect(() => {
    const element = props.containerRef.current;
    if (!element) return;
    const read = () => setScroll((previous) => (
      previous.top === element.scrollTop && previous.height === element.clientHeight
        ? previous
        : { top: element.scrollTop, height: element.clientHeight }
    ));
    element.addEventListener('scroll', read, { passive: true });
    if (typeof ResizeObserver === 'undefined') return () => {
      element.removeEventListener('scroll', read);
    };
    const observer = new ResizeObserver(read);
    observer.observe(element);
    read();
    return () => {
      element.removeEventListener('scroll', read);
      observer.disconnect();
    };
  }, [props.containerRef]);

  // One observer for every mounted row; nodes (re)entering the DOM are picked
  // up after each render below. observe() on an already-observed node is a no-op.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const container = props.containerRef.current;
      if (!container) return;
      const containerTop = container.getBoundingClientRect().top;
      const bottomPinned = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
      let changed = false;
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const messageId = node.dataset.vrowId;
        if (!messageId) continue;
        const height = node.getBoundingClientRect().height;
        const prior = cache.current.get(messageId);
        if (prior !== null && Math.abs(prior - height) > 0.5
          && node.getBoundingClientRect().top < containerTop) {
          // The row sits above the viewport: keep the reading position stable.
          container.scrollTop += height - prior;
        }
        if (prior !== height) {
          cache.current.set(messageId, height);
          if (prior !== null) changed = true;
        }
      }
      if (bottomPinned) container.scrollTop = container.scrollHeight;
      if (changed) bump();
    });
    observerRef.current = observer;
    return () => {
      observerRef.current = null;
      observer.disconnect();
    };
  }, [props.containerRef]);

  // After every render, make sure every mounted row is being measured.
  useEffect(() => {
    const observer = observerRef.current;
    const container = props.containerRef.current;
    if (!observer || !container) return;
    container.querySelectorAll<HTMLElement>('[data-vrow-id]').forEach((node) => {
      observer.observe(node);
    });
  });

  const estimate = props.estimate ?? DEFAULT_ROW_ESTIMATE_PX;
  const heights = props.messages.map((message) => cache.current.get(message.id));
  const offsets = cumulativeOffsets(heights, estimate);
  const { start, end } = visibleWindow(offsets, scroll.top, scroll.height,
    props.overscan ?? DEFAULT_OVERSCAN_ROWS, props.maxMounted ?? DEFAULT_MAX_MOUNTED_ROWS);

  const rows: ReactNode[] = [];
  for (let index = start; index < end; index += 1) {
    const message = props.messages[index]!;
    rows.push(
      <div key={message.id} data-vrow-id={message.id}>
        {props.renderRow(message, index)}
      </div>
    );
  }

  return (
    <>
      {start > 0 ? <div style={{ height: offsets[start] }} aria-hidden="true" data-testid="window-spacer-top" /> : null}
      {rows}
      {end < props.messages.length
        ? <div style={{ height: (offsets[props.messages.length] ?? 0) - (offsets[end] ?? 0) }} aria-hidden="true" data-testid="window-spacer-bottom" />
        : null}
    </>
  );
}
