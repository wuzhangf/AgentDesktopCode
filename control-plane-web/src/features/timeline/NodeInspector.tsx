import type { TimelineNode } from '../../../shared/contracts/types';
import { fmtBytes, fmtMs, fmtTime, fmtTokens } from '../../lib/format';
import { Badge, KV, StatusBadge } from '../../components/ui/primitives';
import { Link } from 'react-router-dom';

export function NodeInspector({ node, timezone }: { node: TimelineNode | null; timezone: string }) {
  if (!node) {
    return <div className="muted" style={{ padding: 12 }}>选择时间线节点查看证据</div>;
  }
  const r = node.resourceSummary as Record<string, unknown>;
  const items: [string, React.ReactNode][] = [
    ['类型', node.kind],
    ['实体', <span className="mono">{node.entityId}</span>],
    ['状态', <StatusBadge outcome={node.outcome} lifecycle={node.lifecycle} activityState={node.activityState} reasons={node.qualityReasons} />],
    ['登记', fmtTime(node.registeredAt, timezone)],
    ['开始', fmtTime(node.startedAt, timezone)],
    ['结束', fmtTime(node.endedAt, timezone)],
    ['精确耗时', node.durationMs != null ? fmtMs(node.durationMs) : '—（未提供）'],
    ['墙钟跨度', node.startedAt != null && node.endedAt != null ? fmtMs(node.endedAt - node.startedAt) : '—'],
    ['timing_quality', node.timingQuality ?? '—'],
  ];
  if (r.resolvedModel || r.requestedModel) items.push(['模型', String(r.resolvedModel ?? r.requestedModel)]);
  if (r.providerId) items.push(['provider', String(r.providerId)]);
  if (r.httpStatus != null) items.push(['HTTP', String(r.httpStatus)]);
  if (r.transportOutcome) items.push(['传输结果', String(r.transportOutcome)]);
  if (r.failureClass) items.push(['失败类别', <Badge tone="failure">{String(r.failureClass)}</Badge>]);
  if (r.totalTokens != null || r.inputTokens != null) {
    items.push(['Token', `in ${fmtTokens(r.inputTokens as number)} / out ${fmtTokens(r.outputTokens as number)} / think ${fmtTokens(r.reasoningTokens as number)} / total ${fmtTokens(r.totalTokens as number)}`]);
  }
  if (r.canonicalToolName) items.push(['工具', String(r.canonicalToolName)]);
  if (r.resultBytes != null) items.push(['结果体积', fmtBytes(r.resultBytes as number)]);
  if (r.exitCode != null) items.push(['退出码', String(r.exitCode)]);
  if (r.role) items.push(['角色', String(r.role)]);
  if (r.childRunId) items.push(['子 Run', <span className="mono">{String(r.childRunId)}</span>]);
  if (node.qualityReasons.length) items.push(['质量提示', node.qualityReasons.map((q) => <Badge key={q} tone="warning">{q}</Badge>)]);
  if (node.detailRef) items.push(['详情', <Link to={node.detailRef}>打开关联页 →</Link>]);
  return (
    <div>
      <div className="card-title" style={{ marginBottom: 8 }}>{node.label}</div>
      <KV items={items} />
    </div>
  );
}
