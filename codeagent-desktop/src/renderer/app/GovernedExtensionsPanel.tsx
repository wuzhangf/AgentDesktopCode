import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { HubConnectionsPanel } from './HubConnectionsPanel';
import { unwrap } from './queries';
import type {
  ExecutionExtensionsResponse,
  ExtensionInvocationActionRequest,
  ExtensionInvocationListResponse,
  ExtensionInvocationView,
  ExtensionTestExecutionResponse,
  McpAuthActionResponse,
  McpDoctorFinding,
  McpGovernedServerRow,
  McpOperationResponse,
  McpPromptListResponse,
  McpPromptResolveResponse,
  McpResourceTemplateListResponse,
  McpServerConfigRequest,
  McpServerConfigRequestFields,
  McpServerDetailResponse,
  McpServerUpdateRequest,
  McpServerUpdateRequestFields,
  McpToolDescriptorView,
  McpToolListResponse,
  SkillImportPreviewResponse,
  SkillImportSourceResponse,
  SkillRecordResponse,
  SkillVersionListResponse
} from '../../../packages/protocol/src/index.js';

/**
 * WU08 governed extension surface (capability uplift): MCP server
 * configuration + lifecycle (templates, argv editing, HTTP transport,
 * OAuth consent, dependency diagnostics), governed skill package import,
 * and per-execution binding/invocation evidence with operator actions.
 *
 * Boundary rules kept here: the renderer never supplies filesystem paths
 * (import source handles come from the main-process picker), never carries
 * credential material (env/header fields are slot names), never sees OAuth
 * tokens (the consent URL goes straight to openExternalHttps), and renders
 * every tool schema/preview as untrusted plain text. All execution stays
 * host-side.
 */

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotWired(err: unknown): boolean {
  const text = message(err);
  return text.includes('EXT_HOST_NOT_WIRED') || text.includes('FEATURE_DISABLED');
}

// ---------------- MCP server templates (WU08) ----------------

/**
 * Client-side launch templates for the design's local targets. Selecting a
 * template only prefills the form — nothing is registered until the user
 * confirms, and templateRef is metadata, never a grant.
 */
const MCP_SERVER_TEMPLATES: ReadonlyArray<{
  templateRef: string;
  templateVersion: string;
  label: string;
  displayName: string;
  executable: string;
  args: string[];
  cwd?: string;
  note: string;
}> = [
  {
    templateRef: 'mcp.template.everything',
    templateVersion: '2025-11-25',
    label: 'Everything（参考实现）',
    displayName: 'MCP Everything',
    executable: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    note: '官方参考服务器 — 覆盖 tools/resources/prompts，用于协议验收。'
  },
  {
    templateRef: 'mcp.template.filesystem',
    templateVersion: '2025-11-25',
    label: 'Filesystem（参考实现）',
    displayName: 'MCP Filesystem',
    executable: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '<允许访问的目录>'],
    note: '把 <允许访问的目录> 替换为服务器可读写的目录后再注册。'
  },
  {
    templateRef: 'mcp.template.git',
    templateVersion: '2025-11-25',
    label: 'Git（参考实现）',
    displayName: 'MCP Git',
    executable: 'uvx',
    args: ['mcp-server-git', '--repository', '<仓库路径>'],
    note: '把 <仓库路径> 替换为目标仓库；需要本机已安装 uvx/git。'
  }
];

const TERMINAL_INVOCATION_STATES = new Set([
  'SUCCEEDED', 'FAILED', 'DENIED', 'CANCELLED', 'UNKNOWN'
]);

/** Poll one management operation until it settles (status/轮询间隔固定). */
function useMcpOperation(operationId: string | null) {
  return useQuery({
    queryKey: ['mcp-operation', operationId],
    enabled: operationId != null,
    refetchInterval: (query) => {
      const status = (query.state.data as McpOperationResponse | undefined)?.status;
      return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED'
        ? false : 1500;
    },
    queryFn: async () => {
      return unwrap(await window.codeAgentDesktop.getMcpOperation(operationId as string)) as McpOperationResponse;
    }
  });
}

/** DIAGNOSE detail is a JSON findings array; degrade to raw text otherwise. */
function diagnoseFindings(detail: string | null | undefined): McpDoctorFinding[] | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as unknown;
    return Array.isArray(parsed) ? parsed as McpDoctorFinding[] : null;
  } catch {
    return null;
  }
}

/**
 * Chinese display labels for the wire enums; unknown values fall back to
 * the raw code (fail-closed display — never hide an unfamiliar state).
 */
const MCP_CONNECTION_STATE_LABELS: Record<string, string> = {
  DISABLED: '已停用',
  STOPPED: '已停止',
  CONNECTING: '连接中',
  READY: '已连接',
  AUTH_REQUIRED: '需要授权',
  DEGRADED: '已降级',
  FAILED: '连接失败',
  UNSUPPORTED: '不支持'
};

function mcpConnectionTone(state: string | null | undefined): string {
  switch (state) {
    case 'READY': return 'tone-success';
    case 'CONNECTING': return 'tone-info';
    case 'AUTH_REQUIRED':
    case 'DEGRADED': return 'tone-warning';
    case 'FAILED': return 'tone-danger';
    default: return 'tone-neutral';
  }
}

const MCP_OPERATION_STATUS_LABELS: Record<string, string> = {
  RUNNING: '运行中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消'
};

function mcpOperationTone(status: string | null | undefined): string {
  switch (status) {
    case 'SUCCEEDED': return 'tone-success';
    case 'RUNNING': return 'tone-info';
    case 'FAILED': return 'tone-danger';
    default: return 'tone-neutral';
  }
}

const MCP_TOOL_RISK_LABELS: Record<string, string> = {
  NORMAL: '常规',
  READ_ONLY: '只读',
  WRITE: '写入',
  EXTERNAL_EFFECT: '外部副作用',
  HIGH_RISK: '高风险'
};

/** Tool availability beyond AVAILABLE — shown with the stable reason. */
const MCP_TOOL_AVAILABILITY_LABELS: Record<string, string> = {
  DISABLED: '已停用',
  UNAVAILABLE: '不可用',
  DEGRADED: '降级',
  INVALID_SCHEMA: '协议不合规',
  UNSUPPORTED_SCHEMA: '协议不支持'
};

function mcpToolRiskTone(risk: string | null | undefined): string {
  switch (risk) {
    case 'HIGH_RISK': return 'tone-danger';
    case 'WRITE':
    case 'EXTERNAL_EFFECT': return 'tone-warning';
    default: return 'tone-neutral';
  }
}

