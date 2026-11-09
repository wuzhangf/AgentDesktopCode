// LocalReportProvider — the real, deterministic report generator (task §10.2,
// design §12). It turns fixed-version source facts into Markdown + JSON inside
// the bounded executor, writes outputs atomically via ReportOutputStore and
// returns file digests. It is NOT a placeholder: every byte of the report is
// produced here, labelled deterministic — never presented as model semantic
// review, and it calls no external model/service.
import { REPORT_ERROR, REPORT_OUTPUT_FORMAT, LOCAL_PROVIDER_REF, LOCAL_PROVIDER_VERSION, LOCAL_REPORT_PROFILE, KNOWN_REPORT_PROFILES, REPORT_DATA_SCOPE } from './ports.mjs';
import { digestOf, utcNow } from './canonical.mjs';
import { ReportSourceError } from './sources.mjs';
import { PERSONAL_DIGEST_PATTERN } from '../../../shared/contracts/personal-enums.mjs';

export const REPORT_DOC_SCHEMA = 'personal-report/v1';

export class ReportProviderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Apply declared dataScope to fetched facts before rendering. Returns a
 * pruned copy; the resolved source digest stays the digest of what was READ
 * (audited), while the report body only carries what the user scoped. */
function enforceDataScope(facts, { includeSamples, includeSchema }) {
  if (!facts || typeof facts !== 'object') return facts;
  const out = { ...facts };
  if (!includeSamples) {
    delete out.sampleRows;
    delete out.sampleItems;
    if (out.deliveries) out.deliveries = { ...out.deliveries, recent: [] };
    if (out.changes) out.changes = { ...out.changes, items: [] };
  }
  if (!includeSchema && Array.isArray(out.columns)) {
    out.columns = out.columns.map((c) => {
      const { topValues, ...rest } = c;
      return rest;
    });
  }
  return out;
}

/** Parse sourceRef of form `<scheme>:<rest>`. */
export function parseSourceRef(sourceRef) {
  if (typeof sourceRef !== 'string' || sourceRef.length === 0 || sourceRef.length > 512) {
    throw new ReportSourceError(REPORT_ERROR.REPORT_SOURCE_UNKNOWN, 'sourceRef must be a non-empty string');
  }
  const idx = sourceRef.indexOf(':');
  if (idx < 1) {
    throw new ReportSourceError(REPORT_ERROR.REPORT_SOURCE_UNKNOWN,
      `sourceRef must use a <scheme>:<ref> form (data:|project:|delivery:|run:|session:), got ${sourceRef}`);
  }
  const scheme = sourceRef.slice(0, idx);
  const ref = sourceRef.slice(idx + 1);
  if (ref.length === 0 || ref.length > 256) {
    throw new ReportSourceError(REPORT_ERROR.REPORT_SOURCE_UNKNOWN, `empty or oversized source ref in ${sourceRef}`);
  }
  return { scheme, ref };
}

/** Caller-declared pins are checked, not trusted silently: a declared
 * sourceVersion/sourceDigest mismatching the resolved source yields a
 * warning in the report, never a silent substitution. */
