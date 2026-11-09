// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliActivityRow } from '../../src/renderer/app/conversation/CliActivityRow';
import type { RunActivity } from '../../src/renderer/app/activity/activityTypes';

afterEach(() => cleanup());

function renderActivity(activity: RunActivity): void {
  render(<CliActivityRow activity={activity} nowMs={0} defaultOpen />);
}

describe('CliActivityRow file path messaging', () => {
  it('prints delegation child identity and status in the row', () => {
    renderActivity({
      activityId: 'child-1',
      runId: 'run-1',
      kind: 'DELEGATION',
      status: 'FAILED',
      detail: 'repo-explorer · sat-1-abcdef01',
      reasonCode: 'PLAN_SUBAGENT_MODEL_PROTOCOL'
    });

    expect(screen.getByText('repo-explorer · sat-1-abcdef01')).toBeTruthy();
    expect(screen.getByText('失败')).toBeTruthy();
  });

  it('does not show the missing-path warning for batch reads with targets', () => {
    renderActivity({
      activityId: 'batch-read-1',
      runId: 'run-1',
      kind: 'FILE_READ',
      status: 'PARTIAL',
      toolName: 'workspace_batch_read',
      resultSummary: 'succeeded 3 partial 1 failed 0',
      targets: [
        { ref: 'src/main/java/A.java', status: 'SUCCEEDED' },
        { ref: 'src/main/java/B.java', status: 'SUCCEEDED' }
      ]
    });

    const row = screen.getByRole('article');
    expect(screen.queryByText('未提供可信文件路径，无法定位文件')).toBeNull();
    expect(row.className).toContain('is-partial');
    expect(row.className).not.toContain('is-attention');
    // The first read promotes to the compact `· name` chip; the rest list as targets.
    expect(screen.getByText('A.java')).toBeTruthy();
    expect(screen.getByText('src/main/java/B.java')).toBeTruthy();
    expect(screen.getByText('输出摘要：成功 3 · 部分 1 · 失败 0')).toBeTruthy();
  });

  it('renders a compact 读取文件 · name row with the absolute path as the tooltip', () => {
    const openFile = vi.fn();
    const { container } = render(
      <CliActivityRow
        activity={{
          activityId: 'read-2',
          runId: 'run-1',
          kind: 'FILE_READ',
          status: 'SUCCEEDED',
          fileRef: 'src/main/java/com/acme/UserService.java',
          fileName: 'UserService.java',
          startLine: 10,
          endLine: 40
        }}
        nowMs={0}
        defaultOpen
        workspaceRoot={'D:\\project\\workspace\\petclinic'}
        onOpenFile={openFile}
      />
    );

    // The verb and the file name stay tightly coupled on one line.
    const toggle = screen.getByRole('button', { name: /读取文件 · UserService\.java/ });
    expect(toggle).toBeTruthy();
    expect(container.querySelector('.cli-file-sep')?.textContent).toBe('·');
    const link = screen.getByRole('button', { name: 'UserService.java' });
    expect(link.getAttribute('title'))
      .toBe('打开 D:\\project\\workspace\\petclinic\\src\\main\\java\\com\\acme\\UserService.java');
    // No trailing directory text and no redundant reference line in details.
    expect(screen.queryByText(/src[\\/]main[\\/]java/)).toBeNull();
    expect(screen.queryByText(/文件引用/)).toBeNull();
    expect(screen.queryByText(/动作：/)).toBeNull();
    fireEvent.click(link);
    // The reveal callback still receives the project-relative ref + line + run.
    expect(openFile).toHaveBeenCalledWith('src/main/java/com/acme/UserService.java', 10, 'run-1');
    expect(screen.getByText('第 10–40 行')).toBeTruthy();
  });

  it('keeps the warning when a file-read activity has no path information at all', () => {
    renderActivity({
      activityId: 'read-1',
      runId: 'run-1',
      kind: 'FILE_READ',
      status: 'SUCCEEDED',
      toolName: 'workspace_read'
    });

    expect(screen.getByText('未提供可信文件路径，无法定位文件')).toBeTruthy();
  });
});

