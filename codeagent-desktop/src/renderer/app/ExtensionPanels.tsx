import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { unwrap } from './queries';

/**
 * EW10.5 skill catalog + EW10.6 typed hook health projections (design
 * §10.6). The desktop never executes extensions: it registers and gates
 * skills (install/enable/permission preview per design) and shows hook
 * health. Hook installation itself is operator service configuration.
 */

interface SkillLike {
  skillId?: string | null;
  name?: string | null;
  version?: string | null;
  source?: string | null;
  scope?: string | null;
  projectAlias?: string | null;
  instructions?: string | null;
  permissions?: string[];
  status?: string | null;
  revision?: number | null;
}

interface HookLike {
  name?: string | null;
  event?: string | null;
  enabled?: boolean | null;
  timeoutMillis?: number | null;
  failurePolicy?: string | null;
  lastStatus?: string | null;
  lastFinishedAt?: string | null;
}

interface HookExecutionLike {
  hookName?: string | null;
  event?: string | null;
  status?: string | null;
  durationMillis?: number | null;
  finishedAt?: string | null;
}

/** Marks FEATURE_DISABLED refusals so panels degrade with an explicit note. */
function isDisabled(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('FEATURE_DISABLED');
}

export function SkillsPanel(props: { enabled?: boolean } = {}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [source, setSource] = useState('user');
  const [scope, setScope] = useState<'PROJECT' | 'USER'>('USER');
  const [projectAlias, setProjectAlias] = useState('');
  const [instructions, setInstructions] = useState('');
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skills = useQuery({
    queryKey: ['skills'],
    enabled: props.enabled ?? true,
    queryFn: async () => {
      try {
        const result = unwrap(await window.codeAgentDesktop.listSkills()) as SkillLike[];
        setDisabled(false);
        setError(null);
        return result;
      } catch (err) {
        if (isDisabled(err)) {
          setDisabled(true);
          return [] as SkillLike[];
        }
        setError(err instanceof Error ? err.message : String(err));
        return [] as SkillLike[];
      }
    }
  });

  const registerM = useMutation({
    mutationFn: async () => {
      return unwrap(await window.codeAgentDesktop.registerSkill({
        name, version, source, scope,
        projectAlias: scope === 'PROJECT' ? projectAlias : null,
        instructions
      })) as SkillLike;
    },
    onSuccess: () => {
      setName('');
      setInstructions('');
      setProjectAlias('');
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  const statusM = useMutation({
    mutationFn: async (input: { skillId: string; status: string; expectedRevision: number }) => {
      return unwrap(await window.codeAgentDesktop.changeSkillStatus(input.skillId, {
        status: input.status, expectedRevision: input.expectedRevision
      })) as SkillLike;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['skills'] }),
    onError: (err) => setError(err instanceof Error ? err.message : String(err))
  });

  if (props.enabled === false) {
    return <div className="mcp-panel" data-testid="skills-panel"><div className="visible-output-header">Skills 目录（仅元数据，不执行）</div><div className="run-meta" data-testid="skills-disabled">Skills 目录未在服务端启用（skillsCatalog flag 已关闭）。</div></div>;
  }

  return (
    <div className="mcp-panel" data-testid="skills-panel">
      <div className="visible-output-header">Skills 目录（仅元数据，不执行）</div>
      {disabled ? (
        <div className="run-meta" data-testid="skills-disabled">
          Skills 目录未在服务端启用（skillsCatalog flag 已关闭）。
        </div>
      ) : (
        <>
          {(skills.data ?? []).map((skill) => (
            <div key={skill.skillId ?? ''} className="mcp-resource" data-testid="skill-record">
              <span className="run-meta">
                {skill.name} v{skill.version} · {skill.scope}
                {skill.projectAlias ? `(${skill.projectAlias})` : ''} · {skill.status} · 来源 {skill.source}
                {skill.permissions && skill.permissions.length > 0 ? ` · 权限 ${skill.permissions.join('/')}` : ''}
              </span>
              {skill.status === 'ACTIVE' ? (
                <button type="button" data-testid="skill-disable"
                  onClick={() => statusM.mutate({ skillId: skill.skillId ?? '', status: 'DISABLED', expectedRevision: skill.revision ?? 1 })}>
                  禁用
                </button>
              ) : skill.status === 'DISABLED' ? (
                <button type="button" data-testid="skill-enable"
                  onClick={() => statusM.mutate({ skillId: skill.skillId ?? '', status: 'ACTIVE', expectedRevision: skill.revision ?? 1 })}>
                  启用
                </button>
              ) : null}
              {skill.status !== 'REVOKED' ? (
                <button type="button" data-testid="skill-revoke"
                  onClick={() => statusM.mutate({ skillId: skill.skillId ?? '', status: 'REVOKED', expectedRevision: skill.revision ?? 1 })}>
                  撤销
                </button>
              ) : null}
            </div>
          ))}
          {skills.data?.length === 0 ? <span className="run-meta">目录为空</span> : null}
          <div className="new-session" data-testid="skill-register-form">
            <label>名称<input value={name} onChange={(event) => setName(event.target.value)} data-testid="skill-name" /></label>
            <label>版本<input value={version} onChange={(event) => setVersion(event.target.value)} data-testid="skill-version" /></label>
            <label>来源<input value={source} onChange={(event) => setSource(event.target.value)} data-testid="skill-source" /></label>
            <label>
              作用域
              <select value={scope} onChange={(event) => setScope(event.target.value as 'PROJECT' | 'USER')} data-testid="skill-scope">
                <option value="USER">USER</option>
                <option value="PROJECT">PROJECT</option>
              </select>
            </label>
            {scope === 'PROJECT' ? (
              <label>项目别名<input value={projectAlias} onChange={(event) => setProjectAlias(event.target.value)} data-testid="skill-project-alias" /></label>
            ) : null}
            <label>指令（可见）<textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} data-testid="skill-instructions" /></label>
            <button type="button" data-testid="skill-register-submit"
              disabled={registerM.isPending || name.trim().length === 0 || instructions.trim().length === 0}
              onClick={() => registerM.mutate()}>
              注册 Skill
            </button>
          </div>
        </>
      )}
      {error ? <div className="run-meta" data-testid="skills-error">{error}</div> : null}
    </div>
  );
}

export function HooksPanel(props: { enabled?: boolean } = {}): React.JSX.Element {
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hooks = useQuery({
    queryKey: ['hooks'],
    enabled: props.enabled ?? true,
    queryFn: async () => {
      try {
        const result = unwrap(await window.codeAgentDesktop.listHooks()) as HookLike[];
        setDisabled(false);
        setError(null);
        return result;
      } catch (err) {
        if (isDisabled(err)) {
          setDisabled(true);
          return [] as HookLike[];
        }
        setError(err instanceof Error ? err.message : String(err));
        return [] as HookLike[];
      }
    }
  });

  const executions = useQuery({
    queryKey: ['hook-executions'],
    enabled: props.enabled ?? true,
    queryFn: async () => {
      try {
        const result = unwrap(
          await window.codeAgentDesktop.listHookExecutions()
        ) as { items?: HookExecutionLike[]; truncated?: boolean };
        return result;
      } catch (err) {
        if (isDisabled(err)) return { items: [], truncated: false };
        setError(err instanceof Error ? err.message : String(err));
        return { items: [], truncated: false };
      }
    }
  });

  if (props.enabled === false) {
    return <div className="mcp-panel" data-testid="hooks-panel"><div className="visible-output-header">Typed Hooks（运维配置，只读健康）</div><div className="run-meta" data-testid="hooks-disabled">Typed Hooks 未在服务端启用（hooks flag 已关闭）。</div></div>;
  }

  return (
    <div className="mcp-panel" data-testid="hooks-panel">
      <div className="visible-output-header">Typed Hooks（运维配置，只读健康）</div>
      {disabled ? (
        <div className="run-meta" data-testid="hooks-disabled">
          Typed Hooks 未在服务端启用（hooks flag 已关闭）。
        </div>
      ) : (
        <>
          {(hooks.data ?? []).map((hook) => (
            <div key={hook.name ?? ''} className="mcp-resource" data-testid="hook-record">
              <span className="run-meta">
                {hook.name} · {hook.event} · {hook.enabled ? '启用' : '停用'} · 超时 {hook.timeoutMillis}ms
                · {hook.failurePolicy}
                {hook.lastStatus ? ` · 最近 ${hook.lastStatus}` : ''}
              </span>
            </div>
          ))}
          {hooks.data?.length === 0 ? <span className="run-meta">未配置 hook</span> : null}
          {(executions.data?.items ?? []).slice(0, 5).map((record, index) => (
            <div key={`${record.finishedAt ?? ''}-${index}`} className="run-meta" data-testid="hook-execution">
              {record.hookName} · {record.status} · {record.durationMillis}ms
            </div>
          ))}
        </>
      )}
      {error ? <div className="run-meta" data-testid="hooks-error">{error}</div> : null}
    </div>
  );
}