function pinCheck(report, resolved) {
  const warnings = [];
  if (report.sourceDigest && PERSONAL_DIGEST_PATTERN.test(report.sourceDigest)
    && resolved.sourceDigest && report.sourceDigest !== resolved.sourceDigest) {
    warnings.push(`declared sourceDigest ${report.sourceDigest} != resolved ${resolved.sourceDigest} — report records the resolved digest`);
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// deterministic rendering
// ---------------------------------------------------------------------------

function escMd(s) { return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }

function mdTable(headers, rows) {
  const head = `| ${headers.map(escMd).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => escMd(c)).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function renderFactsMarkdown(facts, { includeSamples }) {
  const lines = [];
  if (facts.kind === 'csv') {
    lines.push('### 表格概览', '');
    lines.push(mdTable(['文件', '大小(字节)', '数据行数', '列数', '截断'],
      [[facts.fileName ?? '—', facts.sizeBytes ?? '—', facts.rowCount ?? '—', (facts.columns ?? []).length, facts.truncated ? '是' : '否']]));
    if (facts.columns?.length) {
      lines.push('', '### 列汇总', '');
      lines.push(mdTable(
        ['列', '非空', '空值', '去重值', '数值(min/max/均值)', '高频值'],
        facts.columns.map((c) => [
          c.name, c.nonEmpty, c.empty, c.distinct,
          c.numeric ? `${c.numeric.min} / ${c.numeric.max} / ${c.numeric.mean}` : '—',
          (c.topValues ?? []).map((t) => `${t.value}×${t.count}`).slice(0, 3).join(', ') || '—',
        ])));
    }
    if (includeSamples && facts.sampleRows?.length) {
      lines.push('', '### 样例行（前 N 行）', '');
      lines.push(mdTable(['#', ...(facts.columns ?? []).map((c) => c.name)],
        facts.sampleRows.map((r, i) => [String(i + 1), ...r])));
    }
    return lines;
  }
  if (facts.kind === 'json') {
    lines.push('### JSON 概览', '');
    lines.push(mdTable(['文件', '大小(字节)', '顶层形态', '数组长度'],
      [[facts.fileName ?? '—', facts.sizeBytes ?? '—', facts.jsonKind ?? '—', facts.itemCount ?? '—']]));
    if (facts.itemKeys?.length) {
      lines.push('', '### 元素键分布', '');
      lines.push(mdTable(['键', '出现次数'], facts.itemKeys.map((k) => [k.key, k.count])));
    }
    if (facts.topLevelKeys?.length) {
      lines.push('', '### 顶层字段', '');
      lines.push(mdTable(['字段', '类型'], facts.topLevelKeys.map((k) => [k.key, k.type])));
    }
    if (includeSamples && facts.sampleItems?.length) {
      lines.push('', '### 样例（截断至前 N 项）', '', '```json', JSON.stringify(facts.sampleItems, null, 2).slice(0, 8192), '```');
    }
    return lines;
  }
  if (facts.kind === 'project') {
    lines.push('### 项目概览', '');
    const p = facts.project ?? {};
    lines.push(mdTable(['字段', '值'],
      Object.entries(p).map(([k, v]) => [k, v])));
    if (facts.deliveries) {
      lines.push('', `### 交付（共 ${facts.deliveries.count} 条）`, '');
      lines.push(mdTable(['状态', '数量'], Object.entries(facts.deliveries.states ?? {})));
      if (includeSamples && facts.deliveries.recent?.length) {
        lines.push('', '#### 最近交付', '');
        lines.push(mdTable(['deliveryId', '状态', '更新时间'],
          facts.deliveries.recent.map((d) => [d.deliveryId ?? d.id ?? '—', d.state ?? d.status ?? '—', d.updatedAt ?? '—'])));
      }
    }
    if (facts.runs) {
      lines.push('', `### 运行（共 ${facts.runs.count} 条）`, '');
      lines.push(mdTable(['状态', '数量'], Object.entries(facts.runs.states ?? {})));
    }
    return lines;
  }
  if (facts.kind === 'delivery') {
    lines.push('### 交付详情', '');
    const d = facts.delivery ?? {};
    lines.push(mdTable(['字段', '值'], Object.entries(d).map(([k, v]) => [k, v])));
    if (facts.changes) {
      lines.push('', `### 变更（共 ${facts.changes.count} 条）`, '');
      lines.push(mdTable(['类别', '数量'], Object.entries(facts.changes.kinds ?? {})));
      if (includeSamples && facts.changes.items?.length) {
        lines.push('', '#### 变更明细（截断至 200 条）', '');
        lines.push(mdTable(['路径/对象', '类别', '摘要'],
          facts.changes.items.map((c) => [c.path ?? c.artifactRef ?? '—', c.kind ?? c.changeKind ?? '—', c.summary ?? '—'])));
      }
    }
    return lines;
  }
  if (facts.kind === 'run') {
    lines.push('### 运行详情', '');
    const r = facts.run ?? {};
    lines.push(mdTable(['字段', '值'], Object.entries(r).map(([k, v]) => [k, v])));
    if (facts.steps?.length) {
      lines.push('', `### 步骤（共 ${facts.steps.length} 条）`, '');
      lines.push(mdTable(['步骤', '状态', '结果'],
        facts.steps.map((s) => [s.name ?? s.stepId ?? '—', s.state ?? '—', s.outcome ?? '—'])));
    }
    if (facts.totals && Object.keys(facts.totals).length) {
      lines.push('', '### 合计', '');
      lines.push(mdTable(['指标', '值'], Object.entries(facts.totals).map(([k, v]) => [k, v])));
    }
    return lines;
  }
  if (facts.kind === 'session') {
    lines.push('### 会话概览', '');
    lines.push(mdTable(['字段', '值'], Object.entries(facts.session ?? {}).map(([k, v]) => [k, v])));
    return lines;
  }
  // generic fallback: bounded pretty-printed JSON so new fact kinds still render
  lines.push('### 事实（通用结构）', '', '```json', JSON.stringify(facts, null, 2).slice(0, 16384), '```');
  return lines;
}

