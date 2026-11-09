// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolActivityGroup } from '../../src/renderer/app/conversation/ToolActivityGroup';
import type { RunActivity } from '../../src/renderer/app/activity/activityTypes';

afterEach(() => cleanup());

function item(id: string, kind: string, status = 'SUCCEEDED'): RunActivity {
  return { activityId: id, runId: 'run-1', kind, status };
}

describe('ToolActivityGroup folding', () => {
  it('collapses a finished all-success trace to one summary line', () => {
    const activities = Array.from({ length: 18 }, (_, i) => item(`a${i}`, 'WORKSPACE_ANALYSIS'));
    render(<ToolActivityGroup activities={activities} />);
    const group = screen.getByTestId('activity-group');
    expect(group.textContent).toContain('18 步');
    expect(group.textContent).toContain('已成功 18');
    // detail rows stay hidden until expanded
    expect(group.className).toContain('activity-group-collapsed');
    // expand on head click
    fireEvent.click(screen.getByRole('button', { name: /执行过程/ }));
    expect(screen.getByTestId('activity-group').className).not.toContain('activity-group-collapsed');
  });

  it('keeps live or noteworthy traces open', () => {
    const activities = Array.from({ length: 18 }, (_, i) => item(`a${i}`, 'WORKSPACE_ANALYSIS'));
    const { unmount } = render(<ToolActivityGroup activities={activities} live />);
    expect(screen.getByTestId('activity-group').className).not.toContain('activity-group-collapsed');
    unmount();
    const withFailure = [...activities.slice(0, 17), item('bad', 'COMMAND', 'FAILED')];
    render(<ToolActivityGroup activities={withFailure} />);
    expect(screen.getByTestId('activity-group').className).not.toContain('activity-group-collapsed');
  });

  it('shows the real process tool and returned execution summary', () => {
    const processActivity: RunActivity = {
      activityId: 'process-1',
      runId: 'run-1',
      kind: 'COMMAND',
      status: 'SUCCEEDED',
      toolName: 'process_exec',
      capabilityId: 'com.agent.process.exec',
      detail: 'where.exe java',
      commandPreview: 'where.exe java',
      resultSummary: 'exitCode 0; stdout 42 bytes; stderr 0 bytes'
    };
    render(<ToolActivityGroup activities={[processActivity]} />);

    expect(screen.getByTestId('activity-group').textContent).toContain('process_exec');
    fireEvent.click(screen.getByRole('button', { name: /执行命令/ }));
    expect(screen.getByText('where.exe java', { selector: 'code.activity-command' })).toBeTruthy();
    expect(screen.getByTestId('activity-group').textContent).toContain('exitCode 0');
  });
});
