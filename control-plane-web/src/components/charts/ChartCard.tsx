// ChartCard (§7.3): title + caliber description + sample/coverage badges +
// chart/table toggle + export + expand. Every chart answers one question and
// always offers a real HTML table alternative.
import { useMemo, useState, type ReactNode } from 'react';
import { BarChart3, Download, Info, Table as TableIcon } from 'lucide-react';
import { Card } from '../ui/primitives';
import { ChartHost } from './ChartHost';
import { DataTable, type Column } from '../ui/DataTable';
import { Drawer } from '../ui/Drawer';

export interface ChartTableData {
  columns: Column<Record<string, unknown>>[];
  rows: Record<string, unknown>[];
}

export function ChartCard({ title, caliber, badges, option, height, table, actions, empty, onClickPoint, span, ariaLabel }: {
  title: ReactNode;
  caliber?: string;
  badges?: ReactNode;
  option: Record<string, unknown> | null;
  height?: number;
  table?: ChartTableData;
  actions?: ReactNode;
  empty?: ReactNode;
  onClickPoint?: (p: { seriesId?: string; dataIndex?: number; name?: string; value?: unknown }) => void;
  span?: number;
  ariaLabel?: string;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [expanded, setExpanded] = useState(false);

  const csv = useMemo(() => {
    if (!table) return null;
    const header = table.columns.map((c) => c.key);
    const lines = [header.join(',')];
    for (const r of table.rows) {
      lines.push(header.map((k) => {
        const v = r[k];
        const s = v == null ? '' : String(v);
        const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
        return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
      }).join(','));
    }
    return lines.join('\n');
  }, [table]);

  const downloadCsv = () => {
    if (!csv) return;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${String(title).replace(/\s+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const headerRight = (
    <div className="row" style={{ gap: 4 }}>
      {badges}
      {table && (
        <button className="ghost" aria-label={view === 'chart' ? '切换为表格' : '切换为图表'}
          title={view === 'chart' ? '表格视图' : '图表视图'}
          onClick={() => setView(view === 'chart' ? 'table' : 'chart')}>
          {view === 'chart' ? <TableIcon size={14} /> : <BarChart3 size={14} />}
        </button>
      )}
      {table && (
        <button className="ghost" aria-label="导出 CSV" title="导出 CSV" onClick={downloadCsv}>
          <Download size={14} />
        </button>
      )}
      <button className="ghost" aria-label="展开" title="展开" onClick={() => setExpanded(true)}>
        ⤢
      </button>
      {actions}
    </div>
  );

  const body = (
    <>
      {caliber && (
        <div className="card-sub row" style={{ gap: 4, marginBottom: 6 }}>
          <Info size={11} aria-hidden /> {caliber}
        </div>
      )}
      {view === 'table' && table ? (
        <DataTable columns={table.columns} rows={table.rows} rowKey={(_r, i) => String(i)} />
      ) : option ? (
        <ChartHost option={option} height={height ?? 240} onClickPoint={onClickPoint} ariaLabel={ariaLabel} />
      ) : (empty ?? null)}
    </>
  );

  return (
    <>
      <Card title={title} right={headerRight} span={span}>{body}</Card>
      <Drawer open={expanded} onClose={() => setExpanded(false)} title={title}>
        {caliber && <p className="muted" style={{ marginTop: 0 }}>{caliber}</p>}
        {badges && <div className="row wrap" style={{ marginBottom: 10 }}>{badges}</div>}
        {option && <ChartHost option={option} height={420} onClickPoint={onClickPoint} ariaLabel={ariaLabel} />}
        {table && (
          <div style={{ marginTop: 16 }}>
            <DataTable columns={table.columns} rows={table.rows} rowKey={(_, i) => String(i)} dense />
          </div>
        )}
      </Drawer>
    </>
  );
}
