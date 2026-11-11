// Run timeline (§6.3): hierarchy tree + horizontal time track. Bars are
// started→ended wall-clock intervals only; registered-only nodes show a
// diamond; open nodes get a dashed tail to last observation — never a pulse
// that pretends activity without evidence.
import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { TimelineNode } from '../../../shared/contracts/types';
import { fmtMs } from '../../lib/format';
import { chartColors } from '../../lib/chartTheme';
import { motionEnabled } from '../../lib/motion';

interface FlatRow { node: TimelineNode; depth: number; hasChildren: boolean }

const KIND_COLOR: Record<string, string> = {
  RUN: 'accent', RUN_SEGMENT: 'accent', STEP: 'input', STEP_ATTEMPT: 'input',
  MODEL_CALL: 'reasoning', MODEL_ATTEMPT: 'reasoning', TOOL_CALL: 'output',
  COMMAND: 'total', DELEGATION: 'warning',
};

const KIND_LABEL: Record<string, string> = {
  RUN: 'Run', RUN_SEGMENT: 'Segment', STEP: 'Step', STEP_ATTEMPT: 'StepAttempt',
  MODEL_CALL: 'Call', MODEL_ATTEMPT: 'Attempt', TOOL_CALL: 'Tool',
  COMMAND: 'Cmd', DELEGATION: '委派',
};