function renderReport({ report, resolved, generatedAt, includeSamples }) {
  const title = `报告 ${report.reportId}`;
  const provenance = [
    `- 报告 ID: \`${report.reportId}\``,
    `- 请求 key: \`${report.requestKey}\``,
    `- 生成器: \`${LOCAL_PROVIDER_REF}\` (${LOCAL_PROVIDER_VERSION})`,
    `- 生成时间(UTC): ${generatedAt}`,
    `- 汇总类型: **确定性汇总（非模型语义审查）**`,
  ];
  const source = [
    `- sourceRef: \`${report.sourceRef}\``,
    `- sourceVersion: ${report.sourceVersion ? `\`${report.sourceVersion}\`` : '未指定'}`,
    `- 声明 sourceDigest: ${report.sourceDigest ? `\`${report.sourceDigest}\`` : '未提供'}`,
    `- 实际来源 digest: \`${resolved.sourceDigest ?? '—'}\``,
    `- 来源水位: ${resolved.watermark ?? '—'}`,
    `- 读取边界: maxBytes=${resolved.bounds?.maxInputBytes ?? resolved.bounds?.maxItems ?? '—'}, truncated=${Boolean(resolved.bounds?.truncated)}`,
  ];
  const scope = report.dataScope?.length
    ? report.dataScope.map((s) => `- ${s}`).join('\n')
    : '- 未声明扩展范围（仅本机聚合）';
  const warnings = [...(resolved.warnings ?? []), ...pinCheck(report, resolved)];
  const body = renderFactsMarkdown(resolved.facts, { includeSamples });
  const md = [
    `# ${title}`, '',
    '> 本报告由本机确定性作业生成；不含模型语义审查结论，不构成发布资格。',
    '',
    '## 溯源', '', ...provenance, '',
    '## 来源', '', ...source, '',
    '## 用户声明数据范围', '', scope, '',
    ...(warnings.length ? ['## 警告', '', ...warnings.map((w) => `- ${w}`), ''] : []),
    '## 汇总', '', ...body, '',
  ].join('\n');
  const json = {
    schemaVersion: REPORT_DOC_SCHEMA,
    reportId: report.reportId,
    request: {
      requestKey: report.requestKey,
      sourceRef: report.sourceRef,
      sourceVersion: report.sourceVersion ?? null,
      sourceDigest: report.sourceDigest ?? null,
      reportProfileRef: report.reportProfileRef ?? null,
      providerRef: report.providerRef,
      outputFormat: report.outputFormat,
      dataScope: report.dataScope ?? [],
    },
    source: {
      scheme: resolved.scheme,
      resolvedDigest: resolved.sourceDigest ?? null,
      watermark: resolved.watermark ?? null,
      bounds: resolved.bounds ?? null,
    },
    summaryKind: 'deterministic',
    semanticReview: false,
    summary: resolved.facts,
    warnings,
    generatedAt,
    provider: { ref: LOCAL_PROVIDER_REF, version: LOCAL_PROVIDER_VERSION },
  };
  return { md, json };
}

