import type { AttentionLike, MissionLike } from '../queries';
import { MissionPanel } from '../MissionPanel';
import { McpPanel } from '../McpPanel';
import { HooksPanel, SkillsPanel } from '../ExtensionPanels';
import { ExtensionEvidencePanel, McpGovernancePanel, SkillImportPanel } from '../GovernedExtensionsPanel';
import { SettingsCenter, type SettingsRoute } from '../settings/SettingsCenter';
import type { SettingsPageContext } from '../settings/settingsContext';
import type { appearanceFromPreferences } from '../settings/pages/AppearancePage';

/** Navigation-only inbox: attention items come from the service snapshot. */
export function AttentionSurface(props: {
  items: AttentionLike[];
  onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
  return (
    <section className="surface-screen">
      <div className="surface-heading">
        <div><span className="eyebrow">待处理</span><h1>待处理</h1><p>只在需要你决定、恢复或查看警告时打断。</p></div>
        <span className="surface-count">{props.items.length}</span>
      </div>
      <div className="attention-board">
        <section>
          <h2>需要你的决定</h2>
          <ul className="attention-list">
            {props.items.map((item) => (
              <li key={item.attentionId} onClick={() => { if (item.sessionId) props.onOpenSession(item.sessionId); }}>
                <span className="attention-type">{item.attentionType ?? 'ATTENTION'}</span>
                <span className="attention-summary">{item.summary ?? '需要查看服务状态'}</span>
              </li>
            ))}
            {props.items.length === 0 ? <li className="empty">没有待处理事项。</li> : null}
          </ul>
        </section>
        <section>
          <h2>状态说明</h2>
          <p className="surface-note">审批、失败和可恢复状态来自 Java Service 权威快照；此处只负责导航，不在本地改变任务状态。</p>
        </section>
      </div>
    </section>
  );
}

/** Mission orchestration surface; the panel keeps service-owned semantics. */
export function MissionsSurface(props: {
  sessionId: string | null;
  workspaceAlias: string | null;
  onDecide: (mission: MissionLike, decision: 'APPROVE' | 'REJECT') => void;
  onCommand: (mission: MissionLike, command: 'start' | 'pause' | 'resume' | 'cancel') => void;
  onCreate: (input: { title: string; goal: string }) => void;
  pending: boolean;
  onBack: () => void;
  onOpenSession?: (sessionId: string) => void;
}): React.JSX.Element {
  return (
    <section className="surface-screen missions-screen">
      <div className="surface-heading">
        <div><span className="eyebrow">任务编排</span><h1>任务编排</h1><p>跨会话 Mission 总览；新建入口在具体会话内。</p></div>
        <button type="button" className="secondary-button" onClick={props.onBack}>返回会话</button>
      </div>
      <MissionPanel
        sessionId={props.sessionId}
        workspaceAlias={props.workspaceAlias}
        onDecide={props.onDecide}
        onCommand={props.onCommand}
        onCreate={props.onCreate}
        pending={props.pending}
        onOpenSession={props.onOpenSession}
      />
    </section>
  );
}

/** Settings surface wraps the settings center inside the workbench shell. */
export function SettingsSurface(props: {
  context: SettingsPageContext;
  routeRequest: { route: SettingsRoute; nonce: number } | null;
  onAppearancePreview: (draft: ReturnType<typeof appearanceFromPreferences>) => void;
  onDone: () => void;
}): React.JSX.Element {
  return (
    <section className="surface-screen settings-screen settings-surface" data-testid="settings-screen">
      <SettingsCenter
        context={props.context}
        onAppearancePreview={props.onAppearancePreview}
        routeRequest={props.routeRequest}
        onDone={props.onDone}
      />
    </section>
  );
}

/** Controlled boundary panels only: MCP, Skills and Hooks stay service-mediated. */
export function ExtensionsSurface(props: {
  mcpEnabled: boolean;
  skillsEnabled: boolean;
  hooksEnabled: boolean;
  onAttach: (input: { name: string; mediaType: string; text: string }) => void;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <section className="surface-screen extensions-screen">
      <div className="surface-heading">
        <div><span className="eyebrow">扩展</span><h1>扩展</h1><p>MCP、Skills 和 Hooks 只通过受控 Service 边界工作。</p></div>
        <button type="button" className="secondary-button" onClick={props.onBack}>返回会话</button>
      </div>
      <div className="extension-grid">
        <McpGovernancePanel enabled={props.mcpEnabled} />
        <McpPanel enabled={props.mcpEnabled} onAttach={props.onAttach} />
        <SkillImportPanel enabled={props.skillsEnabled} />
        <SkillsPanel enabled={props.skillsEnabled} />
        <HooksPanel enabled={props.hooksEnabled} />
        <ExtensionEvidencePanel enabled={props.mcpEnabled || props.skillsEnabled} />
      </div>
    </section>
  );
}
