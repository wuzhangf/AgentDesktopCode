// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DangerApprovalPanel } from '../../src/renderer/app/conversation/DangerApprovalPanel';
import { GovernanceApprovalCard } from '../../src/renderer/app/conversation/GovernanceApprovalCard';
import { PermissionModeSelector } from '../../src/renderer/app/conversation/PermissionModeSelector';
import { normalizeApprovalForRenderer, type ApprovalRequestLike } from '../../src/renderer/app/queries';
import { UnifiedApprovalCard } from '../../src/renderer/app/conversation/UnifiedApprovalCard';
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

const dangerApproval = {
  approvalId: 'approval-danger-1', sessionId: 'session-1', runId: 'run-1', agentId: 'agent-1',
  kind: 'WRITE', domainRef: 'workspace/customer-data.json', domainVersion: 2, requestVersion: 1,
  decisionStatus: 'PENDING', executionStatus: 'NOT_STARTED', requestFingerprint: 'request-fp-1',
  policyFingerprint: 'policy-fp-1', grantRevision: 3,
  riskCategory: 'D1_IRRECOVERABLE_USER_DATA_LOSS',
  riskEvidence: ['未提交内容可能被覆盖'], publicSummary: '覆盖当前工作区数据文件',
  autoApproveAt: null, expiresAt: '2026-09-04T12:10:00Z', serverTime: '2026-09-04T12:00:00Z',
  allowedActions: ['APPROVE', 'DENY', 'CANCEL', 'ADVANCE'], version: 4
} as unknown as ApprovalRequestLike;

