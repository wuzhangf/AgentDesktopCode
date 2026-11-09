// 数据浏览器 (§6.9): raw fact browsing — entities / events / issues with
// server pagination + event detail drawer (bounded payload preview).
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi, useApiPage } from '../api/hooks';
import { useFilters } from '../state/filters';
import { Badge, Card, EmptyState, ErrorBanner, Skeleton, StatusBadge, Tabs } from '../components/ui/primitives';
import { DataTable, Pager } from '../components/ui/DataTable';
import { Drawer } from '../components/ui/Drawer';
import { fmtInt, fmtMs, fmtTime, shortId } from '../lib/format';

const ENTITY_KINDS = ['TASK', 'RUN', 'RUN_SEGMENT', 'PLAN_REVISION', 'STEP', 'STEP_ATTEMPT', 'MODEL_CALL', 'MODEL_ATTEMPT', 'CONTEXT_SNAPSHOT', 'CONTEXT_TRANSFORM', 'TOOL_CALL', 'COMMAND', 'DELEGATION', 'REASONING_OUTPUT', 'COST_OBSERVATION', 'ARTIFACT'];
const LIFECYCLES = ['REGISTERED', 'STARTED', 'TERMINAL', 'OUTCOME_UNKNOWN'];

type Tab = 'entities' | 'events' | 'issues';