/**
 * Create the local provider. `sources` maps resolved schemes to adapters:
 * { data, project, delivery, run, session } — the analysis schemes share one
 * adapter; the service builds both via sources.mjs.
 */
export function createLocalReportProvider({ sources, store, now } = {}) {
  return {
    providerRef: LOCAL_PROVIDER_REF,
    providerVersion: LOCAL_PROVIDER_VERSION,
    deterministic: true,
    externalTransfer: false,
    profiles: KNOWN_REPORT_PROFILES,
    async generate(ctx) {
      const { report } = ctx;
      const effectiveSources = sources ?? ctx.sources;
      const effectiveStore = store ?? ctx.store;
      const clock = now ?? ctx.now;
      const profile = report.reportProfileRef || LOCAL_REPORT_PROFILE;
      if (!KNOWN_REPORT_PROFILES.includes(profile)) {
        throw new ReportProviderError(REPORT_ERROR.BAD_REQUEST, `unknown report profile ${profile}`);
      }
      const { scheme, ref } = parseSourceRef(report.sourceRef);
      const adapter = effectiveSources?.[scheme];
      if (!adapter) {
        throw new ReportProviderError(REPORT_ERROR.REPORT_SOURCE_UNKNOWN,
          `no source adapter for scheme ${scheme} (supported: ${Object.keys(effectiveSources ?? {}).join(', ') || 'none'})`);
      }
      const resolved = await adapter.fetchFacts({ scheme, ref, version: report.sourceVersion });
      const scope = Array.isArray(report.dataScope) ? report.dataScope : [];
      const includeSamples = scope.includes(REPORT_DATA_SCOPE.SAMPLE_ROWS);
      const includeSchema = scope.includes(REPORT_DATA_SCOPE.INCLUDE_SCHEMA);
      // dataScope is enforced on the facts themselves — not only the markdown —
      // so a SUMMARY_ONLY report genuinely contains no record-level data.
      const facts = enforceDataScope(resolved.facts, { includeSamples, includeSchema });
      const scoped = { ...resolved, facts };
      const { md, json } = renderReport({
        report: { ...report, reportProfileRef: profile },
        resolved: scoped, generatedAt: utcNow(clock), includeSamples,
      });
      const files = [];
      if (report.outputFormat === REPORT_OUTPUT_FORMAT.MARKDOWN || report.outputFormat === REPORT_OUTPUT_FORMAT.MARKDOWN_JSON) {
        files.push({ name: 'report.md', mediaType: 'text/markdown; charset=utf-8', bytes: Buffer.from(md, 'utf8') });
      }
      if (report.outputFormat === REPORT_OUTPUT_FORMAT.JSON || report.outputFormat === REPORT_OUTPUT_FORMAT.MARKDOWN_JSON) {
        files.push({ name: 'report.json', mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(json, null, 2), 'utf8') });
      }
      const written = files.map((f) => ({ ...f, ...effectiveStore.writeFileAtomic(report.reportId, f.name, f.bytes) }));
      const resultDigest = written.find((f) => f.name === 'report.json')?.digest ?? digestOf(written.map((f) => ({ name: f.name, digest: f.digest })));
      return {
        files: written.map((f) => ({ name: f.name, mediaType: f.mediaType, sizeBytes: f.sizeBytes, digest: f.digest, relPath: f.relPath })),
        resultDigest,
        resolvedSourceDigest: resolved.sourceDigest ?? null,
        sourceWatermark: resolved.watermark ?? null,
        summaryMeta: { summaryKind: 'deterministic', semanticReview: false, warnings: [...(resolved.warnings ?? []), ...pinCheck(report, resolved)] },
      };
    },
  };
}
