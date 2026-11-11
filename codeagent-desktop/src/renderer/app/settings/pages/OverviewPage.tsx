/**
 * Overview page (settings design §6.1).
 *
 * Answers "当前配置能否支持正常工作": four one-conclusion status cards, a
 * needs-attention list built only from authoritative projections, and the
 * effective summary. Cards are never colour-only: icon, label and reason
 * always accompany the tone. No fabricated audit history — without a
 * history contract the page says so.
 */

import { AvailabilityBadge, EmptyState, SettingSection, SkeletonRows } from '../components';
import { AUTONOMY_LABELS, availabilityLabel } from '../settingsPresentation';
import type { SettingsPageContext } from '../settingsContext';
import { useModelCatalog, usePolicyLayers, useProductSettings, useServiceStatus, useSettingsKnowledge } from '../useSettingsQueries';
import { modelCatalogEntryMatches } from '../../queries';

type CardTone = 'ok' | 'warn' | 'bad' | 'muted';

function StatusCard(props: { title: string; tone: CardTone; icon: string; conclusion: string; reason: string; testId: string }): React.JSX.Element {
  return (
    <article className={`settings-status-card tone-${props.tone}`} data-testid={props.testId}>
      <header>
        <span className="settings-status-icon" aria-hidden="true">{props.icon}</span>
        <h3>{props.title}</h3>
        <span className={`settings-badge card-tone-${props.tone}`}>
          {props.tone === 'ok' ? '正常' : props.tone === 'warn' ? '注意' : props.tone === 'bad' ? '异常' : '未知'}
        </span>
      </header>
      <p className="settings-status-conclusion">{props.conclusion}</p>
      <p className="run-meta">{props.reason}</p>
    </article>
  );
}

