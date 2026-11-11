// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentRenderer } from '../../src/renderer/app/ContentRenderer';

afterEach(() => cleanup());

describe('ContentRenderer', () => {
  it('renders bounded markdown and code without injecting HTML', () => {
    render(<ContentRenderer text={'# Title\n\n**safe** and `inline`\n\n```ts\nconst value = 1;\n```\n\n<script>alert(1)</script>'} />);

    expect(screen.getByText('Title')).toBeDefined();
    expect(screen.getByText('safe')).toBeDefined();
    expect(screen.getByText('const value = 1;')).toBeDefined();
    expect(screen.queryByRole('script')).toBeNull();
    expect(screen.getByText(/HTML、脚本/)).toBeDefined();
  });

  it('keeps unsafe links as text and only accepts https links', () => {
    render(<ContentRenderer text="[bad](javascript:alert(1))" />);
    expect(screen.getByText((text) => text.includes('[bad](javascript:alert(1))'))).toBeDefined();
    cleanup();
    render(<ContentRenderer text="[good](https://example.com/docs)" />);
    expect(screen.getByRole('link', { name: 'good' }).getAttribute('href')).toBe('https://example.com/docs');
  });

  it('renders GFM tables with narrow alignment dividers like :--:', () => {
    // Models frequently emit two-dash alignment columns; the divider rule
    // must accept any dash count or the whole table degrades to a paragraph.
    const markdown = [
      '| 模块 | 是否直接访问 | 表 |',
      '|------|:--:|------|',
      '| customers-service | ✅ 是 | `owners` |',
      '| api-gateway | ❌ 否 | 无 |'
    ].join('\n');
    render(<ContentRenderer text={markdown} />);
    expect(screen.getByRole('table')).toBeDefined();
    expect(screen.getByText('customers-service')).toBeDefined();
    expect(screen.getByText('owners')).toBeDefined();
  });

  it('renders ordered and unordered Markdown lists as list elements', () => {
    const { container } = render(<ContentRenderer text={'1. First item\n2. Second item\n\n- Bullet item\n- Another bullet'} />);

    expect(screen.getAllByRole('list')).toHaveLength(2);
    expect(container.querySelector('ol')?.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('ul')?.querySelectorAll('li')).toHaveLength(2);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('Bullet item')).toBeDefined();
  });

  it('renders long response content inline without automatic folding or metrics', () => {
    const paragraph = Array.from({ length: 26 }, (_, index) => `paragraph-line-${index + 1}`).join('\n');
    const table = [
      '| name | value |',
      '| --- | --- |',
      ...Array.from({ length: 13 }, (_, index) => `| row-${index + 1} | ${index + 1} |`)
    ].join('\n');
    const code = ['```ts', ...Array.from({ length: 20 }, (_, index) => `const codeLine${index + 1} = ${index + 1};`), '```'].join('\n');
    const { container } = render(<ContentRenderer text={`${paragraph}\n\n${table}\n\n${code}`} />);

    expect(container.querySelector('details.fold-block')).toBeNull();
    expect(container.textContent).toContain('paragraph-line-26');
    expect(container.textContent).toContain('row-13');
    expect(container.textContent).toContain('const codeLine20 = 20;');
    expect(container.textContent).not.toContain('code points');
  });
});
