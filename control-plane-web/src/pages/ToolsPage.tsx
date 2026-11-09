// 工具与命令 (§6.6): tool table, error pareto, output volume, command families.
import { useMemo } from 'react';
import { useApi } from '../api/hooks';
import { ChartCard } from '../components/charts/ChartCard';
import { rankedBarOption } from '../components/charts/options';
import { chartColors } from '../lib/chartTheme';
import { Banner, Card, EmptyState, ErrorBanner, Skeleton } from '../components/ui/primitives';
import { DataTable } from '../components/ui/DataTable';
import { fmtBytes, fmtInt, fmtMs, fmtRatio } from '../lib/format';

interface ToolsData {
  toolTable: {
    canonicalToolName: string; callCount: number;
    successRate: number | null; succeeded: number; failed: number; timedOut: number;
    terminalKnown: number; excluded: number;
    durationP50: number | null; durationP95: number | null; durationSamples: number;
    resultBytesTotal: number | null; resultBytesMedian: number | null; resultBytesSamples: number;
    requestedNames: string[];
  }[];
  totalCalls: number;
  errorPareto: { key: string; count: number }[];
  outputVolume: { tool: string; calls: number; medianBytes: number | null; totalBytes: number | null }[];
  commands: {
    total: number; infra: number;
    families: { family: string; count: number; failed: number; exitCodes: Record<string, number>; stdoutBytes: number; stderrBytes: number }[];
  } | null;
  note: string;
}

export default function ToolsPage() {
  const q = useApi<ToolsData>('/analytics/tools');
  const d = q.data?.data;
  const c = chartColors();

  const rankOption = useMemo(() => {
    if (!d) return null;
    return rankedBarOption(d.toolTable.slice(0, 14).map((t) => ({
      name: t.canonicalToolName, value: t.callCount,
      extra: `成功率 ${fmtRatio(t.successRate)} · p50 ${fmtMs(t.durationP50)}`,
    })));
  }, [d]);

  const errOption = useMemo(() => {
    if (!d) return null;
    return rankedBarOption(d.errorPareto.map((e) => ({ name: e.key, value: e.count, color: c.failure })));
  }, [d]);

  const volOption = useMemo(() => {
    if (!d) return null;
    return rankedBarOption(d.outputVolume.map((v) => ({
      name: v.tool, value: v.totalBytes,
      extra: `中位 ${fmtBytes(v.medianBytes)} · ${v.calls} 次`,
      color: c.output,
    })));
  }, [d]);

  if (q.isPending) return <div className="col"><Skeleton h={240} /><Skeleton h={240} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return null;

  return (
    <div className="col" style={{ gap: 16 }}>
      <h1 className="page-title">工具与命令</h1>
      <Banner kind="info">{d.note} 工具失败是执行质量；SQLITE_UNAVAILABLE 类问题在「质量与健康」页。</Banner>

      <div className="grid cols-12">
        <ChartCard span={7} title="工具调用排名" caliber="canonical_tool_name 聚合；成功率分母=已知终态"
          option={rankOption} height={280}
          empty={<EmptyState title="此范围无工具调用" />}
          table={{
            columns: [
              { key: 'name', header: '工具', render: (r) => String(r.canonicalToolName) },
              { key: 'n', header: '次数', numeric: true, render: (r) => fmtInt(r.callCount as number) },
              { key: 'rate', header: '成功率', numeric: true, render: (r) => fmtRatio(r.successRate as number | null) },
              { key: 'f', header: '失败', numeric: true, render: (r) => fmtInt(r.failed as number) },
            ],
            rows: d.toolTable as unknown as Record<string, unknown>[],
          }} />
        <ChartCard span={5} title="失败 Pareto" caliber="failure_class 或 FAILED 兜底"
          option={errOption} height={280}
          empty={<EmptyState title="无失败记录" />}
          table={{
            columns: [
              { key: 'k', header: '失败类', render: (r) => String(r.key) },
              { key: 'n', header: '数', numeric: true, render: (r) => fmtInt(r.count as number) },
            ],
            rows: d.errorPareto as unknown as Record<string, unknown>[],
          }} />
      </div>

      <Card title="工具明细" sub={`共 ${d.totalCalls} 次调用`}>
        <DataTable
          columns={[
            { key: 'name', header: '工具', render: (r) => <div>{r.canonicalToolName}{r.requestedNames.length > 1 && <div className="muted" style={{ fontSize: 10.5 }}>别名 {r.requestedNames.join(', ')}</div>}</div> },
            { key: 'n', header: '次数', numeric: true, render: (r) => fmtInt(r.callCount) },
            { key: 'rate', header: '成功率', numeric: true, render: (r) => `${fmtRatio(r.successRate)}（终态已知 ${r.terminalKnown}）` },
            { key: 'out', header: '成功/失败/超时', numeric: true, render: (r) => `${r.succeeded}/${r.failed}/${r.timedOut}` },
            { key: 'p50', header: 'p50', numeric: true, render: (r) => fmtMs(r.durationP50) },
            { key: 'p95', header: 'p95', numeric: true, render: (r) => fmtMs(r.durationP95) },
            { key: 'bytes', header: '结果字节', numeric: true, render: (r) => fmtBytes(r.resultBytesTotal) },
            { key: 'excl', header: '剔除', numeric: true, render: (r) => fmtInt(r.excluded) },
          ]}
          rows={d.toolTable}
          rowKey={(r) => r.canonicalToolName}
          empty={<EmptyState title="无工具调用" />} />
      </Card>

      <div className="grid cols-12">
        <ChartCard span={6} title="输出体积" caliber="result_bytes 合计（仅已知样本）"
          option={volOption} height={220}
          empty={<EmptyState title="无字节样本" hint="result_bytes 均为 NULL。" />}
          table={{
            columns: [
              { key: 't', header: '工具', render: (r) => String(r.tool) },
              { key: 'total', header: '合计', numeric: true, render: (r) => fmtBytes(r.totalBytes as number | null) },
              { key: 'med', header: '中位', numeric: true, render: (r) => fmtBytes(r.medianBytes as number | null) },
            ],
            rows: d.outputVolume as unknown as Record<string, unknown>[],
          }} />
        <Card span={6} title="命令族" sub={d.commands ? `共 ${d.commands.total} 条 · 内部基础设施 ${d.commands.infra}` : 'obs_command 不可用'}>
          {d.commands ? (
            <DataTable dense
              columns={[
                { key: 'fam', header: '族', render: (r) => String(r.family) },
                { key: 'n', header: '数', numeric: true, render: (r) => fmtInt(r.count as number) },
                { key: 'fail', header: '失败', numeric: true, render: (r) => fmtInt(r.failed as number) },
                { key: 'exit', header: '退出码', render: (r) => Object.entries(r.exitCodes as Record<string, number>).map(([k, v]) => `${k}×${v}`).join(' ') || '—' },
                { key: 'err', header: 'stderr', numeric: true, render: (r) => fmtBytes(r.stderrBytes as number | null) },
              ]}
              rows={d.commands.families as unknown as Record<string, unknown>[]}
              rowKey={(r) => String(r.family)}
              empty={<EmptyState title="无命令" />} />
          ) : <EmptyState title="无 obs_command 表" />}
        </Card>
      </div>
    </div>
  );
}
