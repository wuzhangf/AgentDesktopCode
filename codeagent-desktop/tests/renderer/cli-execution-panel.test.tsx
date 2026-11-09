// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliExecutionTranscript } from '../../src/renderer/app/conversation/CliExecutionTranscript';
import { CliActivityRow } from '../../src/renderer/app/conversation/CliActivityRow';
import type { RunActivity } from '../../src/renderer/app/activity/activityTypes';

const now = Date.parse('2026-09-13T00:00:10.000Z');

function item(overrides: Partial<RunActivity> = {}): RunActivity {
  return {
    activityId: 'activity-1', runId: 'run-1', kind: 'COMMAND', status: 'RUNNING',
    startedAt: '2026-09-13T00:00:00.000Z', ...overrides
  };
}

describe('CLI execution transcript', () => {
  afterEach(() => cleanup());

  it('renders a real running placeholder when no activity event exists yet', () => {
    render(<CliExecutionTranscript runId="run-1" activities={[]} live nowMs={now} activitiesAvailable />);
    expect(screen.getByTestId('cli-execution-empty').textContent).toContain('等待执行明细');
  });

  it('keeps one activity row and updates its elapsed/detail facts', () => {
    render(<CliExecutionTranscript runId="run-1" activities={[item({ commandPreview: 'mvn test' })]} live nowMs={now} activitiesAvailable />);
    expect(screen.getByText('mvn test')).toBeTruthy();
    expect(screen.getByText('已运行 00:10')).toBeTruthy();
    expect(screen.getByText('$ mvn test')).toBeTruthy();
    // Running commands show the pending line inside the terminal-style log
    // block instead of the old 输出摘要 label.
    expect(screen.getByText('等待命令返回输出…')).toBeTruthy();
  });

  it('collapses a completed structured purpose group to its two-line summary', () => {
    render(<CliExecutionTranscript runId="run-1" activities={[item({
      status: 'SUCCEEDED', commandPreview: 'mvn test', finishedAt: '2026-09-13T00:00:03.000Z', durationMillis: 3000,
      groupId: 'verify', groupPurpose: '验证修复', groupStartNote: '运行测试验证修改。', groupSummary: '验证通过：测试通过'
    })]} live={false} nowMs={now} activitiesAvailable />);
    const group = screen.getByText('验证通过：测试通过');
    expect(group).toBeTruthy();
    expect(screen.queryByText('$ mvn test')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /验证通过/ }));
    fireEvent.click(screen.getByRole('button', { name: '已完成：执行命令 · mvn test' }));
    expect(screen.getByText('$ mvn test')).toBeTruthy();
  });

  it('never renders withheld command content into the row or details', () => {
    render(<CliExecutionTranscript runId="run-1" activities={[item({
      status: 'FAILED', redactionState: 'WITHHELD', commandPreview: 'SECRET_COMMAND', detail: 'SECRET_DETAIL'
    })]} live={false} nowMs={now} activitiesAvailable />);
    expect(screen.queryByText('SECRET_COMMAND')).toBeNull();
    expect(screen.queryByText('SECRET_DETAIL')).toBeNull();
    expect(screen.getByText('命令内容因安全策略隐藏')).toBeTruthy();
  });

  it('renders a single completeness line carrying the loaded count and the service reason', () => {
    render(<CliExecutionTranscript
      runId="run-1" activities={[item({ status: 'SUCCEEDED' })]} live={false} nowMs={now} activitiesAvailable
      loadedActivityCount={1} activityHistoryComplete={false} activityHistoryReason="ACTIVITY_QUERY_LIMIT_REACHED"
    />);
    const lines = document.querySelectorAll('.cli-activity-completeness');
    expect(lines.length).toBe(1);
    expect(lines[0]!.textContent).toBe('已加载 1 项活动 · 快照不完整（活动数量达到服务端单次查询上限），更多记录按需加载');
  });

  it('renders the completeness line without a reason when the snapshot carries none', () => {
    render(<CliExecutionTranscript
      runId="run-1" activities={[item({ status: 'SUCCEEDED' })]} live={false} nowMs={now} activitiesAvailable
      activityHistoryComplete={false}
    />);
    const lines = document.querySelectorAll('.cli-activity-completeness');
    expect(lines.length).toBe(1);
    expect(lines[0]!.textContent).toBe('已加载 1 项活动 · 快照不完整，更多记录按需加载');
  });

  it('renders file name, range and read bytes from structured facts', () => {
    const openFile = vi.fn();
    render(<CliActivityRow activity={item({
      kind: 'FILE_READ', status: 'SUCCEEDED',
      fileRef: 'apps/codeagent-desktop/src/renderer/app/App.tsx',
      fileName: 'App.tsx', relativeDirectory: 'apps/codeagent-desktop/src/renderer/app',
      startLine: 120, endLine: 240, bytesRead: 6000, durationMillis: 200
    })} nowMs={now} defaultOpen onOpenFile={openFile} />);

    const link = screen.getByRole('button', { name: 'App.tsx' });
    expect(link).toBeTruthy();
    // The compact row drops the trailing directory; the ref stays on the tooltip.
    expect(screen.queryByText('apps/codeagent-desktop/src/renderer/app')).toBeNull();
    expect(link.getAttribute('title')).toBe('打开 apps/codeagent-desktop/src/renderer/app/App.tsx');
    expect(screen.getByText('第 120–240 行')).toBeTruthy();
    expect(screen.getByText('6 KB')).toBeTruthy();
    // §5.4: the start clock lives in the expanded timing line
    // `开始 HH:MM:SS · 耗时 mm:ss`, not in the row meta.
    expect(screen.getByText(/开始 \d{2}:\d{2}:\d{2}/)).toBeTruthy();
    expect(screen.queryByText('读取量未知')).toBeNull();
    expect(screen.queryByText('耗时未知')).toBeNull();
    expect(screen.queryByText(/^开始：/)).toBeNull();
    expect(screen.queryByText(/^结束：/)).toBeNull();

    // The file link is independent from the row disclosure control.
    fireEvent.click(screen.getByRole('button', { name: 'App.tsx' }));
    expect(openFile).toHaveBeenCalledWith(
      'apps/codeagent-desktop/src/renderer/app/App.tsx', 120, 'run-1'
    );
    expect(screen.getByText('读取范围：第 120–240 行')).toBeTruthy();
  });

  it('uses the legacy typed target ref and does not confuse file size with read bytes', () => {
    render(<CliActivityRow activity={item({
      kind: 'FILE_READ', status: 'SUCCEEDED',
      targets: [{ ref: 'src/renderer/App.tsx', status: 'SUCCEEDED' }],
      fileSizeBytes: 24000, durationMillis: 200
    })} nowMs={now} defaultOpen />);

    expect(screen.getByText('App.tsx')).toBeTruthy();
    // The relative directory is no longer rendered as row text.
    expect(screen.queryByText('src/renderer')).toBeNull();
    expect(screen.queryByText('文件大小 24 KB')).toBeNull();
    expect(screen.getByText('文件大小：24000 bytes（24 KB）')).toBeTruthy();
    expect(screen.queryByText('本次读取：24000 bytes（24 KB）')).toBeNull();
  });

  it('hides unavailable read quantity and duration while keeping a running read in progress', () => {
    const { rerender } = render(<CliActivityRow activity={item({
      kind: 'FILE_READ', status: 'SUCCEEDED', fileRef: 'README.md', durationMillis: null, startedAt: null
    })} nowMs={now} defaultOpen />);
    expect(screen.queryByText('读取量未知')).toBeNull();
    expect(screen.queryByText('耗时未知')).toBeNull();
    expect(screen.queryByText(/^开始：/)).toBeNull();
    expect(screen.queryByText(/^结束：/)).toBeNull();

    rerender(<CliActivityRow activity={item({
      kind: 'FILE_READ', status: 'RUNNING', fileRef: 'README.md'
    })} nowMs={now} defaultOpen />);
    expect(screen.getAllByText('读取中').length).toBeGreaterThan(0);
    // §5.4: running rows keep the ticking elapsed; the start clock renders
    // inside the expanded timing line `开始 HH:MM:SS · 耗时 mm:ss`.
    expect(screen.getByText('已运行 00:10')).toBeTruthy();
    expect(screen.getByText(/开始 \d{2}:\d{2}:\d{2}/)).toBeTruthy();
  });
});
