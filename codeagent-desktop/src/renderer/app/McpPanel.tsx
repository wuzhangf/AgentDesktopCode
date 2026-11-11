import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { unwrap } from './queries';

/**
 * EW10.3 read-only MCP source panel (design §10.6). Servers come from the
 * service-side allowlist; the panel only lists and reads resources, marks
 * every payload untrusted and renders content as plain text — never as
 * HTML or markdown, and never elevates it toward system authority.
 */

interface McpServerLike {
  serverId?: string | null;
  status?: string | null;
  reason?: string | null;
  resourceCount?: number | null;
}

interface McpResourceLike {
  uri?: string | null;
  name?: string | null;
  mimeType?: string | null;
  description?: string | null;
}

interface McpResourceContentLike {
  serverId?: string | null;
  uri?: string | null;
  mimeType?: string | null;
  contentText?: string | null;
  contentBytes?: number | null;
  truncated?: boolean | null;
  untrustedContent?: boolean | null;
  fetchedAt?: string | null;
}

/** Bounded display/attachment name derived from the resource URI only. */
function resourceAttachmentName(uri: string, mimeType: string | null | undefined): string {
  const extension = mimeType === 'text/markdown' ? '.md' : '.txt';
  try {
    const parsed = new URL(uri);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    const base = (lastSegment || parsed.hostname).replace(/[^\w.-]+/g, '_').slice(0, 72);
    return base.length > 0 ? base + extension : 'resource' + extension;
  } catch {
    return 'resource' + extension;
  }
}

export function McpPanel(props: {
  onAttach: (attachment: { name: string; mediaType: string; text: string }) => void;
  enabled?: boolean;
}): React.JSX.Element {
  const [serverId, setServerId] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<McpResourceContentLike | null>(null);

  const servers = useQuery({
    queryKey: ['mcp-servers'],
    enabled: props.enabled ?? true,
    queryFn: async () => {
      try {
        const result = unwrap(
          await window.codeAgentDesktop.listMcpServers()
        ) as McpServerLike[];
        setDisabled(false);
        setError(null);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('FEATURE_DISABLED')) {
          setDisabled(true);
          return [] as McpServerLike[];
        }
        setError(message);
        return [] as McpServerLike[];
      }
    }
  });

  const resources = useQuery({
    queryKey: ['mcp-resources', serverId],
    enabled: (props.enabled ?? true) && serverId != null,
    queryFn: async () => {
      try {
        const result = unwrap(
          await window.codeAgentDesktop.listMcpResources(serverId as string)
        ) as McpResourceLike[];
        setError(null);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return [] as McpResourceLike[];
      }
    }
  });

  const readM = useMutation({
    mutationFn: async (input: { serverId: string; uri: string }) => {
      return unwrap(
        await window.codeAgentDesktop.readMcpResource(input.serverId, input.uri)
      ) as McpResourceContentLike;
    },
    onSuccess: (data) => {
      setError(null);
      setRead(data);
    },
    onError: (err) => {
      setRead(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  });

  if (props.enabled === false) {
    return <div className="mcp-panel" data-testid="mcp-panel"><div className="visible-output-header">MCP 来源（只读）</div><div className="run-meta" data-testid="mcp-disabled">只读 MCP 来源未在服务端启用（mcpReadOnlySource flag 已关闭）。</div></div>;
  }

  return (
    <div className="mcp-panel" data-testid="mcp-panel">
      <div className="visible-output-header">MCP 来源（只读）</div>
      {disabled ? (
        <div className="run-meta" data-testid="mcp-disabled">
          只读 MCP 来源未在服务端启用（mcpReadOnlySource flag 已关闭）。
        </div>
      ) : (
        <>
          <div data-testid="mcp-servers">
            {(servers.data ?? []).map((server) => (
              <button
                key={server.serverId ?? ''}
                type="button"
                data-testid="mcp-server"
                className={serverId === server.serverId ? 'selected' : undefined}
                onClick={() => {
                  setServerId(server.serverId ?? null);
                  setRead(null);
                }}
              >
                {server.serverId} · {server.status}
                {server.reason ? ` (${server.reason})` : ''}
              </button>
            ))}
            {servers.data?.length === 0 ? (
              <span className="run-meta">未配置只读 MCP 服务器</span>
            ) : null}
          </div>
          {serverId != null ? (
            <div data-testid="mcp-resources">
              {(resources.data ?? []).map((resource) => (
                <div key={resource.uri ?? ''} className="mcp-resource">
                  <span className="run-meta">
                    {resource.name ?? resource.uri}
                    {resource.mimeType ? ` · ${resource.mimeType}` : ''}
                  </span>
                  <button
                    type="button"
                    data-testid="mcp-resource-read"
                    disabled={readM.isPending}
                    onClick={() => readM.mutate({ serverId: serverId, uri: resource.uri ?? '' })}
                  >
                    读取
                  </button>
                </div>
              ))}
              {resources.data?.length === 0 ? (
                <span className="run-meta">该服务器未列出资源</span>
              ) : null}
            </div>
          ) : null}
          {read != null ? (
            <div className="source-card" data-testid="mcp-read-card">
              <div className="source-card-header">
                <span className="source-untrusted" data-testid="mcp-untrusted-badge">不可信内容</span>
                <span className="run-meta">
                  {read.serverId} · {read.uri} · {read.contentBytes} 字节
                  {read.truncated ? ' · 已截断' : ''}
                </span>
                {read.contentText ? (
                  <button
                    type="button"
                    data-testid="mcp-attach"
                    onClick={() => props.onAttach({
                      name: resourceAttachmentName(read.uri ?? '', read.mimeType),
                      mediaType: read.mimeType === 'text/markdown' ? 'text/markdown' : 'text/plain',
                      text: read.contentText ?? ''
                    })}
                  >
                    附加到消息
                  </button>
                ) : null}
              </div>
              {read.contentText ? (
                <pre className="source-content" data-testid="mcp-content">{read.contentText}</pre>
              ) : null}
            </div>
          ) : null}
          {error ? <div className="run-meta" data-testid="mcp-error">读取失败：{error}</div> : null}
        </>
      )}
    </div>
  );
}
