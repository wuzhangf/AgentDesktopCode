import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { unwrap } from './queries';
import { Icon } from './Icon';
import type {
  ExtensionSelection,
  McpGovernedServerRow,
  McpToolDescriptorView,
  McpToolListResponse,
  SkillRecordResponse
} from '../../../packages/protocol/src/index.js';

/**
 * WU07 per-turn extension selection (extension design §4.1): the user
 * picks which enabled MCP servers and ACTIVE skills a message binds. The
 * selection is frozen into the message at send time and never re-resolved
 * — retries replay the same frozen set.
 *
 * Selecting a server binds all of its currently catalogued tools (the
 * service re-validates each toolId against the frozen catalog snapshot;
 * a server with no cached tools contributes nothing and fails closed
 * host-side if misused).
 */

export interface ExtensionSelectionValue {
  selection: ExtensionSelection | null;
  /** Server ids the user toggled on; tools resolve lazily per server. */
  serverIds: string[];
  skillIds: string[];
}

interface GovernedSkillLike {
  skillId?: string | null;
  name?: string | null;
  status?: string | null;
  /** Pinned version digest — required for a frozen selection. */
  currentVersionDigest?: string | null;
}

/** Wire availability states that can never be invoked (catalog-marked or
 * administratively disabled). Absent availability = treat as callable. */
const NON_CALLABLE_AVAILABILITY = new Set(['DISABLED', 'UNAVAILABLE', 'INVALID_SCHEMA', 'UNSUPPORTED_SCHEMA']);

function isToolCallable(availability: string | null | undefined): boolean {
  return availability == null || !NON_CALLABLE_AVAILABILITY.has(availability);
}

function toolAvailabilityLabel(availability: string | null | undefined): string {
  switch (availability) {
    case 'DISABLED': return '已停用';
    case 'UNAVAILABLE': return '不可用';
    case 'DEGRADED': return '降级';
    case 'INVALID_SCHEMA': return '协议不合规';
    case 'UNSUPPORTED_SCHEMA': return '协议不支持';
    default: return availability ?? '未知';
  }
}

export interface ExtensionSelectionState {
  enabled: boolean;
  serverIds: string[];
  skillIds: string[];
  open: boolean;
  servers: McpGovernedServerRow[];
  skills: GovernedSkillLike[];
  /** WU08 per-tool narrowing: serverId → explicit toolIds. Absent = all catalog tools. */
  toolOverrides: Record<string, string[]>;
  toolsFor: (serverId: string) => McpToolDescriptorView[];
  expandedTools: string | null;
  toggleOpen: () => void;
  toggleServer: (serverId: string, checked: boolean) => void;
  toggleSkill: (skillId: string, checked: boolean) => void;
  toggleTool: (serverId: string, toolId: string, checked: boolean) => void;
  setExpandedTools: (serverId: string | null) => void;
  removeServer: (serverId: string) => void;
  removeSkill: (skillId: string) => void;
  emptySelectedTools: boolean;
}

/**
 * WU05 (design §5.5.4): the selection state is lifted into a hook so the
 * trigger/panel can live in the composer footer while the frozen chips
 * render above the textarea.
 */
