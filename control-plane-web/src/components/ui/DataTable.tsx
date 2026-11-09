import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  numeric?: boolean;
  width?: number | string;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, empty, dense }: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  dense?: boolean;
}) {
  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div className="table-wrap">
      <table className="data" style={dense ? { fontSize: 12 } : undefined}>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)} className={onRowClick ? 'clickable' : ''}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}
              tabIndex={onRowClick ? 0 : undefined}>
              {columns.map((c) => (
                <td key={c.key} className={c.numeric ? 'num' : ''}>{c.render(r, i)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({ hasMore, onNext, onPrev, canPrev, note }: {
  hasMore?: boolean; onNext: () => void; onPrev: () => void; canPrev: boolean; note?: ReactNode;
}) {
  return (
    <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8, gap: 4 }}>
      {note && <span className="muted grow" style={{ fontSize: 11.5 }}>{note}</span>}
      <button className="ghost" onClick={onPrev} disabled={!canPrev} aria-label="上一页"><ChevronLeft size={15} /></button>
      <button className="ghost" onClick={onNext} disabled={!hasMore} aria-label="下一页"><ChevronRight size={15} /></button>
    </div>
  );
}
