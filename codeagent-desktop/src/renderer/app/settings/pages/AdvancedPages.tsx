/**
 * Extensions / Runtime / Diagnostics / About pages (settings design §6.9,
 * §6.11–§6.13).
 *
 * Extensions only summarizes capability state and links to the real
 * Extensions surface — no duplicate management UI. Runtime is a
 * public-safe availability projection of declared operations; undeclared
 * capabilities render as UNKNOWN (fail closed), never as guessed booleans.
 * Diagnostics copies/reveals through fixed-intent Main actions only.
 */

import { useEffect, useState } from 'react';
import { AvailabilityBadge, EmptyState, SectionError, SettingRow, SettingSection, UnavailableState } from '../components';
import type { SettingsPageContext } from '../settingsContext';
import { useServiceStatus, useSettingsDiagnostics } from '../useSettingsQueries';

export function ExtensionsPage(props: { context: SettingsPageContext }): React.JSX.Element {
  const features = props.context.capabilities?.features;
  const operations = props.context.capabilities?.operations ?? [];
  const summarize = (id: string, featureEnabled: boolean | undefined, label: string): { label: string; availability: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN'; reason: string | null } => {
    const operation = operations.find((candidate) => candidate.id === id);
    if (!featureEnabled && !operation) {
      return { label, availability: 'UNAVAILABLE', reason: 'FEATURE_DISABLED' };
    }
    if (!operation) return { label, availability: 'UNKNOWN', reason: null };
    return {
      label,
      availability: operation.availability === 'AVAILABLE' ? 'AVAILABLE' : operation.availability === 'DEGRADED' ? 'UNKNOWN' : 'UNAVAILABLE',
      reason: operation.reasonCode ?? null
    };
  };
  const rows = [
    summarize('mcp.resource.read', features?.mcpReadOnlySource, 'MCP 只读资源'),
    summarize('skill.manage', features?.skillsCatalog, 'Skills 目录'),
    summarize('hook.health.read', features?.hooks, 'Hooks 健康')
  ];

  return (
    <SettingSection
      title="扩展"
      description="MCP、Skills 和 Hooks 只通过受控 Service 边界工作；完整管理在扩展面板。"
      hideHeader
      testId="extensions-section"
    >
      <ul className="settings-extension-list" data-testid="extensions-summary">
        {rows.map((row) => (
          <li key={row.label}>
            <strong>{row.label}</strong>
            <AvailabilityBadge availability={row.availability} reasonCode={row.reason} />
          </li>
        ))}
      </ul>
      <p className="run-meta" data-testid="extensions-features-hint">
        MCP 与 Skills 的启用状态见 <button type="button" className="link-button" data-testid="extensions-open-features" onClick={() => props.context.onOpenSettingsRoute?.('FEATURES')}>功能与环境 →</button>
      </p>
      <button type="button" className="primary-button" data-testid="open-extensions" onClick={props.context.onOpenExtensions}>
        打开扩展管理
      </button>
    </SettingSection>
  );
}

const RUNTIME_GROUPS: Array<{ title: string; operationIds: string[]; undeclaredNote: string }> = [
  { title: 'Sandbox（OCI）', operationIds: ['agent.tool.sandbox.shell', 'execution.backends.read'], undeclaredNote: '当前协议未声明 Sandbox 能力。' },
  { title: '终端 (Terminal)', operationIds: ['terminal.session.create', 'terminal.output.read', 'terminal.input.write'], undeclaredNote: '当前协议未声明终端能力。' },
  { title: '只读来源与检索', operationIds: ['agent.tool.workspace.glob', 'agent.tool.workspace.batchRead', 'mcp.resource.read'], undeclaredNote: '当前协议未声明只读来源能力。' },
  { title: 'Java 语义工具', operationIds: ['agent.tool.java.semantic'], undeclaredNote: '当前协议未声明 Java 语义能力。' }
];

