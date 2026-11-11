/**
 * Projects & Sessions page (settings design §6.6).
 *
 * Projects come from the authoritative list; the current session block is a
 * projection of the frozen Session contract. Directory editing lives in the
 * composer directory panel; this page only shows the server-owned policy.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EmptyState, SettingRow, SettingSection, SkeletonRows, UnavailableState } from '../components';
import { availabilityLabel } from '../settingsPresentation';
import { unwrap, useExecutionPolicyDefaults, useProjects } from '../../queries';
import { PermissionModeSelector, type PermissionMode } from '../../conversation/PermissionModeSelector';
import type { SettingsPageContext } from '../settingsContext';

function modeRank(mode: string): number {
  return mode === 'STANDARD' ? 0 : mode === 'AUTO_APPROVE' ? 1 : mode === 'FULL_ACCESS' ? 2 : -1;
}

export function ProjectsSessionsPage(props: { context: SettingsPageContext }): React.JSX.Element {
  const queryClient = useQueryClient();
  const projects = useProjects();
  const session = props.context.session;
  const sessionProjectId = (props.context.projects.length ? props.context.projects : (projects.data ?? []))
    .find((project) => project.workspaceAlias === session?.workspaceAlias)?.projectId ?? null;
  // Project-scope defaults moved here from the composer approval panel
  // (ui-polish-plan-2026-10 §6.1); the block keeps its project-defaults-row
  // testid so governance checks still find it.
  const projectDefaults = useExecutionPolicyDefaults(sessionProjectId);
  const updateProjectDefaultsM = useMutation({
    mutationFn: async (input: { mode: PermissionMode; projectId: string; expectedRevision: number }) => {
      if (typeof window.codeAgentDesktop.updateExecutionPolicyDefaults !== 'function') {
        throw new Error('EXECUTION_POLICY_UNAVAILABLE');
      }
      return unwrap(await window.codeAgentDesktop.updateExecutionPolicyDefaults(input.projectId, {
        expectedRevision: input.expectedRevision,
        requestedMode: input.mode,
        permissionSemanticsVersion: input.mode === 'FULL_ACCESS' ? 2 : undefined,
        fullAccessConfirmation: input.mode === 'FULL_ACCESS'
      }));
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ['execution-policy-defaults', input.projectId] });
      void queryClient.invalidateQueries({ queryKey: ['execution-policy'] });
    }
  });

  return (
    <>
      <SettingSection
        title="已注册项目"
        description="项目由 Service 管理；这里只显示别名与权威状态，不显示绝对路径。"
        testId="projects-section"
      >
        {projects.isPending ? <SkeletonRows rows={2} /> : null}
        {projects.isError ? <SectionErrorInline message={`项目列表不可用：${String(projects.error)}`} /> : null}
        {projects.data && projects.data.length === 0 ? <EmptyState message="尚未注册项目。点击左侧会话栏的“当前项目”添加。" /> : null}
        <ul className="settings-project-list" data-testid="projects-list">
          {(projects.data ?? []).map((project) => (
            <li key={project.projectId} data-testid={`projects-item-${project.workspaceAlias}`}>
              <strong>{project.displayName ?? project.workspaceAlias}</strong>
              {project.displayName && project.displayName !== project.workspaceAlias ? (
                <span className="run-meta">alias: {project.workspaceAlias}</span>
              ) : null}
              <span className={`settings-badge authority-${project.authorityStatus ?? 'UNKNOWN'}`}>
                {project.authorityStatus === 'AVAILABLE' ? '可用'
                  : project.authorityStatus === 'NEEDS_ATTENTION' ? '需要注意'
                    : availabilityLabel(project.authorityStatus ?? 'UNKNOWN')}
              </span>
            </li>
          ))}
        </ul>
      </SettingSection>

      <SettingSection
        title="当前会话"
        description="会话设置在创建时冻结；此处显示权威值。项目默认值不等于会话已冻结值。"
        testId="session-section"
      >
        {session ? (
          <>
            <SettingRow
              label="会话模型"
              scope="SESSION"
              mutability="READ_ONLY"
              source="目录"
              effective={session.modelAlias ?? '使用默认'}
              applyMode="NEW_SESSION"
              testId="session-model"
              advanced={<span className="run-meta">sessionVersion {session.sessionVersion}</span>}
            >
              <span className="run-meta">在“Agent 与模型”页修改</span>
            </SettingRow>
            <SettingRow
              label="目录策略"
              scope="SESSION"
              mutability="READ_ONLY"
              source="目录"
              effective={session.permissionMode === 'FULL_ACCESS'
                ? '完全访问'
                : `${(session.directories ?? session.contextDirectories ?? []).length} 个目录 · ${session.directoryAccess?.savedWriteMode === 'ROOTS' ? '指定目录可写' : '只读'}`}
              testId="session-directories"
            />
            {props.context.sessionActiveRun ? (
              <p className="settings-hint" data-testid="session-active-run-hint">
                该会话有活动中的 Run（{props.context.sessionActiveRun.runId.slice(0, 8)} · {props.context.sessionActiveRun.state}）；会破坏 Run 可重现性的修改会被拒绝或延迟。
              </p>
            ) : null}
          </>
        ) : (
          <EmptyState message="未选择会话。模型与目录策略属于具体会话；先在左侧选择一个会话。" />
        )}
      </SettingSection>

      <SettingSection
        title="项目默认权限"
        description="仅影响此后在该项目创建的新会话；进行中会话在输入区权限菜单里改。"
        testId="project-defaults-section"
      >
        <div data-testid="project-defaults-row">
          {!sessionProjectId ? (
            <EmptyState message="未关联项目。先选择一个绑定项目的会话。" />
          ) : projectDefaults.isPending || projectDefaults.isError ? (
            <span className="run-meta" role="status">{projectDefaults.isPending ? '正在读取项目默认…' : '项目默认暂不可用'}</span>
          ) : (
            <>
              <PermissionModeSelector
                label="项目默认权限"
                capabilities={props.context.capabilities}
                value={projectDefaults.data?.mode}
                supportedModes={projectDefaults.data?.supportedModes}
                lockedModes={(projectDefaults.data?.supportedModes ?? []).filter((mode) =>
                  modeRank(mode) > modeRank(projectDefaults.data?.managedModeCeiling ?? 'STANDARD'))}
                pending={updateProjectDefaultsM.isPending}
                onChange={(mode) => {
                  if (!projectDefaults.data || !sessionProjectId) return;
                  updateProjectDefaultsM.mutate({
                    mode,
                    projectId: sessionProjectId,
                    expectedRevision: projectDefaults.data.revision
                  });
                }}
              />
              <span className="approval-setting-hint">仅影响此后创建的新会话</span>
            </>
          )}
        </div>
      </SettingSection>
    </>
  );
}

function SectionErrorInline(props: { message: string }): React.JSX.Element {
  return <UnavailableState title="项目列表不可用" message={props.message} />;
}