export function useExtensionSelection(enabled: boolean | undefined, onChange: (value: ExtensionSelectionValue) => void): ExtensionSelectionState {
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [toolOverrides, setToolOverrides] = useState<Record<string, string[]>>({});
  const [toolDetails, setToolDetails] = useState<Record<string, McpToolDescriptorView[]>>({});
  const [expandedTools, setExpandedTools] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const resolvedEnabled = enabled ?? true;

  const servers = useQuery({
    queryKey: ['extsel-mcp'],
    enabled: resolvedEnabled && open,
    queryFn: async () => {
      try {
        const result = unwrap(await window.codeAgentDesktop.listMcpServersGoverned()) as McpGovernedServerRow[];
        return result.filter((server) => server.enabled === true && server.serverId != null);
      } catch {
        return [] as McpGovernedServerRow[];
      }
    }
  });

  const skills = useQuery({
    queryKey: ['extsel-skills'],
    enabled: resolvedEnabled && open,
    queryFn: async () => {
      try {
        const result = unwrap(await window.codeAgentDesktop.listSkillsGoverned()) as SkillRecordResponse[];
        // Only skills with a pinned current version can be selected — the
        // frozen binding requires an immutable versionDigest.
        return (result as GovernedSkillLike[]).filter((skill) => skill.status === 'ACTIVE'
          && skill.skillId != null
          && skill.currentVersionDigest != null && skill.currentVersionDigest.length > 0);
      } catch {
        return [] as GovernedSkillLike[];
      }
    }
  });

  // Resolve each selected server's catalog tools lazily — the bound toolIds
  // come from the cached catalog, never from renderer-side name guessing.
  const serverTools = useQuery({
    queryKey: ['extsel-tools', serverIds.join(',')],
    enabled: serverIds.length > 0,
    queryFn: async () => {
      const map: Record<string, McpToolDescriptorView[]> = {};
      for (const serverId of serverIds) {
        try {
          // Paged catalog response — items only, never a bare array.
          const response = unwrap<McpToolListResponse>(
            await window.codeAgentDesktop.listMcpServerTools(serverId, { limit: 200 }));
          map[serverId] = (response.items ?? []) as McpToolDescriptorView[];
        } catch {
          map[serverId] = [];
        }
      }
      return map;
    }
  });

  useEffect(() => {
    if (serverTools.data) setToolDetails(serverTools.data);
  }, [serverTools.data]);

  const availableToolIds = (serverId: string): string[] =>
    (toolDetails[serverId] ?? [])
      .filter((tool) => tool.toolId != null && isToolCallable(tool.availability))
      .map((tool) => tool.toolId as string);

  const toggleTool = (serverId: string, toolId: string, checked: boolean) => {
    setToolOverrides((current) => {
      // First explicit toggle narrows from the full available set.
      const base = current[serverId] ?? availableToolIds(serverId);
      const next = checked
        ? (base.includes(toolId) ? base : [...base, toolId])
        : base.filter((id) => id !== toolId);
      return { ...current, [serverId]: next };
    });
  };

  useEffect(() => {
    if (serverIds.length === 0 && skillIds.length === 0) {
      onChange({ selection: null, serverIds, skillIds });
      return;
    }
    const mcpServers = serverIds
      .map((serverId) => ({
        serverId,
        toolIds: toolOverrides[serverId] ?? availableToolIds(serverId),
        resourcesEnabled: false
      }))
      .filter((entry) => entry.toolIds.length > 0);
    const skillsSelection = skillIds
      .map((skillId) => {
        const record = (skills.data ?? []).find((skill) => skill.skillId === skillId);
        return record?.currentVersionDigest
          ? { skillId, versionDigest: record.currentVersionDigest }
          : null;
      })
      .filter((entry): entry is { skillId: string; versionDigest: string } => entry != null);
    const selection: ExtensionSelection = {
      mode: 'EXPLICIT',
      mcpServers,
      skills: skillsSelection
    };
    onChange({ selection, serverIds, skillIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverIds, skillIds, toolOverrides, serverTools.data, toolDetails]);

  return {
    enabled: resolvedEnabled,
    serverIds,
    skillIds,
    open,
    servers: servers.data ?? [],
    skills: skills.data ?? [],
    toolOverrides,
    toolsFor: (serverId) => toolDetails[serverId] ?? [],
    expandedTools,
    toggleOpen: () => setOpen((value) => !value),
    toggleServer: (serverId: string, checked: boolean) => setServerIds((current) => checked
      ? [...current, serverId]
      : current.filter((id) => id !== serverId)),
    toggleSkill: (skillId: string, checked: boolean) => setSkillIds((current) => checked
      ? [...current, skillId]
      : current.filter((id) => id !== skillId)),
    toggleTool,
    setExpandedTools,
    removeServer: (serverId: string) => {
      setServerIds((current) => current.filter((id) => id !== serverId));
      setToolOverrides((current) => {
        if (!(serverId in current)) return current;
        const next = { ...current };
        delete next[serverId];
        return next;
      });
    },
    removeSkill: (skillId: string) => setSkillIds((current) => current.filter((id) => id !== skillId)),
    emptySelectedTools: serverIds.length > 0 && serverIds.every((id) => availableToolIds(id).length === 0)
  };
}

/**
 * WU05 (design §5.5.4): footer trigger — a `.composer-chip` button with a
 * puzzle icon and the selected count, plus the absolutely-positioned panel
 * (Esc / outside click close).
 */
export function ExtensionSelectionPicker(props: {
  state: ExtensionSelectionState;
}): React.JSX.Element | null {
  const { state } = props;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state.open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && event.target instanceof Node
          && !rootRef.current.contains(event.target)) {
        state.toggleOpen();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') state.toggleOpen();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [state.open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state.enabled) return null;

  const active = state.serverIds.length + state.skillIds.length;
  return (
    <div className="extension-selection" data-testid="extension-selection" ref={rootRef}>
      <button type="button" className={`composer-chip${state.open ? ' selected' : ''}`} data-testid="extension-selection-toggle"
        title="为本条消息选择 MCP 工具与 Skill" aria-label={`扩展${active > 0 ? `，已选 ${active} 项` : ''}`}
        aria-expanded={state.open} onClick={state.toggleOpen}>
        <Icon name="puzzle" size={13} />
        扩展{active > 0 ? ` ${active}` : ''}
      </button>
      {state.open ? (
        <div className="extension-selection-panel" data-testid="extension-selection-panel" role="dialog" aria-label="扩展选择">
          <div className="run-meta">此选择仅对当前消息生效；重发时沿用原选择</div>
          {state.servers.map((server) => {
            const serverId = server.serverId ?? '';
            const checked = state.serverIds.includes(serverId);
            const override = state.toolOverrides[serverId];
            const narrowed = override != null ? ` · 已选 ${override.length} 工具` : '';
            return (
              <div key={serverId} data-testid="extsel-server">
                <label className="run-meta">
                  <input type="checkbox"
                    checked={checked}
                    onChange={(event) => state.toggleServer(serverId, event.target.checked)} />
                  {server.displayName ?? serverId}
                  {server.connectionMode === 'HUB' ? ' · Hub' : ''}
                  {' '}· {server.connectionState} · {server.toolCount ?? 0} 工具{narrowed}
                </label>
                {checked ? (
                  <button type="button" className="secondary-button small" data-testid="extsel-tools-toggle"
                    onClick={() => state.setExpandedTools(state.expandedTools === serverId ? null : serverId)}>
                    {state.expandedTools === serverId ? '收起工具' : '选择工具'}
                  </button>
                ) : null}
                {checked && state.expandedTools === serverId ? (
                  <div className="extension-tool-list" data-testid="extsel-tool-list">
                    {state.toolsFor(serverId).map((tool) => (
                      <label key={tool.toolId ?? ''} className="run-meta" data-testid="extsel-tool">
                        <input type="checkbox"
                          disabled={!isToolCallable(tool.availability)}
                          checked={(override ?? state.toolsFor(serverId)
                            .filter((item) => isToolCallable(item.availability))
                            .map((item) => item.toolId ?? ''))
                            .includes(tool.toolId ?? '')}
                          onChange={(event) => state.toggleTool(serverId, tool.toolId ?? '', event.target.checked)} />
                        {tool.title ?? tool.rawName ?? tool.toolId}
                        {!isToolCallable(tool.availability)
                          ? ` · ${toolAvailabilityLabel(tool.availability)}${tool.availabilityReason ? ` (${tool.availabilityReason})` : ''}`
                          : ''}
                      </label>
                    ))}
                    {state.toolsFor(serverId).length === 0 ? (
                      <div className="run-meta">目录尚未加载或没有工具。</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          {state.servers.length === 0 ? <div className="run-meta">没有已启用的受管 MCP 服务器。</div> : null}
          {state.skills.map((skill) => (
            <label key={skill.skillId ?? ''} className="run-meta" data-testid="extsel-skill">
              <input type="checkbox"
                checked={state.skillIds.includes(skill.skillId ?? '')}
                onChange={(event) => state.toggleSkill(skill.skillId as string, event.target.checked)} />
              {skill.name ?? skill.skillId} · ACTIVE
            </label>
          ))}
          {state.skills.length === 0 ? <div className="run-meta">没有已启用的 Skill。</div> : null}
          {state.emptySelectedTools ? (
            <div className="run-meta" data-testid="extsel-empty-tools">所选服务器没有已缓存工具；请先在扩展面板连接并刷新目录。</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * WU05 (design §5.5.4): the selected servers/skills as removable chips —
 * rendered above the composer textarea.
 */
export function ExtensionSelectionChips(props: {
  state: ExtensionSelectionState;
}): React.JSX.Element | null {
  const { state } = props;
  if (!state.enabled || (state.serverIds.length === 0 && state.skillIds.length === 0)) return null;
  const serverName = (serverId: string): string =>
    state.servers.find((server) => server.serverId === serverId)?.displayName ?? serverId;
  const skillName = (skillId: string): string =>
    state.skills.find((skill) => skill.skillId === skillId)?.name ?? skillId;
  return (
    <div className="extension-chips" data-testid="extension-chips" aria-label="已选扩展">
      {state.serverIds.map((serverId) => (
        <span className="extension-chip" key={`server:${serverId}`}>
          <Icon name="puzzle" size={11} />
          <span className="extension-chip-label">扩展: {serverName(serverId)}</span>
          <button type="button" className="extension-chip-remove" aria-label={`移除扩展 ${serverName(serverId)}`} onClick={() => state.removeServer(serverId)}><Icon name="x" size={11} /></button>
        </span>
      ))}
      {state.skillIds.map((skillId) => (
        <span className="extension-chip" key={`skill:${skillId}`}>
          <Icon name="spark" size={11} />
          <span className="extension-chip-label">Skill: {skillName(skillId)}</span>
          <button type="button" className="extension-chip-remove" aria-label={`移除 Skill ${skillName(skillId)}`} onClick={() => state.removeSkill(skillId)}><Icon name="x" size={11} /></button>
        </span>
      ))}
    </div>
  );
}