describe('permission mode selector', () => {
  it('grants FULL_ACCESS on selection without a second confirmation', () => {
    const onChange = vi.fn();
    render(<PermissionModeSelector capabilities={capabilities} value="STANDARD" onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox', { name: '权限模式' }), { target: { value: 'FULL_ACCESS' } });
    expect(screen.queryByRole('dialog', { name: '确认完全访问权限' })).toBeNull();
    expect(onChange).toHaveBeenCalledWith('FULL_ACCESS');
  });

  it('fails closed when the service does not advertise the mutation', () => {
    render(<PermissionModeSelector value="STANDARD" />);
    expect((screen.getByRole('combobox', { name: '权限模式' }) as HTMLSelectElement).disabled).toBe(true);
  });
});

describe('danger approval panel', () => {
  it('shows target/effect/recovery and decides one approval id only', () => {
    const onDecide = vi.fn();
    const onAdvance = vi.fn();
    const onControl = vi.fn();
    render(<DangerApprovalPanel approval={dangerApproval} onDecide={onDecide} onAdvance={onAdvance} onControl={onControl} />);
    expect(screen.getByTestId('danger-approval-panel').getAttribute('data-approval-id')).toBe('approval-danger-1');
    expect(screen.getByText('workspace/customer-data.json')).toBeDefined();
    expect(screen.getByText('未提交内容可能被覆盖')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '批准本次' }));
    expect(onDecide).toHaveBeenCalledWith(dangerApproval, 'APPROVE');
    expect(onDecide.mock.calls[0]?.[0].approvalId).toBe('approval-danger-1');
    fireEvent.click(screen.getByRole('button', { name: '取消请求' }));
    expect(onControl).toHaveBeenCalledWith(dangerApproval, 'CANCEL');
  });

  it('fails closed for an UNKNOWN execution result', () => {
    const onDecide = vi.fn();
    const unknownApproval = { ...dangerApproval, executionStatus: 'UNKNOWN' } as ApprovalRequestLike;
    render(<DangerApprovalPanel approval={unknownApproval} onDecide={onDecide} onAdvance={vi.fn()} onControl={vi.fn()} />);
    expect(screen.getByRole('status', { name: /执行结果未知/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: '批准本次' })).toBeNull();
    expect(screen.queryByRole('button', { name: '立即执行' })).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe('unified process approval compatibility', () => {
  it('renders a process UNKNOWN kind as a real actionable command card', () => {
    const onDecide = vi.fn();
    const approval = {
      approvalId: 'approval-process-1', sessionId: 'session-1', runId: 'run-1', agentId: 'process.notepad',
      kind: 'UNKNOWN', domainRef: 'process.notepad', domainVersion: 1, requestVersion: 1,
      decisionStatus: 'PENDING', executionStatus: 'NOT_STARTED', requestFingerprint: 'request-fp-1',
      policyFingerprint: 'policy-fp-1', grantRevision: 1, riskCategory: 'NONE', riskEvidence: [],
      publicSummary: '执行 notepad', autoApproveAt: null, expiresAt: '2026-09-04T12:10:00Z',
      serverTime: '2026-09-04T12:00:00Z', allowedActions: ['APPROVE', 'DENY'], version: 1
    } as unknown as ApprovalRequestLike;

    render(
      <UnifiedApprovalCard
        approval={normalizeApprovalForRenderer(approval)}
        onDecide={onDecide}
        onAdvance={vi.fn()}
        onControl={vi.fn()}
      />
    );

    const card = screen.getByTestId('unified-approval-card');
    expect(card.getAttribute('data-approval-kind')).toBe('COMMAND');
    expect(card.textContent).toContain('命令审批');
    expect(card.textContent).toContain('process.notepad');
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ approvalId: 'approval-process-1', kind: 'COMMAND' }), 'APPROVE');
  });

  it('keeps unrelated UNKNOWN approvals unknown and does not invent actions', () => {
    const approval = {
      approvalId: 'approval-unknown-1', sessionId: 'session-1', runId: 'run-1', agentId: 'other.capability',
      kind: 'UNKNOWN', domainRef: 'other.capability', domainVersion: 1, requestVersion: 1,
      decisionStatus: 'PENDING', executionStatus: 'NOT_STARTED', requestFingerprint: 'request-fp-2',
      policyFingerprint: 'policy-fp-2', grantRevision: 1, riskCategory: 'NONE', riskEvidence: [],
      publicSummary: '未知审批', autoApproveAt: null, expiresAt: '2026-09-04T12:10:00Z',
      serverTime: '2026-09-04T12:00:00Z', allowedActions: [], version: 1
    } as unknown as ApprovalRequestLike;

    render(
      <UnifiedApprovalCard
        approval={normalizeApprovalForRenderer(approval)}
        onDecide={vi.fn()}
        onAdvance={vi.fn()}
        onControl={vi.fn()}
      />
    );

    expect(screen.getByTestId('unified-approval-card').getAttribute('data-approval-kind')).toBe('UNKNOWN');
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
    expect(screen.queryByRole('button', { name: '拒绝' })).toBeNull();
  });
});

describe('revisioned governance approval card', () => {
  it('fails closed when the revision snapshot is stale or incomplete', () => {
    const onDecide = vi.fn();
    render(
      <GovernanceApprovalCard
        kind="MISSION_REPLAN"
        approvalId="plan"
        revision={4}
        fingerprint={null}
        available
        onDecide={onDecide}
      />
    );
    expect(screen.getByTestId('governance-approval-card').getAttribute('data-approval-id')).toBe('plan');
    expect(screen.getByRole('status').textContent).toContain('快照不完整');
    expect(screen.queryByTestId('governance-approval-approve')).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('does not expose a fake decision when the capability is unavailable', () => {
    render(
      <GovernanceApprovalCard
        kind="SPEC"
        approvalId="spec-approval-1"
        revision={1}
        fingerprint="fp-1"
        available={false}
        unavailableReason="FEATURE_DISABLED"
        onDecide={vi.fn()}
      />
    );
    expect(screen.getByRole('status').textContent).toContain('未声明审批能力');
    expect(screen.queryByTestId('governance-approval-reject')).toBeNull();
  });
});
