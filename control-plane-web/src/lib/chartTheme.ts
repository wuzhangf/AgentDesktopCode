// ECharts theme derived from CSS tokens — colors read at render time so theme
// switching just re-renders options.
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const chartColors = () => ({
  accent: cssVar('--accent') || '#69a7ff',
  input: cssVar('--input') || '#74b5ff',
  output: cssVar('--output') || '#50d3bd',
  reasoning: cssVar('--reasoning') || '#c1a1ff',
  total: cssVar('--total') || '#f0a35e',
  success: cssVar('--success') || '#58d5a4',
  failure: cssVar('--failure') || '#ff8797',
  warning: cssVar('--warning') || '#f4c66b',
  unknown: cssVar('--unknown') || '#a2aec2',
  cancelled: cssVar('--cancelled') || '#8a94a8',
  conflict: cssVar('--conflict') || '#f4c66b',
  text: cssVar('--text-secondary') || '#b2bfd4',
  grid: cssVar('--chart-grid') || 'rgba(178,191,212,0.12)',
});

export const SERIES_PALETTE = () => {
  const c = chartColors();
  return [c.accent, c.output, c.reasoning, c.total, c.success, c.input, c.warning, c.unknown];
};

export function outcomeColor(outcome: string): string {
  const c = chartColors();
  switch (outcome) {
    case 'SUCCEEDED': return c.success;
    case 'FAILED': return c.failure;
    case 'TIMED_OUT': return '#e06a5a';
    case 'CANCELLED': case 'REJECTED': case 'SKIPPED': return c.cancelled;
    case 'OUTCOME_UNKNOWN': case 'UNCLOSED': return c.unknown;
    case 'STATE_CONFLICT': return c.conflict ?? c.warning;
    default: return c.unknown;
  }
}

export function baseOption() {
  const c = chartColors();
  return {
    animation: true,
    textStyle: { color: c.text, fontSize: 11, fontFamily: 'inherit' },
    grid: { left: 8, right: 12, top: 24, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'item',
      backgroundColor: cssVar('--surface-raised'),
      borderColor: cssVar('--border'),
      textStyle: { color: cssVar('--text'), fontSize: 11.5 },
      confine: true,
    },
  };
}
