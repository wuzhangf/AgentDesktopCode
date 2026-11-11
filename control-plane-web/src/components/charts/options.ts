// ECharts option builders — one builder per chart family (§5 matrix).
// All builders are pure so they can be unit-tested.
import { baseOption, chartColors, outcomeColor, SERIES_PALETTE } from '../../lib/chartTheme';
import { OUTCOME_LABEL } from '../../lib/format';
import type { TrendPoint } from '../../../shared/contracts/types';

/** Tooltip formatters emit HTML — escape any value originating from the DB. */
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export interface SeriesDef {
  id: string;
  name: string;
  color?: string;
  type?: 'line' | 'bar';
  area?: boolean;
  dashed?: boolean;
  /** Values may be null → gap in line, never silent zero. */
  key: string;
}

export function timeSeriesOption(points: TrendPoint[], series: SeriesDef[], tz?: string) {
  const c = chartColors();
  return {
    ...baseOption(),
    aria: { enabled: true, decal: { show: true } },
    legend: { top: 0, textStyle: { color: c.text }, itemWidth: 14, itemHeight: 8 },
    xAxis: {
      type: 'time',
      axisLabel: { color: c.text, hideOverlap: true },
      axisLine: { lineStyle: { color: c.grid } },
    },
    yAxis: {
      type: 'value', min: 0,
      splitLine: { lineStyle: { color: c.grid } },
      axisLabel: { color: c.text },
    },
    tooltip: {
      ...baseOption().tooltip, trigger: 'axis',
      valueFormatter: (v: unknown) => (v == null ? '—' : String(v)),
    },
    series: series.map((s, i) => ({
      id: s.id, name: s.name, type: s.type ?? 'line',
      itemStyle: { color: s.color ?? SERIES_PALETTE()[i % 8] },
      lineStyle: s.dashed ? { type: 'dashed' as const } : undefined,
      areaStyle: s.area ? { opacity: 0.18 } : undefined,
      showSymbol: points.length <= 30,
      symbolSize: 5,
      connectNulls: false,
      emphasis: { focus: 'series' as const },
      data: points.map((p) => [p.bucketStart, (p[s.key] as number | null) ?? null]),
    })),
  };
}

export interface RankRow { name: string; value: number | null; extra?: string; color?: string }

export function rankedBarOption(rows: RankRow[], { unit = '' } = {}) {
  const c = chartColors();
  const sorted = rows.slice().sort((a, b) => (a.value ?? -1) - (b.value ?? -1));
  return {
    ...baseOption(),
    aria: { enabled: true, decal: { show: true } },
    xAxis: { type: 'value', min: 0, splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.text } },
    yAxis: {
      type: 'category',
      data: sorted.map((r) => r.name),
      axisLabel: { color: c.text, width: 110, overflow: 'truncate' as const },
      axisLine: { lineStyle: { color: c.grid } },
    },
    tooltip: {
      ...baseOption().tooltip,
      formatter: (p: { dataIndex: number }) => {
        const r = sorted[p.dataIndex];
        return `<b>${esc(r.name)}</b><br/>${r.value == null ? '未知' : r.value.toLocaleString()}${unit}${r.extra ? `<br/><span style="opacity:.75">${esc(r.extra)}</span>` : ''}`;
      },
    },
    series: [{
      id: 'rank', type: 'bar',
      data: sorted.map((r) => ({
        value: r.value, itemStyle: { color: r.color ?? c.accent },
      })),
      barMaxWidth: 16,
      label: { show: true, position: 'right' as const, color: c.text, formatter: (p: { value: unknown }) => (p.value == null ? '—' : String(p.value)) },
    }],
    grid: { left: 8, right: 40, top: 8, bottom: 8, containLabel: true },
  };
}

export interface HistBucket { label: string; count: number; min?: number; max?: number }

export function histogramOption(buckets: HistBucket[], { color }: { color?: string } = {}) {
  const c = chartColors();
  return {
    ...baseOption(),
    aria: { enabled: true, decal: { show: true } },
    xAxis: { type: 'category', data: buckets.map((b) => b.label), axisLabel: { color: c.text } },
    yAxis: { type: 'value', min: 0, splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.text } },
    tooltip: { ...baseOption().tooltip },
    series: [{
      id: 'hist', type: 'bar', barCategoryGap: '18%',
      itemStyle: { color: color ?? c.accent },
      data: buckets.map((b) => b.count),
    }],
    grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
  };
}