describe('CliActivityRow generic file links (§6.3)', () => {
  it('opens a safe fileRef on non-file kinds through onOpenFile with the line number', () => {
    const openFile = vi.fn();
    render(
      <CliActivityRow
        activity={{
          activityId: 'edit-1',
          runId: 'run-1',
          kind: 'FILE_WRITE',
          status: 'SUCCEEDED',
          fileRef: 'src/app/Main.ts',
          startLine: 42
        }}
        nowMs={0}
        defaultOpen
        onOpenFile={openFile}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Main.ts' }));
    expect(openFile).toHaveBeenCalledWith('src/app/Main.ts', 42, 'run-1');
    expect(screen.getByText('第 42 行')).toBeTruthy();
  });

  it('links safe target refs for non-file kinds and drops unsafe refs from the DOM', () => {
    const openFile = vi.fn();
    render(
      <CliActivityRow
        activity={{
          activityId: 'tool-1',
          runId: 'run-1',
          kind: 'TOOL',
          status: 'SUCCEEDED',
          detail: 'batch update',
          targets: [
            { ref: 'src/a.ts', status: 'SUCCEEDED' },
            { ref: 'src/b.ts', status: 'SUCCEEDED' },
            { ref: 'C:\\Windows\\system.ini', status: 'FAILED' },
            { ref: '../outside.ts', status: 'FAILED' }
          ]
        }}
        nowMs={0}
        defaultOpen
        onOpenFile={openFile}
      />
    );

    // First safe target promotes to the primary file link…
    fireEvent.click(screen.getByRole('button', { name: 'a.ts' }));
    expect(openFile).toHaveBeenCalledWith('src/a.ts', null, 'run-1');
    // …the rest list as clickable detail targets.
    fireEvent.click(screen.getByRole('button', { name: 'src/b.ts' }));
    expect(openFile).toHaveBeenCalledWith('src/b.ts', null, 'run-1');
    // Unsafe refs never reach the DOM: no link, no title, no text.
    expect(screen.queryByText(/system\.ini/)).toBeNull();
    expect(screen.queryByText(/outside\.ts/)).toBeNull();
  });

  it('does not link an unsafe fileRef on any kind', () => {
    const openFile = vi.fn();
    render(
      <CliActivityRow
        activity={{
          activityId: 'tool-2',
          runId: 'run-1',
          kind: 'TOOL',
          status: 'SUCCEEDED',
          detail: 'wrote a file',
          fileRef: 'https://evil.example/x.ts'
        }}
        nowMs={0}
        defaultOpen
        onOpenFile={openFile}
      />
    );

    expect(screen.queryByRole('button', { name: /evil\.example/ })).toBeNull();
    expect(screen.queryByText(/evil\.example/)).toBeNull();
  });
});

describe('CliActivityRow lookup results', () => {
  it('lists every safe lookup target as a result and never promotes one to the file link', () => {
    const openFile = vi.fn();
    const { container } = render(
      <CliActivityRow
        activity={{
          activityId: 'glob-2',
          runId: 'run-1',
          kind: 'FILE_LOOKUP',
          status: 'SUCCEEDED',
          detail: 'src/**/*.ts',
          toolName: 'workspace_glob',
          resultSummary: 'entries 3',
          targets: [
            { ref: 'src/a.ts', status: 'SUCCEEDED' },
            { ref: 'src/b.ts', status: 'SUCCEEDED' },
            { ref: 'src/c.ts', status: 'SUCCEEDED' },
            { ref: 'C:\\Windows\\evil.ini', status: 'FAILED' }
          ]
        }}
        nowMs={0}
        defaultOpen
        onOpenFile={openFile}
      />
    );

    // No target is promoted to the compact file chip next to the verb.
    expect(container.querySelector('.cli-file-sep')).toBeNull();
    expect(screen.queryByRole('button', { name: 'a.ts' })).toBeNull();
    // All safe targets stay in the result list and remain openable.
    for (const ref of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
      fireEvent.click(screen.getByRole('button', { name: ref }));
      expect(openFile).toHaveBeenCalledWith(ref, null, 'run-1');
    }
    // Unsafe refs never reach the DOM.
    expect(screen.queryByText(/evil\.ini/)).toBeNull();
    // The glob pattern already sits on the header row — no duplicate 动作 line.
    expect(screen.queryByText(/^动作：/)).toBeNull();
    expect(screen.getByText('输出摘要：条目 3')).toBeTruthy();
  });

  it('renders glob entry items from the summary as openable links', () => {
    const openFile = vi.fn();
    render(
      <CliActivityRow
        activity={{
          activityId: 'glob-3',
          runId: 'run-1',
          kind: 'FILE_LOOKUP',
          status: 'SUCCEEDED',
          detail: '**/*.ts',
          toolName: 'workspace_glob',
          resultSummary: 'entries 4 items src/a.ts src/b.ts src/sub/ src/c.ts'
        }}
        nowMs={0}
        defaultOpen
        onOpenFile={openFile}
      />
    );

    expect(screen.getByText('输出摘要：条目 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'src/b.ts' }));
    expect(openFile).toHaveBeenCalledWith('src/b.ts', null, 'run-1');
    // Directory entries are display text, not openable file links.
    expect(screen.getByText('src/sub/')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'src/sub/' })).toBeNull();
  });
});

describe('CliActivityRow directory listing', () => {
  it('folds the listed directory and count into one label above the entries', () => {
    const { container } = render(
      <CliActivityRow
        activity={{
          activityId: 'list-1',
          runId: 'run-1',
          kind: 'FILE_LIST',
          status: 'SUCCEEDED',
          toolName: 'workspace.list',
          targets: [{ ref: 'internal/services', status: 'REQUESTED' }],
          resultSummary:
            'entries 3 items internal/services/catalogservice/ internal/services/catalogpriceservice/ internal/services/orderservice/'
        }}
        nowMs={0}
        defaultOpen
      />
    );

    // The listed directory rides the header — no duplicate 目录 detail line.
    const target = container.querySelector('.cli-activity-target');
    expect(target?.textContent).toBe('workspace.list · 目录 internal/services');
    expect(screen.queryByText(/^目录：/)).toBeNull();
    // The count folds into the list label — no separate 输出摘要/条目 lines.
    expect(screen.queryByText(/^输出摘要：/)).toBeNull();
    expect(screen.getByText('目录 3 个：')).toBeTruthy();
    for (const ref of [
      'internal/services/catalogservice/',
      'internal/services/catalogpriceservice/',
      'internal/services/orderservice/'
    ]) {
      expect(screen.getByText(ref)).toBeTruthy();
    }
  });

  it('keeps the folded label for an empty listing', () => {
    renderActivity({
      activityId: 'list-0',
      runId: 'run-1',
      kind: 'FILE_LIST',
      status: 'SUCCEEDED',
      toolName: 'workspace.list',
      targets: [{ ref: 'internal/services', status: 'REQUESTED' }],
      resultSummary: 'entries 0'
    });

    expect(screen.getByText('目录 0 个')).toBeTruthy();
    expect(screen.queryByText(/^输出摘要：/)).toBeNull();
    expect(screen.queryByText(/^目录：/)).toBeNull();
  });

  it('keeps the stats line when a listing carries non-count stats', () => {
    renderActivity({
      activityId: 'list-2',
      runId: 'run-1',
      kind: 'FILE_LIST',
      status: 'SUCCEEDED',
      toolName: 'workspace.list',
      targets: [{ ref: 'internal/services', status: 'REQUESTED' }],
      resultSummary:
        'entries 3 truncated true items internal/services/a/ internal/services/b/ internal/services/c/'
    });

    expect(screen.getByText(/^输出摘要：/)).toBeTruthy();
    expect(screen.getByText('目录：')).toBeTruthy();
    expect(screen.getByText('internal/services/b/')).toBeTruthy();
  });
});

describe('CliActivityRow search summary + scope', () => {
  it('formats search counts, links hit lines and shows the scope as a param', () => {
    const openFile = vi.fn();
    const { container } = render(
      <CliActivityRow
        activity={{
          activityId: 'search-1',
          runId: 'run-1',
          kind: 'CODE_SEARCH',
          status: 'SUCCEEDED',
          detail: '@RestController',
          toolName: 'workspace_search',
          targets: [{ ref: 'src', status: 'REQUESTED' }],
          resultSummary: 'matched files 6 matches 42 scanned 120 hits a/B.java:3 a/B.java:9 c/D.java:1 +39'
        }}
        nowMs={0}
        defaultOpen
        workspaceRoot={'D:\\ws\\demo'}
        onOpenFile={openFile}
      />
    );

    // Header: pattern + scope param on the same line, full text in tooltip.
    const target = container.querySelector('.cli-activity-target');
    expect(target?.textContent).toBe('@RestController · 范围 src');
    expect(target?.getAttribute('title')).toBe('@RestController · 范围 src');

    // The REQUESTED scope is a parameter line, never a '?'-glyphed row.
    expect(screen.getByText('范围：src')).toBeTruthy();
    expect(container.querySelector('.cli-target-status')?.textContent).not.toBe('?');

    // Stats line is translated/segmented; hits list carries file:line links.
    expect(screen.getByText('输出摘要：命中文件 6 · 匹配 42 · 扫描 120')).toBeTruthy();
    expect(screen.getByText('命中位置：')).toBeTruthy();
    const hit = screen.getByRole('button', { name: 'a/B.java:3' });
    expect(hit.getAttribute('title')).toBe('打开 D:\\ws\\demo\\a\\B.java:3');
    fireEvent.click(hit);
    expect(openFile).toHaveBeenCalledWith('a/B.java', 3, 'run-1');
    expect(screen.getByText('…还有 39 条')).toBeTruthy();
  });
});

describe('CliActivityRow command rows', () => {
  it('renders the action on the verb, the prompt directory and the output log', () => {
    const { container } = render(
      <CliActivityRow
        activity={{
          activityId: 'build-1',
          runId: 'run-1',
          kind: 'BUILD',
          status: 'SUCCEEDED',
          detail: 'COMPILE',
          commandPreview: 'python -m compileall -q .',
          workingDirectory: 'services/iam-service',
          fileRef: 'services/iam-service',
          resultSummary: 'compiled 12 files in 360 ms'
        }}
        nowMs={0}
        defaultOpen
        workspaceRoot={'D:\\github-project\\microservices-ecommerce'}
        onOpenFile={vi.fn()}
      />
    );

    // 构建 ▪ COMPILE rides on the verb; the bare command is the target.
    expect(container.querySelector('.cli-activity-verb')?.textContent).toBe('构建 ▪ COMPILE');
    // The prompt carries the workspace-resolved directory tail.
    expect(container.querySelector('.cli-command-preview')?.textContent)
      .toBe('services\\iam-service> python -m compileall -q .');
    // The bounded output digest renders as the execution log.
    expect(container.querySelector('.cli-command-output')?.textContent).toBe('compiled 12 files in 360 ms');
    // The redundant module-path chip next to the verb is gone.
    expect(container.querySelector('.cli-file-link')).toBeNull();
    expect(container.querySelector('.cli-file-name')).toBeNull();
    expect(container.querySelector('.cli-file-sep')).toBeNull();
    expect(container.querySelector('.cli-activity-line')?.className).not.toContain('has-file');
    // The action moved to the verb and the digest is the log — no duplicates.
    expect(screen.queryByText(/^动作：/)).toBeNull();
    expect(screen.queryByText(/^输出摘要：/)).toBeNull();
  });

  it('resolves a `.` working directory against the session workspace root', () => {
    const { container } = render(
      <CliActivityRow
        activity={{
          activityId: 'cmd-dot',
          runId: 'run-1',
          kind: 'COMMAND',
          status: 'SUCCEEDED',
          commandPreview: 'python -m compileall -q .',
          workingDirectory: '.',
          resultSummary: 'done'
        }}
        nowMs={0}
        defaultOpen
        workspaceRoot={'D:\\github-project\\microservices-ecommerce'}
      />
    );

    expect(container.querySelector('.cli-command-preview')?.textContent)
      .toBe('github-project\\microservices-ecommerce> python -m compileall -q .');
  });

  it('degrades an absolute working directory to a two-segment tail, never the host path', () => {
    const { container } = render(
      <CliActivityRow
        activity={{
          activityId: 'cmd-abs',
          runId: 'run-1',
          kind: 'COMMAND',
          status: 'SUCCEEDED',
          commandPreview: 'git status',
          workingDirectory: 'C:\\Users\\someone\\repo',
          resultSummary: 'clean'
        }}
        nowMs={0}
        defaultOpen
      />
    );

    expect(container.querySelector('.cli-command-preview')?.textContent).toBe('someone\\repo> git status');
    expect(container.querySelector('.cli-command-preview')?.textContent).not.toContain('C:');
  });

  it('renders the failure excerpt as an error log and keeps the error-code line', () => {
    const { container } = render(
      <CliActivityRow
        activity={{
          activityId: 'cmd-fail',
          runId: 'run-1',
          kind: 'COMMAND',
          status: 'FAILED',
          detail: 'TEST',
          commandPreview: 'python -m pytest',
          workingDirectory: '.',
          resultSummary: 'ms 672',
          reasonCode: 'PYTHON_DEPENDENCY_MISSING',
          failure: {
            schemaVersion: '1', code: 'PYTHON_DEPENDENCY_MISSING', domain: 'TOOL_EXECUTION',
            phase: 'EXECUTE', disposition: 'TERMINAL', effectState: 'UNKNOWN',
            safeMessage: "ModuleNotFoundError: No module named 'sqlalchemy'",
            recovery: { mode: 'NONE', actor: 'RUNTIME', automatic: false, sameInputAllowed: false, attemptsUsed: 1, maxAttempts: 1, actionIds: [] },
            causes: []
          }
        }}
        nowMs={0}
        defaultOpen
        workspaceRoot={'D:\\github-project\\microservices-ecommerce'}
      />
    );

    const output = container.querySelector('.cli-command-output');
    expect(output?.className).toContain('is-error');
    expect(output?.textContent).toContain('ms 672');
    expect(output?.textContent).toContain('ModuleNotFoundError');
    // The header verb shows the action; the outcome folds into ONE
    // ` · `-joined line — no separate 原因/错误码/摘要 copies of the excerpt.
    expect(container.querySelector('.cli-activity-verb')?.textContent).toBe('执行命令 ▪ TEST');
    expect(screen.getByText('执行结果：失败 · 错误码 PYTHON_DEPENDENCY_MISSING')).toBeTruthy();
    expect(screen.queryByText(/^原因：/)).toBeNull();
    expect(screen.queryByText(/^错误码/)).toBeNull();
    expect(screen.queryByText(/^输出摘要：/)).toBeNull();
  });

  it('keeps a pending line for a running command with no output yet', () => {
    const { container } = render(
      <CliActivityRow
        activity={{
          activityId: 'cmd-live',
          runId: 'run-1',
          kind: 'COMMAND',
          status: 'RUNNING',
          commandPreview: 'npm test'
        }}
        nowMs={0}
        defaultOpen
      />
    );

    expect(container.querySelector('.cli-command-preview')?.textContent).toBe('$ npm test');
    expect(container.querySelector('.cli-command-pending')?.textContent).toBe('等待命令返回输出…');
  });
});

describe('CliActivityRow execution evidence logs (WU-1)', () => {
  function renderWithQueryClient(activity: RunActivity, sessionId: string | null, readArtifact: ReturnType<typeof vi.fn>): void {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    Object.defineProperty(window, 'codeAgentDesktop', {
      configurable: true,
      writable: true,
      value: { readSessionExecutionArtifact: readArtifact }
    });
    render(
      <QueryClientProvider client={queryClient}>
        <CliActivityRow activity={activity} nowMs={0} defaultOpen sessionId={sessionId} />
      </QueryClientProvider>
    );
  }

  const evidenceActivity: RunActivity = {
    activityId: 'build-ev',
    runId: 'run-1',
    kind: 'BUILD',
    status: 'FAILED',
    detail: 'COMPILE',
    commandPreview: 'mvn -q compile',
    resultSummary: 'ms 1200',
    executionId: 'exec-7f2c',
    commandId: 'cmd-001',
    evidenceState: 'EXECUTED',
    evidenceArtifacts: ['artifacts/cmd-001.stdout.log', 'artifacts/cmd-001.stderr.log']
  };

  it('prints the captured stdout/stderr under the command so the row reads as the full interaction', async () => {
    const readArtifact = vi.fn().mockResolvedValue({
      executionId: 'exec-7f2c', path: 'artifacts/cmd-001.stdout.log',
      content: 'BUILD FAILED in 1.2s', offset: 0, totalBytes: 20, hasMore: false
    });
    renderWithQueryClient(evidenceActivity, 'sess-1', readArtifact);

    // Expanding the row is the user intent that loads the bounded slices:
    // the transcript body prints the real log, stats stay a summary line.
    await waitFor(() => expect(readArtifact).toHaveBeenCalledWith(
      'sess-1', 'exec-7f2c', 'artifacts/cmd-001.stdout.log',
      expect.objectContaining({ offset: 0, maxBytes: 65536 })));
    await waitFor(() => expect(readArtifact).toHaveBeenCalledWith(
      'sess-1', 'exec-7f2c', 'artifacts/cmd-001.stderr.log',
      expect.objectContaining({ offset: 0, maxBytes: 65536 })));
    expect((await screen.findAllByText('BUILD FAILED in 1.2s')).length).toBeGreaterThan(0);
    // Stats ride on the single 执行结果 outcome line — no separate 摘要 copy.
    expect(screen.getByText(/^执行结果：/).textContent).toContain('1200 毫秒');
    // The chips stay as the entry point for stdin/result/other records.
    expect(screen.getByText('执行日志：')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'stdout' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'stderr' })).toBeTruthy();
  });

  it('keeps chip selection working for artifacts outside the auto-printed streams', async () => {
    const readArtifact = vi.fn().mockResolvedValue({
      executionId: 'exec-7f2c', path: 'artifacts/cmd-001.stdout.log',
      content: 'BUILD FAILED in 1.2s', offset: 0, totalBytes: 20, hasMore: false
    });
    renderWithQueryClient(evidenceActivity, 'sess-1', readArtifact);
    await waitFor(() => expect(readArtifact).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'stdout' }));
    await waitFor(() => expect(readArtifact).toHaveBeenCalledWith(
      'sess-1', 'exec-7f2c', 'artifacts/cmd-001.stdout.log',
      expect.objectContaining({ offset: 0, maxBytes: 65536 })));
  });

  it('marks truncated slices and offers a bounded load-more', async () => {
    const readArtifact = vi.fn().mockResolvedValue({
      executionId: 'exec-7f2c', path: 'artifacts/cmd-001.stdout.log',
      content: 'first 100 bytes…', offset: 0, totalBytes: 4096, hasMore: true
    });
    renderWithQueryClient(evidenceActivity, 'sess-1', readArtifact);

    await screen.findAllByText(/已显示 .* \/ 4096 bytes/);
    const loadMore = screen.getAllByRole('button', { name: '加载更多' })[0];
    if (!loadMore) throw new Error('expected a load-more button');
    fireEvent.click(loadMore);
    await waitFor(() => expect(readArtifact).toHaveBeenCalledWith(
      'sess-1', 'exec-7f2c', 'artifacts/cmd-001.stdout.log',
      expect.objectContaining({ maxBytes: 65536 * 4 })));
  });

  it('explains when the session cannot scope the artifact read', async () => {
    const readArtifact = vi.fn();
    renderWithQueryClient(evidenceActivity, null, readArtifact);

    fireEvent.click(screen.getByRole('button', { name: 'stderr' }));
    expect(await screen.findByText(/缺少会话标识/)).toBeTruthy();
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it('renders an unavailable/expired state instead of crashing', async () => {
    const readArtifact = vi.fn().mockResolvedValue({
      error: 'artifact expired', code: 'ARTIFACT_EXPIRED'
    });
    renderWithQueryClient(evidenceActivity, 'sess-1', readArtifact);

    // Auto-load and chip-selected views both degrade to the same warning.
    expect((await screen.findAllByText(/日志已过期/)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'stdout' }));
    await waitFor(() => expect(readArtifact).toHaveBeenCalled());
  });

  it('leaves ordinary activities untouched when no evidence exists', () => {
    renderActivity({
      activityId: 'read-plain',
      runId: 'run-1',
      kind: 'FILE_READ',
      status: 'SUCCEEDED',
      toolName: 'workspace_read',
      fileRef: 'src/A.java',
      resultSummary: 'read 40 lines'
    });
    expect(screen.queryByText('执行日志：')).toBeNull();
  });
});

