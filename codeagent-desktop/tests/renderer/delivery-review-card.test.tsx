// @vitest-environment jsdom
/**
 * Review P0-02/P0-04 renderer closure: the delivery review card exposes
 * server-owned state, gates actions by delivery state, and never offers a
 * retry for UNKNOWN — only reconcile.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryReviewCard } from '../../src/renderer/app/conversation/DeliveryReviewCard';

let delivery: Record<string, unknown> = {};
let decideCalls: Array<{ body: Record<string, unknown> }> = [];
let applyCalls: Array<{ body: Record<string, unknown> }> = [];
let reconcileCalls: Array<{ body: Record<string, unknown> }> = [];
let rebaseCalls: Array<{ body: Record<string, unknown> }> = [];

function resetDelivery(state: string, stateVersion = 3): void {
  delivery = {
    deliveryId: 'delivery-1',
    projectId: 'sample',
    workspaceLaneId: 'lane-1',
    state,
    stateVersion,
    changeSetFingerprint: 'f'.repeat(64),
    baseRevision: 'abc1234',
    expectedTargetOid: 't'.repeat(64),
    targetPolicy: 'CHECKOUT_CAS',
    approvalFingerprint: state === 'APPROVED' ? 'a'.repeat(64) : null,
    conflictSummary: null,
    targetAfterOid: null
  };
  decideCalls = [];
  applyCalls = [];
  reconcileCalls = [];
  rebaseCalls = [];
}

function installFakeApi(): void {
  Object.defineProperty(window, 'codeAgentDesktop', {
    configurable: true,
    value: {
      getDelivery: vi.fn(async () => ({ ...delivery })),
      getDeliveryChanges: vi.fn(async () => ({
        deliveryId: 'delivery-1',
        changeSetFingerprint: String(delivery.changeSetFingerprint ?? ''),
        baseRevision: String(delivery.baseRevision ?? ''),
        targetLabel: 'sample',
        targetFingerprint: 't'.repeat(64),
        canApply: true,
        conflictPaths: [],
        files: []
      })),
      decideDelivery: vi.fn(async (_id: string, body: Record<string, unknown>) => {
        decideCalls.push({ body });
        delivery = {
          ...delivery,
          state: body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
          stateVersion: Number(delivery.stateVersion) + 1,
          approvalFingerprint: body.decision === 'APPROVE' ? 'a'.repeat(64) : null
        };
        return { delivery, receipt: { receiptId: 'r-1' } };
      }),
      applyDelivery: vi.fn(async (_id: string, body: Record<string, unknown>) => {
        applyCalls.push({ body });
        delivery = { ...delivery, state: 'QUEUED', stateVersion: Number(delivery.stateVersion) + 1 };
        return { delivery, receipt: { receiptId: 'r-2' } };
      }),
      reconcileDelivery: vi.fn(async (_id: string, body: Record<string, unknown>) => {
        reconcileCalls.push({ body });
        delivery = { ...delivery, state: 'RECONCILING', stateVersion: Number(delivery.stateVersion) + 1 };
        return { delivery, receipt: { receiptId: 'r-3' } };
      }),
      rebaseDelivery: vi.fn(async (_id: string, body: Record<string, unknown>) => {
        rebaseCalls.push({ body });
        delivery = { ...delivery, state: 'REBASING', stateVersion: Number(delivery.stateVersion) + 1 };
        return { delivery, receipt: { receiptId: 'r-4' } };
      })
    }
  });
}

function renderCard(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  render(
    <QueryClientProvider client={queryClient}>
      <DeliveryReviewCard deliveryId="delivery-1" />
    </QueryClientProvider>
  );
}

describe('delivery review card', () => {
  beforeEach(() => {
    resetDelivery('READY_FOR_REVIEW');
    installFakeApi();
  });
  afterEach(() => cleanup());

  it('approves a ready delivery with the server state version', async () => {
    renderCard();
    const approve = await screen.findByTestId('delivery-approve');
    fireEvent.click(approve);
    await waitFor(() => expect(decideCalls).toHaveLength(1));
    expect(decideCalls[0]!.body.decision).toBe('APPROVE');
    expect(decideCalls[0]!.body.expectedStateVersion).toBe(3);
    await waitFor(() => expect(screen.getByTestId('delivery-apply')).toBeTruthy());
  });

  it('offers apply only for approved deliveries', async () => {
    resetDelivery('APPROVED');
    renderCard();
    const apply = await screen.findByTestId('delivery-apply');
    fireEvent.click(apply);
    await waitFor(() => expect(applyCalls).toHaveLength(1));
    expect(applyCalls[0]!.body.approvalFingerprint).toBe('a'.repeat(64));
  });

  it('never retries UNKNOWN and only exposes reconcile', async () => {
    resetDelivery('UNKNOWN');
    renderCard();
    const reconcile = await screen.findByTestId('delivery-reconcile');
    expect(screen.queryByTestId('delivery-apply')).toBeNull();
    expect(screen.queryByTestId('delivery-approve')).toBeNull();
    fireEvent.click(reconcile);
    await waitFor(() => expect(reconcileCalls).toHaveLength(1));
    expect(reconcileCalls[0]!.body.expectedStateVersion).toBe(3);
  });

  it('shows the terminal applied state without further actions', async () => {
    resetDelivery('VERIFIED');
    renderCard();
    await screen.findByTestId('delivery-review');
    expect(screen.queryByTestId('delivery-approve')).toBeNull();
    expect(screen.queryByTestId('delivery-reconcile')).toBeNull();
  });

  it('offers rebase and conflict resolution for CONFLICT deliveries', async () => {
    resetDelivery('CONFLICT');
    renderCard();
    const rebase = await screen.findByTestId('delivery-rebase');
    expect(screen.getByTestId('delivery-resolve-conflicts')).toBeTruthy();
    expect(screen.getByTestId('delivery-reconcile')).toBeTruthy();
    fireEvent.click(rebase);
    await waitFor(() => expect(rebaseCalls).toHaveLength(1));
    expect(rebaseCalls[0]!.body.expectedStateVersion).toBe(3);
  });
});
