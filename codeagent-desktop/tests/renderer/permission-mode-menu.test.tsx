// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionModeMenu } from '../../src/renderer/app/conversation/PermissionModeMenu';
import type { PermissionMode, PermissionModeModelProps } from '../../src/renderer/app/conversation/PermissionModeSelector';
import type { DesktopCapabilities } from '../../electron/shared/api-types';

afterEach(() => cleanup());

const capabilities: DesktopCapabilities = {
  compatible: true,
  operations: [{ id: 'execution.policy.update', availability: 'AVAILABLE', contractVersion: '2.1' }],
  features: {
    sessionV2: true, durableEvents: true, visibleOutputStream: true, worktreeExecution: true,
    mission: true, mcpHost: false, servicePty: false, readOnlySources: true, mcpReadOnlySource: true,
    skillsCatalog: true, hooks: true, readOnlySubagent: false
  },
  limits: { maxDiffBytes: 1000, maxEventPage: 100, maxVisibleDeltaChars: 1000 }
};

function Harness(props: PermissionModeModelProps & {
  pendingApprovalCount?: number;
  onJumpToApprovals?: () => void;
  automation?: { paused: boolean; pending: boolean; disabled: boolean; onToggle: () => void };
  onOpenProjectDefaults?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PermissionModeMenu
      {...props}
      open={open}
      onToggle={() => setOpen((current) => !current)}
      onClose={() => setOpen(false)}
    />
  );
}

function openMenu(): HTMLElement {
  fireEvent.click(screen.getByTestId('permission-mode-chip'));
  return screen.getByTestId('approval-settings-panel');
}

describe('permission mode menu (U2)', () => {
  it('shows the current mode short label on the chip', () => {
    render(<Harness capabilities={capabilities} value="AUTO_APPROVE" onChange={vi.fn()} />);
    const chip = screen.getByTestId('permission-mode-chip');
    expect(chip.getAttribute('aria-label')).toBe('权限模式：自动批准');
    expect(chip.getAttribute('aria-controls')).toBe('approval-settings-panel');
    expect(chip.textContent).toContain('自动批准');
  });

  it('keeps locked modes disabled with their reason visible', () => {
    render(
      <Harness
        capabilities={capabilities}
        value="STANDARD"
        lockedModes={['FULL_ACCESS']}
        lockReasons={{ FULL_ACCESS: '已锁定：组织上限为 自动批准' }}
        onChange={vi.fn()}
      />
    );
    const menu = openMenu();
    const lockedItem = within(menu).getByTestId('permission-mode-item-FULL_ACCESS') as HTMLButtonElement;
    expect(lockedItem.disabled).toBe(true);
    expect(lockedItem.textContent).toContain('已锁定：组织上限为 自动批准');
    expect((within(menu).getByTestId('permission-mode-item-STANDARD') as HTMLButtonElement).disabled).toBe(false);
  });

  it('fails closed with the shared status text when the capability is missing', () => {
    const onChange = vi.fn();
    render(<Harness capabilities={{ ...capabilities, operations: [] }} value="STANDARD" onChange={onChange} />);
    const menu = openMenu();
    expect(within(menu).getByText('服务未声明权限模式 API，保持标准权限')).toBeDefined();
    for (const mode of ['STANDARD', 'AUTO_APPROVE', 'FULL_ACCESS'] satisfies PermissionMode[]) {
      expect((within(menu).getByTestId(`permission-mode-item-${mode}`) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(within(menu).getByTestId('permission-mode-item-AUTO_APPROVE'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('grants FULL_ACCESS directly without a second confirmation', () => {
    const onChange = vi.fn();
    render(<Harness capabilities={capabilities} value="STANDARD" onChange={onChange} />);
    const menu = openMenu();
    fireEvent.click(within(menu).getByTestId('permission-mode-item-FULL_ACCESS'));
    expect(screen.queryByRole('dialog', { name: '确认完全访问权限' })).toBeNull();
    expect(onChange).toHaveBeenCalledWith('FULL_ACCESS');
  });

  it('shows the pending-approval and automation rows only when data exists', () => {
    const onToggle = vi.fn();
    const { unmount } = render(<Harness capabilities={capabilities} value="STANDARD" onChange={vi.fn()} />);
    let menu = openMenu();
    expect(within(menu).queryByTestId('approval-pending-summary')).toBeNull();
    expect(within(menu).queryByTestId('automation-control')).toBeNull();
    unmount();

    render(
      <Harness
        capabilities={capabilities}
        value="STANDARD"
        onChange={vi.fn()}
        pendingApprovalCount={2}
        onJumpToApprovals={vi.fn()}
        automation={{ paused: false, pending: false, disabled: false, onToggle }}
      />
    );
    menu = openMenu();
    expect(within(menu).getByTestId('approval-pending-summary').textContent).toContain('2 项审批等待决定');
    expect(within(menu).getByTestId('automation-control').textContent).toContain('自动批准调度：运行中');
    fireEvent.click(within(menu).getByTestId('automation-control-toggle'));
    expect(onToggle).toHaveBeenCalled();
  });
});