export function RuntimePage(props: { context: SettingsPageContext }): React.JSX.Element {
  const operations = props.context.capabilities?.operations ?? [];
  const scheduler = useServiceStatus(Boolean(props.context.capabilities)).data?.scheduler;
  return (
    <SettingSection
      title="运行时"
      description="按 capability 声明投影 public-safe 可用性；未声明的能力按未知处理，不猜测。"
      hideHeader
      testId="runtime-section"
    >
      {RUNTIME_GROUPS.map((group) => {
        const declared = group.operationIds
          .map((id) => operations.find((operation) => operation.id === id))
          .filter((operation): operation is NonNullable<typeof operation> => Boolean(operation));
        if (declared.length === 0) {
          return (
            <SettingRow
              key={group.title}
              label={group.title}
              scope="SERVICE_INSTANCE"
              mutability="READ_ONLY"
              source="capability 声明"
              effective="未知（未声明）"
              testId={`runtime-group-${group.operationIds[0]}`}
            >
              <span className="run-meta">{group.undeclaredNote}</span>
            </SettingRow>
          );
        }
        return (
          <div key={group.title} className="settings-runtime-group" data-testid={`runtime-group-${group.operationIds[0]}`}>
            <h3>{group.title}</h3>
            <ul>
              {declared.map((operation) => (
                <li key={operation.id}>
                  <code className="run-meta">{operation.id}</code>
                  <AvailabilityBadge availability={operation.availability} reasonCode={operation.reasonCode} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <div className="settings-runtime-group" data-testid="runtime-scheduler-summary">
        <h3>Scheduler（Service 权威投影）</h3>
        <dl className="settings-summary-grid">
          <div><dt>模式</dt><dd>{scheduler?.schedulerMode ?? '未知'}</dd></div>
          <div><dt>活跃 / 上限</dt><dd>{scheduler ? `${scheduler.activeRuns} / ${scheduler.maxActiveRuns}` : '未知'}</dd></div>
          <div><dt>排队</dt><dd>{scheduler?.queuedRuns ?? '未知'}</dd></div>
          <div><dt>恢复屏障</dt><dd>{scheduler?.recoveryBarrier ?? '未知'}</dd></div>
          <div><dt>主因</dt><dd>{props.context.sessionActiveRun?.primaryReason ?? '无 / 未提供'}</dd></div>
        </dl>
      </div>
    </SettingSection>
  );
}

export function DiagnosticsPage(): React.JSX.Element {
  const diagnostics = useSettingsDiagnostics();
  const [copyState, setCopyState] = useState<string | null>(null);
  const [revealState, setRevealState] = useState<string | null>(null);

  if (diagnostics.isPending) {
    return <SettingSection title="诊断" description="桌面本体的连接与存储状态。" hideHeader><EmptyState message="正在读取诊断信息…" /></SettingSection>;
  }
  if (diagnostics.isError || !diagnostics.data) {
    return <SectionError message={`无法读取诊断信息：${String(diagnostics.error)}`} onRetry={() => void diagnostics.refetch()} />;
  }
  const data = diagnostics.data;

  return (
    <SettingSection title="诊断" description="不显示任何 token、密钥或原始配置；导出文本由 Main 生成并限长。" hideHeader testId="diagnostics-section">
      <SettingRow label="Service 状态" scope="SERVICE_INSTANCE" mutability="READ_ONLY" source="桌面本体" effective={data.serviceState} testId="diagnostics-service-state" />
      <SettingRow
        label="owned 进程"
        scope="SERVICE_INSTANCE"
        mutability="READ_ONLY"
        source="桌面本体"
        effective={data.ownedProcess ? `pid ${data.ownedProcess.pid} · port ${data.ownedProcess.port}` : '无（attached 模式）'}
        testId="diagnostics-owned-process"
      />
      <SettingRow
        label="OS 加密"
        scope="USER"
        mutability="READ_ONLY"
        source="桌面本体"
        effective={data.encryptionAvailable ? '可用' : '不可用（token 仅会话内保存）'}
        testId="diagnostics-encryption"
      />
      <SettingRow
        label="日志位置"
        scope="USER"
        mutability="READ_ONLY"
        source="桌面本体"
        effective="userData 诊断文件夹"
        testId="diagnostics-log-location"
        advanced={<span className="run-meta">{data.logLocation}</span>}
      >
        <button
          type="button"
          data-testid="diagnostics-reveal"
          onClick={() => {
            void window.codeAgentDesktop.revealDiagnosticsFolder().then((result) => {
              setRevealState(result && 'error' in result ? (result.error || '打开失败') : null);
            }).catch(() => setRevealState('打开失败'));
          }}
        >
          打开诊断文件夹
        </button>
      </SettingRow>
      {revealState ? <p className="settings-error-text" role="alert">{revealState}</p> : null}
      <div className="settings-diagnostics-actions">
        <button
          type="button"
          data-testid="diagnostics-copy"
          onClick={() => {
            void window.codeAgentDesktop.copyDiagnostics().then((result) => {
              setCopyState(result && 'error' in result ? '复制失败' : `已复制（${result.bytes ?? 0} 字节，已脱敏）`);
            }).catch(() => setCopyState('复制失败'));
          }}
        >
          复制诊断摘要
        </button>
        {copyState ? <span className="run-meta" aria-live="polite">{copyState}</span> : null}
      </div>
    </SettingSection>
  );
}

export function AboutPage(props: { context: SettingsPageContext }): React.JSX.Element {
  const [about, setAbout] = useState<{ desktopVersion: string; electronVersion: string } | null>(null);
  const serviceInstanceId = props.context.capabilities?.serviceInstanceId;

  useEffect(() => {
    let cancelled = false;
    void window.codeAgentDesktop.getAboutInfo().then((result) => {
      if (cancelled || !result || 'error' in result) return;
      setAbout(result);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  return (
    <SettingSection title="关于" description="版本信息由 Main / Service 注入，不从 Renderer 路径读取。" hideHeader testId="about-section">
      <SettingRow label="Desktop 版本" scope="USER" mutability="READ_ONLY" source="桌面本体" effective={about?.desktopVersion ?? '…'} testId="about-desktop-version" />
      <SettingRow label="Electron 版本" scope="USER" mutability="READ_ONLY" source="桌面本体" effective={about?.electronVersion ?? '…'} testId="about-electron-version" />
      <SettingRow
        label="Service 协议"
        scope="SERVICE_INSTANCE"
        mutability="READ_ONLY"
        source="握手"
        effective={props.context.protocolVersion ?? '未知'}
        testId="about-protocol"
      />
      <SettingRow
        label="Service 实例指纹"
        scope="SERVICE_INSTANCE"
        mutability="READ_ONLY"
        source="握手"
        effective={serviceInstanceId ? serviceInstanceId.slice(0, 12) : '未知'}
        testId="about-service-instance"
      />
    </SettingSection>
  );
}
