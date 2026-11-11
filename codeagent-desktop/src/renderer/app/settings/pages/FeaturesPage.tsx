/**
 * Environment & capabilities page (settings design: feature cards).
 *
 * Renders the six service-owned capability cards (Sandbox, Web search,
 * Terminal, Models, MCP, Skills) with the four-state readiness contract:
 * READY / ENABLED_NOT_READY / NOT_ENABLED / NOT_INSTALLED, plus the
 * installation projection. Writes persist to the service database and
 * apply at the next Service restart — the card's pendingRestart badge and
 * the SERVICE_RESTART apply mode keep that honest. Secret material never
 * appears here; credential state is a configured/not-configured flag.
 */

import { useEffect, useState } from 'react';
import type {
  EnvironmentFeatureAction,
  EnvironmentFeatureCard,
  EnvironmentFeatureField
} from '../../../../../packages/protocol/src/index.js';
import {
  EmptyState,
  SectionError,
  SettingSection,
  SettingSelect,
  SettingToggle,
  SettingsDialog,
  SkeletonRows,
  UnavailableState
} from '../components';
import { StatusBadge } from '../../ui/StatusBadge';
import {
  FEATURE_APPLY_STATUS_LABELS,
  FEATURE_CHECK_LABELS,
  FEATURE_INSTALLATION_LABELS,
  FEATURE_STATE_LABELS,
  FEATURE_TOOL_AVAILABILITY_LABELS,
  FEATURE_TOOL_EFFECT_LABELS,
  friendlySaveError
} from '../settingsPresentation';
import type { SettingsPageContext } from '../settingsContext';
import {
  useEnvironmentFeatures,
  usePreflightEnvironmentFeature,
  useUpdateEnvironmentFeature
} from '../useSettingsQueries';
import { McpGovernancePanel, SkillImportPanel } from '../../GovernedExtensionsPanel';
import { WebSearchProvidersPanel } from './WebSearchProvidersPanel';

function checkStatusLabel(status: string): string {
  return FEATURE_CHECK_LABELS[status] ?? status;
}

/**
 * Display label for a field's key segment group (web.fetch.* → 网页抓取).
 * Unknown segments fall back to the raw segment text so service-side
 * additions never render blank.
 */
const FIELD_GROUP_LABELS: Record<string, string> = {
  network: '网络',
  fetch: '网页抓取',
  search: '搜索',
  http: 'HTTP',
  budget: '限额与并发'
};

function fieldGroupKey(key: string): string {
  const parts = key.split('.');
  return parts.length >= 3 ? (parts[1] ?? '') : '';
}

/**
 * Typed configuration surface rendered from the card's field dictionary
 * (settings design S02/S06 + the §7.2 sub-sections): the service owns
 * field metadata so the editable surface can never drift from the
 * parser whitelist. Rendered settings-editor style — grouped by the
 * key's second segment, filterable, with a per-row dirty indicator —
 * inside a floating window opened from the card's 配置参数 button.
 * A blank input clears the stored entry (a null tombstone); sensitive
 * fields never echo the stored value — typing replaces it.
 */
