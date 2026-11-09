// KPI metric card (§6.1): value, unit, one delta, one quality badge. Values
// animate from old→new only when a real change arrives (§7.2).
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import type { MetricValue } from '../../../shared/contracts/types';
import { useAppNavigate } from '../../state/filters';
import { fmtDelta, fmtMetric, fmtPp } from '../../lib/format';
import { metricRegistry } from '../../lib/metricLabels';
import { motionEnabled } from '../../lib/motion';
import { Badge } from '../../components/ui/primitives';

function qualityBadge(m: MetricValue): ReactNode {
  if (m.state === 'NO_DATA') return <Badge tone="unknown">无数据</Badge>;
  if (m.state === 'UNSUPPORTED') return <Badge tone="plain">不支持</Badge>;
  if (m.completeness === 'PARTIAL') return <Badge tone="warning">{m.coverageRatio != null ? `${Math.round(m.coverageRatio * 100)}%可用` : '部分可用'}</Badge>;
  if (m.reasonCodes.includes('SMALL_SAMPLE')) return <Badge tone="info">小样本</Badge>;
  return null;
}

export function MetricCard({ metric, delay = 0 }: { metric: MetricValue; delay?: number }) {
  const nav = useAppNavigate();
  const def = metricRegistry(metric.metricId);
  const { main, sub } = fmtMetric(metric);

  const cmp = metric.comparison;
  const delta = cmp?.comparable
    ? (cmp.deltaKind === 'PERCENTAGE_POINT' ? fmtPp(cmp.delta) : fmtDelta(cmp.delta, true))
    : cmp?.reason === 'PREVIOUS_WAS_ZERO' ? '上期为 0' : null;
  const deltaClass = cmp?.delta == null ? 'delta-flat' : cmp.delta > 0 ? 'delta-up' : cmp.delta < 0 ? 'delta-down' : 'delta-flat';

  return (
    <motion.button
      className="kpi"
      style={{ textAlign: 'left', cursor: metric.drilldown?.path ? 'pointer' : 'default' }}
      initial={motionEnabled() ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay }}
      onClick={() => metric.drilldown?.path && nav(metric.drilldown.path, metric.drilldown.filters)}
      aria-label={`${def.label}: ${main}`}
    >
      <span className="label">{def.label}{qualityBadge(metric)}</span>
      <span className="value">
        <span>{main}</span>
      </span>
      <span className="sub">
        {sub}
        {delta && <span className={deltaClass} style={{ marginLeft: 6 }}>{delta}</span>}
      </span>
      {metric.state === 'NO_DATA' && metric.reasonCodes.includes('USAGE_NOT_PROVIDED') && (
        <span className="sub">未提供用量</span>
      )}
      {metric.state === 'NO_DATA' && metric.reasonCodes.includes('NO_EXACT_DURATION') && (
        <span className="sub">暂无精确耗时</span>
      )}
    </motion.button>
  );
}
