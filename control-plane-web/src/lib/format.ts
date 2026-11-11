// Central display formatting (§11.3): unknown ≠ 0; null → '—'; only known
// zeros render as 0. Never `value || 0` — always `value == null` checks.
import type { MetricValue } from '../../shared/contracts/types';

export function fmtInt(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString('en-US');
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null) return '—';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('en-US');
}

export function fmtRatio(r: number | null | undefined, digits = 1): string {
  if (r == null) return '—';
  return `${(r * 100).toFixed(digits)}%`;
}

export function fmtPp(delta: number | null | undefined): string {
  if (delta == null) return '—';
  const pp = delta * 100;
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

export function fmtDelta(delta: number | null | undefined, comparable?: boolean, reason?: string): string {
  if (!comparable) {
    if (reason === 'PREVIOUS_WAS_ZERO') return '上期为 0';
    return '—';
  }
  if (delta == null) return '—';
  return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n}B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)}KiB`;
  return `${(n / 1_048_576).toFixed(1)}MiB`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  return fmtCompact(n);
}

export function fmtTime(ms: number | null | undefined, tz?: string): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: tz });
}

export function fmtTimeShort(ms: number | null | undefined, tz?: string): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('zh-CN', {
    hour12: false, timeZone: tz, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}

export function fmtMetric(m: MetricValue): { main: string; sub: string } {
  const coverage = m.sampleCount > 0 ? `${m.knownCount}/${m.sampleCount} 已知` : '';
  switch (m.unit) {
    case 'ratio':
      return { main: fmtRatio(m.value as number | null), sub: m.denominator != null ? `${m.numerator ?? '—'}/${m.denominator}` : coverage };
    case 'ms':
      return { main: fmtMs(m.value as number | null), sub: coverage };
    case 'tokens':
      if (m.state === 'NO_DATA') return { main: '—', sub: m.sampleCount ? `0/${m.sampleCount} 个样本有用量` : '无样本' };
      return { main: fmtTokens(m.value as number | null), sub: coverage };
    case 'money':
      return { main: m.value != null ? String(m.value) : '—', sub: m.currency ?? coverage };
    case 'bytes':
      return { main: fmtBytes(m.value as number | null), sub: coverage };
    default:
      return { main: fmtInt(m.value as number | null), sub: coverage };
  }
}

export const OUTCOME_LABEL: Record<string, string> = {
  SUCCEEDED: '成功', FAILED: '失败', TIMED_OUT: '超时', CANCELLED: '已取消',
  REJECTED: '已拒绝', SKIPPED: '已跳过', OUTCOME_UNKNOWN: '结果未知',
  UNCLOSED: '未闭合', STATE_CONFLICT: '状态冲突',
};

export const ACTIVITY_LABEL: Record<string, string> = {
  COMPLETED: '已终结', PAUSED: '已暂停', UNCLOSED: '已登记未闭合',
  ACTIVITY_UNKNOWN: '活性未知', STATE_CONFLICT: '状态待核对',
};

export const RELATION_LABEL: Record<string, string> = {
  VERIFIED: '已验证', UNVERIFIED_PARENT: '父级未验证', MISSING_PARENT: '父级缺失',
  ROOT_MISMATCH: '根不一致', SELF_ROOT_WITH_PARENT: '自根且有父', CYCLE: '关系成环',
};

export const LIFECYCLE_LABEL: Record<string, string> = {
  REGISTERED: '已登记', STARTED: '进行中', TERMINAL: '已终结', OUTCOME_UNKNOWN: '结果未知',
};
