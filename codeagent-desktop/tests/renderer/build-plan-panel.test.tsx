// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BuildPlanPanel } from '../../src/renderer/app/BuildPlanPanel';

afterEach(cleanup);

function mount(): ReturnType<typeof vi.fn> {
  const save = vi.fn().mockResolvedValue({ profileId: 'default', revision: 8, enabled: true, config: {} });
  Object.defineProperty(window, 'codeAgentDesktop', { configurable: true, value: {
    getProjectBuildPlan: vi.fn().mockResolvedValue({ generatedAt: 0, buildMode: 'MODEL_ONLY', targets: [{
      targetId: 'python-api', tool: 'PYTHON', projectDirectory: 'apps/api', manifestPath: 'apps/api/pyproject.toml',
      actions: { TEST: { argv: ['uv', 'run', 'pytest', 'tests/with space'], runner: 'uv', planSource: 'USER_OVERRIDE',
        workspace: { targetDirectory: 'D:/repo/apps/api', workspaceRoot: 'D:/repo', inherited: true },
        readiness: [{ id: 'runner', passed: false, severity: 'FAIL', code: 'TOOLCHAIN_NOT_FOUND' }] } }, overrides: []
    }] }),
    getProjectVerificationProfiles: vi.fn().mockResolvedValue({ profiles: [{
      profileId: 'default', revision: 7, enabled: true, config: { buildMode: 'MODEL_ONLY', customKey: 'preserved' }
    }] }),
    putProjectVerificationProfile: save
  } });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <BuildPlanPanel projectId="project" onClose={() => undefined} />
  </QueryClientProvider>);
  return save;
}

it('shows effective mode, workspace provenance and argv boundaries', async () => {
  mount();
  expect(await screen.findByText(/模式 MODEL_ONLY/)).toBeTruthy();
  expect(screen.getByText('来源 USER_OVERRIDE')).toBeTruthy();
  expect(screen.getByText('cwd D:/repo/apps/api')).toBeTruthy();
  expect(screen.getByText('工作区 D:/repo')).toBeTruthy();
  expect(screen.getByText('uv run pytest "tests/with space"')).toBeTruthy();
});

it('persists project mode with revision and preserves unrelated profile keys', async () => {
  const save = mount();
  await screen.findByText(/rev 7/);
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
  fireEvent.change(screen.getByLabelText('构建模式'), { target: { value: 'FIXED' } });
  fireEvent.click(screen.getByRole('button', { name: '保存 profile' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith('project', 'default', expect.objectContaining({
    expectedRevision: 7, config: expect.objectContaining({ buildMode: 'FIXED', customKey: 'preserved' })
  })));
});

it('removes a project override when inheriting global mode', async () => {
  const save = mount();
  await screen.findByText(/rev 7/);
  fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
  fireEvent.change(screen.getByLabelText('构建模式'), { target: { value: 'INHERIT' } });
  fireEvent.click(screen.getByRole('button', { name: '保存 profile' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]![2].config).not.toHaveProperty('buildMode');
});
