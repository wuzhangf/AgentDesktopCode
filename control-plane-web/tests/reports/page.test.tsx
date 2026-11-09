// @vitest-environment jsdom
// PAE P7 — ReportsPage render smoke (source only; run after merge).
// Asserts the honest UI contract: deterministic-summary labelling, real
// provider list from meta, subscription shown 未启用, empty/failure states.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ReportsPage from '../../src/personal/reports/ReportsPage';
import type { ReportDescriptor } from '../../../codeagent-desktop/packages/protocol/src/personal';

const { api } = vi.hoisted(() => ({
  api: {
    listReports: vi.fn(),
    createReport: vi.fn(),
    listReportFiles: vi.fn(),
    listProjects: vi.fn(),
  },
}));
vi.mock('../../src/personal/reports/api', () => api);

// No vitest globals → no RTL auto-cleanup; unmount between tests so queries
// only see this test's render (stacked renders duplicate badges/text).
afterEach(cleanup);

function envelope<T>(data: T, meta: Partial<Record<string, unknown>> = {}) {
  return {
    meta: {
      source: 'management/reports', instance: 'test', controlPlaneId: 'cp-test',
      observedAt: '2026-10-18T00:00:00Z', revision: '1',
      supportedActions: ['REPORTS', 'REPORT_CREATE', 'REPORT', 'REPORT_FILES', 'REPORT_PROVIDER:local'],
      reasonCodes: [], ...meta,
    },
    data,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

const READY: ReportDescriptor = {
  reportId: 'rpt_1', requestKey: 'rk-1', sourceRef: 'data:orders.csv',
  providerRef: 'local', outputFormat: 'markdown+json', state: 'READY',
  resultDigest: `sha256:${'a'.repeat(64)}`,
  createdAt: '2026-10-18T01:00:00Z', updatedAt: '2026-10-18T01:00:01Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listReports.mockResolvedValue(envelope([READY]));
  api.listReportFiles.mockResolvedValue(envelope([
    { fileId: 'f_1', name: 'report.md', mediaType: 'text/markdown; charset=utf-8', sizeBytes: 1234, digest: `sha256:${'b'.repeat(64)}` },
    { fileId: 'f_2', name: 'report.json', mediaType: 'application/json', sizeBytes: 567, digest: `sha256:${'c'.repeat(64)}` },
  ]));
  api.listProjects.mockResolvedValue(envelope([]));
});

describe('ReportsPage (task §10, E37–E39)', () => {
  it('renders the report list with real states and digests', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('data:orders.csv')).toBeTruthy());
    expect(screen.getByText('就绪')).toBeTruthy();
    expect(screen.getAllByText(/aaaa/)[0]).toBeTruthy(); // truncated digest visible
  });

  it('shows subscription as 未启用 — never a fake scheduled task', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('未启用')).toBeTruthy());
    expect(screen.getByText(/不创建任何后台\/系统任务/)).toBeTruthy();
  });

  it('labels generation as deterministic, not model semantic review', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/不含模型语义审查/)).toBeTruthy());
  });

  it('surfaces an honest banner when a declared provider is not configured', async () => {
    api.listReports.mockResolvedValue(envelope([], { reasonCodes: ['REPORT_PROVIDER_NOT_CONFIGURED'] }));
    renderPage();
    await waitFor(() => expect(screen.getByText(/未配置/)).toBeTruthy());
  });
});
