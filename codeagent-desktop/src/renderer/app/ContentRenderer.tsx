import { memo, useMemo, useState, type ReactNode } from 'react';

const MAX_MARKDOWN_CHARS = 50_000;
const MAX_CODE_CHARS = 30_000;
const MAX_TABLE_ROWS = 200;

type MarkdownBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'code'; language: string; source: string; closed: boolean }
  | { kind: 'unsupported'; source: string; reason: string };

function isRawHtml(text: string): boolean {
  return /<\/?[a-z][^>]*>|javascript\s*:|data\s*:\s*text\/html|file:\/\//i.test(text);
}

function splitTableRow(line: string): string[] {
  const normalized = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return normalized.split('|').map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  // GFM allows any dash count (models often emit narrow `:--:` columns),
  // so require one or more dashes with optional alignment colons only.
  return splitTableRow(line).length > 0 && splitTableRow(line).every((cell) => /^:?-+:?$/.test(cell));
}

function parseMarkdown(source: string): MarkdownBlock[] {
  const bounded = source.length > MAX_MARKDOWN_CHARS ? `${source.slice(0, MAX_MARKDOWN_CHARS)}\n\n[内容已限制为 50,000 个字符]` : source;
  const lines = bounded.replaceAll('\r\n', '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }

    const fence = line.match(/^\s*```([^\s`]*)\s*$/);
    if (fence) {
      const language = fence[1] ?? 'text';
      const codeLines: string[] = [];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        if (/^\s*```\s*$/.test(lines[index] ?? '')) { closed = true; index += 1; break; }
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      const sourceText = codeLines.join('\n');
      blocks.push(sourceText.length > MAX_CODE_CHARS
        ? { kind: 'unsupported', source: sourceText.slice(0, MAX_CODE_CHARS), reason: '代码块过大，已安全截断' }
        : { kind: 'code', language: language || 'text', source: sourceText, closed });
      continue;
    }

    const heading = line.match(/^\s*(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (heading) { blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! }); index += 1; continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) { quote.push((lines[index] ?? '').replace(/^\s*>\s?/, '')); index += 1; }
      blocks.push({ kind: 'quote', text: quote.join('\n') });
      continue;
    }
    if (/^\s*(?:[-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\. /.test(line);
      const items: string[] = [];
      while (index < lines.length && (ordered ? /^\s*\d+\. /.test(lines[index] ?? '') : /^\s*[-*+] /.test(lines[index] ?? ''))) {
        items.push((lines[index] ?? '').replace(ordered ? /^\s*\d+\. / : /^\s*[-*+] /, ''));
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1] ?? '')) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) {
        if (rows.length < MAX_TABLE_ROWS) rows.push(splitTableRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim()
      && !/^\s*```/.test(lines[index] ?? '')
      && !/^\s*(?:#{1,4})\s+/.test(lines[index] ?? '')
      && !/^\s*(?:[-*+] |\d+\. |>)/.test(lines[index] ?? '')) {
      paragraph.push(lines[index] ?? ''); index += 1;
    }
    const text = paragraph.join('\n');
    blocks.push(isRawHtml(text)
      ? { kind: 'unsupported', source: text, reason: 'HTML、脚本或本地地址不会在消息中执行' }
      : { kind: 'paragraph', text });
  }
  return blocks;
}

function safeExternalHref(href: string): string | null {
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.toString() : null;
  } catch { return null; }
}

function InlineText(props: { text: string }): React.JSX.Element {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\)\n]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(props.text)) !== null) {
    if (match.index > last) parts.push(props.text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) parts.push(<code key={key++} className="inline-code">{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('*')) parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link ? safeExternalHref(link[2]!) : null;
      if (link && href) {
        parts.push(<a key={key++} href={href} onClick={(event) => { event.preventDefault(); void window.codeAgentDesktop.openExternalHttps(href); }}>{link[1]}</a>);
      } else parts.push(<span key={key++} className="unsafe-link">{token}</span>);
    }
    last = match.index + token.length;
  }
  if (last < props.text.length) parts.push(props.text.slice(last));
  return <>{parts}</>;
}