export default function ExplorerPage() {
  const { filters, sourceEpoch } = useFilters();
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<Tab>('entities');
  const [stack, setStack] = useState<(string | null)[]>([null]);

  // URL-carried filters/source changes invalidate the keyset cursor stack.
  const spKey = sp.toString();
  useEffect(() => {
    setStack((s) => (s.length > 1 || s[0] != null ? [null] : s));
  }, [spKey, sourceEpoch]);
  const [entityKind, setEntityKind] = useState('');
  const [entityId, setEntityId] = useState('');
  const [lifecycle, setLifecycle] = useState('');
  const [eventEntity, setEventEntity] = useState('');
  const [issueCode, setIssueCode] = useState('');
  const [severity, setSeverity] = useState('');
  const [eventOpen, setEventOpen] = useState<string | null>(null);

  const cursor = stack[stack.length - 1] ?? undefined;
  const paramsByTab: Record<Tab, Record<string, unknown>> = {
    entities: { entityKind: entityKind || undefined, entityId: entityId || undefined, lifecycle: lifecycle || undefined },
    events: { entityId: eventEntity || undefined },
    issues: { issueCode: issueCode || undefined, severity: severity || undefined },
  };
  const path = tab === 'entities' ? '/entities' : tab === 'events' ? '/events' : '/issues';
  const q = useApiPage<Record<string, unknown>>(path, { limit: 50, cursor, ...paramsByTab[tab] }, { keepPreviousData: true });
  const detailQ = useApi<Record<string, unknown>>(`/events/${eventOpen}`, undefined, { enabled: !!eventOpen });

  const rows = q.data?.data.rows ?? [];
  const reset = () => setStack([null]);

  return (
    <div className="col" style={{ gap: 16 }}>
      <h1 className="page-title">数据浏览器</h1>
      <div className="banner info">
        原始观测事实的只读浏览。展示字段为存储原值；payload 预览有界截断。
      </div>

      <Card>
        <Tabs active={tab} onChange={(t) => { setTab(t as Tab); reset(); }}
          tabs={[{ id: 'entities', label: '实体' }, { id: 'events', label: '事件' }, { id: 'issues', label: '登记问题' }]} />
        <div className="row wrap" style={{ marginBottom: 10, gap: 8 }}>
          {tab === 'entities' && (
            <>
              <select value={entityKind} aria-label="实体类型" onChange={(e) => { setEntityKind(e.target.value); reset(); }}>
                <option value="">全部类型</option>
                {ENTITY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <input placeholder="entity_id 精确" value={entityId} aria-label="entity_id"
                onChange={(e) => setEntityId(e.target.value)} onBlur={reset} onKeyDown={(e) => e.key === 'Enter' && reset()} />
              <select value={lifecycle} aria-label="lifecycle" onChange={(e) => { setLifecycle(e.target.value); reset(); }}>
                <option value="">全部 lifecycle</option>
                {LIFECYCLES.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </>
          )}
          {tab === 'events' && (
            <input placeholder="entity_id 过滤" value={eventEntity} aria-label="entity_id 过滤"
              onChange={(e) => setEventEntity(e.target.value)} onBlur={reset} onKeyDown={(e) => e.key === 'Enter' && reset()} />
          )}
          {tab === 'issues' && (
            <>
              <input placeholder="issue_code" value={issueCode} aria-label="issue_code"
                onChange={(e) => setIssueCode(e.target.value)} onBlur={reset} onKeyDown={(e) => e.key === 'Enter' && reset()} />
              <select value={severity} aria-label="severity" onChange={(e) => { setSeverity(e.target.value); reset(); }}>
                <option value="">全部级别</option>
                <option value="INFO">INFO</option><option value="WARN">WARN</option><option value="ERROR">ERROR</option>
              </select>
            </>
          )}
        </div>

        {q.isError && <ErrorBanner error={q.error} onRetry={() => q.refetch()} />}
        {q.isPending ? <Skeleton h={320} /> : (
          <>
            {tab === 'entities' && (
              <DataTable dense
                columns={[
                  { key: 'id', header: 'entity_id', render: (r) => <span className="mono">{shortId(String(r.entity_id))}</span> },
                  { key: 'kind', header: 'kind', render: (r) => <Badge tone="plain">{String(r.entity_kind)}</Badge> },
                  { key: 'state', header: '状态', render: (r) => <StatusBadge outcome={r.outcome as string} lifecycle={r.lifecycle as string} /> },
                  { key: 'native', header: 'native', render: (r) => String(r.native_status ?? '—') },
                  { key: 'reg', header: 'registered', render: (r) => fmtTime(r.registered_at as number | null, filters.timezone) },
                  { key: 'start', header: 'started', render: (r) => fmtTime(r.started_at as number | null, filters.timezone) },
                  { key: 'end', header: 'ended', render: (r) => fmtTime(r.ended_at as number | null, filters.timezone) },
                  { key: 'dur', header: 'duration', numeric: true, render: (r) => fmtMs(r.duration_ms as number | null) },
                  { key: 'rev', header: 'rev', numeric: true, render: (r) => fmtInt(r.current_revision as number | null) },
                  { key: 'run', header: 'root_run', render: (r) => <span className="mono">{r.root_run_id ? shortId(String(r.root_run_id)) : '—'}</span> },
                ]}
                rows={rows} rowKey={(r) => String(r.entity_id)} />
            )}
            {tab === 'events' && (
              <DataTable dense
                columns={[
                  { key: 'id', header: 'event_id', render: (r) => <span className="mono">{shortId(String(r.event_id))}</span> },
                  { key: 'entity', header: 'entity', render: (r) => <span className="mono">{shortId(String(r.entity_id))}</span> },
                  { key: 'kind', header: 'kind', render: (r) => String(r.entity_kind) },
                  { key: 'rev', header: 'rev', numeric: true, render: (r) => fmtInt(r.entity_revision as number | null) },
                  { key: 'type', header: 'type', render: (r) => <Badge tone="plain">{String(r.event_type)}</Badge> },
                  { key: 'occ', header: 'occurred', render: (r) => fmtTime(r.occurred_at as number | null, filters.timezone) },
                  { key: 'rec', header: 'recorded', render: (r) => fmtTime(r.recorded_at as number | null, filters.timezone) },
                ]}
                rows={rows} rowKey={(r) => String(r.event_id)}
                onRowClick={(r) => setEventOpen(String(r.event_id))} />
            )}
            {tab === 'issues' && (
              <DataTable dense
                columns={[
                  { key: 'code', header: 'code', render: (r) => <span className="mono">{String(r.issue_code)}</span> },
                  { key: 'sev', header: '级别', render: (r) => <Badge tone={String(r.severity) === 'ERROR' ? 'failure' : 'warning'}>{String(r.severity)}</Badge> },
                  { key: 'entity', header: 'entity', render: (r) => <span className="mono">{r.entity_id ? shortId(String(r.entity_id)) : '—'}</span> },
                  { key: 'n', header: '次数', numeric: true, render: (r) => fmtInt(r.occurrence_count as number) },
                  { key: 'first', header: '首次', render: (r) => fmtTime(r.first_seen_at as number | null, filters.timezone) },
                  { key: 'last', header: '最近', render: (r) => fmtTime(r.last_seen_at as number | null, filters.timezone) },
                  { key: 'res', header: '处置', render: (r) => String(r.resolution ?? '—') },
                ]}
                rows={rows} rowKey={(r, i) => String(r.issue_id ?? i)} />
            )}
            <Pager hasMore={q.data?.data.hasMore} canPrev={stack.length > 1}
              onNext={() => q.data?.data.nextCursor && setStack((s) => [...s, q.data.data.nextCursor!])}
              onPrev={() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
              note={q.isFetching ? '更新中…' : `本页 ${rows.length} 条`} />
          </>
        )}
      </Card>

      <Drawer open={!!eventOpen} onClose={() => setEventOpen(null)} title={`事件 ${eventOpen ? shortId(eventOpen) : ''}`}>
        {detailQ.isPending && <Skeleton h={200} />}
        {detailQ.isError && <ErrorBanner error={detailQ.error} onRetry={() => detailQ.refetch()} />}
        {detailQ.data?.data && <EventDetail e={detailQ.data.data} tz={filters.timezone} />}
      </Drawer>
    </div>
  );
}

function EventDetail({ e, tz }: { e: Record<string, unknown>; tz: string }) {
  const payload = typeof e.payload_json === 'string' ? e.payload_json : null;
  const truncated = payload != null && payload.length > 4000;
  return (
    <div className="col" style={{ gap: 12 }}>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', margin: 0, fontSize: 12 }}>
        <dt className="muted">entity</dt><dd className="mono" style={{ margin: 0 }}>{String(e.entity_id)}</dd>
        <dt className="muted">kind/rev</dt><dd style={{ margin: 0 }}>{String(e.entity_kind)} · rev {String(e.entity_revision)}</dd>
        <dt className="muted">type</dt><dd style={{ margin: 0 }}>{String(e.event_type)}</dd>
        <dt className="muted">occurred</dt><dd style={{ margin: 0 }}>{fmtTime(e.occurred_at as number | null, tz)}</dd>
        <dt className="muted">recorded</dt><dd style={{ margin: 0 }}>{fmtTime(e.recorded_at as number | null, tz)}</dd>
        <dt className="muted">source</dt><dd className="mono" style={{ margin: 0 }}>{String(e.source_instance_id ?? '—')}</dd>
        <dt className="muted">hash</dt><dd className="mono" style={{ margin: 0, overflowWrap: 'anywhere' }}>{String(e.payload_hash ?? '—')}</dd>
      </dl>
      <div>
        <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
          payload_json{truncated ? '（截断至 4000 字符）' : ''}
        </div>
        <pre style={{ fontSize: 11, maxHeight: 380, overflow: 'auto', background: 'var(--surface)', padding: 10, borderRadius: 6 }}>
          {payload ? payload.slice(0, 4000) : '—'}
        </pre>
      </div>
    </div>
  );
}