export function buildRows(nodes: TimelineNode[], collapsed: Set<string>): FlatRow[] {
  const children = new Map<string | null, TimelineNode[]>();
  for (const n of nodes) {
    const p = n.parentNodeId ?? null;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(n);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (a.startedAt ?? a.registeredAt) - (b.startedAt ?? b.registeredAt));
  }
  const out: FlatRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const n of children.get(parentId) ?? []) {
      out.push({ node: n, depth, hasChildren: n.childrenCount > 0 });
      if (!collapsed.has(n.nodeId)) visit(n.nodeId, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

export function TimelineGantt({ nodes, originAt, selectedId, onSelect, truncated }: {
  nodes: TimelineNode[];
  originAt: number | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  truncated: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [axisMode, setAxisMode] = useState<'relative' | 'absolute'>('relative');
  const [hovered, setHovered] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  const rows = useMemo(() => buildRows(nodes, collapsed), [nodes, collapsed]);

  const [tMin, tMax] = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const n of nodes) {
      const s = n.startedAt ?? n.registeredAt;
      const e = n.endedAt ?? n.lastObservedAt ?? s;
      if (s < lo) lo = s;
      if (e > hi) hi = e;
    }
    if (!Number.isFinite(lo)) { lo = originAt ?? 0; hi = lo + 1; }
    if (hi <= lo) hi = lo + 1;
    return [lo, hi];
  }, [nodes, originAt]);

  const span = tMax - tMin;
  const pct = (t: number) => `${(((t - tMin) / span) * 100).toFixed(3)}%`;

  const ROW_H = 26;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const endIdx = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + 8);
  const visible = rows.slice(startIdx, endIdx);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onSelect(null); return; }
    const idx = rows.findIndex((r) => r.node.nodeId === selectedId);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
      onSelect(rows[next]?.node.nodeId ?? null);
    }
  }, [rows, selectedId, onSelect]);

  const c = chartColors();
  const ticks = useMemo(() => {
    const n = 6;
    return Array.from({ length: n + 1 }, (_, i) => tMin + (span * i) / n);
  }, [tMin, span]);

  return (
    <div className="timeline" onKeyDown={onKey} tabIndex={0} aria-label="执行时间线，方向键上下导航，Esc取消选择">
      <div className="row" style={{ marginBottom: 6, fontSize: 11.5 }}>
        <button className="ghost" onClick={() => setAxisMode(axisMode === 'relative' ? 'absolute' : 'relative')}>
          时间轴：{axisMode === 'relative' ? '相对开始' : '绝对时间'}
        </button>
        {truncated && <span className="badge warning">节点超限已截断（≤2000）</span>}
        <span className="muted right">{rows.length} 节点</span>
      </div>
      {/* axis header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px,280px) 1fr' }}>
        <div />
        <div style={{ position: 'relative', height: 18 }}>
          {ticks.map((t, i) => (
            <span key={i} className="muted" style={{
              position: 'absolute', left: pct(t), fontSize: 10, transform: 'translateX(-50%)',
            }}>
              {axisMode === 'relative' ? `+${fmtMs(t - tMin)}` : new Date(t).toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
          ))}
        </div>
      </div>
      <div ref={listRef} style={{ maxHeight: 480, overflowY: 'auto' }}
        onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          <div style={{ position: 'absolute', top: startIdx * ROW_H, left: 0, right: 0 }}>
            {visible.map(({ node, depth, hasChildren }) => {
              const start = node.startedAt ?? node.registeredAt;
              const end = node.endedAt;
              const hasInterval = node.startedAt != null && end != null && end >= node.startedAt;
              const colorKey = KIND_COLOR[node.kind] ?? 'unknown';
              const color = (c as Record<string, string>)[colorKey] ?? c.unknown;
              const isSel = node.nodeId === selectedId;
              const isHover = node.nodeId === hovered;
              const lastObs = node.lastObservedAt;
              return (
                <div key={node.nodeId}
                  className={`tl-row${isSel ? ' selected' : ''}`}
                  style={{ height: ROW_H }}
                  onMouseEnter={() => setHovered(node.nodeId)}
                  onMouseLeave={() => setHovered((h) => (h === node.nodeId ? null : h))}
                  onClick={() => onSelect(isSel ? null : node.nodeId)}
                  role="button" aria-pressed={isSel} aria-label={`${KIND_LABEL[node.kind]} ${node.label}`}>
                  <div className="tl-label" style={{ paddingLeft: 8 + depth * 14 }}>
                    {hasChildren ? (
                      <span role="button" aria-label={collapsed.has(node.nodeId) ? '展开' : '收起'}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCollapsed((s) => {
                            const n = new Set(s);
                            if (n.has(node.nodeId)) n.delete(node.nodeId); else n.add(node.nodeId);
                            return n;
                          });
                        }}>
                        {collapsed.has(node.nodeId) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      </span>
                    ) : <span style={{ width: 12 }} />}
                    <span className="muted">{KIND_LABEL[node.kind] ?? node.kind}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.label}</span>
                    {node.activityState === 'STATE_CONFLICT' && <span className="badge conflict" style={{ padding: '0 5px' }}>!</span>}
                  </div>
                  <div className="tl-track">
                    {hasInterval && (
                      <div className="tl-bar" title={`${fmtMs(end! - node.startedAt!)} 墙钟`}
                        style={{
                          left: pct(node.startedAt!), width: `max(3px, calc(${pct(end!)} - ${pct(node.startedAt!)}))`,
                          background: node.outcome === 'FAILED' || node.outcome === 'TIMED_OUT' ? c.failure : color,
                          opacity: isHover || isSel ? 1 : 0.85,
                          boxShadow: isSel ? `0 0 0 2px ${c.accent}` : undefined,
                        }} />
                    )}
                    {!hasInterval && start != null && (
                      <div className="tl-diamond" title="仅登记时刻" style={{ left: pct(start), background: end == null ? c.unknown : color }} />
                    )}
                    {end == null && start != null && lastObs != null && lastObs > start && (
                      <div className="tl-bar open" title="未闭合：虚线至最后观测点"
                        style={{ left: pct(start), width: `calc(${pct(lastObs)} - ${pct(start)})` }} />
                    )}
                    {node.markers?.filter((m) => m.atMs >= tMin && m.atMs <= tMax).map((m, i) => (
                      <div key={i} className={`tl-marker ${m.kind}`} title={`${m.label} +${fmtMs(m.atMs - (node.startedAt ?? node.registeredAt))}`}
                        style={{ left: pct(m.atMs) }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="row muted" style={{ fontSize: 10.5, marginTop: 6, gap: 14 }}>
        <span>▲ 首响应</span><span style={{ color: 'var(--output)' }}>● 首答案片段</span>
        <span style={{ color: 'var(--reasoning)' }}>◥ 首思考片段</span>
        <span>◆ 仅登记时刻</span><span>虚线=未闭合至最后观测</span>
        {motionEnabled() && <span className="right">点击节点查看证据 · Esc 取消</span>}
      </div>
    </div>
  );
}