function CodeBlock(props: { language: string; source: string; closed: boolean }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard?.writeText(props.source); setCopied(true); window.setTimeout(() => setCopied(false), 1200); } catch { /* clipboard is optional */ }
  };
  const body = (
    <div className="content-code-block">
      <div className="content-code-toolbar"><span>{props.language || 'text'}</span><span>{!props.closed ? 'streaming' : ''}</span><button type="button" onClick={() => void copy()}>{copied ? '已复制' : '复制'}</button></div>
      <pre><code>{props.source}</code></pre>
    </div>
  );
  return body;
}

interface MermaidGraph {
  nodes: Array<{ id: string; label: string; index: number }>;
  edges: Array<{ from: string; to: string; label?: string }>;
}

function parseMermaidGraph(source: string): MermaidGraph | null {
  const edges: MermaidGraph['edges'] = [];
  const labels = new Map<string, string>();
  const edgePattern = /\b([A-Za-z][\w-]{0,30})(?:\s*\[([^\]]{0,100})\])?\s*--+>\s*(?:\|([^|]{0,80})\|\s*)?([A-Za-z][\w-]{0,30})(?:\s*\[([^\]]{0,100})\])?/g;
  let match: RegExpExecArray | null;
  while ((match = edgePattern.exec(source)) !== null) {
    const from = match[1] ?? '';
    const to = match[4] ?? '';
    if (!from || !to) continue;
    if (match[2]) labels.set(from, match[2]);
    if (match[5]) labels.set(to, match[5]);
    edges.push({ from, to, ...(match[3] ? { label: match[3] } : {}) });
  }
  if (edges.length === 0) return null;
  const ids = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
  return { nodes: ids.map((id, index) => ({ id, label: labels.get(id) ?? id, index })), edges };
}

function DiagramBlock(props: { source: string }): React.JSX.Element {
  const blocked = props.source.length > MAX_CODE_CHARS
    || /\b(click|foreignObject|href\s*=|<\s*[/]?\s*(?:script|style|[a-z]))/i.test(props.source);
  const graph = blocked ? null : parseMermaidGraph(props.source);
  return (
    <div className="content-diagram-block" role="group" aria-label="图示">
      <div className="content-block-label">图示 {blocked || !graph ? '· 仅源码' : '· 安全预览'}</div>
      {blocked ? <p className="content-fallback">图形包含不允许的交互或内容，已保留源码。</p> : graph ? <>
        <p className="diagram-summary">本地安全子集预览；交互、外链和 HTML label 已禁用。</p>
        <svg className="diagram-svg" viewBox={`0 0 ${Math.max(320, graph.nodes.length * 150)} 150`} role="img" aria-label={`Mermaid graph with ${graph.nodes.length} nodes`}>
          {graph.edges.map((edge, index) => {
            const from = graph.nodes.find((node) => node.id === edge.from);
            const to = graph.nodes.find((node) => node.id === edge.to);
            if (!from || !to) return null;
            const x1 = 70 + from.index * 140;
            const x2 = 70 + to.index * 140;
            return <g key={`${edge.from}-${edge.to}-${index}`}><line x1={x1 + 48} y1="75" x2={x2 - 48} y2="75" /><title>{edge.label ?? `${edge.from} to ${edge.to}`}</title></g>;
          })}
          {graph.nodes.map((node) => <g key={node.id}><rect x={22 + node.index * 140} y="52" width="96" height="46" rx="7" /><text x={70 + node.index * 140} y="80" textAnchor="middle">{node.label.slice(0, 18)}</text></g>)}
        </svg>
      </> : <p className="content-fallback">图形语法不在当前安全预览子集内，已保留源码。</p>}
      <details><summary>查看源码</summary><pre><code>{props.source}</code></pre></details>
    </div>
  );
}