function FeatureFieldsForm(props: {
  card: EnvironmentFeatureCard;
  busy: boolean;
  saveError?: string | null;
  onSave: (entries: Record<string, string | null>) => Promise<void>;
}): React.JSX.Element | null {
  const fields = props.card.fields ?? [];
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [configuredOnly, setConfiguredOnly] = useState(false);

  // Re-seed the draft whenever the card's field values change (after a
  // save or a refresh) — never clobber in-flight typing for unchanged
  // fields.
  useEffect(() => {
    setDraft((current) => {
      const next: Record<string, string> = {};
      for (const field of fields) {
        const seeded = field.sensitive ? '' : (field.value ?? '');
        next[field.key] = field.key in current && current[field.key] !== seeded
          ? (current[field.key] ?? seeded) : seeded;
      }
      return next;
    });
    setCleared({});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.card.configHash, props.card.revision]);

  if (fields.length === 0) return null;

  const editable = fields.filter((field) => !field.readOnly);
  const fieldDirty = (field: EnvironmentFeatureField): boolean => {
    const original = field.sensitive ? '' : (field.value ?? '');
    return cleared[field.key] === true
      ? field.value != null
      : (draft[field.key] ?? '') !== original;
  };
  const dirtyCount = editable.filter(fieldDirty).length;

  const needle = query.trim().toLowerCase();
  const visible = fields.filter((field) => {
    // Keep dirty rows visible under "仅看已设置" so a pending edit on a
    // previously-unset field is never hidden mid-edit.
    if (configuredOnly && field.value == null && !fieldDirty(field)) return false;
    if (needle === '') return true;
    return [field.label, field.key, field.description ?? '']
      .some((text) => text.toLowerCase().includes(needle));
  });

  // Group by the key's second segment, first-appearance order — the
  // service already orders fields, so merging by name keeps the
  // §7.2 sub-sections (网络/抓取/搜索/HTTP/限额) contiguous.
  const grouped = new Map<string, EnvironmentFeatureField[]>();
  for (const field of visible) {
    const name = fieldGroupKey(field.key);
    const bucket = grouped.get(name);
    if (bucket) bucket.push(field);
    else grouped.set(name, [field]);
  }
  const groups = [...grouped.entries()];
  const showGroupHeaders = groups.length > 1 || groups[0]?.[0] !== '';

  const submit = async (): Promise<void> => {
    const entries: Record<string, string | null> = {};
    for (const field of editable) {
      const original = field.sensitive ? '' : (field.value ?? '');
      const value = cleared[field.key] === true
        ? '' : (draft[field.key] ?? '');
      if (value === original) continue;
      entries[field.key] = value.trim() === '' ? null : value.trim();
    }
    await props.onSave(entries);
    setCleared({});
  };

  const save = (): void => {
    // The mutation error is surfaced through the card-level mutation
    // state (saveError prop); the dialog stays open so edits survive.
    void submit().catch(() => undefined);
  };

  const renderInput = (field: EnvironmentFeatureField): React.JSX.Element => {
    const value = cleared[field.key] === true ? '' : (draft[field.key] ?? '');
    const disabled = props.busy || field.readOnly;
    const testId = `feature-field-${props.card.featureId}-${field.key}`;
    if (field.type === 'BOOLEAN') {
      return (
        <input
          type="checkbox"
          aria-label={field.label}
          data-testid={testId}
          checked={value === 'true'}
          disabled={disabled}
          onChange={(event) => setDraft((current) => ({
            ...current, [field.key]: event.target.checked ? 'true' : 'false'
          }))}
        />
      );
    }
    if (field.type === 'ENUM') {
      return (
        <SettingSelect
          ariaLabel={field.label}
          testId={testId}
          value={value}
          disabled={disabled}
          options={[
            { value: '', label: '（未设置）' },
            ...field.options.map((option) => ({ value: option, label: option }))
          ]}
          onChange={(next) => setDraft((current) => ({ ...current, [field.key]: next }))}
        />
      );
    }
    const numeric = field.type === 'INTEGER' || field.type === 'LONG' || field.type === 'DECIMAL';
    return (
      <input
        data-testid={testId}
        value={value}
        disabled={disabled}
        inputMode={numeric ? 'numeric' : undefined}
        type={field.sensitive ? 'password' : 'text'}
        autoComplete="off"
        placeholder={field.sensitive && field.value != null ? '已设置（输入以替换）' : undefined}
        onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
      />
    );
  };

  return (
    <div className="settings-feature-fields" data-testid={`feature-fields-${props.card.featureId}`}>
      <div className="settings-params">
        {props.saveError ? <SectionError message={props.saveError} /> : null}
        <div className="settings-params-toolbar">
          <span className="settings-params-title">
            配置参数 <span className="run-meta">{visible.length === fields.length ? `${fields.length} 项` : `${visible.length}/${fields.length} 项`}</span>
          </span>
          <input
            type="search"
            className="settings-params-filter"
            data-testid={`feature-fields-filter-${props.card.featureId}`}
            placeholder="筛选参数…"
            aria-label="筛选参数"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="settings-params-flag">
            <input
              type="checkbox"
              data-testid={`feature-fields-configured-${props.card.featureId}`}
              checked={configuredOnly}
              onChange={(event) => setConfiguredOnly(event.target.checked)}
            />
            仅看已设置
          </label>
        </div>

        {visible.length === 0 ? (
          <p className="run-meta" data-testid={`feature-fields-empty-${props.card.featureId}`}>没有匹配的参数。</p>
        ) : (
          groups.map(([name, groupFields]) => (
            <div className="settings-param-group" key={name || 'default'}>
              {showGroupHeaders ? (
                <div className="settings-param-group-title">
                  {FIELD_GROUP_LABELS[name] ?? (name === '' ? '通用' : name)}
                </div>
              ) : null}
              {groupFields.map((field) => (
                <div
                  key={field.key}
                  className={`settings-param-row${fieldDirty(field) ? ' is-dirty' : ''}`}
                  data-testid={`feature-field-row-${props.card.featureId}-${field.key}`}
                >
                  <div className="settings-param-meta">
                    <span className="settings-param-label">
                      {field.label}
                      {field.readOnly ? '（只读）' : ''}
                      {field.required ? ' *' : ''}
                      {field.value != null ? <em className="settings-param-set">已设置</em> : null}
                    </span>
                    <code className="settings-param-key">{field.key}</code>
                    {field.description ? <p className="settings-field-hint">{field.description}</p> : null}
                  </div>
                  <div className="settings-param-control">
                    {renderInput(field)}
                    {!field.readOnly && field.value != null ? (
                      <button
                        type="button"
                        className="link-button"
                        data-testid={`feature-field-clear-${props.card.featureId}-${field.key}`}
                        disabled={props.busy}
                        onClick={() => setCleared((current) => ({
                          ...current, [field.key]: current[field.key] !== true
                        }))}
                      >
                        {cleared[field.key] === true ? '撤销清除' : '清除'}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}

        <div className="settings-save-actions">
          <button
            type="button"
            className="primary-button"
            data-testid={`feature-fields-save-${props.card.featureId}`}
            disabled={props.busy || dirtyCount === 0}
            onClick={save}
          >
            保存参数
          </button>
          <span className="run-meta">
            {dirtyCount > 0 ? `${dirtyCount} 项未保存 · ` : ''}
            {props.card.featureId === 'MODEL' ? '参数写入数据库，保存后立即生效' : '参数写入数据库，重启 Service 后生效'}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Embedded MCP/Skills management inside the Settings feature cards
 * (settings design S06.4): the governed panels are the same components
 * the extensions surface uses — configuration and lifecycle stay on the
 * service boundary. The panels open as a floating window so the card
 * stays a summary row.
 */
function FeatureManagement(props: {
  card: EnvironmentFeatureCard;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element | null {
  const panel = props.card.featureId === 'MCP'
    ? <McpGovernancePanel />
    : props.card.featureId === 'SKILLS'
      ? <SkillImportPanel />
      : props.card.featureId === 'WEBSEARCH'
        ? <WebSearchProvidersPanel />
        : null;
  if (panel == null) return null;
  const label = props.card.featureId === 'MCP'
    ? '管理服务器'
    : props.card.featureId === 'WEBSEARCH' ? '管理搜索配置' : '管理技能';
  return (
    <div className="settings-feature-manage" data-testid={`feature-manage-${props.card.featureId}`}>
      <button
        type="button"
        className="secondary-button"
        data-testid={`feature-manage-toggle-${props.card.featureId}`}
        onClick={() => props.onOpenChange(true)}
      >
        {label}
      </button>
      {props.open ? (
        <SettingsDialog
          title={label}
          eyebrow={props.card.title}
          description="配置与生命周期由扩展宿主执行；关闭窗口不影响已写入的状态。"
          wide
          testId={`feature-manage-dialog-${props.card.featureId}`}
          onClose={() => props.onOpenChange(false)}
        >
          {panel}
        </SettingsDialog>
      ) : null}
    </div>
  );
}

export function FeaturesPage(props: { context: SettingsPageContext }): React.JSX.Element {
  const enabled = Boolean(props.context.capabilities);
  const features = useEnvironmentFeatures(enabled);
  const updateFeature = useUpdateEnvironmentFeature();
  const preflight = usePreflightEnvironmentFeature();
  const [restartBusy, setRestartBusy] = useState(false);
  const [copiedAction, setCopiedAction] = useState<string | null>(null);
  const [openGuides, setOpenGuides] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [fieldsDialogId, setFieldsDialogId] = useState<string | null>(null);
  const [manageOpenId, setManageOpenId] = useState<string | null>(null);
  const [recheckingAll, setRecheckingAll] = useState(false);
  const [featureFilter, setFeatureFilter] = useState<'ALL' | 'ATTENTION' | 'READY' | 'NOT_ENABLED'>('ALL');

  const runAction = async (card: EnvironmentFeatureCard, action: EnvironmentFeatureAction): Promise<void> => {
    setActionError(null);
    try {
      switch (action.kind) {
        case 'RECHECK':
          await preflight.mutateAsync(card.featureId);
          return;
        case 'RESTART_SERVICE':
          await restartServiceAndReload();
          return;
        case 'OPEN_URL':
          if (action.url) {
            await window.codeAgentDesktop.openExternalHttps(action.url);
          }
          return;
        case 'COPY_TEXT':
          if (action.copyText) {
            await navigator.clipboard.writeText(action.copyText);
            setCopiedAction(action.id);
            window.setTimeout(() => setCopiedAction((current) => current === action.id ? null : current), 2000);
          }
          return;
        case 'OPEN_SURFACE':
          if (action.url === 'extensions') {
            props.context.onOpenExtensions();
          } else if (action.url === 'settings:models') {
            props.context.onOpenSettingsRoute?.('MODELS');
          } else if (action.url === 'settings:websearch') {
            setManageOpenId('WEBSEARCH');
          }
          return;
        case 'SHOW_GUIDE':
          setOpenGuides((current) => ({ ...current, [action.id]: !current[action.id] }));
          return;
        default:
          return;
      }
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const restartServiceAndReload = async (): Promise<void> => {
    setRestartBusy(true);
    try {
      const bootstrap = await window.codeAgentDesktop.restartService();
      if (bootstrap.status === 'START_FAILED' || bootstrap.status === 'DEGRADED') {
        throw new Error(bootstrap.message ?? 'Service 重启后未就绪');
      }
      // Rebuild the renderer from the fresh handshake so capability
      // gates (including terminal.session.create) do not keep the
      // previous Service snapshot after a restart/reconnect.
      window.location.reload();
    } finally {
      setRestartBusy(false);
    }
  };

  const cards = features.data?.features ?? [];
  // Design 2026-09-30 §7.1: summary counters share the same口径 as the
  // card tone bar — READY without FAIL is ready; enabled-but-not-ready,
  // not-installed, any FAIL check or a failed apply needs attention.
  const hasFailCheck = (card: EnvironmentFeatureCard): boolean =>
    card.checks.some((check) => check.status === 'FAIL');
  // Same口径 as cardStatus: a WARN check also surfaces as 需处理, so the
  // filter/summary count and the auto-expanded body must count it too.
  const needsAttention = (card: EnvironmentFeatureCard): boolean =>
    hasFailCheck(card)
    || card.applyStatus === 'APPLY_FAILED'
    || card.state === 'ENABLED_NOT_READY'
    || card.state === 'NOT_INSTALLED'
    || card.checks.some((check) => check.status === 'WARN');
  const summaryCounts = {
    // Buckets stay disjoint: a READY card whose checks still carry WARN
    // belongs to 需处理, not 可用.
    ready: cards.filter((card) => card.state === 'READY' && !needsAttention(card)).length,
    attention: cards.filter(needsAttention).length,
    notEnabled: cards.filter((card) => card.state === 'NOT_ENABLED' && !needsAttention(card)).length,
    unknown: cards.filter((card) => card.state === 'UNKNOWN' || card.state === 'UNSUPPORTED').length
  };
  const pendingRestartCount = cards.filter((card) => card.pendingRestart).length;

  // §10.3 (S4): exactly one status per card — the raw FEATURE_STATE_LABELS
  // enum collapses into the four user-facing states.
  const cardStatus = (card: EnvironmentFeatureCard): { tone: 'ok' | 'warn' | 'bad' | 'off' | 'info'; label: string } => {
    if (hasFailCheck(card)) return { tone: 'bad', label: '需处理' };
    if (card.state === 'ENABLED_NOT_READY' || card.state === 'NOT_INSTALLED'
        || card.applyStatus === 'APPLY_FAILED'
        || card.checks.some((check) => check.status === 'WARN')) return { tone: 'warn', label: '需处理' };
    if (card.state === 'NOT_ENABLED') return { tone: 'off', label: '未启用' };
    if (card.state === 'READY') return { tone: 'ok', label: '可用' };
    return { tone: 'info', label: '状态未知' };
  };

  // §10.2: attention cards always sort first; the summary counts double as
  // a local filter (ALL/需处理/可用/未启用).
  const attentionFirst = (list: EnvironmentFeatureCard[]): EnvironmentFeatureCard[] =>
    [...list.filter(needsAttention), ...list.filter((card) => !needsAttention(card))];
  const filteredCards = attentionFirst(
    featureFilter === 'ALL' ? cards
      : cards.filter((card) =>
        featureFilter === 'ATTENTION' ? needsAttention(card)
          : featureFilter === 'READY' ? card.state === 'READY' && !needsAttention(card)
            : card.state === 'NOT_ENABLED' && !needsAttention(card))
  );
  const firstAttentionCard = cards.find(needsAttention);

  const cardToneClass = (card: EnvironmentFeatureCard): string =>
    hasFailCheck(card) ? 'tone-bad' : needsAttention(card) ? 'tone-warn' : '';
  const hasManagementEntry = (card: EnvironmentFeatureCard): boolean =>
    card.featureId === 'MCP' || card.featureId === 'SKILLS' || card.featureId === 'WEBSEARCH'
    || card.featureId === 'MODEL' || card.actions.some((action) => action.kind === 'OPEN_SURFACE');
  const sourceLabel = (source: string | null | undefined): string | null =>
    source === 'DATABASE' ? '数据库' : source === 'FILE_IMPORT' ? '文件导入' : source === 'DEFAULT' ? '默认值' : source ?? null;
  const checkSeverity = (status: string): number => {
    switch (status) {
      case 'FAIL': return 0;
      case 'WARN': return 1;
      case 'CHECKING': return 3;
      case 'PASS': return 4;
      default: return 2;
    }
  };

  // Recheck every card in parallel; the button state tracks the whole batch
  // instead of the last mutate() call.
  const recheckAll = async (): Promise<void> => {
    setRecheckingAll(true);
    try {
      const results = await Promise.allSettled(cards.map((card) => preflight.mutateAsync(card.featureId)));
      const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
      if (failed) setActionError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
    } finally {
      setRecheckingAll(false);
    }
  };

  return (
    <SettingSection
      title="功能与环境"
      hideHeader
      testId="features-section"
    >
      {features.isPending ? <SkeletonRows rows={3} /> : null}
      {features.isError ? (() => {
        const message = features.error instanceof Error ? features.error.message : String(features.error);
        const offline = message.includes('SERVICE_NOT_CONNECTED')
          || (features.error as (Error & { code?: string }) | null | undefined)?.code === 'SERVICE_NOT_CONNECTED';
        return offline
          ? <UnavailableState title="功能状态不可用" message="Service 未连接；离线时不会显示旧状态。" reasonCode="SERVICE_NOT_CONNECTED" />
          : <SectionError message={`无法读取功能状态：${message}`} onRetry={() => void features.refetch()} />;
      })() : null}
      {features.data && cards.length === 0 ? <EmptyState message="Service 没有返回任何能力卡片。" /> : null}
      {actionError ? <SectionError message={friendlySaveError(actionError)} /> : null}

      {features.data ? (
        <div className="features-summary" data-testid="features-summary">
          <div className="features-summary-head">
            <strong>{cards.length} 项能力</strong>
            <span className="features-summary-counts" role="group" aria-label="按状态过滤">
              <button
                type="button"
                className={`features-count ${featureFilter === 'ALL' ? 'active' : ''}`}
                onClick={() => setFeatureFilter('ALL')}
              >
                全部 {cards.length}
              </button>
              <button
                type="button"
                className={`features-count tone-warn ${featureFilter === 'ATTENTION' ? 'active' : ''}`}
                data-testid="feature-toc"
                disabled={summaryCounts.attention === 0}
                onClick={() => {
                  setFeatureFilter('ATTENTION');
                  if (firstAttentionCard) {
                    window.setTimeout(() => document.getElementById(`feature-card-${firstAttentionCard.featureId}`)
                      ?.scrollIntoView({ block: 'start' }), 0);
                  }
                }}
              >
                ⚠ {summaryCounts.attention} 需处理
              </button>
              <button
                type="button"
                className={`features-count tone-ok ${featureFilter === 'READY' ? 'active' : ''}`}
                onClick={() => setFeatureFilter('READY')}
              >
                ✓ {summaryCounts.ready} 可用
              </button>
              <button
                type="button"
                className={`features-count tone-muted ${featureFilter === 'NOT_ENABLED' ? 'active' : ''}`}
                onClick={() => setFeatureFilter('NOT_ENABLED')}
              >
                ○ {summaryCounts.notEnabled} 未启用
              </button>
            </span>
            <button
              type="button"
              className="secondary-button"
              data-testid="features-recheck-all"
              disabled={recheckingAll}
              onClick={() => { void recheckAll(); }}
            >
              {recheckingAll ? '检测中…' : '全部重新检测'}
            </button>
          </div>
          <p className="sr-only" id="features-apply-note">修改写入 Service 数据库；模型目录保存即生效，其余特性重启 Service 后生效</p>
        </div>
      ) : null}
      {pendingRestartCount > 0 ? (
        <div className="features-restart-banner" data-testid="features-restart-banner" role="status">
          <span>⚠ {pendingRestartCount} 项修改需重启 Service 后生效</span>
          <button
            type="button"
            className="secondary-button small"
            disabled={restartBusy}
            onClick={() => { void restartServiceAndReload().catch((failure) => setActionError(failure instanceof Error ? failure.message : String(failure))); }}
          >
            {restartBusy ? '正在重启…' : '立即重启 Service'}
          </button>
        </div>
      ) : null}

      {featureFilter !== 'ALL' ? (
        <p className="run-meta" data-testid="features-filter-note">
          已按状态过滤 · <button type="button" className="link-button" onClick={() => setFeatureFilter('ALL')}>显示全部</button>
        </p>
      ) : null}
      <ul className="settings-feature-list" data-testid="feature-card-list">
        {filteredCards.map((card) => {
          const desired = card.desiredEnabled ?? card.effectiveEnabled;
          const pendingToggle = updateFeature.isPending && updateFeature.variables?.featureId === card.featureId;
          const pendingCheck = preflight.isPending && preflight.variables === card.featureId;
          const supportsToggle = card.supportsToggle !== false;
          const fields = card.fields ?? [];
          const checks = card.checks ?? [];
          const nonPassChecks = checks
            .filter((check) => check.status !== 'PASS')
            .sort((left, right) => checkSeverity(left.status) - checkSeverity(right.status));
          const passChecks = checks.filter((check) => check.status === 'PASS');
          const allPass = checks.length > 0 && nonPassChecks.length === 0;
          const tools = card.tools ?? [];
          const toolCounts = tools.reduce<Record<string, number>>((counts, tool) => {
            const key = tool.availability ?? 'UNKNOWN';
            counts[key] = (counts[key] ?? 0) + 1;
            return counts;
          }, {});
          const toolsSummary = Object.entries(toolCounts)
            .map(([availability, count]) => `${FEATURE_TOOL_AVAILABILITY_LABELS[availability] ?? availability} ${count}`)
            .join(' · ');
          const src = sourceLabel(card.source);
          const status = cardStatus(card);
          // An OPEN_SURFACE action whose target is the panel
          // FeatureManagement already opens must not render a second
          // identical entry point (S2).
          const cardActions = card.actions.filter((action) =>
            !(action.kind === 'OPEN_SURFACE' && action.url === 'settings:websearch'));
          const recheckActions = cardActions.filter((action) => action.kind === 'RECHECK');
          const restActions = cardActions.filter((action) => action.kind !== 'RECHECK');
          const desiredMismatch = supportsToggle && card.desiredEnabled != null && card.desiredEnabled !== card.effectiveEnabled;
          return (
            <li key={card.featureId} id={`feature-card-${card.featureId}`} className={`settings-feature-card ${cardToneClass(card)}`} data-testid={`feature-card-${card.featureId}`}>
              <div className="settings-feature-head">
                <strong className="settings-feature-title">{card.title}</strong>
                <StatusBadge
                  tone={status.tone}
                  label={status.label}
                  testId={`feature-state-${card.featureId}`}
                  title={FEATURE_STATE_LABELS[card.state] ?? card.state}
                />
                {card.pendingRestart ? (
                  <StatusBadge tone="warn" label="重启后生效" testId={`feature-pending-${card.featureId}`} />
                ) : null}
                {recheckActions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className="feature-head-action"
                    data-testid={`feature-action-${card.featureId}-${action.id}`}
                    disabled={action.enabled === false || pendingCheck}
                    onClick={() => { void runAction(card, action); }}
                  >
                    {pendingCheck ? '检测中…' : action.label}
                  </button>
                ))}
                {supportsToggle ? (
                  <span className="settings-feature-head-toggle">
                    <SettingToggle
                      testId={`feature-toggle-${card.featureId}`}
                      label={`启用 ${card.title}`}
                      checked={desired}
                      disabled={pendingToggle}
                      title="启用状态写入数据库，重启 Service 后生效"
                      ariaDescribedBy="features-apply-note"
                      onChange={(checked) => {
                        setActionError(null);
                        updateFeature.mutate({ featureId: card.featureId, enabled: checked, expectedRevision: card.revision });
                      }}
                    />
                  </span>
                ) : null}
              </div>

              {/* Body folds behind a summary for healthy cards; attention
                  cards stay expanded because their fixHint is the action. */}
              {(() => {
                const attention = needsAttention(card);
                const body = (
                  <>
              {!supportsToggle ? (
                <p className="run-meta" data-testid={`feature-managed-${card.featureId}`}>
                  {hasManagementEntry(card) ? '无总开关 · 通过管理入口配置' : '无总开关 · 状态由环境检测决定'}
                </p>
              ) : null}

              {desiredMismatch ? (
                <p className="feature-pending-warning settings-feature-mismatch" data-testid={`feature-mismatch-${card.featureId}`}>
                  已设为{card.desiredEnabled ? '启用' : '停用'}，重启 Service 后生效
                </p>
              ) : null}

              {allPass ? (
                <details className="settings-feature-checks-fold" data-testid={`feature-checks-fold-${card.featureId}`}>
                  <summary>✓ {checks.length} 项检查全部通过</summary>
                  <ul className="settings-feature-checks" data-testid={`feature-checks-${card.featureId}`}>
                    {checks.map((check) => (
                      <li key={check.code} className="check-pass" data-testid={`feature-check-${card.featureId}-${check.code}`}>
                        <span className={`settings-badge check-${check.status}`}>{checkStatusLabel(check.status)}</span>
                        <span className="settings-feature-check-label">{check.label}</span>
                        {check.detail ? <code className="settings-feature-check-detail">{check.detail}</code> : null}
                        {check.fixHint ? <span className="settings-hint">{check.fixHint}</span> : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : checks.length > 0 ? (
                <ul className="settings-feature-checks" data-testid={`feature-checks-${card.featureId}`}>
                  {nonPassChecks.map((check) => (
                    <li key={check.code} className="check-attention" data-testid={`feature-check-${card.featureId}-${check.code}`}>
                      <span className="check-line">
                        <span className={`settings-badge check-${check.status}`}>{checkStatusLabel(check.status)}</span>
                        <span className="settings-feature-check-label">{check.label}</span>
                      </span>
                      {check.fixHint ? <span className="settings-hint check-fix">{check.fixHint}</span> : null}
                      {check.detail || check.code ? (
                        <details className="settings-feature-check-detail-fold">
                          <summary>详情</summary>
                          <code className="settings-feature-check-detail">{check.code}{check.detail ? ` · ${check.detail}` : ''}</code>
                        </details>
                      ) : null}
                    </li>
                  ))}
                  {passChecks.map((check) => (
                    <li key={check.code} className="check-pass" data-testid={`feature-check-${card.featureId}-${check.code}`}>
                      <span className={`settings-badge check-${check.status}`}>{checkStatusLabel(check.status)}</span>
                      <span className="settings-feature-check-label">{check.label}</span>
                      {check.detail ? <code className="settings-feature-check-detail">{check.detail}</code> : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {tools.length > 0 ? (
                <details className="settings-feature-tools-fold" data-testid={`feature-tools-fold-${card.featureId}`}>
                  <summary>工具目录 · {tools.length} 项{toolsSummary ? `（${toolsSummary}）` : ''}</summary>
                  <ul className="settings-feature-tools" data-testid={`feature-tools-${card.featureId}`}>
                    {tools.map((tool) => (
                      <li key={tool.name} data-testid={`feature-tool-${card.featureId}-${tool.name}`}>
                        <code className="settings-feature-tool-name">{tool.name}</code>
                        <span className={`settings-badge tool-effect-${tool.effect}`}>
                          {FEATURE_TOOL_EFFECT_LABELS[tool.effect] ?? tool.effect}
                        </span>
                        <span className={`settings-badge tool-availability-${tool.availability}`}>
                          {FEATURE_TOOL_AVAILABILITY_LABELS[tool.availability] ?? tool.availability}
                        </span>
                        {tool.summary ? <span className="settings-feature-tool-summary">{tool.summary}</span> : null}
                        {tool.availabilityDetail ? <span className="run-meta">{tool.availabilityDetail}</span> : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              {restActions.length > 0 ? (
                <div className="settings-feature-actionbar-right">
                  {restActions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      className={action.style === 'PRIMARY' ? 'primary-button' : 'secondary-button'}
                      data-testid={`feature-action-${card.featureId}-${action.id}`}
                      disabled={action.enabled === false || pendingCheck || (action.kind === 'RESTART_SERVICE' && restartBusy)}
                      onClick={() => { void runAction(card, action); }}
                    >
                      {action.kind === 'COPY_TEXT' && copiedAction === action.id ? '已复制' : action.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="settings-feature-foot">
                <div className="settings-feature-foot-left">
                  {fields.length > 0 ? (
                    <button
                      type="button"
                      className="secondary-button"
                      data-testid={`feature-fields-open-${card.featureId}`}
                      onClick={() => setFieldsDialogId(card.featureId)}
                    >
                      配置参数（{fields.length} 项）
                    </button>
                  ) : null}
                  <FeatureManagement
                    card={card}
                    open={manageOpenId === card.featureId}
                    onOpenChange={(open) => setManageOpenId(open ? card.featureId : null)}
                  />
                  {card.featureId === 'MODEL' ? (
                    <button
                      type="button"
                      className="secondary-button"
                      data-testid="feature-model-route"
                      onClick={() => props.context.onOpenSettingsRoute?.('MODELS')}
                    >
                      前往 Agent 与模型
                    </button>
                  ) : null}
                </div>
                <span className="settings-feature-foot-meta">
                  {card.applyStatus ? <><span data-testid={`feature-apply-${card.featureId}`}>{FEATURE_APPLY_STATUS_LABELS[card.applyStatus] ?? card.applyStatus}</span> · </> : null}
                  {src ? <>来源 {src} · </> : null}
                  {card.installation !== 'INSTALLED' ? <>安装 <span data-testid={`feature-installation-${card.featureId}`}>{FEATURE_INSTALLATION_LABELS[card.installation] ?? card.installation}</span></> : null}
                </span>
              </div>
              {card.actions.filter((action) => action.kind === 'SHOW_GUIDE' && openGuides[action.id] && action.guideSteps).map((action) => (
                <ol key={action.id} className="settings-guide" data-testid={`feature-guide-${card.featureId}-${action.id}`}>
                  {(action.guideSteps ?? []).map((step, index) => <li key={index}>{step}</li>)}
                </ol>
              ))}

              {updateFeature.isError && updateFeature.variables?.featureId === card.featureId ? (
                <SectionError message={friendlySaveError(updateFeature.error instanceof Error ? updateFeature.error.message : String(updateFeature.error))} />
              ) : null}
                  </>
                );
                return attention ? body : (
                  <details className="settings-collapsible settings-feature-details" data-testid={`feature-details-${card.featureId}`}>
                    <summary>
                      详情与操作{checks.length > 0 ? ` · 检查 ${checks.length}` : ''}{fields.length > 0 ? ` · 参数 ${fields.length}` : ''}
                    </summary>
                    {body}
                  </details>
                );
              })()}
            </li>
          );
        })}
      </ul>

      {fieldsDialogId ? (() => {
        const dialogCard = cards.find((entry) => entry.featureId === fieldsDialogId);
        if (!dialogCard) return null;
        const dialogBusy = updateFeature.isPending && updateFeature.variables?.featureId === dialogCard.featureId;
        const dialogError = updateFeature.isError && updateFeature.variables?.featureId === dialogCard.featureId
          ? friendlySaveError(updateFeature.error instanceof Error ? updateFeature.error.message : String(updateFeature.error))
          : null;
        return (
          <SettingsDialog
            title={`${dialogCard.title} · 配置参数`}
            eyebrow="功能与环境"
            description={dialogCard.featureId === 'MODEL'
              ? '参数写入 Service 数据库，保存后立即生效。敏感字段不回显已存值。'
              : '参数写入 Service 数据库，重启 Service 后生效。敏感字段不回显已存值。'}
            wide
            testId={`feature-fields-dialog-${dialogCard.featureId}`}
            onClose={() => setFieldsDialogId(null)}
          >
            <FeatureFieldsForm
              card={dialogCard}
              busy={dialogBusy}
              saveError={dialogError}
              onSave={async (entries) => {
                setActionError(null);
                await updateFeature.mutateAsync({
                  featureId: dialogCard.featureId,
                  entries,
                  expectedRevision: dialogCard.revision
                });
              }}
            />
          </SettingsDialog>
        );
      })() : null}
    </SettingSection>
  );
}
