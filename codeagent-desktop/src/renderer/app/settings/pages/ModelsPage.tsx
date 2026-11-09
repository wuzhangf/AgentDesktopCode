/**
 * Agent & Models page (settings design §6.4).
 *
 * Catalog data is the generated public-safe ModelCatalogResponse — never
 * base URLs, API keys or key env names. The current-session model edits via
 * patchSession with expectedSessionVersion; active runs accept a pending
 * change for the next safe request boundary, unavailable models are not selectable, and success adopts the returned
 * SessionResponse rather than the select value.
 */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ConflictPanel,
  EmptyState,
  SaveBar,
  SectionError,
  SettingRow,
  SettingSection,
  SettingSelect,
  SkeletonRows,
  UnavailableState
} from '../components';
import { MODEL_AVAILABILITY_LABELS, friendlySaveError } from '../settingsPresentation';
import { settingsKeys } from '../settingsKeys';
import type { SettingsPageContext } from '../settingsContext';
import { useModelCatalog, usePatchSessionModel } from '../useSettingsQueries';
import { modelCatalogEntryMatches, useProjectSessionPreflight } from '../../queries';
import { useSettingsDraft } from '../useSettingsDraft';
import { useReportDirty } from '../useDirtyRegistry';
import { ManagedModelPanel } from './ManagedModelPanel';

interface SessionModelDraft {
  modelAlias: string | null;
  providerId?: string | null;
  catalogRevision?: string | null;
  reasoningMode: 'DEFAULT' | 'OFF' | 'EFFORT' | 'MANUAL_BUDGET';
  reasoningOptionId: string | null;
  contextMode: 'AUTO' | 'PRESET';
  contextPresetId: string | null;
}

const CAPABILITY_LABELS: Record<string, string> = {
  IMAGE_INPUT: '图片理解',
  NATIVE_TOOL_CALLING: '工具调用',
  PARALLEL_TOOL_CALLING: '并行工具调用',
  STRICT_TOOL_SCHEMA: '严格工具结构',
  TOOL_CALLING: '工具调用',
  JSON_SCHEMA_OUTPUT: '结构化输出',
  REASONING_EFFORT: '可调推理强度',
  ADAPTIVE_THINKING: '自适应思考',
  MANUAL_THINKING_BUDGET: '思考预算',
  REASONING_SUMMARY: '思考摘要',
  STATEFUL_CONTINUATION: '状态续接',
  STREAMING_TEXT: '流式文本',
  STREAMING_TOOL_CALLS: '流式工具调用',
  PROMPT_CACHE_IMPLICIT: '提示缓存',
  PROMPT_CACHE_EXPLICIT: '提示缓存'
};

