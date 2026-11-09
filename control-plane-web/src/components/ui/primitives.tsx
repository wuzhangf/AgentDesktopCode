import type { ReactNode } from 'react';
import { AlertTriangle, Info, XCircle } from 'lucide-react';
import { ACTIVITY_LABEL, LIFECYCLE_LABEL, OUTCOME_LABEL, RELATION_LABEL } from '../../lib/format';

export function Card({ title, sub, children, span, right, raised }: {
  title?: ReactNode; sub?: ReactNode; children: ReactNode; span?: number;
  right?: ReactNode; raised?: boolean;
}) {
  return (
    <section className={`card${raised ? ' raised' : ''}${span ? ` span-${span}` : ''}`}>
      {(title || right) && (
        <div className="row" style={{ marginBottom: 8 }}>
          {title && <div className="card-title">{title}</div>}
          {right && <div className="right row">{right}</div>}
        </div>
      )}
      {sub && <div className="card-sub">{sub}</div>}
      {children}
    </section>
  );
}

export function Badge({ tone = 'plain', children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return <span className={`badge ${tone}`} title={title}>{children}</span>;
}

export function StatusBadge({ outcome, lifecycle, activityState, reasons }: {
  outcome?: string | null; lifecycle?: string | null; activityState?: string | null;
  reasons?: string[];
}) {
  if (activityState === 'STATE_CONFLICT' || reasons?.length) {
    return <Badge tone="conflict" title={reasons?.join(', ')}>状态待核对</Badge>;
  }
  if (activityState === 'PAUSED') return <Badge tone="plain">已暂停</Badge>;
  if (activityState === 'UNCLOSED') return <Badge tone="unknown">未闭合</Badge>;
  if (activityState === 'ACTIVITY_UNKNOWN') return <Badge tone="unknown">活性未知</Badge>;
  if (outcome) {
    const tone = outcome === 'SUCCEEDED' ? 'success'
      : outcome === 'FAILED' || outcome === 'TIMED_OUT' ? 'failure'
      : 'plain';
    return <Badge tone={tone}>{OUTCOME_LABEL[outcome] ?? `${outcome}?`}</Badge>;
  }
  if (lifecycle) return <Badge tone="unknown">{LIFECYCLE_LABEL[lifecycle] ?? lifecycle}</Badge>;
  return <Badge tone="unknown">未知</Badge>;
}

export function RelationBadge({ state }: { state?: string | null }) {
  if (!state || state === 'VERIFIED') return null;
  return <Badge tone="conflict">{RELATION_LABEL[state] ?? state}</Badge>;
}

export function Skeleton({ h = 120 }: { h?: number }) {
  return <div className="skeleton" style={{ height: h }} aria-label="加载中" />;
}

export function EmptyState({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint && <div>{hint}</div>}
      {children}
    </div>
  );
}

export function Banner({ kind = 'info', children }: { kind?: 'info' | 'error' | 'demo'; children: ReactNode }) {
  const Icon = kind === 'error' ? XCircle : kind === 'demo' ? Info : AlertTriangle;
  return <div className={`banner ${kind}`} role="status"><Icon size={15} aria-hidden /> <div className="grow">{children}</div></div>;
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error as { code?: string; message?: string };
  return (
    <Banner kind="error">
      <span>{e?.message ?? '请求失败'}{e?.code ? `（${e.code}）` : ''}</span>
      {onRetry && <button onClick={onRetry}>重试</button>}
    </Banner>
  );
}

export function Tabs({ tabs, active, onChange }: {
  tabs: { id: string; label: ReactNode }[];
  active: string; onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={active === t.id}
          className={active === t.id ? 'active' : ''} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', margin: 0, fontSize: 12 }}>
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt className="muted nowrap">{k}</dt>
          <dd style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