/** 100% state distribution as a single horizontal stacked bar (O02). */
export function stateStackOption(dist: { outcome: string; count: number }[], { title = '' } = {}) {
  const c = chartColors();
  const total = dist.reduce((a, d) => a + d.count, 0);
  const rows = dist.filter((d) => d.count > 0);
  return {
    ...baseOption(),
    aria: { enabled: true },
    legend: { top: 0, textStyle: { color: c.text }, itemWidth: 14, itemHeight: 8, type: 'scroll' as const },
    xAxis: { type: 'value', max: 'dataMax' as const, splitLine: { show: false }, axisLabel: { show: false }, axisLine: { show: false } },
    yAxis: { type: 'category', data: [title || '结果'], axisLabel: { show: false }, axisLine: { show: false } },
    tooltip: {
      ...baseOption().tooltip,
      formatter: (p: { seriesName: string; value: unknown }) =>
        `${esc(OUTCOME_LABEL[p.seriesName] ?? p.seriesName)}: ${esc(p.value)}（${total ? (((p.value as number) / total) * 100).toFixed(1) : '—'}%）`,
    },
    series: rows.map((d) => ({
      id: `outcome-${d.outcome}`, name: OUTCOME_LABEL[d.outcome] ?? d.outcome,
      type: 'bar', stack: 'all', barWidth: 26,
      itemStyle: { color: outcomeColor(d.outcome) },
      label: { show: d.count / Math.max(total, 1) > 0.06, color: '#fff', fontSize: 10.5, formatter: String(d.count) },
      data: [d.count],
    })),
    grid: { left: 8, right: 12, top: 26, bottom: 4, containLabel: true },
  };
}

/** Donut / pie (share-of-total). Legend left, value+share in tooltip. */
export function donutOption(slices: { name: string; value: number | null; color?: string }[], { title = '', center }: { title?: string; center?: [string, string] } = {}) {
  const c = chartColors();
  const rows = slices.filter((s) => s.value != null && s.value > 0);
  return {
    ...baseOption(),
    aria: { enabled: true, decal: { show: true } },
    legend: { type: 'scroll' as const, bottom: 0, textStyle: { color: c.text }, itemWidth: 12, itemHeight: 8 },
    title: title ? { text: title, left: 'center', top: '42%', textStyle: { color: c.text, fontSize: 12, fontWeight: 500 as const } } : undefined,
    tooltip: {
      ...baseOption().tooltip,
      formatter: (p: { name: string; value: unknown; percent?: number }) =>
        `${esc(p.name)}: ${esc(p.value)}（${p.percent?.toFixed(1) ?? '—'}%）`,
    },
    series: [{
      id: 'donut', type: 'pie', radius: ['42%', '66%'], center: center ?? ['50%', '46%'],
      itemStyle: { borderColor: cssColor('surface'), borderWidth: 2 },
      label: { show: false },
      emphasis: { label: { show: true, color: c.text, fontSize: 11 } },
      data: rows.map((s, i) => ({
        name: s.name, value: s.value,
        itemStyle: { color: s.color ?? SERIES_PALETTE()[i % 8] },
      })),
    }],
  };
}

export interface HeatCell { x: string; y: string; value: number }
export function heatmapOption(xCats: string[], yCats: string[], cells: HeatCell[], { name = '' } = {}) {
  const c = chartColors();
  const max = Math.max(1, ...cells.map((x) => x.value));
  return {
    ...baseOption(),
    aria: { enabled: true, decal: { show: true } },
    xAxis: { type: 'category', data: xCats, axisLabel: { color: c.text } },
    yAxis: { type: 'category', data: yCats, axisLabel: { color: c.text } },
    visualMap: {
      min: 0, max, orient: 'horizontal' as const, left: 'center', bottom: 0,
      inRange: { color: [cssColor('surface'), c.accent] },
      textStyle: { color: c.text }, calculable: false,
    },
    tooltip: { ...baseOption().tooltip },
    series: [{
      id: 'heat', name, type: 'heatmap',
      data: cells.map((x) => [xCats.indexOf(x.x), yCats.indexOf(x.y), x.value]),
      label: { show: false },
    }],
    grid: { left: 8, right: 12, top: 8, bottom: 34, containLabel: true },
  };
}

function cssColor(v: string) { return getComputedStyle(document.documentElement).getPropertyValue(`--${v}`).trim() || '#131c2f'; }

export interface ScatterPoint { x: number | null; y: number | null; size?: number | null; name: string; color?: string; extra?: Record<string, unknown> }