function capabilityLabel(value: string): string {
  const key = value.trim().toUpperCase().replace(/[-\s]/g, '_');
  return CAPABILITY_LABELS[key] ?? value;
}

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) {
    const value = tokens / 1_000;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}K`;
  }
  return `${tokens}`;
}

export function ModelsPage(props: { context: SettingsPageContext }): React.JSX.Element {
  const queryClient = useQueryClient();
  const catalog = useModelCatalog(Boolean(props.context.capabilities));
  const session = props.context.session;
  const activeRun = props.context.sessionActiveRun ?? null;
  const patchModel = usePatchSessionModel();

  const handle = useSettingsDraft<SessionModelDraft>({
    base: session ? (() => {
      const settings = session.modelSettings ?? {};
      return {
        modelAlias: settings.modelAlias ?? session.modelAlias ?? null,
        providerId: settings.providerId ?? null,
        catalogRevision: settings.catalogRevision ?? null,
        reasoningMode: settings.reasoningMode ?? 'DEFAULT',
        reasoningOptionId: settings.reasoningOptionId ?? null,
        contextMode: settings.contextMode === 'PRESET' || settings.contextMode === 'CUSTOM' ? 'PRESET' : 'AUTO',
        contextPresetId: settings.contextPresetId
          ?? ((settings.contextMode === 'PRESET' || settings.contextMode === 'CUSTOM') && settings.contextMaxTokens != null
            ? String(settings.contextMaxTokens) : null)
      };
    })() : undefined,
    baseRevision: session?.sessionVersion,
    onSave: async (draft, baseRevision) => {
      if (!session) throw new Error('NO_SESSION');
      const selectedContextPreset = draft.contextMode === 'PRESET'
        && draft.contextPresetId
        && contextOptions.includes(Number(draft.contextPresetId))
        ? draft.contextPresetId : null;
      const response = await patchModel.mutateAsync({
        sessionId: session.sessionId,
        modelAlias: draft.modelAlias,
        expectedSessionVersion: baseRevision ?? session.sessionVersion,
        modelSettings: {
          providerId: draft.providerId ?? null,
          modelAlias: draft.modelAlias,
          catalogRevision: draft.catalogRevision ?? null,
          reasoningMode: draft.reasoningMode,
          reasoningOptionId: draft.reasoningOptionId
            ?? selectedModel?.reasoningEffortOptions?.[0]
            ?? null,
          reasoningBudgetTokens: null,
          contextMode: selectedContextPreset ? 'PRESET' : 'AUTO',
          contextPresetId: selectedContextPreset,
          contextMaxTokens: null,
          outputMode: 'AUTO',
          outputMaxTokens: null
        }
      });
      const settings = response.modelSettings ?? {};
      return {
        modelAlias: settings.modelAlias ?? response.modelAlias ?? null,
        providerId: settings.providerId ?? null,
        catalogRevision: settings.catalogRevision ?? null,
        reasoningMode: settings.reasoningMode ?? 'DEFAULT',
        reasoningOptionId: settings.reasoningOptionId ?? null,
        contextMode: settings.contextMode === 'PRESET' || settings.contextMode === 'CUSTOM' ? 'PRESET' : 'AUTO',
        contextPresetId: settings.contextPresetId
          ?? ((settings.contextMode === 'PRESET' || settings.contextMode === 'CUSTOM') && settings.contextMaxTokens != null
            ? String(settings.contextMaxTokens) : null)
      };
    }
  });

  const availableModels = (catalog.data?.items ?? []).filter((entry) => entry.availability === 'AVAILABLE' && entry.configured);
  const draft = handle.draft;
  const selectedModel = availableModels.find((entry) => modelCatalogEntryMatches(entry, draft?.modelAlias))
    ?? availableModels.find((entry) => modelCatalogEntryMatches(entry, catalog.data?.defaultModel));
  const contextOptions = selectedModel?.contextTokenOptions ?? [];
  const contextSelectValue = draft?.contextMode === 'PRESET' && draft.contextPresetId
    && contextOptions.includes(Number(draft.contextPresetId))
    ? `PRESET:${draft.contextPresetId}` : 'AUTO';
  useReportDirty('MODELS', handle.hasChanges);

  // Reasoning/context overrides stay collapsed by default; a session that
  // already carries non-default values opens the advanced block so active
  // overrides are never hidden.
  const advancedOverrides = Boolean(draft
    && ((draft.reasoningMode !== 'DEFAULT' && draft.reasoningMode != null) || draft.contextMode === 'PRESET'));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    if (advancedOverrides) setAdvancedOpen(true);
  }, [advancedOverrides]);

  const runActive = Boolean(activeRun && (activeRun.state === 'RUNNING' || activeRun.state === 'QUEUED'));
  // Service/project default model is read-only until a mutation contract exists.
  const defaultProject = props.context.projects[0];
  const preflight = useProjectSessionPreflight(defaultProject?.projectId ?? null, Boolean(props.context.capabilities) && Boolean(defaultProject));

  return (
    <>
      <ManagedModelPanel />

      <SettingSection
        title="模型目录"
        description="目录由 Service 返回。Desktop 不读取或保存模型密钥。"
        testId="models-section"
      >
        {catalog.isPending ? <SkeletonRows rows={2} /> : null}
        {catalog.isError ? (() => {
          const message = catalog.error instanceof Error ? catalog.error.message : String(catalog.error);
          const offline = message.includes('SERVICE_NOT_CONNECTED');
          return offline
            ? <UnavailableState title="模型目录不可用" message="Service 未连接；离线时不会显示旧目录。" reasonCode="SERVICE_NOT_CONNECTED" />
            : <SectionError message={`无法读取模型目录：${message}`} onRetry={() => void catalog.refetch()} />;
        })() : null}
        {catalog.data && (catalog.data.items ?? []).length === 0 ? <EmptyState message="Service 没有返回任何模型。" /> : null}
        <ul className="settings-model-list" data-testid="model-catalog">
          {(catalog.data?.items ?? []).map((entry) => (
            <li key={entry.modelAlias} data-testid={`model-entry-${entry.modelAlias}`}>
              <details className="settings-model-details">
                <summary className="settings-model-head">
                  <strong className="settings-model-alias">{entry.modelAlias}</strong>
                  {entry.providerDisplayName ? <span className="run-meta">{entry.providerDisplayName}</span> : null}
                  <span className={`settings-badge model-${entry.availability}`} data-testid={`model-availability-${entry.modelAlias}`}>
                    {MODEL_AVAILABILITY_LABELS[entry.availability] ?? entry.availability}
                  </span>
                </summary>
                <div className="settings-model-detail-body">
                  <p className="run-meta">
                    {entry.providerDisplayName ? `提供商：${entry.providerDisplayName}` : null}
                    {entry.protocol ? ` · API：${entry.protocol}` : null}
                    {entry.routePolicyName ? ` · 路由策略：${entry.routePolicyName}` : null}
                    {entry.maxContextLevel ? ` · 最大上下文：${entry.maxContextLevel} tokens` : null}
                  </p>
                  {entry.capabilities && entry.capabilities.length > 0 ? (
                    <p className="run-meta">能力：{entry.capabilities.map(capabilityLabel).join('、')}</p>
                  ) : null}
                  {entry.reasoningEffortOptions && entry.reasoningEffortOptions.length > 0 ? (
                    <p className="run-meta">推理力度选项：{entry.reasoningEffortOptions.join('、')}</p>
                  ) : null}
                  {entry.contextTokenOptions && entry.contextTokenOptions.length > 0 ? (
                    <p className="run-meta">上下文选项：{entry.contextTokenOptions.map(contextLabel).join('、')}</p>
                  ) : null}
                </div>
              </details>
            </li>
          ))}
        </ul>

        <SettingRow
          label="Service 默认模型"
          scope="SERVICE_INSTANCE"
          mutability="READ_ONLY"
          source="项目 preflight"
          effective={preflight.data ? (preflight.data.modelAlias ?? '继承默认') : '—'}
          testId="service-default-model"
          advanced={<span className="run-meta">可用性：{preflight.data?.modelAvailability ?? '—'}</span>}
        >
          <span className="run-meta">暂无修改契约，只读</span>
        </SettingRow>

        {catalog.data && (catalog.data.items ?? []).some((entry) => entry.availability === 'UNCONFIGURED') ? (
          <p className="settings-guide" data-testid="model-unconfigured-guide">
            当前 Service 存在尚未配置的模型。可在下方提供商管理中设置凭据，保存后立即生效，无需重启；
            环境变量型凭据的取值仍随 Service 进程环境，改变量本身需重启 Service。Desktop 不会读取或保存模型密钥。
          </p>
        ) : null}
      </SettingSection>

      <SettingSection
        title="当前会话模型"
        description="修改写入当前会话设置；空闲会话下次请求直接使用，活动 Run 在当前调用和工具处理完成后的下一个安全请求边界生效。留空表示使用 Service/项目默认。推理强度和上下文长度只能从目标模型声明的选项中选择。"
        testId="session-model-section"
      >
        {session ? (
          <>
            {runActive ? (
              <p className="settings-hint" data-testid="session-model-locked">
                会话有活动中的 Run（{activeRun?.runId.slice(0, 8)}）；当前调用保持原配置，修改将在当前调用和工具处理完成后的下一个安全请求边界生效。
              </p>
            ) : null}
            <SettingRow
              label="会话模型"
              scope="SESSION"
              source="目录"
              applyMode="NEXT_SAFE_REQUEST"
              mutability="EDITABLE"
              effective={draft?.modelAlias ?? '使用默认'}
              testId="session-model-edit"
              advanced={session ? <span className="run-meta">expectedSessionVersion: {session.sessionVersion}</span> : null}
            >
              <SettingSelect
                ariaLabel="当前会话模型"
                testId="session-model-select"
                value={draft?.modelAlias ?? ''}
                disabled={handle.saveState === 'SAVING' || availableModels.length === 0}
                options={[
                  { value: '', label: '使用默认' },
                  ...availableModels.map((entry) => ({ value: entry.modelAlias, label: entry.modelAlias }))
                ]}
                onChange={(value) => {
                  handle.setField('modelAlias', value === '' ? null : value);
                  handle.setField('providerId', null);
                  handle.setField('catalogRevision', null);
                  // A model change may invalidate both dependent option lists;
                  // require an explicit choice from the new model's catalog.
                  handle.setField('reasoningOptionId', null);
                  handle.setField('contextMode', 'AUTO');
                  handle.setField('contextPresetId', null);
                }}
              />
            </SettingRow>
            <details
              className="settings-advanced"
              data-testid="session-model-advanced"
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
            >
              <summary>高级选项（思考强度、上下文长度；默认随模型）</summary>
              <div className="settings-advanced-body">
            <SettingRow
              label="思考强度"
              scope="SESSION"
              source="目标模型 profile"
              applyMode="NEXT_SAFE_REQUEST"
              mutability="EDITABLE"
              effective={draft?.reasoningMode === 'EFFORT' ? (draft.reasoningOptionId ?? '默认档位') : (draft?.reasoningMode ?? 'DEFAULT')}
              testId="session-reasoning-edit"
              advanced={<span className="run-meta">选项来自目标模型 profile；不支持的档位不会发送到供应商。</span>}
            >
              <div className="settings-control-stack">
                <SettingSelect
                  ariaLabel="会话思考模式"
                  testId="session-reasoning-mode"
                  value={draft?.reasoningMode ?? 'DEFAULT'}
                  disabled={handle.saveState === 'SAVING'}
                  options={[
                    { value: 'DEFAULT', label: '模型默认' },
                    { value: 'OFF', label: '关闭（若支持）' },
                    { value: 'EFFORT', label: '选择档位' }
                  ]}
                  onChange={(value) => handle.setField('reasoningMode', value as SessionModelDraft['reasoningMode'])}
                />
                {draft?.reasoningMode === 'EFFORT' ? (() => {
                  const options = selectedModel?.reasoningEffortOptions ?? [];
                  return <SettingSelect
                    ariaLabel="会话思考档位"
                    testId="session-reasoning-option"
                    value={draft.reasoningOptionId ?? options[0] ?? ''}
                    disabled={handle.saveState === 'SAVING' || options.length === 0}
                    options={options.map((value) => ({ value, label: value }))}
                    onChange={(value) => handle.setField('reasoningOptionId', value || null)}
                  />;
                })() : null}
              </div>
            </SettingRow>
            <SettingRow
              label="上下文长度"
              scope="SESSION"
              source="会话设置 / 模型能力上限"
              applyMode="NEXT_SAFE_REQUEST"
              mutability="EDITABLE"
              effective={draft?.contextMode === 'PRESET' && draft.contextPresetId
                ? contextLabel(Number(draft.contextPresetId)) : '自动'}
              testId="session-context-edit"
              advanced={<span className="run-meta">只能选择模型声明的上下文预设；不会改变供应商声明的物理窗口。</span>}
            >
              <div className="settings-control-stack">
                <SettingSelect
                  ariaLabel="会话上下文模式"
                  testId="session-context-mode"
                  value={contextSelectValue}
                  disabled={handle.saveState === 'SAVING'}
                  options={[{ value: 'AUTO', label: '自动（模型默认）' }, ...contextOptions.map((value) => ({
                    value: 'PRESET:' + String(value), label: contextLabel(value)
                  }))]}
                  onChange={(value) => {
                    if (value === 'AUTO') {
                      handle.setField('contextMode', 'AUTO');
                      handle.setField('contextPresetId', null);
                    } else {
                      handle.setField('contextMode', 'PRESET');
                      handle.setField('contextPresetId', value.slice('PRESET:'.length));
                    }
                  }}
                />
              </div>
            </SettingRow>
              </div>
            </details>
            {availableModels.length === 0 && !catalog.isPending && !catalog.isError ? (
              <p className="settings-hint">没有可用模型可选。请在提供商管理中配置凭据，保存后立即生效。</p>
            ) : null}
            {handle.saveState === 'CONFLICT' ? (
              <ConflictPanel
                serverValue={session.modelAlias ?? '使用默认'}
                draftValue={draft?.modelAlias ?? '使用默认'}
                onReload={() => {
                  handle.adoptServerState();
                  if (session) void queryClient.invalidateQueries({ queryKey: settingsKeys.session(session.sessionId) });
                }}
              />
            ) : null}
            {handle.errorMessage ? <SectionError message={friendlySaveError(handle.errorMessage)} /> : null}
            <SaveBar
              saveState={handle.saveState}
              hasChanges={handle.hasChanges}
              applyMode="NEXT_SAFE_REQUEST"
              saveSuccess={handle.saveSuccess}
              onSave={handle.save}
              onCancel={handle.discard}
              saveLabel="应用到会话"
            />
          </>
        ) : (
          <EmptyState message="未选择会话。当前会话模型属于会话作用域；先在左侧选择一个会话。" />
        )}
      </SettingSection>
    </>
  );
}