function ChartBlock(props: { source: string }): React.JSX.Element {
  let parsed: unknown;
  try { parsed = JSON.parse(props.source); } catch { parsed = null; }
  const rows = parsed && typeof parsed === 'object' && Array.isArray((parsed as { data?: unknown }).data)
    ? (parsed as { data: Array<Record<string, unknown>> }).data : [];
  const title = parsed && typeof parsed === 'object' && typeof (parsed as { title?: unknown }).title === 'string'
    ? (parsed as { title: string }).title : 'Chart data';
  const valid = rows.length > 0 && rows.length <= MAX_TABLE_ROWS && rows.every((row) => row && typeof row === 'object' && !Object.values(row).some((value) => typeof value === 'string' && /^(https?:|data:|javascript:)/i.test(value)));
  return (
    <div className="content-chart-block" role="group" aria-label={title}>
      <div className="content-block-label">{title} · {valid ? `${rows.length} rows` : 'source only'}</div>
      {valid ? <div className="chart-bars" aria-hidden="true">{rows.slice(0, 12).map((row, index) => { const numeric = Object.values(row).find((value) => typeof value === 'number') as number | undefined; const width = numeric === undefined ? 12 : Math.max(8, Math.min(100, Math.abs(numeric))); return <progress key={index} className="chart-bar" value={width} max={100} />; })}</div> : <p className="content-fallback">图表数据不符合受限本地 JSON 规范，已降级为源码。</p>}
      {valid ? <table><tbody>{rows.slice(0, 20).map((row, index) => <tr key={index}>{Object.entries(row).map(([key, value]) => <td key={key}>{String(value)}</td>)}</tr>)}</tbody></table> : null}
      {!valid ? <pre><code>{props.source}</code></pre> : null}
    </div>
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBlock(left: MarkdownBlock, right: MarkdownBlock): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'heading': return right.kind === 'heading' && left.level === right.level && left.text === right.text;
    case 'paragraph': return right.kind === 'paragraph' && left.text === right.text;
    case 'quote': return right.kind === 'quote' && left.text === right.text;
    case 'list': return right.kind === 'list' && left.ordered === right.ordered && sameStringArray(left.items, right.items);
    case 'table':
      return right.kind === 'table'
        && sameStringArray(left.headers, right.headers)
        && left.rows.length === right.rows.length
        && left.rows.every((row, index) => sameStringArray(row, right.rows[index] ?? []));
    case 'code': return right.kind === 'code' && left.language === right.language && left.source === right.source && left.closed === right.closed;
    case 'unsupported': return right.kind === 'unsupported' && left.source === right.source && left.reason === right.reason;
  }
}

const Block = memo(function Block(props: { block: MarkdownBlock }): React.JSX.Element {
  const block = props.block;
  switch (block.kind) {
    case 'heading': return <div className={`content-heading level-${block.level}`}><InlineText text={block.text} /></div>;
    case 'paragraph': return <p><InlineText text={block.text} /></p>;
    case 'quote': return <blockquote><InlineText text={block.text} /></blockquote>;
    case 'list': { const List = block.ordered ? 'ol' : 'ul'; return <List>{block.items.map((item, index) => <li key={index}><InlineText text={item} /></li>)}</List>; }
    case 'table': {
      return <div className="content-table-wrap"><table><thead><tr>{block.headers.map((header, headerIndex) => <th key={headerIndex}><InlineText text={header} /></th>)}</tr></thead><tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={`${index}-${cellIndex}`}><InlineText text={cell} /></td>)}</tr>)}</tbody></table></div>;
    }
    case 'code': return block.language.toLowerCase() === 'mermaid' ? <DiagramBlock source={block.source} /> : block.language.toLowerCase() === 'chart' || block.language.toLowerCase() === 'vega-lite' ? <ChartBlock source={block.source} /> : block.language.toLowerCase() === 'math' || block.language.toLowerCase() === 'latex' ? <div className="content-math-block"><span className="content-block-label">数学 · 安全文本</span><code>{block.source}</code></div> : <CodeBlock language={block.language} source={block.source} closed={block.closed} />;
    case 'unsupported': return <div className="content-fallback-block"><span className="content-block-label">不支持的内容</span><span>{block.reason}</span><pre><code>{block.source}</code></pre></div>;
  }
}, (previous, next) => sameBlock(previous.block, next.block));

/**
 * Memoized safe-subset Markdown renderer (2026-09-05 design §9.2). The parse
 * result is cached per source string, so composer keystrokes or live output
 * appends elsewhere in the transcript never re-parse unchanged bodies. The
 * restricted parser and no-external-execution boundaries are unchanged; long
 * message content is rendered inline without an automatic fold.
 */
export const ContentRenderer = memo(function ContentRenderer(
  props: { text: string; className?: string }
): React.JSX.Element {
  const source = typeof props.text === 'string' ? props.text : '';
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return <div className={`content-renderer${props.className ? ` ${props.className}` : ''}`}>{blocks.map((block, index) => <Block block={block} key={index} />)}</div>;
});