describe('CliActivityRow kind glyph layout', () => {
  it('keeps the target on the header row when a kind glyph is present', () => {
    // The toggle is a 3-column grid: glyph + verb + target. A fourth grid
    // child (the standalone kind icon) used to wrap onto an implicit row
    // under the 16px glyph column and clip the target to "w…".
    const { container } = render(
      <CliActivityRow
        activity={{
          activityId: 'glob-1',
          runId: 'run-1',
          kind: 'FILE_LOOKUP',
          status: 'SUCCEEDED',
          detail: '**/*calc*',
          resultSummary: 'entries 0',
          toolName: 'workspace_glob'
        }}
        nowMs={0}
        defaultOpen
        kindGlyph="≡"
      />
    );

    const toggle = container.querySelector('.cli-activity-toggle');
    expect(toggle?.children.length).toBe(3);
    const kindIcon = container.querySelector('.cli-activity-verb .cli-activity-kind');
    expect(kindIcon?.textContent).toBe('≡');
    const target = container.querySelector('.cli-activity-target');
    expect(target?.textContent).toBe('**/*calc*');
    expect(toggle?.children[2]).toBe(target);
  });
});

describe('CliActivityRow execution record commands', () => {
  const recordActivity: RunActivity = {
    activityId: 'build-rec',
    runId: 'run-1',
    kind: 'BUILD',
    status: 'FAILED',
    detail: 'COMPILE',
    commandPreview: 'dotnet.exe build HybridApp.csproj',
    resultSummary: 'ms 1200',
    reasonCode: 'BUILD_FAILED',
    executionId: 'exec-9a',
    commandId: 'cmd-001',
    evidenceArtifacts: ['artifacts/cmd-001.stderr.log']
  };

  function renderWithRecord(getExecution: ReturnType<typeof vi.fn>): void {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    Object.defineProperty(window, 'codeAgentDesktop', {
      configurable: true,
      writable: true,
      value: {
        getSessionExecution: getExecution,
        readSessionExecutionArtifact: vi.fn().mockResolvedValue({
          executionId: 'exec-9a', path: 'artifacts/cmd-001.stderr.log',
          content: 'err text', offset: 0, totalBytes: 8, hasMore: false
        })
      }
    });
    render(
      <QueryClientProvider client={queryClient}>
        <CliActivityRow activity={recordActivity} nowMs={0} defaultOpen sessionId="sess-1" />
      </QueryClientProvider>
    );
  }

  it('prints the journaled argv and outcome for each recorded command', async () => {
    const getExecution = vi.fn().mockResolvedValue({
      executionId: 'exec-9a', kind: 'BUILD', state: 'FAILED', createdAt: 0,
      commandRecords: [{
        commandId: 'cmd-001',
        argv: ['dotnet.exe', 'build', 'HybridApp.csproj'],
        workingDirectory: 'D:\\repo\\src\\WebApp',
        state: 'FAILED', exitCode: 1,
        startedAt: 1000, finishedAt: 2200
      }]
    });
    renderWithRecord(getExecution);

    await waitFor(() => expect(getExecution).toHaveBeenCalledWith('sess-1', 'exec-9a'));
    expect(await screen.findByText('执行命令：')).toBeTruthy();
    // Exact argv from the record sits beside the bounded preview copy.
    expect((await screen.findAllByText('dotnet.exe build HybridApp.csproj')).length)
      .toBeGreaterThan(0);
    // One ` · `-joined line carries state/exit/elapsed/cwd plus the folded
    // activity outcome — no separate 输出摘要/原因 lines.
    expect(screen.getByText(/cmd-001 · FAILED · 退出码 1 · 00:01 · src\\WebApp · 1200 毫秒 · 原因 BUILD_FAILED/)).toBeTruthy();
    expect(screen.queryByText(/^输出摘要：/)).toBeNull();
    expect(screen.queryByText(/^原因：/)).toBeNull();
  });

  it('reports a missing record instead of a silent gap', async () => {
    const getExecution = vi.fn().mockResolvedValue({ error: 'gone', code: 'EXECUTION_NOT_FOUND' });
    renderWithRecord(getExecution);
    expect(await screen.findByText(/执行记录已不存在/)).toBeTruthy();
  });

  it('shows plan provenance and planned argv when preflight prevented execution', async () => {
    const getExecution = vi.fn().mockResolvedValue({
      executionId: 'exec-9a', kind: 'BUILD', state: 'BLOCKED', createdAt: 0,
      transitions: [{ state: 'PLANNED', detail: JSON.stringify({
        planSource: 'USER_OVERRIDE', runner: 'uv', planFingerprint: '123456789abcdef',
        command: ['uv', 'run', 'pytest', 'tests/with space']
      }) }], commandRecords: []
    });
    renderWithRecord(getExecution);
    expect(await screen.findByText('构建方案：USER_OVERRIDE · uv · 123456789abc')).toBeTruthy();
    expect(screen.getByText('uv run pytest "tests/with space"')).toBeTruthy();
    expect(screen.getByText(/未执行命令/)).toBeTruthy();
  });
});