function mcpFindingTone(status: string | null | undefined): string {
  switch (status) {
    case 'OK': return 'tone-success';
    case 'WARN': return 'tone-warning';
    case 'FAIL': return 'tone-danger';
    default: return 'tone-neutral';
  }
}

function invocationTone(state: string | null | undefined): string {
  switch (state) {
    case 'SUCCEEDED': return 'tone-success';
    case 'FAILED':
    case 'DENIED': return 'tone-danger';
    case 'WAITING_INPUT':
    case 'UNKNOWN': return 'tone-warning';
    case 'CANCELLED': return 'tone-neutral';
    default: return 'tone-info';
  }
}

// ---------------- MCP server governance ----------------

export function McpGovernancePanel(props: { enabled?: boolean } = {}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notWired, setNotWired] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'tools' | 'prompts' | 'templates'>('tools');
  const [operationId, setOperationId] = useState<string | null>(null);
  const [diagnoseFor, setDiagnoseFor] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ExtensionTestExecutionResponse | null>(null);

  // create/edit form state — argv is one per line so paths keep spaces (G16)
  const [editing, setEditing] = useState<string | null>(null); // serverId under PATCH
  const [templateRef, setTemplateRef] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [transportKind, setTransportKind] = useState<'STDIO' | 'STREAMABLE_HTTP'>('STDIO');
  const [executable, setExecutable] = useState('');
  const [argsText, setArgsText] = useState('');
  const [cwd, setCwd] = useState('');
  const [envRefs, setEnvRefs] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [allowInsecureLoopback, setAllowInsecureLoopback] = useState(false);
  const [credentialRef, setCredentialRef] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [protocolPolicy, setProtocolPolicy] = useState<'AUTO' | 'PIN'>('AUTO');
  const [protocolProfile, setProtocolProfile] = useState<
    'LEGACY_2024_11_05' | 'LEGACY_2025_11_25' | 'MODERN_2026_07_28'
  >('LEGACY_2024_11_05');

  const operation = useMcpOperation(operationId);
  const diagnose = diagnoseFor
    ? diagnoseFindings((operation.data as McpOperationResponse | undefined)?.detail)
    : null;

  const resetForm = () => {
    setEditing(null);
    setTemplateRef('');
    setDisplayName('');
    setTransportKind('STDIO');
    setExecutable('');
    setArgsText('');
    setCwd('');
    setEnvRefs('');
    setEndpoint('');
    setAllowInsecureLoopback(false);
    setCredentialRef('');
    setOauthClientId('');
    setProtocolPolicy('AUTO');
    setProtocolProfile('LEGACY_2024_11_05');
  };

  const applyTemplate = (ref: string) => {
    setTemplateRef(ref);
    const template = MCP_SERVER_TEMPLATES.find((item) => item.templateRef === ref);
    if (!template) return;
    setDisplayName(template.displayName);
    setTransportKind('STDIO');
    setExecutable(template.executable);
    setArgsText(template.args.join('\n'));
    setCwd(template.cwd ?? '');
  };

  const servers = useQuery({
    queryKey: ['mcp-governed'],
    enabled: props.enabled ?? true,
    queryFn: async () => {
      try {
        const result = unwrap(await window.codeAgentDesktop.listMcpServersGoverned()) as McpGovernedServerRow[];
        setNotWired(false);
        setError(null);
        return result;
      } catch (err) {
        if (isNotWired(err)) {
          setNotWired(true);
          return [] as McpGovernedServerRow[];
        }
        setError(message(err));
        return [] as McpGovernedServerRow[];
      }
    }
  });

  const tools = useQuery({
    queryKey: ['mcp-tools', selected],
    enabled: selected != null,
    queryFn: async () => {
      try {
        const response = unwrap<McpToolListResponse>(
          await window.codeAgentDesktop.listMcpServerTools(selected as string));
        return (response.items ?? []) as McpToolDescriptorView[];
      } catch (err) {
        setError(message(err));
        return [] as McpToolDescriptorView[];
      }
    }
  });

  const prompts = useQuery({
    queryKey: ['mcp-prompts', selected],
    enabled: selected != null && detailTab === 'prompts',
    queryFn: async () => {
      try {
        return unwrap<McpPromptListResponse>(
          await window.codeAgentDesktop.listMcpPrompts(selected as string));
      } catch (err) {
        setError(message(err));
        return { items: [] } as McpPromptListResponse;
      }
    }
  });

  const templates = useQuery({
    queryKey: ['mcp-templates', selected],
    enabled: selected != null && detailTab === 'templates',
    queryFn: async () => {
      try {
        return unwrap<McpResourceTemplateListResponse>(
          await window.codeAgentDesktop.listMcpResourceTemplates(selected as string));
      } catch (err) {
        setError(message(err));
        return { items: [] } as McpResourceTemplateListResponse;
      }
    }
  });

  const testM = useMutation({
    mutationFn: async (input: { serverId: string; toolId: string }) => {
      return unwrap(await window.codeAgentDesktop.createExtensionTestExecution({
        serverId: input.serverId, toolId: input.toolId, arguments: {}
      })) as ExtensionTestExecutionResponse;
    },
    onSuccess: (response) => {
      setTestResult(response);
      setDiagnoseFor(null);
    },
    onError: (err) => setError(message(err))
  });

  const buildTransport = (): Record<string, unknown> => {
    if (transportKind === 'STREAMABLE_HTTP') {
      return {
        kind: 'STREAMABLE_HTTP',
        endpoint,
        allowInsecureLoopback
      };
    }
    return {
      kind: 'STDIO',
      executable,
      args: argsText.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
      cwd: cwd.trim().length > 0 ? cwd.trim() : null,
      envKeys: envRefs.trim().length === 0 ? [] : envRefs.split(/[,\s]+/)
    };
  };

  const createM = useMutation({
    mutationFn: async () => {
      const template = MCP_SERVER_TEMPLATES.find((item) => item.templateRef === templateRef);
      const request: McpServerConfigRequest & McpServerConfigRequestFields = {
        displayName,
        scope: 'USER',
        enabled: true,
        protocolPolicy,
        protocolProfile: protocolPolicy === 'PIN' ? protocolProfile : null,
        transport: buildTransport() as McpServerConfigRequest['transport'],
        credentialRef: credentialRef.trim().length > 0 ? credentialRef.trim() : null,
        oauthClientId: oauthClientId.trim().length > 0 ? oauthClientId.trim() : null,
        templateRef: template?.templateRef ?? null,
        templateVersion: template?.templateVersion ?? null
      };
      return unwrap(await window.codeAgentDesktop.createMcpServer(request)) as McpServerDetailResponse;
    },
    onSuccess: () => {
      resetForm();
      void queryClient.invalidateQueries({ queryKey: ['mcp-governed'] });
    },
    onError: (err) => setError(message(err))
  });

  const updateM = useMutation({
    mutationFn: async (server: McpServerDetailResponse) => {
      const request: McpServerUpdateRequest & McpServerUpdateRequestFields = {
        expectedRevision: server.revision ?? 0,
        displayName,
        protocolPolicy,
        protocolProfile: protocolPolicy === 'PIN' ? protocolProfile : null,
        transport: buildTransport() as McpServerUpdateRequest['transport'],
        credentialRef: credentialRef.trim().length > 0 ? credentialRef.trim() : null,
        oauthClientId: oauthClientId.trim().length > 0 ? oauthClientId.trim() : null
      };
      return unwrap(await window.codeAgentDesktop.updateMcpServer(server.serverId ?? '', request)) as McpServerDetailResponse;
    },
    onSuccess: () => {
      resetForm();
      void queryClient.invalidateQueries({ queryKey: ['mcp-governed'] });
    },
    onError: (err) => setError(message(err))
  });

  const statusM = useMutation({
    mutationFn: async (input: { serverId: string; enabled: boolean; expectedRevision: number }) => {
      return unwrap(await window.codeAgentDesktop.setMcpServerStatus(input.serverId, {
        enabled: input.enabled,
        expectedRevision: input.expectedRevision
      })) as McpServerDetailResponse;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['mcp-governed'] }),
    onError: (err) => setError(message(err))
  });

  const actionM = useMutation({
    mutationFn: async (input: { serverId: string; action: 'CONNECT' | 'TEST' | 'DISCONNECT' | 'RESTART' | 'DIAGNOSE' }) => {
      return unwrap(await window.codeAgentDesktop.requestMcpConnectionAction(input.serverId, input.action)) as McpOperationResponse;
    },
    onSuccess: async (op, input) => {
      setOperationId(op.operationId ?? null);
      setDiagnoseFor(input.action === 'DIAGNOSE' ? op.operationId ?? null : null);
      void queryClient.invalidateQueries({ queryKey: ['mcp-governed'] });
      void queryClient.invalidateQueries({ queryKey: ['mcp-tools', selected] });
    },
    onError: (err) => setError(message(err))
  });

  const authM = useMutation({
    mutationFn: async (input: { serverId: string; action: 'START' | 'CANCEL' | 'REVOKE' }) => {
      const response = unwrap(await window.codeAgentDesktop.requestMcpAuthAction(
        input.serverId, input.action)) as McpAuthActionResponse;
      // Consent happens in the system browser — the renderer never sees tokens.
      if (input.action === 'START' && response.loginUrl) {
        await window.codeAgentDesktop.openExternalHttps(response.loginUrl);
      }
      return response;
    },
    onSuccess: (response) => {
      if (response.operationId) setOperationId(response.operationId);
      setDiagnoseFor(null);
      void queryClient.invalidateQueries({ queryKey: ['mcp-governed'] });
    },
    onError: (err) => setError(message(err))
  });

  const promptResolveM = useMutation({
    mutationFn: async (input: { name: string; arguments_: Record<string, string> }) => {
      if (!selected) throw new Error('NO_SERVER');
      return unwrap(await window.codeAgentDesktop.resolveMcpPrompt(selected, {
        name: input.name,
        arguments: Object.keys(input.arguments_).length > 0 ? input.arguments_ : null
      })) as McpPromptResolveResponse;
    },
    onSuccess: (response, input) => {
      setPromptResult({ name: input.name, response });
      setError(null);
    },
    onError: (err) => setError(message(err))
  });
  const [promptResolveFor, setPromptResolveFor] = useState<string | null>(null);
  const [promptArgValues, setPromptArgValues] = useState<Record<string, string>>({});
  const [promptResult, setPromptResult] = useState<{ name: string; response: McpPromptResolveResponse } | null>(null);

  const refreshM = useMutation({
    mutationFn: async (serverId: string) => {
      return unwrap(await window.codeAgentDesktop.refreshMcpServerCatalog(serverId)) as McpOperationResponse;
    },
    onSuccess: (op) => {
      setOperationId(op.operationId ?? null);
      setDiagnoseFor(null);
      void queryClient.invalidateQueries({ queryKey: ['mcp-tools', selected] });
    },
    onError: (err) => setError(message(err))
  });

  if (props.enabled === false) {
    return <div className="mcp-panel" data-testid="mcp-governed-panel"><div className="visible-output-header">MCP 受管服务器</div><div className="run-meta">扩展宿主未装配。</div></div>;
  }

  const editingServer = editing == null ? null
    : (servers.data ?? []).find((server) => server.serverId === editing) ?? null;
  const isHttp = transportKind === 'STREAMABLE_HTTP';
  const formReady = displayName.trim().length > 0
    && (isHttp ? endpoint.trim().length > 0 : executable.trim().length > 0);

  return (
    <div className="mcp-panel" data-testid="mcp-governed-panel">
      <div className="visible-output-header">MCP 受管服务器（配置/生命周期由宿主执行）</div>
      {notWired ? (
        <div className="run-meta" data-testid="mcp-governed-nowired">扩展宿主未装配（EXT_HOST_NOT_WIRED）。</div>
      ) : (
        <>
          {/* WU01: Hub associations feed managed MCP; direct registrations stay below. */}
          <HubConnectionsPanel />
          {(servers.data ?? []).map((server) => {
            const connState = server.connectionState ?? '';
            return (
              <div
                key={server.serverId ?? ''}
                className={`mcp-server-card${selected === server.serverId ? ' is-selected' : ''}`}
                data-testid="mcp-governed-record"
                role="button"
                tabIndex={0}
                onClick={() => setSelected(server.serverId ?? null)}
                onKeyDown={(event) => {
                  // Inner buttons keep their own activation — only a press
                  // directly on the card body selects the server.
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelected(server.serverId ?? null);
                  }
                }}
              >
                <div className="mcp-server-head">
                  <span className="mcp-server-name">{server.displayName}</span>
                  {connState ? (
                    <span className={`status-pill ${mcpConnectionTone(connState)}`} title={connState}>
                      {MCP_CONNECTION_STATE_LABELS[connState] ?? connState}
                    </span>
                  ) : null}
                  {server.connectionMode === 'HUB' ? (
                    <span className="status-pill tone-info" data-testid="mcp-hub-source"
                      title={server.hubConnectionId ? `Hub 关联 ${server.hubConnectionId}` : 'Hub 受管'}>
                      Hub
                    </span>
                  ) : null}
                  {!server.enabled ? <span className="status-pill tone-neutral">已停用</span> : null}
                </div>
                <div className="mcp-server-meta">
                  <code>{server.serverId}</code>
                  <span>{server.transportKind}</span>
                  {server.connectionMode === 'HUB' && server.hubConnectionId ? (
                    <span>关联 <code>{server.hubConnectionId}</code></span>
                  ) : null}
                  <span>工具 {server.toolCount ?? 0}</span>
                  <span>rev {server.revision ?? '?'}</span>
                  {server.stateReason ? <span className="mcp-server-reason">{server.stateReason}</span> : null}
                </div>
                <div className="mcp-server-actions">
                  {server.enabled ? (
                    <button type="button" className="secondary-button small" data-testid="mcp-disable"
                      onClick={(event) => { event.stopPropagation(); statusM.mutate({ serverId: server.serverId ?? '', enabled: false, expectedRevision: server.revision ?? 1 }); }}>
                      停用
                    </button>
                  ) : (
                    <button type="button" className="secondary-button small" data-testid="mcp-enable"
                      onClick={(event) => { event.stopPropagation(); statusM.mutate({ serverId: server.serverId ?? '', enabled: true, expectedRevision: server.revision ?? 1 }); }}>
                      启用
                    </button>
                  )}
                  <button type="button" className="secondary-button small" data-testid="mcp-connect"
                    onClick={(event) => { event.stopPropagation(); actionM.mutate({ serverId: server.serverId ?? '', action: 'CONNECT' }); }}>
                    连接
                  </button>
                  <button type="button" className="secondary-button small" data-testid="mcp-test"
                    onClick={(event) => { event.stopPropagation(); actionM.mutate({ serverId: server.serverId ?? '', action: 'TEST' }); }}>
                    测试
                  </button>
                  <button type="button" className="secondary-button small" data-testid="mcp-diagnose"
                    onClick={(event) => { event.stopPropagation(); actionM.mutate({ serverId: server.serverId ?? '', action: 'DIAGNOSE' }); }}>
                    诊断
                  </button>
                  {server.transportKind === 'STREAMABLE_HTTP' ? (
                    <>
                      <button type="button" className="secondary-button small" data-testid="mcp-auth-start"
                        onClick={(event) => { event.stopPropagation(); authM.mutate({ serverId: server.serverId ?? '', action: 'START' }); }}>
                        {server.connectionState === 'AUTH_REQUIRED' ? '授权' : '重新授权'}
                      </button>
                      <button type="button" className="secondary-button small" data-testid="mcp-auth-revoke"
                        onClick={(event) => { event.stopPropagation(); authM.mutate({ serverId: server.serverId ?? '', action: 'REVOKE' }); }}>
                        吊销
                      </button>
                    </>
                  ) : null}
                  <button type="button" className="secondary-button small" data-testid="mcp-edit"
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditing(server.serverId ?? null);
                      setDisplayName(server.displayName ?? '');
                      setTransportKind(server.transportKind === 'STREAMABLE_HTTP' ? 'STREAMABLE_HTTP' : 'STDIO');
                    }}>
                    编辑
                  </button>
                  <button type="button" className="secondary-button small" data-testid="mcp-refresh"
                    onClick={(event) => { event.stopPropagation(); refreshM.mutate(server.serverId ?? ''); }}>
                    刷新目录
                  </button>
                </div>
              </div>
            );
          })}
          {servers.data?.length === 0 ? <p className="mcp-empty">未配置受管服务器。</p> : null}
          {operation.data ? (
            <div className="mcp-notice" data-testid="mcp-operation">
              <span
                className={`status-pill ${mcpOperationTone(operation.data.status)}`}
                title={operation.data.status ?? undefined}
              >
                {MCP_OPERATION_STATUS_LABELS[operation.data.status ?? ''] ?? operation.data.status}
              </span>
              <span className="mcp-notice-text">
                操作 <code>{operation.data.operationId}</code> · {operation.data.kind}
                {operation.data.detail && diagnose == null ? ` · ${operation.data.detail}` : ''}
                {operation.data.status === 'RUNNING' ? ' · 轮询中…' : ''}
              </span>
            </div>
          ) : null}
          {diagnose ? (
            <div className="mcp-findings" data-testid="mcp-diagnose-findings">
              <div className="visible-output-header">依赖诊断</div>
              {diagnose.map((finding, index) => (
                <div key={index} className="mcp-finding" data-testid="mcp-diagnose-finding">
                  <span className={`status-pill ${mcpFindingTone(finding.status)}`} title={finding.status ?? undefined}>
                    {finding.status}
                  </span>
                  <code>{finding.item}</code>
                  <span>{finding.detail}</span>
                </div>
              ))}
            </div>
          ) : null}
          {selected ? (
            <div className="mcp-detail" data-testid="mcp-tool-list">
              <div className="mcp-tabs" role="tablist" aria-label="服务器目录">
                <button type="button" role="tab" aria-selected={detailTab === 'tools'} data-testid="mcp-tab-tools"
                  className={`mcp-tab${detailTab === 'tools' ? ' is-active' : ''}`}
                  onClick={() => setDetailTab('tools')}>工具目录</button>
                <button type="button" role="tab" aria-selected={detailTab === 'prompts'} data-testid="mcp-tab-prompts"
                  className={`mcp-tab${detailTab === 'prompts' ? ' is-active' : ''}`}
                  onClick={() => setDetailTab('prompts')}>Prompts</button>
                <button type="button" role="tab" aria-selected={detailTab === 'templates'} data-testid="mcp-tab-templates"
                  className={`mcp-tab${detailTab === 'templates' ? ' is-active' : ''}`}
                  onClick={() => setDetailTab('templates')}>资源模板</button>
              </div>
              {detailTab === 'tools' ? (
                <>
                  <div className="mcp-detail-title">工具目录 · <code>{selected}</code></div>
                  <ul className="mcp-record-list">
                    {(tools.data ?? []).map((tool) => (
                      <li key={tool.toolId ?? ''} className="mcp-record" data-testid="mcp-tool">
                        <code className="mcp-record-id">{tool.toolId}</code>
                        <span className="mcp-record-name">{tool.title ?? tool.rawName ?? ''}</span>
                        <span className={`status-pill ${mcpToolRiskTone(tool.effectiveRisk)}`} title={tool.effectiveRisk ?? undefined}>
                          {MCP_TOOL_RISK_LABELS[tool.effectiveRisk ?? ''] ?? tool.effectiveRisk ?? 'NORMAL'}
                        </span>
                        {tool.availability === 'AVAILABLE' ? (
                          <button type="button" className="secondary-button small mcp-record-action" data-testid="mcp-tool-test"
                            disabled={testM.isPending}
                            onClick={() => testM.mutate({ serverId: selected, toolId: tool.toolId ?? '' })}>
                            测试调用
                          </button>
                        ) : (
                          <span className="status-pill tone-neutral" data-testid="mcp-tool-unavailable"
                            title={tool.availabilityReason ?? tool.availability ?? undefined}>
                            {MCP_TOOL_AVAILABILITY_LABELS[tool.availability ?? ''] ?? tool.availability ?? '未知'}
                            {tool.availabilityReason ? ` · ${tool.availabilityReason}` : ''}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {tools.data?.length === 0 ? <p className="mcp-empty">该服务器暂无已缓存工具（先连接并刷新目录）。</p> : null}
                  {testResult ? (
                    <div className="mcp-notice" data-testid="mcp-tool-test-result">
                      <span className="mcp-notice-text">
                        测试执行 <code>{testResult.executionId ?? ''}</code> · {testResult.status ?? '已提交'}
                        {testResult.bindingId ? <> · 绑定 <code>{testResult.bindingId}</code></> : null}
                      </span>
                    </div>
                  ) : null}
                </>
              ) : null}
              {detailTab === 'prompts' ? (
                <>
                  <div className="mcp-detail-title">Prompts · <code>{selected}</code></div>
                  <ul className="mcp-record-list">
                    {(prompts.data?.items ?? []).map((prompt, index) => (
                      <li key={prompt.name ?? index} className="mcp-record" data-testid="mcp-prompt">
                        <code className="mcp-record-id">{prompt.name}</code>
                        <span className="mcp-record-name">{prompt.title ?? ''}</span>
                        {prompt.description ? <span className="mcp-record-detail">{prompt.description}</span> : null}
                        {prompt.name ? (
                          <>
                            <button
                              type="button"
                              className="secondary-button"
                              data-testid={`mcp-prompt-resolve-${prompt.name}`}
                              onClick={() => {
                                setPromptResolveFor((current) => current === prompt.name ? null : (prompt.name ?? null));
                                setPromptArgValues({});
                                setPromptResult(null);
                              }}
                            >解析</button>
                            {promptResolveFor === prompt.name ? (
                              <div className="mcp-prompt-resolve" data-testid="mcp-prompt-resolve-form">
                                {(prompt.arguments ?? []).length === 0 ? (
                                  <span className="run-meta">该 prompt 无参数，直接解析。</span>
                                ) : (prompt.arguments ?? []).map((arg) => (
                                  <label key={arg.name} className="mcp-prompt-arg">
                                    <span>{arg.name}{arg.required ? ' *' : ''}{arg.description ? ` — ${arg.description}` : ''}</span>
                                    <input
                                      value={promptArgValues[arg.name ?? ''] ?? ''}
                                      aria-label={`参数 ${arg.name}`}
                                      onChange={(event) => setPromptArgValues((current) => ({ ...current, [arg.name ?? '']: event.target.value }))}
                                    />
                                  </label>
                                ))}
                                <button
                                  type="button"
                                  className="secondary-button"
                                  data-testid="mcp-prompt-resolve-submit"
                                  disabled={promptResolveM.isPending
                                    || (prompt.arguments ?? []).some((arg) => arg.required && !(promptArgValues[arg.name ?? ''] ?? '').trim())}
                                  onClick={() => {
                                    if (!prompt.name) return;
                                    const args = Object.fromEntries(
                                      Object.entries(promptArgValues).filter(([, value]) => value.trim().length > 0)
                                    );
                                    promptResolveM.mutate({ name: prompt.name, arguments_: args });
                                  }}
                                >{promptResolveM.isPending ? '解析中…' : '执行解析'}</button>
                              </div>
                            ) : null}
                            {promptResult?.name === prompt.name ? (
                              <div className="mcp-prompt-result" data-testid="mcp-prompt-result">
                                {(promptResult.response.blocks ?? []).map((block, blockIndex) => (
                                  <pre key={blockIndex} className="mcp-prompt-block">{block.text ?? `[${block.kind ?? 'BLOCK'}] ${block.artifactRef ?? ''}`}</pre>
                                ))}
                                {(promptResult.response.blocks ?? []).length === 0 ? <span className="run-meta">解析返回空内容。</span> : null}
                                {promptResult.response.provenance ? <span className="run-meta">来源：{promptResult.response.provenance}</span> : null}
                              </div>
                            ) : null}
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {(prompts.data?.items ?? []).length === 0 ? (
                    <p className="mcp-empty">该服务器没有 prompt（或目录未刷新）。</p>
                  ) : null}
                </>
              ) : null}
              {detailTab === 'templates' ? (
                <>
                  <div className="mcp-detail-title">资源模板 · <code>{selected}</code></div>
                  <ul className="mcp-record-list">
                    {(templates.data?.items ?? []).map((template, index) => (
                      <li key={template.uriTemplate ?? index} className="mcp-record" data-testid="mcp-resource-template">
                        <code className="mcp-record-id">{template.uriTemplate}</code>
                        <span className="mcp-record-name">{template.name ?? ''}</span>
                        {template.description ? <span className="mcp-record-detail">{template.description}</span> : null}
                      </li>
                    ))}
                  </ul>
                  {(templates.data?.items ?? []).length === 0 ? (
                    <p className="mcp-empty">该服务器没有资源模板。</p>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
          <div className="mcp-form" data-testid="mcp-create-form">
            <div className="mcp-form-title">
              {editingServer
                ? <>修改 <code>{editingServer.serverId}</code>（PATCH：重新填写完整 transport；rev {editingServer.revision ?? '?'}）</>
                : '注册 MCP 服务器（凭证字段只填槽名，不填值）'}
            </div>
            {!editingServer ? (
              <label className="settings-field">
                <span>模板</span>
                <select value={templateRef} onChange={(event) => applyTemplate(event.target.value)} data-testid="mcp-template">
                  <option value="">自定义</option>
                  {MCP_SERVER_TEMPLATES.map((template) => (
                    <option key={template.templateRef} value={template.templateRef}>{template.label}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {templateRef ? (
              <p className="settings-field-hint" data-testid="mcp-template-note">
                {MCP_SERVER_TEMPLATES.find((item) => item.templateRef === templateRef)?.note}
              </p>
            ) : null}
            <div className="settings-field-grid">
              <label className="settings-field">
                <span>名称</span>
                <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} data-testid="mcp-name" />
              </label>
              <label className="settings-field">
                <span>传输</span>
                <select value={transportKind} onChange={(event) => setTransportKind(event.target.value as 'STDIO' | 'STREAMABLE_HTTP')} data-testid="mcp-transport">
                  <option value="STDIO">STDIO（本地子进程）</option>
                  <option value="STREAMABLE_HTTP">STREAMABLE_HTTP（远程）</option>
                </select>
              </label>
              {isHttp ? (
                <>
                  <label className="settings-field mcp-field-span">
                    <span>端点</span>
                    <input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://host/mcp" data-testid="mcp-endpoint" />
                  </label>
                  <label className="settings-field-inline mcp-field-span">
                    <input type="checkbox" checked={allowInsecureLoopback} onChange={(event) => setAllowInsecureLoopback(event.target.checked)} data-testid="mcp-loopback" />
                    允许 http://127.0.0.1 回环（仅此场景可用纯 HTTP）
                  </label>
                  <label className="settings-field">
                    <span>凭据槽名（Bearer/API-Key 槽名，不是值）</span>
                    <input value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} data-testid="mcp-credential-ref" />
                  </label>
                  <label className="settings-field">
                    <span>OAuth 客户端 ID（预注册公共客户端）</span>
                    <input value={oauthClientId} onChange={(event) => setOauthClientId(event.target.value)} data-testid="mcp-oauth-client" />
                  </label>
                </>
              ) : (
                <>
                  <label className="settings-field">
                    <span>可执行文件</span>
                    <input value={executable} onChange={(event) => setExecutable(event.target.value)} placeholder="例如 npx 或绝对路径" data-testid="mcp-executable" />
                  </label>
                  <label className="settings-field">
                    <span>工作目录</span>
                    <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="可选" data-testid="mcp-cwd" />
                  </label>
                  <label className="settings-field mcp-field-span">
                    <span>参数（每行一个；含空格的路径不会被拆开）</span>
                    <textarea value={argsText} onChange={(event) => setArgsText(event.target.value)}
                      placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:\\allowed'} rows={3} data-testid="mcp-args" />
                  </label>
                  <label className="settings-field mcp-field-span">
                    <span>环境槽名</span>
                    <input value={envRefs} onChange={(event) => setEnvRefs(event.target.value)} placeholder="逗号/空格分隔的槽名，不是值" data-testid="mcp-envrefs" />
                  </label>
                </>
              )}
              <label className="settings-field">
                <span>协议策略</span>
                <select value={protocolPolicy} onChange={(event) => setProtocolPolicy(event.target.value as 'AUTO' | 'PIN')} data-testid="mcp-protocol-policy">
                  <option value="AUTO">AUTO（探测协商）</option>
                  <option value="PIN">PIN（固定版本）</option>
                </select>
              </label>
              {protocolPolicy === 'PIN' ? (
                <label className="settings-field">
                  <span>协议版本</span>
                  <select value={protocolProfile} onChange={(event) => setProtocolProfile(
                    event.target.value as 'LEGACY_2024_11_05' | 'LEGACY_2025_11_25' | 'MODERN_2026_07_28')} data-testid="mcp-protocol-profile">
                    <option value="LEGACY_2024_11_05">2024-11-05（stdio 旧版）</option>
                    <option value="LEGACY_2025_11_25">2025-11-25（含 HTTP session）</option>
                    <option value="MODERN_2026_07_28">2026-07-28（modern，验收 gate）</option>
                  </select>
                </label>
              ) : null}
            </div>
            <div className="mcp-form-actions">
              <button type="button" className="primary-button" data-testid="mcp-create-submit"
                disabled={(editingServer ? updateM.isPending : createM.isPending) || !formReady}
                onClick={() => (editingServer ? updateM.mutate(editingServer) : createM.mutate())}>
                {editingServer ? '保存修改' : '注册服务器'}
              </button>
              {editingServer ? (
                <button type="button" className="secondary-button" data-testid="mcp-edit-cancel" onClick={resetForm}>取消修改</button>
              ) : null}
            </div>
          </div>
        </>
      )}
      {error ? <div className="mcp-error" role="alert" data-testid="mcp-governed-error">{error}</div> : null}
    </div>
  );
}

// ---------------- Skill package import + governance ----------------

export function SkillImportPanel(props: { enabled?: boolean } = {}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<SkillImportSourceResponse | null>(null);
  const [preview, setPreview] = useState<SkillImportPreviewResponse | null>(null);
  const [scope, setScope] = useState<'USER' | 'PROJECT'>('USER');
  const [projectAlias, setProjectAlias] = useState('');
  const [imported, setImported] = useState<SkillRecordResponse | null>(null);
  const [versions, setVersions] = useState<SkillVersionListResponse | null>(null);
  const [manifestFor, setManifestFor] = useState<string | null>(null);
  const [manifest, setManifest] = useState<string | null>(null);

  const pickM = useMutation({
    mutationFn: async () => {
      return unwrap(await window.codeAgentDesktop.pickSkillImportSource(null)) as SkillImportSourceResponse;
    },
    onSuccess: async (created) => {
      setSource(created);
      setPreview(null);
      setImported(null);
      if (created.sourceHandle) {
        try {
          const shown = unwrap(await window.codeAgentDesktop.previewSkillImport(created.sourceHandle)) as SkillImportPreviewResponse;
          setPreview(shown);
        } catch (err) {
          setError(message(err));
        }
      }
    },
    onError: (err) => setError(message(err))
  });

  const importM = useMutation({
    mutationFn: async () => {
      return unwrap(await window.codeAgentDesktop.importSkillPackage({
        previewId: preview?.previewId ?? '',
        expectedSourceDigest: preview?.sourceDigest ?? '',
        scope,
        projectAlias: scope === 'PROJECT' ? projectAlias : null,
        name: null
      })) as SkillRecordResponse;
    },
    onSuccess: (record) => {
      setImported(record);
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => setError(message(err))
  });

  const versionsM = useMutation({
    mutationFn: async (skillId: string) => {
      return unwrap(await window.codeAgentDesktop.listSkillVersions(skillId)) as SkillVersionListResponse;
    },
    onSuccess: (list) => setVersions(list),
    onError: (err) => setError(message(err))
  });

  const manifestM = useMutation({
    mutationFn: async (input: { skillId: string; versionDigest: string }) => {
      return unwrap(await window.codeAgentDesktop.getSkillManifest(
        input.skillId, input.versionDigest)) as { manifest?: unknown };
    },
    onSuccess: (response, input) => {
      setManifestFor(input.versionDigest);
      setManifest(JSON.stringify(response, null, 2));
    },
    onError: (err) => setError(message(err))
  });

  const selectM = useMutation({
    mutationFn: async (input: { skillId: string; versionDigest: string; expectedRevision: number }) => {
      return unwrap(await window.codeAgentDesktop.selectSkillVersion(input.skillId, {
        versionDigest: input.versionDigest,
        expectedRevision: input.expectedRevision
      })) as SkillRecordResponse;
    },
    onSuccess: (record) => {
      setImported(record);
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (err) => setError(message(err))
  });

  const statusM = useMutation({
    mutationFn: async (input: { skillId: string; status: 'ACTIVE' | 'DISABLED'; expectedRevision: number }) => {
      return unwrap(await window.codeAgentDesktop.changeSkillStatus(input.skillId, {
        status: input.status, expectedRevision: input.expectedRevision
      })) as SkillRecordResponse;
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['skills'] }),
    onError: (err) => setError(message(err))
  });

  if (props.enabled === false) {
    return <div className="mcp-panel" data-testid="skill-import-panel"><div className="visible-output-header">Skill 包导入</div><div className="run-meta">扩展宿主未装配。</div></div>;
  }

  const entry = preview?.entries?.[0] ?? null;
  return (
    <div className="mcp-panel" data-testid="skill-import-panel">
      <div className="visible-output-header">Skill 包导入（扫描/存储在宿主内执行）</div>
      <div>
        <button type="button" className="secondary-button" data-testid="skill-import-pick" disabled={pickM.isPending}
          onClick={() => pickM.mutate()}>
          选择 Skill 目录…
        </button>
      </div>
      {preview ? (
        <div className="mcp-preview" data-testid="skill-import-preview">
          <div className="mcp-preview-head">
            <span className="mcp-record-name">预览 · {entry?.name ?? '未命名'}</span>
            <span className="mcp-server-meta">
              {entry?.fileCount ?? 0} 个文件 · {entry?.totalBytes ?? 0} B
              · digest <code>{preview.sourceDigest?.slice(0, 19)}…</code>
            </span>
          </div>
          {entry?.description ? <p className="mcp-empty">{entry.description}</p> : null}
          {(entry?.scriptPaths ?? []).map((script: string) => (
            <div key={script} className="run-meta" data-testid="skill-script">脚本：<code>{script}</code></div>
          ))}
          {(entry?.permissionHints ?? []).map((hint: string) => (
            <div key={hint} className="run-meta" data-testid="skill-permission-hint">权限提示：{hint}</div>
          ))}
          {(entry?.diagnostics ?? []).map((diag: { severity?: string | null; code?: string | null; message?: string | null }, index: number) => (
            <div key={index} className="run-meta" data-testid="skill-diagnostic">
              {diag.severity}: {diag.message}
            </div>
          ))}
          <div className="mcp-form">
            <div className="settings-field-grid">
              <label className="settings-field">
                <span>作用域</span>
                <select value={scope} onChange={(event) => setScope(event.target.value as 'USER' | 'PROJECT')} data-testid="skill-import-scope">
                  <option value="USER">USER</option>
                  <option value="PROJECT">PROJECT</option>
                </select>
              </label>
              {scope === 'PROJECT' ? (
                <label className="settings-field">
                  <span>项目别名</span>
                  <input value={projectAlias} onChange={(event) => setProjectAlias(event.target.value)} data-testid="skill-import-project" />
                </label>
              ) : null}
            </div>
            <div className="mcp-form-actions">
              <button type="button" className="primary-button" data-testid="skill-import-submit" disabled={importM.isPending}
                onClick={() => importM.mutate()}>
                导入（保持 DISABLED，显式启用后才可用）
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {imported ? (
        <div className="mcp-preview" data-testid="skill-imported">
          <div className="mcp-preview-head">
            <span className="mcp-record-name">已导入 {imported.name}</span>
            <span className="mcp-server-meta">
              <code>{imported.skillId}</code> · {imported.status} · rev {imported.revision}
            </span>
          </div>
          <div className="mcp-server-actions">
            {imported.status === 'DISABLED' ? (
              <button type="button" className="secondary-button small" data-testid="skill-imported-enable"
                onClick={() => statusM.mutate({ skillId: imported.skillId ?? '', status: 'ACTIVE', expectedRevision: imported.revision ?? 1 })}>
                显式启用（信任此包）
              </button>
            ) : null}
            <button type="button" className="secondary-button small" data-testid="skill-versions-load"
              onClick={() => versionsM.mutate(imported.skillId ?? '')}>
              查看版本
            </button>
          </div>
          <ul className="mcp-record-list">
            {(versions?.items ?? []).map((version) => {
              const digest = version.packageDigest ?? version.versionId ?? '';
              return (
                <li key={version.versionId ?? ''} className="mcp-record mcp-record-block" data-testid="skill-version">
                  <code className="mcp-record-id">{version.versionId}</code>
                  <span className="mcp-server-meta">
                    digest {digest.slice(0, 19)}… · {version.format ?? ''} · {version.fileCount ?? 0} 文件
                  </span>
                  <span className="mcp-server-actions">
                    <button type="button" className="secondary-button small" data-testid="skill-version-select"
                      onClick={() => selectM.mutate({
                        skillId: imported.skillId ?? '',
                        versionDigest: digest,
                        expectedRevision: imported.revision ?? 1
                      })}>
                      钉为新执行版本
                    </button>
                    <button type="button" className="secondary-button small" data-testid="skill-manifest"
                      disabled={manifestM.isPending}
                      onClick={() => manifestM.mutate({ skillId: imported.skillId ?? '', versionDigest: digest })}>
                      查看清单
                    </button>
                  </span>
                  {manifestFor === digest && manifest ? (
                    <pre className="mcp-manifest" data-testid="skill-manifest-view">{manifest}</pre>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {error ? <div className="mcp-error" role="alert" data-testid="skill-import-error">{error}</div> : null}
    </div>
  );
}

// ---------------- Execution evidence ----------------

export function ExtensionEvidencePanel(props: { enabled?: boolean } = {}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [executionId, setExecutionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [resumeFor, setResumeFor] = useState<string | null>(null);
  const [resumeInput, setResumeInput] = useState('');

  const binding = useQuery({
    queryKey: ['execution-extensions', executionId],
    enabled: executionId.trim().length > 0,
    queryFn: async () => {
      try {
        const result = unwrap(await window.codeAgentDesktop.getExecutionExtensions(executionId.trim())) as ExecutionExtensionsResponse;
        setError(null);
        return result;
      } catch (err) {
        setError(message(err));
        return null;
      }
    }
  });

  const invocations = useQuery({
    queryKey: ['extension-invocations', executionId, cursor],
    enabled: executionId.trim().length > 0,
    refetchInterval: (query) => {
      const items = (query.state.data as ExtensionInvocationListResponse | undefined)?.items ?? [];
      return items.some((item) => item.state != null && !TERMINAL_INVOCATION_STATES.has(item.state))
        ? 2000 : false;
    },
    queryFn: async () => {
      try {
        return unwrap(await window.codeAgentDesktop.listExtensionInvocations(
          executionId.trim(), { cursor: cursor ?? undefined, limit: 50 })) as ExtensionInvocationListResponse;
      } catch {
        return { items: [], nextCursor: null } as ExtensionInvocationListResponse;
      }
    }
  });

  const actionM = useMutation({
    mutationFn: async (input: { invocationId: string; body: ExtensionInvocationActionRequest }) => {
      return unwrap(await window.codeAgentDesktop.requestExtensionInvocationAction(
        executionId.trim(), input.invocationId, input.body)) as ExtensionInvocationView;
    },
    onSuccess: () => {
      setResumeFor(null);
      setResumeInput('');
      void queryClient.invalidateQueries({ queryKey: ['extension-invocations', executionId] });
    },
    onError: (err) => setError(message(err))
  });

  if (props.enabled === false) {
    return <div className="mcp-panel" data-testid="extension-evidence-panel"><div className="visible-output-header">扩展执行证据</div><div className="run-meta">扩展宿主未装配。</div></div>;
  }

  const bound = binding.data?.binding ?? null;
  const calls = invocations.data?.items ?? [];
  const nextCursor = invocations.data?.nextCursor ?? null;
  return (
    <div className="mcp-panel" data-testid="extension-evidence-panel">
      <div className="visible-output-header">扩展执行证据（绑定 + 调用记录）</div>
      <label className="settings-field">
        <span>执行 ID</span>
        <input value={executionId} onChange={(event) => { setExecutionId(event.target.value); setCursor(null); }}
          placeholder="run-* 或 chat-*" data-testid="evidence-execution-id" />
      </label>
      {bound ? (
        <div className="mcp-notice" data-testid="evidence-binding">
          <span className="mcp-notice-text">
            绑定 <code>{bound.bindingId}</code> · rev {bound.revision} · <code>{bound.snapshotDigest?.slice(0, 19)}…</code>
            {(bound.servers ?? []).length > 0 ? ` · 服务器 ${(bound.servers ?? []).map((server) => server.serverId).join(', ')}` : ''}
            {(bound.skills ?? []).length > 0 ? ` · 技能 ${(bound.skills ?? []).map((skill) => `${skill.skillId}(${skill.state ?? '?'})`).join(', ')}` : ''}
          </span>
        </div>
      ) : null}
      {calls.length > 0 ? (
        <ul className="mcp-record-list">
          {calls.map((call) => {
            const terminal = call.state == null || TERMINAL_INVOCATION_STATES.has(call.state);
            const waitingInput = call.state === 'WAITING_INPUT';
            const uncertain = call.state === 'UNKNOWN' || call.effectOutcome === 'POSSIBLE';
            const metaParts = [
              call.effectOutcome === 'POSSIBLE' ? '效果未知(POSSIBLE)' : null,
              call.approvalId ? `审批 ${call.approvalId}` : null,
              call.errorCode ?? null,
              call.attempts != null && call.attempts > 1 ? `尝试 ${call.attempts}` : null
            ].filter((part): part is string => part != null);
            return (
              <li key={call.invocationId ?? ''} className="mcp-record mcp-record-block" data-testid="evidence-invocation">
                <code className="mcp-record-id">{call.invocationId}</code>
                <span className="mcp-record-name">{call.target?.toolId ?? call.target?.skillId ?? '?'}</span>
                {call.state ? (
                  <span className={`status-pill ${invocationTone(call.state)}`}>{call.state}</span>
                ) : null}
                {metaParts.length > 0 ? <span className="mcp-server-meta">{metaParts.join(' · ')}</span> : null}
                <span className="mcp-server-actions">
                  {!terminal ? (
                    <button type="button" className="secondary-button small" data-testid="invocation-cancel"
                      onClick={() => actionM.mutate({ invocationId: call.invocationId ?? '', body: { action: 'CANCEL' } })}>
                      取消
                    </button>
                  ) : null}
                  {waitingInput ? (
                    <button type="button" className="secondary-button small" data-testid="invocation-resume"
                      onClick={() => setResumeFor(resumeFor === call.invocationId ? null : call.invocationId ?? null)}>
                      提交输入
                    </button>
                  ) : null}
                  {uncertain ? (
                    <button type="button" className="secondary-button small" data-testid="invocation-reconcile"
                      onClick={() => actionM.mutate({ invocationId: call.invocationId ?? '', body: { action: 'RECONCILE' } })}>
                      对账
                    </button>
                  ) : null}
                </span>
                {resumeFor === call.invocationId ? (
                  <span className="mcp-form-inline" data-testid="invocation-resume-form">
                    <input value={resumeInput} onChange={(event) => setResumeInput(event.target.value)}
                      placeholder='输入答复文本或 JSON，例如 {"answer":"是"}' data-testid="invocation-resume-input" />
                    <button type="button" className="primary-button" data-testid="invocation-resume-submit"
                      disabled={actionM.isPending}
                      onClick={() => {
                        let input: Record<string, unknown>;
                        try {
                          const parsed = JSON.parse(resumeInput) as unknown;
                          input = parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
                            ? parsed as Record<string, unknown> : { answer: parsed };
                        } catch {
                          input = { answer: resumeInput };
                        }
                        actionM.mutate({
                          invocationId: call.invocationId ?? '',
                          body: { action: 'RESUME_INPUT', input: input as ExtensionInvocationActionRequest['input'] }
                        });
                      }}>
                      恢复调用
                    </button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {nextCursor ? (
        <div>
          <button type="button" className="secondary-button small" data-testid="evidence-more"
            onClick={() => setCursor(nextCursor)}>
            加载更多（nextCursor）
          </button>
        </div>
      ) : null}
      {executionId.trim().length > 0 && !bound && calls.length === 0 && !binding.isFetching ? (
        <p className="mcp-empty">该执行没有扩展绑定/调用记录。</p>
      ) : null}
      {error ? <div className="mcp-error" role="alert" data-testid="evidence-error">{error}</div> : null}
    </div>
  );
}
