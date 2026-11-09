// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelShell } from '../../src/renderer/app/ui/PanelShell';
import { Menu, MenuRadioItem, Popover } from '../../src/renderer/app/ui/Popover';
import { StatusBadge } from '../../src/renderer/app/ui/StatusBadge';
import {
  activityActionLabel,
  changeTypeLabel,
  envIssueLabel,
  runStateLabel,
  terminalStateLabel
} from '../../src/renderer/app/ui/labels';

function PopoverHarness(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <span className="popover-anchor">
      <button ref={anchorRef} type="button" onClick={() => setOpen((value) => !value)}>触发</button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} ariaLabel="示例浮层">
        <p>浮层内容</p>
      </Popover>
    </span>
  );
}

describe('ui primitives (U1)', () => {
  afterEach(() => { cleanup(); });

  it('PanelShell renders exactly one heading and one close control', () => {
    render(
      <PanelShell title="状态摘要" subtitle="运行 · repo" closeLabel="关闭状态面板" onClose={vi.fn()} testId="panel">
        <p>正文</p>
      </PanelShell>
    );
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '状态摘要' })).toBeDefined();
    expect(screen.getByRole('button', { name: '关闭状态面板' })).toBeDefined();
    expect(screen.getByText('正文')).toBeDefined();
    expect(screen.getByText('运行 · repo')).toBeDefined();
  });

  it('PanelShell renders the optional sticky footer only when provided', () => {
    const { rerender } = render(
      <PanelShell title="目录" closeLabel="关闭" onClose={vi.fn()}><p>body</p></PanelShell>
    );
    expect(document.querySelector('.panel-shell-footer')).toBeNull();
    rerender(
      <PanelShell title="目录" closeLabel="关闭" onClose={vi.fn()}
        footer={<button type="button">保存</button>}><p>body</p></PanelShell>
    );
    expect(screen.getByRole('button', { name: '保存' })).toBeDefined();
  });

  it('Popover closes on Escape and returns focus to the trigger', () => {
    render(<PopoverHarness />);
    const trigger = screen.getByRole('button', { name: '触发' });
    fireEvent.click(trigger);
    expect(screen.getByText('浮层内容')).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('浮层内容')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Popover closes on outside mousedown but ignores the trigger itself', () => {
    render(<PopoverHarness />);
    const trigger = screen.getByRole('button', { name: '触发' });
    fireEvent.click(trigger);
    fireEvent.mouseDown(trigger);
    expect(screen.getByText('浮层内容')).toBeDefined();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('浮层内容')).toBeNull();
  });

  it('Menu moves focus with arrow keys and skips disabled items', () => {
    const onA = vi.fn();
    const onB = vi.fn();
    render(
      <Menu ariaLabel="测试菜单">
        <MenuRadioItem title="选项 A" checked={false} onSelect={onA} />
        <MenuRadioItem title="选项 B" description="一行说明" checked onSelect={onB} />
        <MenuRadioItem title="选项 C" checked={false} disabled disabledReason="暂不可用" onSelect={vi.fn()} />
      </Menu>
    );
    const items = screen.getAllByRole('menuitemradio');
    expect(items).toHaveLength(3);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.click(items[1]!);
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onA).not.toHaveBeenCalled();
    expect((items[2] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('暂不可用')).toBeDefined();
  });

  it('StatusBadge keeps the caller testId and renders the tone class', () => {
    render(<StatusBadge tone="warn" label="2 项等待决定" testId="approval-count" />);
    const badge = screen.getByTestId('approval-count');
    expect(badge.className).toContain('tone-warn');
    expect(badge.textContent).toContain('2 项等待决定');
  });

  it('labels map known codes and fall back to the raw value', () => {
    expect(runStateLabel('WAITING_APPROVAL')).toBe('待审批');
    expect(runStateLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(changeTypeLabel('MODIFIED')).toBe('修改');
    expect(changeTypeLabel('BRAND_NEW')).toBe('BRAND_NEW');
    expect(activityActionLabel('decision')).toBe('决策中');
    expect(activityActionLabel('shell')).toBe('执行命令');
    expect(activityActionLabel('X_CUSTOM_VERB')).toBe('X_CUSTOM_VERB');
    expect(envIssueLabel('TOOLCHAIN_NOT_FOUND')).toBe('未找到工具链');
    expect(envIssueLabel('ANOTHER_ISSUE')).toBe('ANOTHER_ISSUE');
    expect(terminalStateLabel('LOST')).toBe('已失效');
    expect(terminalStateLabel('SOME_STATE')).toBe('SOME_STATE');
  });
});