describe('CliActivityRow 变更内容 (run diff section)', () => {
  function renderWriteDiff(opts: {
    activity?: Partial<RunActivity>;
    getRunDiff?: ReturnType<typeof vi.fn>;
    runId?: string | null;
    runTerminal?: boolean | null;
    defaultOpen?: boolean;
  }): void {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    Object.defineProperty(window, 'codeAgentDesktop', {
      configurable: true,
      writable: true,
      value: { getRunDiff: opts.getRunDiff ?? vi.fn() }
    });
    render(
      <QueryClientProvider client={queryClient}>
        <CliActivityRow
          activity={{
            activityId: 'edit-1',
            runId: 'run-1',
            kind: 'FILE_WRITE',
            status: 'SUCCEEDED',
            toolName: 'workspace_edit',
            targets: [{ ref: 'src/app/Main.ts', status: 'SUCCEEDED' }],
            ...opts.activity
          }}
          nowMs={0}
          defaultOpen={opts.defaultOpen ?? true}
          runId={opts.runId === undefined ? 'run-1' : opts.runId}
          runTerminal={opts.runTerminal === undefined ? true : opts.runTerminal}
        />
      </QueryClientProvider>
    );
  }

  const diffPage = (files: unknown[], extra: Record<string, unknown> = {}) => ({
    runId: 'run-1', stateVersion: 7, hasMore: false, complete: true, files, ...extra
  });

  // Since U4 the +/-/space sign sits in its own grid column — assert on the
  // code cell text only.
  const codeLine = (text: string) => (content: string, el: Element | null) =>
    content === text && (el as HTMLElement | null)?.classList?.contains('diff-line-code') === true;

  it('renders the unified patch for the edited file once the run is terminal', async () => {
    const getRunDiff = vi.fn().mockResolvedValue(diffPage([{
      path: 'src/app/Main.ts', changeType: 'MODIFIED', binary: false, truncated: false,
      patch: [
        'diff --git a/src/app/Main.ts b/src/app/Main.ts',
        '--- a/src/app/Main.ts',
        '+++ b/src/app/Main.ts',
        '@@ -1,2 +1,3 @@',
        ' const keep = 1;',
        '-old line',
        '+new line',
        '+another line'
      ].join('\n')
    }]));
    renderWriteDiff({ getRunDiff });

    await waitFor(() => expect(screen.getByText(codeLine('new line'))).toBeTruthy());
    expect(screen.getByText(codeLine('old line'))).toBeTruthy();
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.getByText('-1')).toBeTruthy();
    expect(getRunDiff).toHaveBeenCalledWith('run-1', { page: 0, pageSize: 100 });
    expect(screen.getByText(/累计变更/)).toBeTruthy();
  });

  it('does not fetch while the run is still live and prints a pending note', () => {
    const getRunDiff = vi.fn();
    renderWriteDiff({ getRunDiff, runTerminal: false });

    expect(screen.getByText(/运行仍在进行/)).toBeTruthy();
    expect(getRunDiff).not.toHaveBeenCalled();
  });

  it('labels paths absent from the recorded diff instead of fabricating content', async () => {
    const getRunDiff = vi.fn().mockResolvedValue(diffPage([]));
    renderWriteDiff({ getRunDiff });

    const missing = await screen.findByTestId('write-diff-missing');
    expect(missing.textContent).toContain('src/app/Main.ts');
    expect(missing.textContent).toContain('未被归因收录');
  });

  it('matches a renamed file through previousFileRef', async () => {
    const getRunDiff = vi.fn().mockResolvedValue(diffPage([{
      path: 'src/app/Renamed.ts', previousFileRef: 'src/app/Main.ts',
      changeType: 'RENAMED', binary: false, truncated: false,
      patch: '@@ -1 +1 @@\n-old\n+new'
    }]));
    renderWriteDiff({ getRunDiff });

    await waitFor(() => expect(screen.getByText('src/app/Renamed.ts')).toBeTruthy());
    expect(screen.getByText(codeLine('new'))).toBeTruthy();
    expect(screen.queryByTestId('write-diff-missing')).toBeNull();
  });

  it('matches targets written with Windows separators', async () => {
    const getRunDiff = vi.fn().mockResolvedValue(diffPage([{
      path: 'src/app/Main.ts', changeType: 'MODIFIED',
      patch: '@@ -1 +1 @@\n-a\n+b'
    }]));
    renderWriteDiff({
      getRunDiff,
      activity: { targets: [{ ref: 'src\\app\\Main.ts', status: 'SUCCEEDED' }] }
    });

    await waitFor(() => expect(screen.getByText(codeLine('b'))).toBeTruthy());
  });

  it('rejects unsafe refs so they never reach the diff lookup', async () => {
    const getRunDiff = vi.fn().mockResolvedValue(diffPage([]));
    renderWriteDiff({
      getRunDiff,
      activity: {
        fileRef: 'D:/project/secret.ts',
        targets: [
          { ref: '../outside.ts', status: 'SUCCEEDED' },
          { ref: '/abs/path.ts', status: 'SUCCEEDED' },
          { ref: 'src/app/Main.ts', status: 'SUCCEEDED' }
        ]
      }
    });

    await waitFor(() => expect(getRunDiff).toHaveBeenCalled());
    // Only the safe relative path participates — and it is the missing one.
    const missing = await screen.findByTestId('write-diff-missing');
    expect(missing.textContent).toContain('src/app/Main.ts');
    expect(screen.queryByText(/outside\.ts/)).toBeNull();
    expect(screen.queryByText(/secret\.ts/)).toBeNull();
  });

  it('stops paging early once every requested path matched', async () => {
    const getRunDiff = vi.fn()
      .mockResolvedValueOnce(diffPage([{
        path: 'src/app/Main.ts', changeType: 'MODIFIED', patch: '+x'
      }], { hasMore: true }))
      .mockResolvedValueOnce(diffPage([], { hasMore: false }));
    renderWriteDiff({ getRunDiff });

    await waitFor(() => expect(screen.getByText(codeLine('x'))).toBeTruthy());
    expect(getRunDiff).toHaveBeenCalledTimes(1);
  });

  it('flags a partial scan when the page bound is reached with hasMore still true', async () => {
    const getRunDiff = vi.fn().mockResolvedValue(diffPage([], { hasMore: true }));
    renderWriteDiff({ getRunDiff });

    const missing = await screen.findByTestId('write-diff-missing');
    expect(missing.textContent).toContain('未完全扫描');
    expect(getRunDiff).toHaveBeenCalledTimes(10);
  });

  it('marks binary files without rendering patch lines', async () => {
    const getRunDiff = vi.fn().mockResolvedValue(diffPage([{
      path: 'src/app/Main.ts', changeType: 'MODIFIED', binary: true, patch: null
    }]));
    renderWriteDiff({ getRunDiff });

    await waitFor(() => expect(screen.getByText('二进制文件不显示 patch 内容。')).toBeTruthy());
    expect(screen.getByText('二进制')).toBeTruthy();
  });

  it('warns when the recorded patch was truncated', async () => {
    const getRunDiff = vi.fn().mockResolvedValue(diffPage([{
      path: 'src/app/Main.ts', changeType: 'MODIFIED', truncated: true,
      patch: '@@ -1 +1 @@\n-a\n+b'
    }]));
    renderWriteDiff({ getRunDiff });

    await waitFor(() => expect(screen.getByText('patch 截断')).toBeTruthy());
    expect(screen.getByText(codeLine('b'))).toBeTruthy();
  });

  it('warns when the diff snapshot is stale', async () => {
    const getRunDiff = vi.fn().mockResolvedValue(diffPage([{
      path: 'src/app/Main.ts', changeType: 'MODIFIED', patch: '+x'
    }], { stale: true }));
    renderWriteDiff({ getRunDiff });

    await waitFor(() => expect(screen.getByText(/变更快照已过期/)).toBeTruthy());
  });

  it('fails closed when the diff endpoint returns an error', async () => {
    const getRunDiff = vi.fn().mockResolvedValue({ error: 'boom', code: 'DIFF_FAILED' });
    renderWriteDiff({ getRunDiff });

    expect(await screen.findByTestId('write-diff-error')).toBeTruthy();
    expect(screen.getByText(/变更内容不可用（DIFF_FAILED）/)).toBeTruthy();
  });

  it('keeps the row expandable for a write activity with no other body', () => {
    const getRunDiff = vi.fn().mockResolvedValue(diffPage([]));
    renderWriteDiff({ getRunDiff, defaultOpen: false });

    const toggle = screen.getByRole('button', { name: /展开|修改文件/ });
    expect(toggle.hasAttribute('disabled')).toBe(false);
    fireEvent.click(toggle);
    expect(screen.getByTestId('write-diff')).toBeTruthy();
  });
});
