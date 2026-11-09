// CSV export helpers (§6.10): metadata header rows + formula-injection escape.
const FORMULA_PREFIX = /^[=+\-@]/;

export function csvCell(value) {
  if (value == null) return '';
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (FORMULA_PREFIX.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv({ meta, columns, rows }) {
  const lines = [];
  lines.push(`# source=${csvCell(meta.sourceId)} scope=${csvCell(meta.scopeId)} timezone=${csvCell(meta.timezone)} from=${meta.from ?? ''} to=${meta.to ?? ''} metricVersion=${csvCell(meta.metricVersion)} snapshotId=${csvCell(meta.snapshotId)}`);
  const ignored = meta.filtersIgnored && Object.keys(meta.filtersIgnored).length
    ? ` ignored=${JSON.stringify(meta.filtersIgnored)}` : '';
  lines.push(`# filters=${JSON.stringify(meta.filtersApplied ?? {})}${ignored}`);
  for (const w of meta.warnings ?? []) lines.push(`# warning ${w.code}: ${w.message}`);
  if (meta.mode === 'DEMO') lines.push('# DEMO DATA - not real execution records');
  lines.push(columns.map(csvCell).join(','));
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