export function scatterOption(points: ScatterPoint[], { xName = '', yName = '' } = {}) {
  const c = chartColors();
  const valid = points.filter((p) => p.x != null && p.y != null);
  const maxSize = Math.max(1, ...valid.map((p) => p.size ?? 1));
  return {
    ...baseOption(),
    aria: { enabled: true },
    xAxis: { type: 'value', name: xName, nameLocation: 'middle' as const, nameGap: 24, min: 0, splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.text } },
    yAxis: { type: 'value', name: yName, min: 0, splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.text } },
    tooltip: {
      ...baseOption().tooltip,
      formatter: (p: { dataIndex: number }) => {
        const d = valid[p.dataIndex];
        return `<b>${esc(d.name)}</b><br/>${esc(xName)}: ${esc(d.x)}<br/>${esc(yName)}: ${esc(d.y)}`;
      },
    },
    series: [{
      id: 'scatter', type: 'scatter',
      symbolSize: (v: number[], p: { dataIndex: number }) => {
        const s = valid[p.dataIndex]?.size ?? 6;
        return 6 + Math.sqrt(s / maxSize) * 22;
      },
      data: valid.map((p) => ({ value: [p.x, p.y], name: p.name, itemStyle: { color: p.color ?? c.accent, opacity: 0.75 } })),
    }],
    grid: { left: 8, right: 16, top: 28, bottom: 8, containLabel: true },
  };
}

/** Bullet-style capacity bars (C01): estimated vs budget, threshold markers. */
export function bulletOption(items: { name: string; value: number | null; max: number | null }[]) {
  const c = chartColors();
  const sorted = items.slice(0, 12);
  return {
    ...baseOption(),
    aria: { enabled: true, decal: { show: true } },
    xAxis: { type: 'value', min: 0, max: 1.05, axisLabel: { color: c.text, formatter: (v: number) => `${Math.round(v * 100)}%` }, splitLine: { lineStyle: { color: c.grid } } },
    yAxis: { type: 'category', data: sorted.map((i) => i.name), axisLabel: { color: c.text, width: 100, overflow: 'truncate' as const } },
    tooltip: {
      ...baseOption().tooltip,
      formatter: (p: { dataIndex: number }) => {
        const i = sorted[p.dataIndex];
        return `<b>${esc(i.name)}</b><br/>占用 ${i.value == null ? '未知' : `${(i.value * 100).toFixed(1)}%`}<br/>${i.value != null && i.max != null ? `${i.value.toLocaleString()} / ${i.max.toLocaleString()}` : ''}`;
      },
    },
    series: [{
      id: 'bullet', type: 'bar', barWidth: 14,
      data: sorted.map((i) => ({
        value: i.value != null && i.max ? i.value / i.max : null,
        itemStyle: {
          color: i.value != null && i.max ? (i.value / i.max >= 0.95 ? c.failure : i.value / i.max >= 0.85 ? c.warning : c.accent) : c.unknown,
          borderRadius: 3,
        },
      })),
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: c.warning, type: 'dashed' as const },
        data: [{ xAxis: 0.85 }, { xAxis: 0.95 }],
        label: { color: c.text, fontSize: 10 },
      },
    }],
    grid: { left: 8, right: 16, top: 8, bottom: 8, containLabel: true },
  };
}

/** Box plot for latency distributions (M04). */
export function boxOption(groups: { name: string; values: number[] }[]) {
  const c = chartColors();
  const data = groups.map((g) => {
    const v = g.values.slice().sort((a, b) => a - b);
    const q = (p: number) => (v.length ? v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)] : 0);
    return [v[0] ?? 0, q(0.25), q(0.5), q(0.75), v[v.length - 1] ?? 0];
  });
  return {
    ...baseOption(),
    aria: { enabled: true },
    xAxis: { type: 'category', data: groups.map((g) => g.name), axisLabel: { color: c.text } },
    yAxis: { type: 'value', min: 0, splitLine: { lineStyle: { color: c.grid } }, axisLabel: { color: c.text } },
    tooltip: {
      ...baseOption().tooltip,
      formatter: (p: { dataIndex: number }) => {
        const d = data[p.dataIndex];
        return `<b>${esc(groups[p.dataIndex].name)}</b><br/>min ${d[0]} · Q1 ${d[1]} · 中位 ${d[2]} · Q3 ${d[3]} · max ${d[4]}<br/><span style="opacity:.75">四分位区间；异常点单列</span>`;
      },
    },
    series: [{ id: 'box', type: 'boxplot', data, itemStyle: { color: 'transparent', borderColor: c.accent } }],
    grid: { left: 8, right: 12, top: 12, bottom: 8, containLabel: true },
  };
}