export function OverviewPage(props: { context: SettingsPageContext }): React.JSX.Element {
  const { context } = props;
  const serviceStatus = useServiceStatus(Boolean(context.capabilities));
  const catalog = useModelCatalog(Boolean(context.capabilities));
  const settings = useProductSettings(Boolean(context.capabilities));
  const policy = usePolicyLayers(Boolean(context.capabilities));
  const knowledge = useSettingsKnowledge(Boolean(context.capabilities));

  const pendingKnowledge = (knowledge.data?.items ?? []).filter((item) => item.status === 'PENDING').length;
  const modelEntries = catalog.data?.items ?? [];
  const availableModels = modelEntries.filter((entry) => entry.availability === 'AVAILABLE');
  const unconfiguredModels = modelEntries.filter((entry) => entry.availability === 'UNCONFIGURED');
  const sessionModel = context.session?.modelAlias ?? null;
  const encryptionAvailable = serviceStatus.data ? Boolean(serviceStatus.data.encryptionAvailable) : null;
  const scheduler = serviceStatus.data?.scheduler;

  const serviceTone: CardTone = !context.capabilities ? 'muted' : context.connection === 'CONNECTED' ? 'ok' : 'bad';
  const modelTone: CardTone = catalog.isError ? 'muted' : availableModels.length > 0 ? (sessionModel && !availableModels.some((entry) => modelCatalogEntryMatches(entry, sessionModel)) ? 'warn' : 'ok') : unconfiguredModels.length > 0 ? 'warn' : 'bad';
  const privacyTone: CardTone = settings.isError ? 'muted' : settings.data?.telemetryMinimal ? 'ok' : 'warn';
  const policyTone: CardTone = policy.isError ? 'muted' : 'ok';

  const attention: Array<{ id: string; text: string; tone: 'warn' | 'bad' }> = [];
  if (serviceStatus.data && serviceStatus.data.encryptionAvailable === false) {
    attention.push({ id: 'token-session', text: 'OS 加密不可用：Service token 仅在本次会话内保存，不会写入磁盘。', tone: 'warn' });
  }
  if (unconfiguredModels.length > 0) {
    attention.push({ id: 'model-unconfigured', text: `有 ${unconfiguredModels.length} 个模型尚未配置；请在提供商管理中设置凭据，保存后立即生效。`, tone: 'warn' });
  }
  if (pendingKnowledge > 0) {
    attention.push({ id: 'knowledge-pending', text: `${pendingKnowledge} 条知识建议等待确认（确认前不是事实）。`, tone: 'warn' });
  }
  if (context.connection !== 'CONNECTED' && context.capabilities) {
    attention.push({ id: 'service-connection', text: 'Service 事件流未连接；设置中的 Service 数据可能不可用。', tone: 'bad' });
  }

  const scopeProject = context.projects[0]?.displayName ?? context.projects[0]?.workspaceAlias;

  return (
    <>
      <div className="settings-scope-bar" data-testid="settings-scope-bar">
        <span>作用域：</span>
        <span className="settings-badge scope-USER">本桌面</span>
        <span className="settings-badge scope-PROJECT">{scopeProject ?? '未选择项目'}</span>
        <span className="settings-badge scope-SESSION">
          {context.session ? (context.session.title ?? context.session.sessionId.slice(0, 8)) : '未选择会话'}
        </span>
      </div>

      <div className="settings-status-grid" data-testid="settings-status-cards">
        <StatusCard
          title="Service"
          tone={serviceTone}
          icon="⏺"
          conclusion={context.connection === 'CONNECTED' ? '已连接' : '未连接'}
          reason={serviceStatus.data
            ? `状态 ${serviceStatus.data.state}${serviceStatus.data.ownedPid ? ` · owned pid ${serviceStatus.data.ownedPid}` : ''}`
            : '无权威状态'}
          testId="overview-card-service"
        />
        <StatusCard
          title="模型"
          tone={modelTone}
          icon="✦"
          conclusion={availableModels.length > 0 ? `${availableModels.length} 个模型可用` : '没有可用模型'}
          reason={catalog.isError ? '目录不可用' : sessionModel ? `当前会话：${sessionModel}` : '当前会话：使用默认'}
          testId="overview-card-model"
        />
        <StatusCard
          title="隐私"
          tone={privacyTone}
          icon="🛡"
          conclusion={settings.data?.telemetryMinimal ? '最小收集' : '超出最小范围'}
          reason={settings.data ? `local-only ${settings.data.localOnly ? '开' : '关'} · Trace ${settings.data.traceExportEnabled ? '开' : '关'}` : '设置不可用'}
          testId="overview-card-privacy"
        />
        <StatusCard
          title="权限"
          tone={policyTone}
          icon="⛨"
          conclusion={`有效自治：${policy.data ? (AUTONOMY_LABELS[policy.data.effectiveMaximumAutonomy] ?? policy.data.effectiveMaximumAutonomy) : '—'}`}
          reason={policy.data ? `${policy.data.layers.length} 层策略 · 只能收紧` : '策略不可用'}
          testId="overview-card-permissions"
        />
      </div>

      <SettingSection title="需要处理" description="只列出权威投影中确实需要决定或修复的事项。" testId="overview-attention">
        {attention.length === 0 ? (
          <EmptyState message="没有需要处理的事项。" />
        ) : (
          <ul className="settings-attention-list">
            {attention.map((item) => (
              <li key={item.id} className={`settings-attention-item tone-${item.tone}`} data-testid={`overview-attention-${item.id}`}>
                <span aria-hidden="true">{item.tone === 'bad' ? '✖' : '⚠'}</span>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingSection>

      <SettingSection title="当前有效配置" description="来自各权威源的当前生效值摘要。" testId="overview-summary">
        <dl className="settings-summary-grid" data-testid="overview-summary-grid">
          <div><dt>当前模型</dt><dd>{sessionModel ?? '使用默认'} {catalog.data ? <AvailabilityBadge availability={availableModels.length > 0 ? 'AVAILABLE' : 'UNAVAILABLE'} /> : null}</dd></div>
          <div><dt>有效自治上限</dt><dd>{policy.data ? (AUTONOMY_LABELS[policy.data.effectiveMaximumAutonomy] ?? policy.data.effectiveMaximumAutonomy) : '—'}</dd></div>
          <div><dt>写入范围</dt><dd>{context.session?.writeAllow && context.session.writeAllow.length > 0 ? context.session.writeAllow.join(', ') : '无（普通会话）'}</dd></div>
          <div><dt>local-only</dt><dd>{settings.data ? (settings.data.localOnly ? '开启' : '关闭') : '—'}</dd></div>
          <div><dt>Trace 导出</dt><dd>{settings.data ? (settings.data.traceExportEnabled ? '开启' : '关闭') : '—'}</dd></div>
          <div><dt>token 存储</dt><dd>{encryptionAvailable === null ? '—' : encryptionAvailable ? 'OS 加密' : '仅会话（未落盘）'}</dd></div>
        </dl>
      </SettingSection>

      <SettingSection title="Scheduler 权威状态" description="只显示 Java Service /api/v2/scheduler/overview 与当前 Run 投影；缺失时保持未知。" testId="overview-scheduler">
        <dl className="settings-summary-grid">
          <div><dt>mode</dt><dd data-testid="scheduler-mode">{scheduler?.schedulerMode ?? '未知'}</dd></div>
          <div><dt>active / max</dt><dd data-testid="scheduler-active">{scheduler ? `${scheduler.activeRuns} / ${scheduler.maxActiveRuns}` : '未知'}</dd></div>
          <div><dt>queued</dt><dd data-testid="scheduler-queued">{scheduler?.queuedRuns ?? '未知'}</dd></div>
          <div><dt>恢复屏障</dt><dd data-testid="scheduler-recovery">{scheduler?.recoveryBarrier ?? '未知'}</dd></div>
          <div><dt>主因</dt><dd data-testid="scheduler-primary-reason">{context.sessionActiveRun?.primaryReason ?? '无 / 未提供'}</dd></div>
        </dl>
      </SettingSection>

      <SettingSection title="最近变更" testId="overview-history">
        <EmptyState message="Service 尚未提供配置变更历史 API；此处只显示本次打开期间的保存回执。" />
      </SettingSection>

      {catalog.isPending && settings.isPending && policy.isPending ? <SkeletonRows /> : null}
      <p className="settings-hint">数据可用性：{availabilityLabel(context.capabilities ? 'AVAILABLE' : 'UNKNOWN')}（桌面握手 {context.capabilities ? '已完成' : '未完成'}）</p>
    </>
  );
}
