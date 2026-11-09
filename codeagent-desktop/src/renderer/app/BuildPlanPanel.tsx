import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BuildPlanActionView,
  BuildPlanOverrideRequest,
  BuildPlanOverrideResponse,
  BuildPlanOverrideView,
  BuildPlanPreviewResponse,
  BuildPlanReadiness,
  BuildPlanTargetView,
  ProjectBuildPlanResponse,
  VerificationProfileListResponse,
  VerificationProfileView
} from '../../../electron/shared/api-types';
import { unwrap } from './queries';
import { PanelShell } from './ui/PanelShell';
import { StatusBadge } from './ui/StatusBadge';

const ACTIONS = ['COMPILE', 'TEST', 'PACKAGE', 'VERIFY'] as const;

type Draft = {
  action: string;
  runner: string;
  argvText: string;
  envText: string;
  disabled: boolean;
};

function readinessTone(check: BuildPlanReadiness): 'pass' | 'warn' | 'fail' {
  if (check.passed === true) return 'pass';
  if (check.severity === 'WARN' || check.inconclusive === true) return 'warn';
  return 'fail';
}

function draftFromOverride(override: BuildPlanOverrideView | undefined, action: string): Draft {
  return {
    action,
    runner: override?.runner ?? '',
    argvText: (override?.argv ?? []).join('\n'),
    envText: Object.entries(override?.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    disabled: override?.disabled === true
  };
}

function draftToRequest(projectId: string, targetId: string, draft: Draft): BuildPlanOverrideRequest & { projectId: string } {
  const argv = draft.argvText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const env: Record<string, string> = {};
  for (const line of draft.envText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return {
    projectId,
    targetId,
    action: draft.action === '*' ? undefined : draft.action,
    runner: draft.runner.trim() === '' ? undefined : draft.runner.trim(),
    argv: argv.length === 0 ? undefined : argv,
    env: Object.keys(env).length === 0 ? undefined : env,
    disabled: draft.disabled ? true : undefined
  };
}

function ActionRow(props: { name: string; view: BuildPlanActionView | undefined; onEditPlan?: (argv: string[]) => void }): React.JSX.Element {
  const view = props.view;
  const checks = view?.readiness ?? [];
  return (
    <li className="build-plan-action" data-testid={`build-plan-action-${props.name}`}>
      <div className="build-plan-action-head">
        <code>{props.name}</code>
        {view?.disabled === true ? <StatusBadge tone="off" label="已停用" /> : null}
        {view?.override === true ? <StatusBadge tone="info" label="override" /> : null}
        {checks.map((check, index) => (
          <span key={check.id ?? check.check ?? index}
            className={`readiness-dot readiness-${readinessTone(check)}`}
            title={`${check.check ?? check.id ?? ''} ${check.code ?? ''} ${check.message ?? ''}`} />
        ))}
      </div>
      {view?.argv && view.argv.length > 0 ? (
        <code className="build-plan-argv">{view.argv.map((arg) => /\s|["']/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}</code>
      ) : (
        <span className="muted">{
          checks.find((check) => check.passed === false)?.message
            ?? (view?.disabled === true ? '该动作已被 override 停用' : '无可用解析结果')
        }</span>
      )}
      {view?.runner ? <span className="muted">runner {view.runner}</span> : null}
      {view?.planSource ? <span className="muted">来源 {view.planSource}{view.overrideRevision ? ` · rev ${view.overrideRevision}` : ''}</span> : null}
      {view?.workspace?.targetDirectory ? <span className="muted">cwd {view.workspace.targetDirectory}</span> : null}
      {view?.workspace?.inherited ? <span className="muted">工作区 {view.workspace.workspaceRoot}</span> : null}
      {view?.workspace?.discoveryWarning ? <span className="form-error">{view.workspace.discoveryWarning}</span> : null}
      {view?.successfulPlan ? <span className="muted">成功命令 {view.successfulPlan.status} · {view.successfulPlan.revision?.slice(0, 8)}</span> : null}
      {view?.successfulPlan?.history?.length ? <label>成功版本
        <select value="" aria-label={`${props.name} 成功版本`} onChange={(event) => {
          const revision = view.successfulPlan?.history?.find((row) => row.revision === event.target.value);
          if (revision) props.onEditPlan?.(revision.argv);
        }}>
          <option value="">选择版本</option>
          {view.successfulPlan.history.map((row) => <option key={row.revision} value={row.revision}>
            {new Date(row.createdAt).toLocaleString()} · {row.revision.slice(0, 8)} · {row.source}
          </option>)}
        </select>
      </label> : null}
      {view?.planFingerprint ? (
        <span className="muted" data-testid={`build-plan-digest-${props.name}`}
          title={`planDigest ${view.planFingerprint} · 预览与执行必须携带相同 digest`}>
          digest {view.planFingerprint.slice(0, 12)}
        </span>
      ) : null}
    </li>
  );
}

function TargetCard(props: { projectId: string; target: BuildPlanTargetView }): React.JSX.Element {
  const queryClient = useQueryClient();
  const target = props.target;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [previewArgv, setPreviewArgv] = useState<Record<string, string[]>>({});
  const [previewDigest, setPreviewDigest] = useState<Record<string, string>>({});
  const activeOverride = (target.overrides ?? []).find((row) => row.status === 'ACTIVE');
  const staleOverrides = (target.overrides ?? []).filter((row) => row.status === 'STALE');

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['project-build-plan', props.projectId] });
  };
  const preview = useMutation({
    mutationFn: async (request: BuildPlanOverrideRequest & { projectId: string }) =>
      unwrap<BuildPlanPreviewResponse>(await window.codeAgentDesktop.previewProjectBuildPlan(request.projectId, request)),
    onSuccess: (data, request) => {
      const key = request.action ?? '*';
      const actionView = data.target?.actions?.[request.action ?? ''];
      setPreviewArgv((current) => ({ ...current, [key]: actionView?.argv ?? [] }));
      if (actionView?.planFingerprint !== undefined) {
        setPreviewDigest((current) => ({ ...current, [key]: actionView.planFingerprint as string }));
      }
    }
  });
  const save = useMutation({
    mutationFn: async (request: BuildPlanOverrideRequest & { projectId: string }) =>
      unwrap<BuildPlanOverrideResponse>(await window.codeAgentDesktop.putProjectBuildPlanOverride(request.projectId, request)),
    onSuccess: () => { invalidate(); setDraft(null); }
  });

  const mutationError = preview.error ?? save.error;
  const errorMessage = mutationError instanceof Error ? mutationError.message : null;

  return (
    <li className="settings-feature-card build-plan-target" data-testid={`build-plan-target-${target.targetId}`}>
      <div className="settings-feature-head">
        <strong>{target.tool}@{target.dir ?? '.'}</strong>
        <StatusBadge tone={target.source === 'USER' ? 'info' : 'off'} label={target.source === 'USER' ? '已覆盖' : '检测'} />
        {activeOverride ? (
          <button type="button" className="link-button"
            onClick={() => setDraft(draftFromOverride(activeOverride, activeOverride.action ?? '*'))}>
            编辑 override
          </button>
        ) : (
          <button type="button" className="link-button"
            onClick={() => setDraft({ action: '*', runner: '', argvText: '', envText: '', disabled: false })}>
            新增 override
          </button>
        )}
      </div>
      {staleOverrides.length > 0 ? (
        <p className="muted">工作区指纹已变化，{staleOverrides.length} 条 override 标记为 STALE，不会生效。</p>
      ) : null}
      <ul className="build-plan-actions">
        {ACTIONS.filter((name) => target.actions[name] !== undefined).map((name) => (
          <ActionRow key={name} name={name} view={target.actions[name]} onEditPlan={(argv) => {
            setPreviewArgv({}); setPreviewDigest({});
            setDraft({ action: name, runner: '', argvText: argv.join('\n'), envText: '', disabled: false });
          }} />
        ))}
      </ul>
      {draft !== null ? (
        <form className="build-plan-editor" data-testid={`build-plan-editor-${target.targetId}`}
          onSubmit={(event) => { event.preventDefault(); save.mutate(draftToRequest(props.projectId, target.targetId, draft)); }}>
          <label>action
            <select value={draft.action}
              onChange={(event) => setDraft({ ...draft, action: event.target.value })}>
              <option value="*">全部动作</option>
              {ACTIONS.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <label>runner
            <input value={draft.runner} placeholder="留空按 recipe 自动选择"
              onChange={(event) => setDraft({ ...draft, runner: event.target.value })} />
          </label>
          <label>argv（每行一个参数；首行为可执行文件）
            <textarea rows={4} value={draft.argvText}
              onChange={(event) => setDraft({ ...draft, argvText: event.target.value })} />
          </label>
          <label>env（每行 KEY=VALUE）
            <textarea rows={3} value={draft.envText}
              onChange={(event) => setDraft({ ...draft, envText: event.target.value })} />
          </label>
          <label className="build-plan-disabled">
            <input type="checkbox" checked={draft.disabled}
              onChange={(event) => setDraft({ ...draft, disabled: event.target.checked })} />
            停用该动作
          </label>
          {(() => {
            const previewed = previewArgv[draft.action];
            const previewedDigest = previewDigest[draft.action];
            return (
              <>
                {previewed !== undefined
                  ? <code className="build-plan-argv">{previewed.join(' ')}</code>
                  : null}
                {previewedDigest !== undefined
                  ? <span className="muted" data-testid="build-plan-preview-digest">digest {previewedDigest.slice(0, 12)}</span>
                  : null}
              </>
            );
          })()}
          {errorMessage !== null ? <p className="form-error">{errorMessage}</p> : null}
          <div className="activity-summary-actions">
            <button type="button" disabled={preview.isPending}
              onClick={() => preview.mutate(draftToRequest(props.projectId, target.targetId, draft))}>
              预览
            </button>
            <button type="submit" disabled={save.isPending}>保存 override</button>
            <button type="button" onClick={() => { setDraft(null); setPreviewArgv({}); }}>取消</button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

type ProfileDraft = {
  buildMode: 'INHERIT' | 'COLLABORATIVE' | 'MODEL_ONLY' | 'FIXED';
  evidenceLevel: 'STRUCTURED' | 'EXIT_ONLY';
  allowAllSkipped: boolean;
  timeoutText: string;
  enabled: boolean;
};

function draftFromProfile(profile: VerificationProfileView | undefined): ProfileDraft {
  const config = (profile?.config ?? {}) as Record<string, unknown>;
  return {
    buildMode: config.buildMode === 'COLLABORATIVE' || config.buildMode === 'MODEL_ONLY' || config.buildMode === 'FIXED'
      ? config.buildMode : 'INHERIT',
    evidenceLevel: config.evidenceLevel === 'EXIT_ONLY' ? 'EXIT_ONLY' : 'STRUCTURED',
    allowAllSkipped: config.allowAllSkipped === true,
    timeoutText: typeof config.timeoutMillis === 'number' ? String(config.timeoutMillis) : '',
    enabled: profile?.enabled !== false
  };
}

/**
 * Verification-profile card (design 2026-09-26 §7.4): edits the
 * project's "default" profile — the document the run snapshots once
 * per invocation. Only the keys that actually reach the spec are
 * surfaced; unknown keys already stored are preserved on save.
 */
function VerificationProfileCard(props: { projectId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const profiles = useQuery({
    queryKey: ['project-verification-profiles', props.projectId],
    retry: false,
    queryFn: async () =>
      unwrap(await window.codeAgentDesktop.getProjectVerificationProfiles(props.projectId)) as VerificationProfileListResponse
  });
  const profile = (profiles.data?.profiles ?? []).find((row) => row.profileId === 'default');

  const save = useMutation({
    mutationFn: async (next: ProfileDraft) => {
      const existing = (profile?.config ?? {}) as Record<string, unknown>;
      const config: Record<string, unknown> = { ...existing };
      if (next.buildMode === 'INHERIT') delete config.buildMode;
      else config.buildMode = next.buildMode;
      config.evidenceLevel = next.evidenceLevel;
      config.allowAllSkipped = next.allowAllSkipped;
      const timeout = next.timeoutText.trim();
      if (timeout.length === 0) {
        delete config.timeoutMillis;
      } else {
        const parsed = Number(timeout);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error('timeoutMillis 必须是非负数字');
        }
        config.timeoutMillis = parsed;
      }
      return unwrap<VerificationProfileView>(await window.codeAgentDesktop.putProjectVerificationProfile(
        props.projectId, 'default', {
          config,
          enabled: next.enabled,
          expectedRevision: profile?.revision
        }));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-verification-profiles', props.projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-build-plan', props.projectId] });
      setDraft(null);
    }
  });

  const errorMessage = save.error instanceof Error ? save.error.message
    : save.error !== null ? String(save.error) : null;
  const current = draft ?? draftFromProfile(profile);

  return (
    <li className="settings-feature-card" data-testid="verification-profile-card">
      <div className="settings-feature-head">
        <strong>验证 profile · default</strong>
        {profile === undefined
          ? <StatusBadge tone="off" label="未配置" />
          : <StatusBadge tone={profile.enabled ? 'ok' : 'off'} label={profile.enabled ? '证据策略启用' : '证据策略停用'} />}
        {profile !== undefined ? (
          <span className="muted" title={`configDigest ${profile.configDigest ?? '—'}`}>
            rev {profile.revision} · digest {(profile.configDigest ?? '—').slice(0, 12)}
          </span>
        ) : null}
        <button type="button" className="link-button"
          onClick={() => setDraft(draft === null ? draftFromProfile(profile) : null)}>
          {draft === null ? '编辑' : '收起'}
        </button>
      </div>
      {profiles.isError ? (
        <p className="form-error">无法读取验证 profile：{String(profiles.error instanceof Error ? profiles.error.message : profiles.error)}</p>
      ) : null}
      {profile === undefined && draft === null && !profiles.isPending && !profiles.isError ? (
        <p className="muted">未配置 default profile —— 运行使用内置默认（STRUCTURED 证据）。保存后即对下一次运行生效。</p>
      ) : null}
      {draft !== null ? (
        <form className="build-plan-editor" data-testid="verification-profile-editor"
          onSubmit={(event) => { event.preventDefault(); save.mutate(current); }}>
          <label>构建模式
            <select value={current.buildMode}
              onChange={(event) => setDraft({ ...current, buildMode: event.target.value as ProfileDraft['buildMode'] })}>
              <option value="INHERIT">继承全局</option>
              <option value="COLLABORATIVE">工具与模型协作</option>
              <option value="MODEL_ONLY">由模型处理</option>
              <option value="FIXED">只使用已确认方案</option>
            </select>
          </label>
          <label>evidenceLevel
            <select value={current.evidenceLevel}
              onChange={(event) => setDraft({ ...current, evidenceLevel: event.target.value as ProfileDraft['evidenceLevel'] })}>
              <option value="STRUCTURED">STRUCTURED（报告缺失判 INCONCLUSIVE）</option>
              <option value="EXIT_ONLY">EXIT_ONLY（仅以退出码判定）</option>
            </select>
          </label>
          <label className="build-plan-disabled">
            <input type="checkbox" checked={current.allowAllSkipped}
              onChange={(event) => setDraft({ ...current, allowAllSkipped: event.target.checked })} />
            允许全部测试跳过仍判 PASSED
          </label>
          <label>timeoutMillis（留空用 recipe 默认）
            <input value={current.timeoutText} inputMode="numeric"
              onChange={(event) => setDraft({ ...current, timeoutText: event.target.value })} />
          </label>
          <label className="build-plan-disabled">
            <input type="checkbox" checked={current.enabled}
              onChange={(event) => setDraft({ ...current, enabled: event.target.checked })} />
            启用证据策略
          </label>
          {errorMessage !== null ? <p className="form-error">{errorMessage}</p> : null}
          <div className="activity-summary-actions">
            <button type="submit" disabled={save.isPending}>保存 profile</button>
            <button type="button" onClick={() => setDraft(null)}>取消</button>
          </div>
        </form>
      ) : profile !== undefined ? (
        <ul className="build-plan-actions">
          <li className="build-plan-action">
            <span className="muted">
              构建模式 {String((profile.config as Record<string, unknown>).buildMode ?? '继承全局')}
              {' · '}
              evidenceLevel {String((profile.config as Record<string, unknown>).evidenceLevel ?? 'STRUCTURED')}
              {' · '}allowAllSkipped {String((profile.config as Record<string, unknown>).allowAllSkipped === true)}
              {' · '}timeout {typeof (profile.config as Record<string, unknown>).timeoutMillis === 'number'
                ? `${String((profile.config as Record<string, unknown>).timeoutMillis)}ms` : 'recipe 默认'}
            </span>
          </li>
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Verification-plan panel (design 2026-09-26 §7.3): one card per build
 * target with resolved argv per action, readiness facts, and the
 * validated override editor. Every render is a server-side dry run —
 * this panel never starts a process.
 */
export function BuildPlanPanel(props: {
  projectId: string | null;
  onClose: () => void;
}): React.JSX.Element {
  const plan = useQuery({
    queryKey: ['project-build-plan', props.projectId],
    enabled: props.projectId !== null,
    retry: false,
    queryFn: async () =>
      unwrap(await window.codeAgentDesktop.getProjectBuildPlan(props.projectId as string)) as ProjectBuildPlanResponse
  });
  const targets = useMemo(() => plan.data?.targets ?? [], [plan.data]);

  return (
    <PanelShell
      title="验证计划"
      className="activity-summary-panel build-plan-panel"
      testId="build-plan-panel"
      ariaLabel="验证计划"
      closeLabel="关闭验证计划"
      onClose={props.onClose}
    >
      {props.projectId === null ? (
        <div className="empty-state">当前会话未绑定项目。</div>
      ) : (
        <>
          <p className="muted">
            模式 {plan.data?.buildMode ?? 'COLLABORATIVE'} · {' '}
            recipes {plan.data?.recipesVersion ?? '—'} · 指纹 {plan.data?.workspaceFingerprint?.slice(0, 12) ?? '—'}
            {plan.data?.truncated === true ? ' · 探查不完整' : ''}
          </p>
          {plan.isPending ? <p className="muted">正在解析构建计划…</p> : null}
          {plan.isError ? (
            <p className="form-error">无法读取构建计划：{String(plan.error instanceof Error ? plan.error.message : plan.error)}</p>
          ) : null}
          {plan.data !== undefined && targets.length === 0 ? (
            <div className="empty-state">未检测到构建目标（pom.xml / package.json / pyproject.toml 等）。</div>
          ) : null}
          <ul className="settings-feature-list">
            <VerificationProfileCard projectId={props.projectId as string} />
            {targets.map((target) => (
              <TargetCard key={target.targetId} projectId={props.projectId as string} target={target} />
            ))}
          </ul>
        </>
      )}
    </PanelShell>
  );
}
