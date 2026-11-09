// Quality & capability presentation (§10.3, §14): honest empty states — a
// missing/empty table is a capability statement, never a fake zero.
import type { ReactNode } from 'react';
import { Database, ShieldAlert } from 'lucide-react';
import type { CapabilityEntry } from '../../../shared/contracts/types';
import { Badge, EmptyState } from '../../components/ui/primitives';

export function CapabilityBlock({ cap, children, title }: {
  cap: CapabilityEntry | undefined;
  children: ReactNode;
  title: string;
}) {
  if (!cap) return <>{children}</>;
  if (!cap.schemaAvailable) {
    return (
      <EmptyState title={`${title}：当前数据版本不支持`}
        hint="schema 缺少对应表/字段，本模块降级，其余页面不受影响。" />
    );
  }
  if (cap.observedRows === 0) {
    return (
      <EmptyState title={`${title}：无已登记记录`}
        hint={cap.sourceDeclared === 'YES'
          ? '采集端声明支持该观测类型，但所选范围没有记录。'
          : '采集范围待确认——不声称业务发生量为 0。'} />
    );
  }
  if (cap.usableSamples === 0) {
    return (
      <EmptyState title={`${title}：${cap.observedRows} 行记录但可分析字段全未知`}
        hint={cap.note ?? '字段已登记但数值未提供。'} />
    );
  }
  return <>{children}</>;
}

export function CoverageBadge({ ratio, known, total }: { ratio: number | null; known: number; total: number }) {
  if (total === 0) return <Badge tone="plain">无样本</Badge>;
  if (ratio == null) return <Badge tone="unknown">覆盖未知</Badge>;
  if (ratio >= 0.999) return <Badge tone="success">完整</Badge>;
  return <Badge tone="warning">{Math.round(ratio * 100)}% 可用</Badge>;
}

export function CoverageMatrix({ matrix }: {
  matrix: { family: string; label: string; total: number; fields: { field: string; known: number }[] }[];
}) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr><th>指标族</th><th>样本数</th>{matrix[0]?.fields.map((f) => <th key={f.field}>{f.field}</th>)}</tr>
        </thead>
        <tbody>
          {matrix.map((m) => (
            <tr key={m.family}>
              <td><Database size={12} style={{ verticalAlign: -2 }} /> {m.label}</td>
              <td className="num">{m.total}</td>
              {m.fields.map((f) => (
                <td key={f.field} className="num">
                  {m.total === 0 ? '—' : (
                    <span style={{ color: f.known / m.total >= 0.99 ? 'var(--success)' : f.known === 0 ? 'var(--failure)' : 'var(--warning)' }}>
                      {Math.round((f.known / m.total) * 100)}%
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConflictList({ items }: {
  items: { entityId: string; kind: string; reasons: string[]; lifecycle?: string; outcome?: string | null; nativeStatus?: string | null }[];
}) {
  if (!items.length) return <EmptyState title="无状态冲突" hint="生命周期与结果字段未发现矛盾。" />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>实体</th><th>类型</th><th>lifecycle</th><th>outcome</th><th>native_status</th><th>冲突原因</th></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.entityId}>
              <td className="mono">{i.entityId.slice(0, 12)}…</td>
              <td>{i.kind}</td>
              <td>{i.lifecycle}</td>
              <td>{i.outcome ?? '—'}</td>
              <td>{i.nativeStatus ?? '—'}</td>
              <td><Badge tone="conflict"><ShieldAlert size={11} />{i.reasons.join(', ')}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
