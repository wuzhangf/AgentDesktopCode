// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FailureDescriptor } from '../../packages/protocol/src/failureContract';
import { RunFailureCard } from '../../src/renderer/app/conversation/RunFailureCard';

afterEach(() => cleanup());

const failure: FailureDescriptor = {
  schemaVersion: '1',
  code: 'SERVICE_ADDED_CODE',
  domain: 'TOOL_EXECUTION',
  phase: 'EXECUTE',
  disposition: 'AUTO_RECOVERING',
  effectState: 'UNKNOWN',
  safeMessage: '命令执行结果尚未确认。',
  recovery: {
    mode: 'RETRY_OPERATION',
    actor: 'RUNTIME',
    automatic: true,
    sameInputAllowed: true,
    attemptsUsed: 1,
    maxAttempts: 2,
    actionIds: ['RETRY_OPERATION']
  },
  context: {
    toolName: 'process_exec',
    toolCallId: 'call-1',
    correlationId: 'corr-1',
    pathRef: 'src/OrderService.java'
  },
  causes: [{ code: 'PROCESS_RESULT_UNKNOWN', message: '未收到终态回执' }]
};

describe('RunFailureCard (M0 design §6.4/§6.5)', () => {
  it('shows the failure facts and keeps unknown effect language bounded', () => {
    render(<RunFailureCard run={{ runId: 'run-1', state: 'FAILED', failure, terminationCode: 'PROCESS_FAILED' }} />);

    const card = screen.getByTestId('run-failure-card');
    const text = card.textContent ?? '';
    expect(text).toContain('此步骤失败，原因尚未完整分类');
    expect(text).toContain('执行工具');
    expect(text).toContain('process_exec');
    expect(text).toContain('该操作可能已执行，请先查看结果');
    expect(text).toContain('运行已终止，恢复已停止');
    expect(text).not.toContain('没有任何修改');
    expect(screen.queryByRole('button', { name: /Retry|重试/ })).toBeNull();
  });

  it('copies only bounded diagnostic fields', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<RunFailureCard run={{ runId: 'run-1', state: 'FAILED', failure }} />);

    fireEvent.click(screen.getByRole('button', { name: '复制诊断' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('已复制'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain('code: SERVICE_ADDED_CODE');
    expect(writeText.mock.calls[0]?.[0]).toContain('correlationId: corr-1');
    expect(writeText.mock.calls[0]?.[0]).not.toContain('token');
  });
});
