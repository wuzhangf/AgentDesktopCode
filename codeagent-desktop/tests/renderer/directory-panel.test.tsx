// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryPanel } from '../../src/renderer/app/DirectoryPanel';
import type { SessionLike } from '../../src/renderer/app/queries';

const session: SessionLike = {
  sessionId: 'session-1',
  sessionVersion: 4,
  workspaceAlias: 'petclinic',
  permissionMode: 'WORKSPACE',
  directoryPolicyVersion: 2,
  directories: [
    { id: 'default-workspace', path: 'D:\\project\\workspace\\petclinic', writeEnabled: true },
    { id: 'a', path: 'D:\\project\\workspace\\spring-petclinic-microservices', writeEnabled: true },
    { id: 'b', path: 'D:\\project\\workspace\\TestSemantic', writeEnabled: false }
  ],
  directoryAccess: {
    savedSessionVersion: 4,
    savedWriteMode: 'ROOTS',
    entries: [
      { id: 'default-workspace', writable: true, immutable: true, reason: 'DEFAULT_WORKSPACE' },
      { id: 'a', writable: true, reason: 'DIRECT' },
      { id: 'b', writable: false, reason: 'NOT_GRANTED' }
    ]
  }
};

function renderPanel(value: SessionLike = session): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DirectoryPanel session={value} onClose={vi.fn()} />
    </QueryClientProvider>
  );
}

describe('DirectoryPanel contract projection', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'codeAgentDesktop', {
      configurable: true,
      value: {
        getProjectSessionPreflight: vi.fn(async () => ({ suggestedWriteScope: ['src'] })),
        patchSession: vi.fn()
      }
    });
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows editable and read-only directory rows without the legacy contract card', async () => {
    renderPanel();
    expect(await screen.findByTestId('directory-panel')).toBeDefined();
    expect(screen.queryByTestId('directory-contract')).toBeNull();
    expect(screen.getByText('D:\\project\\workspace\\spring-petclinic-microservices')).toBeDefined();
    expect(screen.getByText('D:\\project\\workspace\\TestSemantic')).toBeDefined();
    expect(screen.getAllByText('可写').length).toBeGreaterThan(0);
    expect(screen.getByText('只读')).toBeDefined();
  });

  it('saves the complete v2 directory list and keeps the optimistic version', async () => {
    const patchSession = vi.fn(async () => session);
    Object.defineProperty(window, 'codeAgentDesktop', {
      configurable: true,
      value: { patchSession }
    });
    renderPanel();
    const checkbox = screen.getAllByRole('checkbox')[2]!;
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(patchSession).toHaveBeenCalledWith('session-1', expect.objectContaining({
      expectedSessionVersion: 4,
      directoryPolicyVersion: 2,
      directories: expect.arrayContaining([
        expect.objectContaining({ id: 'b', writeEnabled: true })
      ])
    })));
  });

  it('keeps the default workspace row writable and immutable', async () => {
    renderPanel();
    const checkboxes = screen.getAllByRole('checkbox');
    expect((checkboxes[0] as HTMLInputElement).disabled).toBe(true);
    expect((screen.getAllByRole('button', { name: '修改' })[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole('button', { name: '移除' })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not show the legacy repair action', async () => {
    renderPanel({ ...session, directoryPolicyVersion: 1, directories: undefined, writeAllow: ['src'] });
    expect(await screen.findByTestId('directory-panel')).toBeDefined();
    expect(screen.queryByRole('button', { name: '恢复项目写入范围' })).toBeNull();
  });
});
