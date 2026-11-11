/**
 * Managed model catalog panel (two-level: provider → models).
 *
 * This is the database-desired view from /api/v2/model-providers: FILE rows
 * are read-only provenance, DATABASE/OVERRIDE rows are editable, and every
 * write hot-applies immediately — the service re-assembles the effective
 * model context in place, no restart (desktop consolidation follow-up).
 * apiKey is write-only — the renderer sends it once and the service stores
 * it in the OS-protected store; responses only carry credentialConfigured.
 */

import { useState } from 'react';
import type {
  JsonValue,
  ManagedModel,
  ManagedModelProvider,
  ManagedModelProviderRequest,
  ManagedModelRequest,
  RemoteModelEntry,
  RemoteModelsProbeRequest,
  RemoteModelsProbeResponse
} from '../../../../../packages/protocol/src/index.js';
import { unwrap } from '../../queries';
import {
  EmptyState,
  SectionError,
  SettingSection,
  SettingSelect,
  SettingsDialog,
  SkeletonRows,
  UnavailableState
} from '../components';
import {
  CREDENTIAL_KIND_LABELS,
  MANAGED_SOURCE_LABELS,
  friendlySaveError
} from '../settingsPresentation';
import {
  useDeleteModelProvider,
  useDeleteProviderModel,
  useManagedModelProviders,
  useUpdateEnvironmentFeature,
  useUpsertModelProvider,
  useUpsertProviderModel
} from '../useSettingsQueries';

const DIALECT_OPTIONS = [
  { value: 'OPENAI_CHAT_COMPLETIONS', label: 'OpenAI Chat Completions' },
  { value: 'OPENAI_RESPONSES', label: 'OpenAI Responses' },
  { value: 'ANTHROPIC_MESSAGES', label: 'Anthropic Messages' }
];

interface ProviderDraft {
  providerId: string;
  displayName: string;
  dialect: string;
  baseUrl: string;
  apiVersion: string;
  betaHeaders: string;
  credentialKind: 'ENV' | 'SECRET';
  credentialEnvName: string;
  /** Write-only; blank keeps the stored credential. */
  apiKey: string;
  enabled: boolean;
  expectedRevision?: number;
  /** Snapshot of the stored row for unset-on-blank semantics. */
  stored: ManagedModelProvider | null;
}

interface ModelDraft {
  providerId: string;
  modelId: string;
  remoteModelId: string;
  displayName: string;
  capabilities: string;
  reasoningEfforts: string;
  thinkingMode: string;
  contextWindowTokens: string;
  maxOutputTokens: string;
  costTier: string;
  latencyTier: string;
  qualityTier: string;
  imageInputProfile: string;
  cacheTtls: string;
  reasoningWireJson: string;
  enabled: boolean;
  expectedRevision?: number;
  stored: ManagedModel | null;
}

const THINKING_MODE_OPTIONS = [
  { value: '', label: '（未设置）' },
  { value: 'NONE', label: 'NONE — 无推理控制' },
  { value: 'TOGGLE', label: 'TOGGLE — 开关式' },
  { value: 'ADAPTIVE', label: 'ADAPTIVE — 档位自适应' },
  { value: 'MANUAL_BUDGET', label: 'MANUAL_BUDGET — 显式 token 预算' }
];
const COST_TIER_OPTIONS = [
  { value: '', label: '（未设置）' },
  { value: 'ECONOMY', label: 'ECONOMY' },
  { value: 'BALANCED', label: 'BALANCED' },
  { value: 'PREMIUM', label: 'PREMIUM' }
];
const LATENCY_TIER_OPTIONS = [
  { value: '', label: '（未设置）' },
  { value: 'FAST', label: 'FAST' },
  { value: 'MODERATE', label: 'MODERATE' },
  { value: 'SLOW', label: 'SLOW' }
];
const QUALITY_TIER_OPTIONS = [
  { value: '', label: '（未设置）' },
  { value: 'BASIC', label: 'BASIC' },
  { value: 'SOLID', label: 'SOLID' },
  { value: 'FRONTIER', label: 'FRONTIER' }
];
const IMAGE_PROFILE_OPTIONS = [
  { value: '', label: '（未设置）' },
  { value: 'FIRST_PHASE_DEFAULT', label: 'FIRST_PHASE_DEFAULT' }
];

/**
 * Quick-add presets: bundle dialect + baseUrl so the common flow is
 * "pick provider, paste key, name the model". Custom stays available for
 * gateways/proxies; every other field keeps service defaults.
 * `models` are curated upstream suggestions rendered as selectable chips —
 * the service exposes no remote model-list endpoint, so they are
 * suggestions, not fetched truth; the custom input always remains.
 */
const PROVIDER_PRESETS = [
  // providerId 与常见部署中的既有记录对齐：选预设命中已有提供商时走更新路径。
  { key: 'commandcode', providerId: 'commandcode-chat', label: 'CommandCode', dialect: 'OPENAI_CHAT_COMPLETIONS', baseUrl: 'https://api.commandcode.ai/provider/v1', models: ['MiniMaxAI/MiniMax-M2.5', 'MiniMaxAI/MiniMax-M2.7', 'MiniMaxAI/MiniMax-M3', 'deepseek-v4.1-flash'] },
  { key: 'opencode-zen', providerId: 'opencode-zen', label: 'OpenCode Zen', dialect: 'OPENAI_RESPONSES', baseUrl: 'https://opencode.ai/zen/go/v1', models: ['deepseek-v4.1-flash'] },
  { key: 'openrouter', providerId: 'openrouter', label: 'OpenRouter', dialect: 'OPENAI_CHAT_COMPLETIONS', baseUrl: 'https://openrouter.ai/api/v1', models: ['openai/gpt-5', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'minimax/minimax-m2'] },
  { key: 'deepseek', providerId: 'deepseek', label: 'DeepSeek', dialect: 'OPENAI_CHAT_COMPLETIONS', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { key: 'kimi', providerId: 'kimi', label: 'Kimi（月之暗面）', dialect: 'OPENAI_CHAT_COMPLETIONS', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-0905-preview', 'kimi-latest', 'moonshot-v1-128k'] },
  { key: 'glm', providerId: 'glm', label: 'GLM（智谱）', dialect: 'OPENAI_CHAT_COMPLETIONS', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air'] },
  { key: 'minimax', providerId: 'minimax', label: 'MiniMax 官方', dialect: 'OPENAI_CHAT_COMPLETIONS', baseUrl: 'https://api.minimaxi.com/v1', models: ['MiniMax-M2.5', 'MiniMax-M2'] }
];

interface QuickDraft {
  /** 'preset:<key>' | 'provider:<providerId>' | 'custom' */
  target: string;
  apiKey: string;
  /** Selected suggested model, or CUSTOM_MODEL when typing a custom name. */
  modelPick: string;
  /** Free-text model name — used when no suggestion applies. */
  modelId: string;
  /** Custom endpoint only. */
  baseUrl: string;
  dialect: string;
}

const CUSTOM_MODEL = '__custom__';

const QUICK_EMPTY: QuickDraft = { target: 'preset:commandcode', apiKey: '', modelPick: '', modelId: '', baseUrl: '', dialect: 'OPENAI_CHAT_COMPLETIONS' };

const LOCAL_ID_PATTERN = /^[A-Za-z0-9._:\/-]+$/;

/**
 * Supply pool returned by the remote-models probe. Each upstream id maps to
 * a pick: `checked` marks it for import and `alias` is the LOCAL modelId it
 * will be registered as — one upstream model may be configured several
 * times under different aliases/configs (Open WebUI-style workspace
 * entries), so `alias` is editable and re-adding an already-registered
 * upstream id just picks a fresh alias.
 */
interface ProbePool {
  /** Target the probe ran against — stale if quickDraft.target changes. */
  target: string;
  models: RemoteModelEntry[];
  picks: Record<string, { checked: boolean; alias: string }>;
  filter: string;
}

function remoteModelMeta(model: RemoteModelEntry): string {
  const parts: string[] = [];
  if (model.contextWindowTokens != null && model.contextWindowTokens > 0) {
    parts.push(`上下文 ${model.contextWindowTokens >= 1000
      ? `${Math.round(model.contextWindowTokens / 1000)}K`
      : String(model.contextWindowTokens)}`);
  }
  const pricing = model.extras?.['pricing'] as Record<string, unknown> | undefined;
  const prompt = pricing?.['prompt'];
  const promptPrice = typeof prompt === 'string' ? Number(prompt)
    : typeof prompt === 'number' ? prompt : NaN;
  if (Number.isFinite(promptPrice) && promptPrice > 0) {
    parts.push(`$${(promptPrice * 1e6).toPrecision(3)}/M tokens`);
  }
  if (model.ownedBy) parts.push(model.ownedBy);
  return parts.join(' · ');
}

function customProviderId(baseUrl: string): string {
  try {
    const slug = new URL(baseUrl).hostname.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug ? `custom-${slug}` : '';
  } catch {
    return '';
  }
}

function providerDraftOf(provider: ManagedModelProvider | null): ProviderDraft {
  return {
    providerId: provider?.providerId ?? '',
    displayName: provider?.displayName ?? '',
    dialect: provider?.dialect ?? 'OPENAI_CHAT_COMPLETIONS',
    baseUrl: provider?.baseUrl ?? '',
    apiVersion: provider?.apiVersion ?? '',
    betaHeaders: provider?.betaHeaders ?? '',
    credentialKind: provider?.credentialKind === 'SECRET' ? 'SECRET' : 'ENV',
    credentialEnvName: provider?.credentialEnvName ?? '',
    apiKey: '',
    // A provider without models cannot be enabled: the merged catalog
    // validation rejects it, so new records start disabled and the user
    // enables the provider after adding its first model.
    enabled: provider?.enabled ?? false,
    expectedRevision: provider?.revision,
    stored: provider
  };
}

function modelDraftOf(providerId: string, model: ManagedModel | null): ModelDraft {
  return {
    providerId,
    modelId: model?.modelId ?? '',
    remoteModelId: model?.remoteModelId ?? '',
    displayName: model?.displayName ?? '',
    capabilities: (model?.capabilities ?? []).join(', '),
    reasoningEfforts: (model?.reasoningEffortOptions ?? []).join(', '),
    thinkingMode: model?.thinkingMode ?? '',
    contextWindowTokens: model?.contextWindowTokens != null ? String(model.contextWindowTokens) : '',
    maxOutputTokens: model?.maxOutputTokens != null ? String(model.maxOutputTokens) : '',
    costTier: model?.costTier ?? '',
    latencyTier: model?.latencyTier ?? '',
    qualityTier: model?.qualityTier ?? '',
    imageInputProfile: model?.imageInputProfile ?? '',
    cacheTtls: model?.cacheTtls ?? '',
    reasoningWireJson: model?.reasoningWire ? JSON.stringify(model.reasoningWire, null, 2) : '',
    enabled: model?.enabled ?? true,
    expectedRevision: model?.revision,
    stored: model
  };
}

function listField(value: string): string[] | undefined {
  const items = value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function numberField(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function ManagedModelPanel(): React.JSX.Element {
  const catalog = useManagedModelProviders(true);
  const upsertProvider = useUpsertModelProvider();
  const deleteProvider = useDeleteModelProvider();
  const upsertModel = useUpsertProviderModel();
  const deleteModel = useDeleteProviderModel();
  const updateFeature = useUpdateEnvironmentFeature();

  const [providerDraft, setProviderDraft] = useState<ProviderDraft | null>(null);
  const [modelDraft, setModelDraft] = useState<ModelDraft | null>(null);
  const [quickDraft, setQuickDraft] = useState<QuickDraft>(QUICK_EMPTY);
  /** null = follow the auto rule (checked only when no default exists). */
  const [quickSetDefault, setQuickSetDefault] = useState<boolean | null>(null);
  const [probePool, setProbePool] = useState<ProbePool | null>(null);
  const [probing, setProbing] = useState(false);
  const [listFilter, setListFilter] = useState('');
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  /** MODEL_IN_USE replacement prompt: which model takes over as default. */
  const [replacePrompt, setReplacePrompt] = useState<{
    kind: 'provider' | 'model';
    providerId: string;
    modelId?: string;
    revision?: number;
  } | null>(null);
  const [replaceChoice, setReplaceChoice] = useState('');

  const busy = upsertProvider.isPending || deleteProvider.isPending
    || upsertModel.isPending || deleteModel.isPending || updateFeature.isPending;

  const mutate = (action: Promise<unknown>, successText: string): void => {
    setFormError(null);
    setFormSuccess(null);
    void action.then(() => {
      setProviderDraft(null);
      setModelDraft(null);
      setArmedDelete(null);
      setReplacePrompt(null);
      setFormSuccess(successText);
    }).catch((failure) => {
      setFormError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  const submitProvider = (): void => {
    if (!providerDraft) return;
    const providerId = providerDraft.providerId.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(providerId)) {
      setFormError('提供商 ID 只能包含字母、数字、点、下划线与连字符');
      return;
    }
    const stored = providerDraft.stored;
    const unsetFields: string[] = [];
    const optional = (field: 'displayName' | 'apiVersion' | 'betaHeaders', draft: string, had: string | null | undefined): string | undefined => {
      const trimmed = draft.trim();
      if (!trimmed && had != null) unsetFields.push(field);
      return trimmed || undefined;
    };
    const body: ManagedModelProviderRequest = {
      dialect: providerDraft.dialect,
      baseUrl: providerDraft.baseUrl.trim(),
      credentialKind: providerDraft.credentialKind,
      displayName: optional('displayName', providerDraft.displayName, stored?.displayName),
      apiVersion: optional('apiVersion', providerDraft.apiVersion, stored?.apiVersion),
      betaHeaders: optional('betaHeaders', providerDraft.betaHeaders, stored?.betaHeaders),
      enabled: providerDraft.enabled,
      expectedRevision: providerDraft.expectedRevision
    };
    if (unsetFields.length > 0) body.unsetFields = unsetFields;
    if (providerDraft.credentialKind === 'ENV') {
      if (!providerDraft.credentialEnvName.trim()) {
        setFormError('环境变量凭据需要填写变量名');
        return;
      }
      body.credentialEnvName = providerDraft.credentialEnvName.trim();
    } else if (providerDraft.apiKey.trim()) {
      body.apiKey = providerDraft.apiKey.trim();
    } else if (providerDraft.expectedRevision === undefined) {
      setFormError('新建提供商选择加密存储时必须填写 API Key');
      return;
    }
    mutate(upsertProvider.mutateAsync({ providerId, body }), '已保存 · 立即生效');
  };

  /**
   * Remote supply probe: resolves the credential the same way submitQuick
   * would — a stored provider goes through {providerId} (apiKey overrides
   * for rotation), a fresh preset/custom goes through the draft request.
   * Succeeds into a checkable supply pool; failures land on formError with
   * the service's typed message (auth/unreachable/timeout/bad response).
   */
  const runProbe = (): void => {
    setFormError(null);
    setFormSuccess(null);
    const preset = PROVIDER_PRESETS.find((entry) => `preset:${entry.key}` === quickDraft.target);
    const existing = quickDraft.target.startsWith('provider:')
      ? providers.find((provider) => provider.providerId === quickDraft.target.slice('provider:'.length))
      : providers.find((provider) => provider.providerId === preset?.providerId);
    const isCustom = quickDraft.target === 'custom';
    const apiKey = quickDraft.apiKey.trim();
    const body: RemoteModelsProbeRequest = {};
    if (isCustom) {
      if (!quickDraft.baseUrl.trim()) {
        setFormError('自定义接入需要先填写 Base URL');
        return;
      }
      body.dialect = quickDraft.dialect;
      body.baseUrl = quickDraft.baseUrl.trim();
      if (apiKey) body.apiKey = apiKey;
    } else if (existing) {
      body.providerId = existing.providerId;
      if (apiKey) body.apiKey = apiKey;
    } else {
      if (!preset) {
        setFormError('请选择提供商');
        return;
      }
      body.dialect = preset.dialect;
      body.baseUrl = preset.baseUrl;
      if (apiKey) body.apiKey = apiKey;
    }
    const targetKey = quickDraft.target;
    const suggestions = preset?.models ?? [];
    const registered = new Set(
      (existing?.models ?? []).flatMap((model) => [model.modelId, model.remoteModelId]).filter(Boolean) as string[]);
    setProbing(true);
    void window.codeAgentDesktop.probeRemoteProviderModels(body).then((result) => {
      const unwrapped = unwrap(result) as RemoteModelsProbeResponse;
      const picks: ProbePool['picks'] = {};
      for (const model of unwrapped.models ?? []) {
        // Pre-check preset suggestions not yet registered; everything
        // else starts unchecked so importing stays a deliberate choice.
        const suggested = suggestions.length === 0 || suggestions.includes(model.id);
        picks[model.id] = {
          checked: suggested && !registered.has(model.id),
          alias: model.id
        };
      }
      setProbePool({ target: targetKey, models: unwrapped.models ?? [], picks, filter: '' });
    }).catch((failure) => {
      setProbePool(null);
      setFormError(failure instanceof Error ? failure.message : String(failure));
    }).finally(() => {
      setProbing(false);
    });
  };

  /** Alias for a re-add of an already-registered upstream id. */
  const freshAlias = (upstreamId: string, picks: ProbePool['picks'], provider?: ManagedModelProvider): string => {
    const taken = new Set<string>([
      ...(provider?.models ?? []).map((model) => model.modelId),
      ...Object.values(picks).map((pick) => pick.alias)
    ]);
    let suffix = 2;
    while (taken.has(`${upstreamId}-${suffix}`)) suffix += 1;
    return `${upstreamId}-${suffix}`;
  };

  /**
   * Pool import: register every checked upstream model under its editable
   * alias. New providers are created disabled first, enabled once at least
   * one model row exists; per-model failures are reported individually so
   * a partial import never reads as total success.
   */
  const submitPool = (pool: ProbePool): void => {
    setFormError(null);
    setFormSuccess(null);
    const checked = pool.models.filter((model) => pool.picks[model.id]?.checked);
    if (checked.length === 0) {
      setFormError('请在供应池中勾选要接入的模型');
      return;
    }
    for (const model of checked) {
      if (!LOCAL_ID_PATTERN.test(pool.picks[model.id].alias.trim())) {
        setFormError(`别名 ${pool.picks[model.id].alias.trim() || '（空）'} 只能包含字母、数字与 ._:/- 字符`);
        return;
      }
    }
    const preset = PROVIDER_PRESETS.find((entry) => `preset:${entry.key}` === quickDraft.target);
    const existing = quickDraft.target.startsWith('provider:')
      ? providers.find((provider) => provider.providerId === quickDraft.target.slice('provider:'.length))
      : providers.find((provider) => provider.providerId === preset?.providerId);
    const isCustom = quickDraft.target === 'custom';
    let providerId = existing?.providerId ?? preset?.providerId ?? '';
    if (isCustom) providerId = customProviderId(quickDraft.baseUrl);
    if (!providerId) {
      setFormError('请选择提供商');
      return;
    }
    const matched = providers.find((provider) => provider.providerId === providerId);
    const creatingNew = !matched;
    if (creatingNew && !quickDraft.apiKey.trim()) {
      setFormError('新建提供商需要 API Key（加密存储，只写入不回显）');
      return;
    }
    const makeDefault = (quickSetDefault ?? !catalog.data?.defaultModel);
    void (async () => {
      const failures: string[] = [];
      let createdRevision: number | undefined;
      if (creatingNew) {
        const created = await upsertProvider.mutateAsync({
          providerId,
          body: {
            dialect: preset?.dialect ?? quickDraft.dialect,
            baseUrl: (preset?.baseUrl ?? quickDraft.baseUrl).trim(),
            credentialKind: 'SECRET',
            apiKey: quickDraft.apiKey.trim(),
            displayName: preset?.label ?? providerId.replace(/^custom-/, ''),
            enabled: false
          }
        });
        createdRevision = created?.revision;
      } else if (quickDraft.apiKey.trim()) {
        await upsertProvider.mutateAsync({
          providerId,
          body: { apiKey: quickDraft.apiKey.trim(), enabled: matched.enabled, expectedRevision: matched.revision }
        });
      }
      let imported = 0;
      for (const model of checked) {
        const alias = pool.picks[model.id].alias.trim();
        const existingModel = matched?.models.find((item) => item.modelId === alias);
        try {
          await upsertModel.mutateAsync({
            providerId,
            modelId: alias,
            body: {
              remoteModelId: model.id,
              displayName: alias,
              contextWindowTokens: model.contextWindowTokens ?? undefined,
              enabled: true,
              expectedRevision: existingModel?.revision
            }
          });
          imported += 1;
        } catch (failure) {
          failures.push(`${alias}：${failure instanceof Error ? failure.message : String(failure)}`);
        }
      }
      if (creatingNew) {
        await upsertProvider.mutateAsync({
          providerId,
          body: { enabled: imported > 0, expectedRevision: createdRevision }
        });
      }
      if (makeDefault && imported > 0) {
        const first = pool.picks[checked[0].id].alias.trim();
        await updateFeature.mutateAsync({
          featureId: 'MODEL',
          entries: { defaultModel: `${providerId}:${first}` }
        });
      }
      return { imported, failures };
    })().then(({ imported, failures }) => {
      setProbePool(null);
      setQuickDraft((current) => ({ ...QUICK_EMPTY, target: current.target }));
      setQuickSetDefault(null);
      setFormSuccess(`已接入 ${imported}/${checked.length} 个模型到 ${providerId}${makeDefault && imported > 0 ? '（首个设为默认）' : ''} · 立即生效`);
      if (failures.length > 0) {
        setFormError(`部分模型接入失败：${failures.join('；')}`);
      }
    }).catch((failure) => {
      setFormError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  /**
   * Quick add: provider preset (or an existing provider) + API key + model
   * name. Everything else keeps service defaults; the full-parameter
   * dialogs below stay available for advanced cases.
   */
  const submitQuick = (): void => {
    if (probePool && probePool.target === quickDraft.target) {
      submitPool(probePool);
      return;
    }
    setFormError(null);
    setFormSuccess(null);
    const presetSuggestions = PROVIDER_PRESETS.find((entry) => `preset:${entry.key}` === quickDraft.target)?.models ?? [];
    const providerExists = Boolean(providers.find((provider) => provider.providerId === (
      quickDraft.target.startsWith('provider:') ? quickDraft.target.slice('provider:'.length)
        : (PROVIDER_PRESETS.find((entry) => `preset:${entry.key}` === quickDraft.target)?.providerId ?? ''))));
    const modelId = quickDraft.modelPick === '' && presetSuggestions.length > 0 && !providerExists
      ? presetSuggestions[0]
      : quickDraft.modelPick === '' || quickDraft.modelPick === CUSTOM_MODEL
        ? quickDraft.modelId.trim()
        : quickDraft.modelPick;
    const byId = (id: string) => providers.find((provider) => provider.providerId === id);
    const existing = quickDraft.target.startsWith('provider:')
      ? byId(quickDraft.target.slice('provider:'.length))
      : undefined;
    const preset = quickDraft.target.startsWith('preset:')
      ? PROVIDER_PRESETS.find((entry) => `preset:${entry.key}` === quickDraft.target)
      : undefined;
    const isCustom = quickDraft.target === 'custom';

    let providerId = existing?.providerId ?? preset?.providerId ?? '';
    if (isCustom) {
      providerId = customProviderId(quickDraft.baseUrl);
      if (!providerId) {
        setFormError('自定义接入需要有效的 Base URL，例如 https://api.example.com/v1');
        return;
      }
    }
    if (!providerId) {
      setFormError('请选择提供商');
      return;
    }
    const matched = byId(providerId);
    const creatingNew = !matched;
    if (modelId && !/^[A-Za-z0-9._:\/-]+$/.test(modelId)) {
      setFormError('模型名只能包含字母、数字与 ._:/- 字符');
      return;
    }
    if (!modelId && !quickDraft.apiKey.trim()) {
      setFormError(creatingNew ? '请填写模型名' : '至少填写 API Key 或模型名');
      return;
    }
    if (creatingNew && !modelId) {
      setFormError('请填写模型名');
      return;
    }
    if (creatingNew && !quickDraft.apiKey.trim()) {
      setFormError('新建提供商需要 API Key（加密存储，只写入不回显）');
      return;
    }
    const existingModel = modelId ? matched?.models.find((model) => model.modelId === modelId) : undefined;
    const makeDefault = modelId !== '' && (quickSetDefault ?? !catalog.data?.defaultModel);

    void (async () => {
      if (creatingNew) {
        // Create disabled first: catalog validation rejects an enabled
        // provider with no models — enable after the model row exists.
        const created = await upsertProvider.mutateAsync({
          providerId,
          body: {
            dialect: preset?.dialect ?? quickDraft.dialect,
            baseUrl: (preset?.baseUrl ?? quickDraft.baseUrl).trim(),
            credentialKind: 'SECRET',
            apiKey: quickDraft.apiKey.trim(),
            displayName: preset?.label ?? providerId.replace(/^custom-/, ''),
            enabled: false
          }
        });
        await upsertModel.mutateAsync({
          providerId,
          modelId,
          body: { remoteModelId: modelId, displayName: modelId, enabled: true }
        });
        await upsertProvider.mutateAsync({
          providerId,
          body: { enabled: true, expectedRevision: created?.revision }
        });
      } else {
        if (quickDraft.apiKey.trim()) {
          await upsertProvider.mutateAsync({
            providerId,
            body: { apiKey: quickDraft.apiKey.trim(), enabled: matched.enabled, expectedRevision: matched.revision }
          });
        }
        // Picking an already-enabled model is a no-op: re-upserting would
        // overwrite a custom displayName with the bare modelId.
        if (modelId && !(existingModel?.enabled && existingModel.displayName === modelId)) {
          await upsertModel.mutateAsync({
            providerId,
            modelId,
            body: { remoteModelId: modelId, displayName: modelId, enabled: true, expectedRevision: existingModel?.revision }
          });
        }
      }
      if (makeDefault) {
        await updateFeature.mutateAsync({
          featureId: 'MODEL',
          entries: { defaultModel: `${providerId}:${modelId}` }
        });
      }
    })().then(() => {
      setQuickDraft((current) => ({ ...QUICK_EMPTY, target: current.target }));
      setQuickSetDefault(null);
      setFormSuccess(`已保存并启用 ${providerId}${modelId ? ` / ${modelId}` : ''}${makeDefault ? '（已设为默认）' : ''} · 立即生效`);
    }).catch((failure) => {
      setFormError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  const submitModel = (): void => {
    if (!modelDraft) return;
    const modelId = modelDraft.modelId.trim();
    if (!/^[A-Za-z0-9._:\/-]+$/.test(modelId)) {
      setFormError('模型 ID 只能包含字母、数字与 ._:/- 字符');
      return;
    }
    const stored = modelDraft.stored;
    const unsetFields: string[] = [];
    const optional = (field: string, draft: string, had: unknown): string | undefined => {
      const trimmed = draft.trim();
      if (!trimmed && had != null) unsetFields.push(field);
      return trimmed || undefined;
    };
    let reasoningWire: Record<string, JsonValue> | undefined;
    if (modelDraft.reasoningWireJson.trim()) {
      try {
        const parsed = JSON.parse(modelDraft.reasoningWireJson) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setFormError('推理显示配置必须是 JSON 对象');
          return;
        }
        reasoningWire = parsed as Record<string, JsonValue>;
      } catch {
        setFormError('推理显示配置不是合法 JSON');
        return;
      }
    } else if (stored?.reasoningWire != null) {
      unsetFields.push('reasoningWire');
    }
    if (stored?.capabilities != null && stored.capabilities.length > 0
        && !modelDraft.capabilities.trim()) {
      unsetFields.push('capabilities');
    }
    if (stored?.reasoningEffortOptions != null && stored.reasoningEffortOptions.length > 0
        && !modelDraft.reasoningEfforts.trim()) {
      unsetFields.push('reasoningEfforts');
    }
    const body: ManagedModelRequest = {
      remoteModelId: optional('remoteModelId', modelDraft.remoteModelId, stored?.remoteModelId),
      displayName: optional('displayName', modelDraft.displayName, stored?.displayName),
      capabilities: listField(modelDraft.capabilities),
      reasoningEfforts: listField(modelDraft.reasoningEfforts),
      thinkingMode: optional('thinkingMode', modelDraft.thinkingMode, stored?.thinkingMode),
      contextWindowTokens: numberField(modelDraft.contextWindowTokens),
      maxOutputTokens: numberField(modelDraft.maxOutputTokens),
      costTier: optional('costTier', modelDraft.costTier, stored?.costTier),
      latencyTier: optional('latencyTier', modelDraft.latencyTier, stored?.latencyTier),
      qualityTier: optional('qualityTier', modelDraft.qualityTier, stored?.qualityTier),
      imageInputProfile: optional('imageInputProfile', modelDraft.imageInputProfile, stored?.imageInputProfile),
      cacheTtls: optional('cacheTtls', modelDraft.cacheTtls, stored?.cacheTtls),
      reasoningWire,
      enabled: modelDraft.enabled,
      expectedRevision: modelDraft.expectedRevision
    };
    if (stored?.contextWindowTokens != null && !modelDraft.contextWindowTokens.trim()) {
      unsetFields.push('contextWindowTokens');
    }
    if (stored?.maxOutputTokens != null && !modelDraft.maxOutputTokens.trim()) {
      unsetFields.push('maxOutputTokens');
    }
    if (unsetFields.length > 0) body.unsetFields = unsetFields;
    mutate(upsertModel.mutateAsync({ providerId: modelDraft.providerId, modelId, body }),
      '已保存 · 立即生效');
  };

  const confirmDelete = (key: string, action: () => Promise<unknown>,
                         target?: { kind: 'provider' | 'model'; providerId: string; modelId?: string; revision?: number }): void => {
    if (armedDelete === key) {
      setFormError(null);
      setFormSuccess(null);
      void action().then(() => {
        setProviderDraft(null);
        setModelDraft(null);
        setArmedDelete(null);
        setFormSuccess('已删除 · 立即生效');
      }).catch((failure) => {
        setArmedDelete(null);
        const message = failure instanceof Error ? failure.message : String(failure);
        // MODEL_IN_USE: the row backs the default ref — offer an
        // explicit replacement rather than failing dead (design S05).
        if (message.includes('MODEL_IN_USE') && target) {
          setReplacePrompt(target);
          setReplaceChoice('');
          setFormError('该条目仍是默认模型引用。请选择接管默认值的模型后重试删除。');
          return;
        }
        setFormError(message);
      });
    } else {
      setArmedDelete(key);
    }
  };

  /** Other usable models the default can move to. */
  const replaceCandidates = (): Array<{ ref: string; label: string }> => {
    const candidates: Array<{ ref: string; label: string }> = [];
    for (const provider of catalog.data?.providers ?? []) {
      if (!provider.enabled) continue;
      for (const model of provider.models) {
        if (!model.enabled) continue;
        if (replacePrompt?.kind === 'provider' && provider.providerId === replacePrompt.providerId) continue;
        if (replacePrompt?.kind === 'model'
            && provider.providerId === replacePrompt.providerId
            && model.modelId === replacePrompt.modelId) continue;
        candidates.push({
          ref: `${provider.providerId}:${model.modelId}`,
          label: `${provider.displayName ?? provider.providerId} / ${model.displayName ?? model.modelId}`
        });
      }
    }
    return candidates;
  };

  const confirmReplace = (): void => {
    if (!replacePrompt || !replaceChoice) return;
    const action = replacePrompt.kind === 'provider'
      ? deleteProvider.mutateAsync({
          providerId: replacePrompt.providerId,
          expectedRevision: replacePrompt.revision,
          replaceDefault: replaceChoice
        })
      : deleteModel.mutateAsync({
          providerId: replacePrompt.providerId,
          modelId: replacePrompt.modelId ?? '',
          expectedRevision: replacePrompt.revision,
          replaceDefault: replaceChoice
        });
    mutate(action, '已删除并替换默认模型 · 立即生效');
  };

  const setDefault = (providerId: string, model: ManagedModel): void => {
    setFormError(null);
    setFormSuccess(null);
    // The default ref lives on the MODEL feature row (composite
    // providerId:modelKey storage); revision is intentionally omitted —
    // the service applies the write against the current row.
    void updateFeature.mutateAsync({
      featureId: 'MODEL',
      entries: { defaultModel: `${providerId}:${model.modelId}` }
    }).then(() => {
      setFormSuccess(`默认模型已设为 ${providerId}:${model.modelId} · 立即生效`);
    }).catch((failure) => {
      setFormError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  const providers = catalog.data?.providers ?? [];
  const filterQuery = listFilter.trim().toLowerCase();
  const filteredProviders = filterQuery
    ? providers.flatMap((provider) => {
        const providerHit = provider.providerId.toLowerCase().includes(filterQuery)
          || (provider.displayName ?? '').toLowerCase().includes(filterQuery);
        const models = provider.models.filter((model) =>
          providerHit
          || model.modelId.toLowerCase().includes(filterQuery)
          || (model.displayName ?? '').toLowerCase().includes(filterQuery)
          || (model.remoteModelId ?? '').toLowerCase().includes(filterQuery));
        return providerHit || models.length > 0 ? [{ ...provider, models }] : [];
      })
    : providers;
  const dialogOpen = providerDraft != null || modelDraft != null || replacePrompt != null;
  const modelProvider = modelDraft
    ? providers.find((provider) => provider.providerId === modelDraft.providerId)
    : undefined;

  return (
    <SettingSection
      title="提供商与模型管理"
      description="快速接入：勾选渠道、粘贴 Key、选常用模型即可启用，其余参数取服务默认值。列表与「完整参数」对话框提供协议、地址、能力、档位等全部选项。API Key 只写入不显示，保存后立即生效。"
      testId="managed-models-section"
      actions={catalog.data ? (
        <button
          type="button"
          className="secondary-button"
          data-testid="provider-add-open"
          disabled={busy}
          onClick={() => { setFormError(null); setProviderDraft(providerDraftOf(null)); setModelDraft(null); }}
        >
          添加提供商（完整参数）
        </button>
      ) : undefined}
    >
      {catalog.isPending ? <SkeletonRows rows={2} /> : null}
      {catalog.isError ? (() => {
        const message = catalog.error instanceof Error ? catalog.error.message : String(catalog.error);
        const offline = message.includes('SERVICE_NOT_CONNECTED')
          || (catalog.error as (Error & { code?: string }) | null | undefined)?.code === 'SERVICE_NOT_CONNECTED';
        return offline
          ? <UnavailableState title="模型目录不可用" message="Service 未连接；离线时不显示旧目录。" reasonCode="SERVICE_NOT_CONNECTED" />
          : <SectionError message={`无法读取模型目录：${message}`} onRetry={() => void catalog.refetch()} />;
      })() : null}
      {catalog.data && providers.length === 0 ? <EmptyState message="还没有提供商。添加一个以启用模型。" /> : null}
      {catalog.data?.overlayError ? (
        <SectionError message={`数据库覆盖配置未生效，正在使用文件配置：${catalog.data.overlayError}`} />
      ) : null}
      {catalog.data ? (
        <p className="run-meta" data-testid="managed-default-model">
          默认模型：{catalog.data.defaultModel ?? '未设置'} · 目录修订：{catalog.data.revision}
        </p>
      ) : null}
      {formSuccess ? <p className="settings-hint" data-testid="managed-save-success">{formSuccess}</p> : null}
      {formError && !dialogOpen ? <SectionError message={friendlySaveError(formError)} /> : null}

      {catalog.data ? (() => {
        const quickPreset = PROVIDER_PRESETS.find((entry) => `preset:${entry.key}` === quickDraft.target);
        const quickPresetProvider = quickPreset
          ? providers.find((provider) => provider.providerId === quickPreset.providerId)
          : undefined;
        const quickProvider = quickDraft.target.startsWith('provider:')
          ? providers.find((provider) => provider.providerId === quickDraft.target.slice('provider:'.length))
          : undefined;
        const modelChoices = quickPreset ? quickPreset.models
          : quickProvider ? quickProvider.models.map((model) => model.modelId) : [];
        // Existing provider (direct or preset match): the model row is
        // optional — picking 不改动 leaves models untouched.
        const modelOptional = Boolean(quickProvider ?? quickPresetProvider);
        const showModelChips = quickDraft.target !== 'custom';
        const showModelInput = quickDraft.target === 'custom' || quickDraft.modelPick === CUSTOM_MODEL;
        const setDefaultEffective = quickSetDefault ?? !catalog.data.defaultModel;
        // '' means "leave models untouched" when the provider exists, and
        // resolves to the first suggestion when the provider is new.
        const effectiveModelPick = quickDraft.modelPick === '' && !modelOptional && modelChoices.length > 0
          ? modelChoices[0] : quickDraft.modelPick;
        const pickTarget = (target: string) => {
          setQuickDraft({ ...quickDraft, target, modelPick: '', modelId: '' });
          setProbePool(null);
        };
        const pool = probePool && probePool.target === quickDraft.target ? probePool : null;
        const poolProvider = quickPreset
          ? providers.find((provider) => provider.providerId === quickPreset.providerId)
          : quickProvider;
        const registeredUpstream = new Set(
          (poolProvider?.models ?? [])
            .flatMap((model) => [model.modelId, model.remoteModelId])
            .filter(Boolean) as string[]);
        const poolFiltered = pool
          ? pool.models.filter((model) => {
              const query = pool.filter.trim().toLowerCase();
              if (!query) return true;
              return model.id.toLowerCase().includes(query)
                || (model.displayName ?? '').toLowerCase().includes(query)
                || (model.ownedBy ?? '').toLowerCase().includes(query);
            })
          : [];
        const poolCheckedCount = pool
          ? pool.models.filter((model) => pool.picks[model.id]?.checked).length
          : 0;
        return (
        <div className="settings-provider-card settings-quick-card" data-testid="quick-add-card">
          <div className="settings-model-head">
            <strong>快速接入</strong>
            <span className="settings-badge">勾选渠道 → 粘贴 Key → 探测 → 勾选接入</span>
          </div>
          <div className="settings-quick-grid">
            <label className="settings-field">
              <span>渠道</span>
              <SettingSelect
                ariaLabel="接入渠道"
                testId="quick-target"
                value={quickDraft.target}
                disabled={busy}
                options={[
                  ...PROVIDER_PRESETS.map((preset) => ({ value: `preset:${preset.key}`, label: preset.label })),
                  ...providers.map((provider) => ({ value: `provider:${provider.providerId}`, label: `已有 · ${provider.displayName ?? provider.providerId}` })),
                  { value: 'custom', label: '自定义接入…' }
                ]}
                onChange={(target) => pickTarget(target)}
              />
            </label>
          </div>
          <p className="run-meta" data-testid="quick-target-hint">
            {quickPreset ? `${quickPreset.dialect} · ${quickPreset.baseUrl}` : ''}
            {quickProvider ? `已有提供商 · ${quickProvider.dialect} · ${quickProvider.baseUrl || '未设置地址'}` : ''}
          </p>
          <div className="settings-quick-grid">
            <label className="settings-field">
              <span>API Key</span>
              <input
                type="password"
                data-testid="quick-api-key"
                value={quickDraft.apiKey}
                disabled={busy || probing}
                autoComplete="off"
                onChange={(event) => setQuickDraft({ ...quickDraft, apiKey: event.target.value })}
                placeholder={modelOptional ? '留空则用已存密钥探测' : '粘贴密钥'}
              />
            </label>
          </div>
          {quickDraft.target === 'custom' ? (
            <div className="settings-quick-grid">
              <label className="settings-field">
                <span>Base URL</span>
                <input
                  data-testid="quick-baseurl"
                  value={quickDraft.baseUrl}
                  disabled={busy}
                  onChange={(event) => setQuickDraft({ ...quickDraft, baseUrl: event.target.value })}
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label className="settings-field">
                <span>接口协议</span>
                <SettingSelect
                  ariaLabel="接口协议"
                  testId="quick-dialect"
                  value={quickDraft.dialect}
                  disabled={busy}
                  options={DIALECT_OPTIONS}
                  onChange={(value) => setQuickDraft({ ...quickDraft, dialect: value })}
                />
              </label>
            </div>
          ) : null}
          <div className="settings-feature-actions">
            <button
              type="button"
              className="secondary-button"
              data-testid="quick-probe"
              disabled={busy || probing || (quickDraft.target === 'custom' && !quickDraft.baseUrl.trim())}
              title="用该密钥向渠道查询真实模型列表；已有提供商留空 Key 时使用已存密钥"
              onClick={runProbe}
            >
              {probing ? '正在探测…' : '探测模型列表'}
            </button>
          </div>
          {pool ? (
            <div className="settings-pool" data-testid="quick-pool">
              <div className="settings-model-head">
                <strong>供应池 · {pool.models.length} 个模型</strong>
                {pool.models.length > 8 ? (
                  <input
                    className="settings-pool-filter"
                    data-testid="quick-pool-filter"
                    value={pool.filter}
                    disabled={busy}
                    placeholder="搜索模型…"
                    onChange={(event) => setProbePool({ ...pool, filter: event.target.value })}
                  />
                ) : null}
              </div>
              <ul className="settings-pool-list">
                {poolFiltered.map((model) => {
                  const pick = pool.picks[model.id] ?? { checked: false, alias: model.id };
                  const registered = registeredUpstream.has(model.id);
                  const meta = remoteModelMeta(model);
                  return (
                    <li key={model.id} className="settings-pool-row" data-testid={`pool-model-${model.id.replace(/[^A-Za-z0-9._-]+/g, '-')}`}>
                      <label className="settings-pool-check">
                        <input
                          type="checkbox"
                          checked={pick.checked}
                          disabled={busy}
                          onChange={(event) => setProbePool({
                            ...pool,
                            picks: { ...pool.picks, [model.id]: { ...pick, checked: event.target.checked } }
                          })}
                        />
                        <span className="settings-pool-id" title={meta || undefined}>{model.id}</span>
                        {meta ? <span className="run-meta settings-pool-meta">{meta}</span> : null}
                        {registered ? <span className="settings-badge">已注册</span> : null}
                      </label>
                      {pick.checked ? (
                        <input
                          className="settings-pool-alias"
                          data-testid={`pool-alias-${model.id.replace(/[^A-Za-z0-9._-]+/g, '-')}`}
                          value={pick.alias}
                          disabled={busy}
                          title="本地别名（模型 ID，创建后不可改）；上游名保持探测结果"
                          onChange={(event) => setProbePool({
                            ...pool,
                            picks: { ...pool.picks, [model.id]: { ...pick, alias: event.target.value } }
                          })}
                        />
                      ) : null}
                      {registered ? (
                        <button type="button" className="settings-pool-again"
                          data-testid={`pool-again-${model.id.replace(/[^A-Za-z0-9._-]+/g, '-')}`}
                          disabled={busy}
                          title="同一上游模型再配一份：新别名 + 独立配置"
                          onClick={() => setProbePool({
                            ...pool,
                            picks: {
                              ...pool.picks,
                              [model.id]: { checked: true, alias: freshAlias(model.id, pool.picks, poolProvider) }
                            }
                          })}
                        >
                          ＋再配一份
                        </button>
                      ) : null}
                    </li>
                  );
                })}
                {poolFiltered.length === 0 ? (
                  <li className="run-meta">供应池内没有匹配「{pool.filter}」的模型。</li>
                ) : null}
              </ul>
            </div>
          ) : showModelChips ? (
            <div className="settings-quick-grid">
              <label className="settings-field">
                <span>模型（内置建议）</span>
                <SettingSelect
                  ariaLabel="选择模型"
                  testId="quick-model-choices"
                  value={effectiveModelPick === '' && modelOptional ? '__none__' : effectiveModelPick}
                  disabled={busy}
                  options={[
                    ...(modelOptional ? [{ value: '__none__', label: '不改动模型' }] : []),
                    ...modelChoices.map((modelName) => ({ value: modelName, label: modelName })),
                    { value: CUSTOM_MODEL, label: '自定义…' }
                  ]}
                  onChange={(value) => setQuickDraft({ ...quickDraft, modelPick: value === '__none__' ? '' : value })}
                />
              </label>
            </div>
          ) : null}
          {showModelInput ? (
            <label className="settings-field">
              <span>{quickDraft.target === 'custom' ? '模型名' : '自定义模型名'}</span>
              <input
                data-testid="quick-model-id"
                value={quickDraft.modelId}
                disabled={busy}
                onChange={(event) => setQuickDraft({ ...quickDraft, modelId: event.target.value })}
                placeholder={quickPreset ? `如 ${quickPreset.models.join(' / ')}` : '提供商侧模型名'}
              />
            </label>
          ) : null}
          <div className="settings-feature-actions">
            <button
              type="button"
              className="primary-button"
              data-testid="quick-save"
              disabled={busy || probing || (pool != null && poolCheckedCount === 0)}
              onClick={submitQuick}
            >
              {pool != null ? `接入勾选的 ${poolCheckedCount} 个` : '保存并启用'}
            </button>
            <label className="settings-field-inline">
              <input
                type="checkbox"
                data-testid="quick-set-default"
                checked={setDefaultEffective}
                disabled={busy}
                onChange={(event) => setQuickSetDefault(event.target.checked)}
              />
              <span>接入后设为默认模型</span>
            </label>
          </div>
          <p className="run-meta">
            「探测模型列表」向渠道拉取真实供应列表；部分渠道目录不鉴权（探测成功代表渠道可达、目录可读，密钥有效性仍需首次调用确认）。勾选后按本地别名接入；已有提供商留空 Key 用已存密钥探测。能力信息以渠道返回为准（多数渠道只给模型 ID 与上下文），缺项保存后走「完整参数」补。也可以不探测直接勾建议模型接入。
          </p>
        </div>
        );
      })() : null}

      {replacePrompt ? (
        <SettingsDialog
          title="选择接管默认值的模型"
          role="alertdialog"
          eyebrow="模型目录"
          description={replacePrompt.kind === 'provider'
            ? `删除提供商 ${replacePrompt.providerId} 会移除当前默认模型，删除前需要指定新的默认模型。`
            : `模型 ${replacePrompt.modelId} 是当前默认模型，删除前需要指定新的默认模型。`}
          testId="replace-default-form"
          onClose={() => { setReplacePrompt(null); setFormError(null); }}
          footer={(
            <>
              <button type="button" data-testid="replace-default-cancel" disabled={busy}
                onClick={() => { setReplacePrompt(null); setFormError(null); }}>取消</button>
              <button type="button" className="danger-button" data-testid="replace-default-confirm"
                disabled={busy || !replaceChoice}
                onClick={confirmReplace}>删除并替换默认</button>
            </>
          )}
        >
          {formError ? <SectionError message={friendlySaveError(formError)} /> : null}
          <label className="settings-field">
            <span>新默认模型</span>
            <SettingSelect
              ariaLabel="新默认模型"
              testId="replace-default-select"
              value={replaceChoice}
              disabled={busy}
              options={[
                { value: '', label: '（请选择）' },
                ...replaceCandidates().map((candidate) => ({ value: candidate.ref, label: candidate.label }))
              ]}
              onChange={setReplaceChoice}
            />
          </label>
        </SettingsDialog>
      ) : null}

      {providerDraft ? (
        <SettingsDialog
          title={providerDraft.expectedRevision === undefined ? '添加提供商' : '编辑提供商'}
          eyebrow="模型目录 · 提供商"
          description="接口协议、地址与凭据写入 Service 数据库，保存后立即生效。API Key 只写入不显示。"
          meta={providerDraft.stored ? (
            <span className="settings-badge">提供商 ID：{providerDraft.providerId}</span>
          ) : undefined}
          testId="provider-form"
          onClose={() => { setProviderDraft(null); setFormError(null); }}
          footer={(
            <>
              <button type="button" data-testid="provider-form-cancel" disabled={busy}
                onClick={() => { setProviderDraft(null); setFormError(null); }}>取消</button>
              <button type="button" className="primary-button" data-testid="provider-form-save" disabled={busy}
                onClick={submitProvider}>保存</button>
            </>
          )}
        >
          {formError ? <SectionError message={friendlySaveError(formError)} /> : null}
          <label className="settings-field">
            <span>提供商 ID</span>
            <input
              data-testid="provider-id-input"
              value={providerDraft.providerId}
              disabled={providerDraft.expectedRevision !== undefined || busy}
              onChange={(event) => setProviderDraft({ ...providerDraft, providerId: event.target.value })}
              placeholder="例如 provider-a"
            />
          </label>
          <label className="settings-field">
            <span>显示名</span>
            <input
              data-testid="provider-name-input"
              value={providerDraft.displayName}
              disabled={busy}
              onChange={(event) => setProviderDraft({ ...providerDraft, displayName: event.target.value })}
            />
          </label>
          <label className="settings-field">
            <span>接口协议</span>
            <SettingSelect
              ariaLabel="接口协议"
              testId="provider-dialect-select"
              value={providerDraft.dialect}
              disabled={busy}
              options={DIALECT_OPTIONS}
              onChange={(value) => setProviderDraft({ ...providerDraft, dialect: value })}
            />
          </label>
          <label className="settings-field">
            <span>Base URL</span>
            <input
              data-testid="provider-baseurl-input"
              value={providerDraft.baseUrl}
              disabled={busy}
              onChange={(event) => setProviderDraft({ ...providerDraft, baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label className="settings-field">
            <span>凭据方式</span>
            <SettingSelect
              ariaLabel="凭据方式"
              testId="provider-credential-kind"
              value={providerDraft.credentialKind}
              disabled={busy}
              options={[
                { value: 'ENV', label: '环境变量引用' },
                { value: 'SECRET', label: '系统加密存储（写入后不显示）' }
              ]}
              onChange={(value) => setProviderDraft({ ...providerDraft, credentialKind: value as 'ENV' | 'SECRET' })}
            />
          </label>
          {providerDraft.credentialKind === 'ENV' ? (
            <label className="settings-field">
              <span>环境变量名</span>
              <input
                data-testid="provider-env-name"
                value={providerDraft.credentialEnvName}
                disabled={busy}
                onChange={(event) => setProviderDraft({ ...providerDraft, credentialEnvName: event.target.value })}
                placeholder="例如 PROVIDER_A_API_KEY"
              />
            </label>
          ) : (
            <label className="settings-field">
              <span>API Key（只写入，不回显）</span>
              <input
                type="password"
                data-testid="provider-api-key"
                value={providerDraft.apiKey}
                disabled={busy}
                autoComplete="off"
                onChange={(event) => setProviderDraft({ ...providerDraft, apiKey: event.target.value })}
                placeholder={providerDraft.expectedRevision === undefined ? '粘贴密钥' : '留空保持不变'}
              />
            </label>
          )}
          <details className="settings-advanced">
            <summary>高级配置</summary>
            <div className="settings-advanced-body">
              <label className="settings-field">
                <span>API 版本（可选，如 2024-10-21）</span>
                <input
                  data-testid="provider-apiversion-input"
                  value={providerDraft.apiVersion}
                  disabled={busy}
                  onChange={(event) => setProviderDraft({ ...providerDraft, apiVersion: event.target.value })}
                />
              </label>
              <label className="settings-field">
                <span>Beta 头（可选，逗号分隔）</span>
                <input
                  data-testid="provider-betaheaders-input"
                  value={providerDraft.betaHeaders}
                  disabled={busy}
                  onChange={(event) => setProviderDraft({ ...providerDraft, betaHeaders: event.target.value })}
                  placeholder="例如 context-1m-2025-08-07"
                />
              </label>
            </div>
          </details>
          <label className="settings-field-inline">
            <input
              type="checkbox"
              data-testid="provider-enabled"
              checked={providerDraft.enabled}
              disabled={busy}
              onChange={(event) => setProviderDraft({ ...providerDraft, enabled: event.target.checked })}
            />
            <span>启用该提供商</span>
          </label>
          {providerDraft.expectedRevision === undefined ? (
            <p className="settings-field-hint">提供商需要先添加至少一个模型才能启用；可先保存为停用状态。</p>
          ) : null}
        </SettingsDialog>
      ) : null}

      {providers.length > 0 ? (
        <input
          className="settings-pool-filter settings-list-filter"
          data-testid="provider-list-filter"
          value={listFilter}
          disabled={busy}
          placeholder="过滤提供商 / 模型 / 别名…"
          onChange={(event) => setListFilter(event.target.value)}
        />
      ) : null}
      <ul className="settings-provider-list" data-testid="provider-list">
        {filteredProviders.map((provider) => (
          <li key={provider.providerId} className="settings-provider-card" data-testid={`provider-${provider.providerId}`}>
            <details className="settings-model-details">
              <summary className="settings-model-head">
                <strong>{provider.displayName ?? provider.providerId}</strong>
                <span className="settings-badge">{provider.providerId}</span>
                <span className={`settings-badge ${provider.enabled ? 'feature-state-READY' : 'feature-state-NOT_ENABLED'}`}>
                  {provider.enabled ? '启用' : '停用'}
                </span>
                <span className="settings-badge" data-testid={`provider-credential-${provider.providerId}`}>
                  {CREDENTIAL_KIND_LABELS[provider.credentialKind] ?? provider.credentialKind}
                  {provider.credentialKind === 'NONE' ? '' : provider.credentialConfigured ? ' · 已配置' : ' · 未配置'}
                </span>
                <span className="settings-badge">{MANAGED_SOURCE_LABELS[provider.source] ?? provider.source}</span>
                <span className="run-meta">模型 · {provider.models.length}</span>
                {provider.pendingRestart ? <span className="settings-badge apply-SERVICE_RESTART">待生效</span> : null}
              </summary>
            <p className="run-meta">
              协议：{provider.dialect} · 地址：{provider.baseUrl || '未设置'}
              {provider.credentialKind === 'ENV' && provider.credentialEnvName ? ` · 环境变量：${provider.credentialEnvName}` : ''}
            </p>
            <div className="settings-feature-actions">
              <button type="button" className="secondary-button" data-testid={`provider-edit-${provider.providerId}`}
                disabled={busy}
                onClick={() => { setFormError(null); setProviderDraft(providerDraftOf(provider)); setModelDraft(null); }}>
                编辑
              </button>
              <button
                type="button"
                className={armedDelete === `provider:${provider.providerId}` ? 'danger-button' : 'secondary-button'}
                data-testid={`provider-delete-${provider.providerId}`}
                disabled={busy || provider.source === 'FILE'}
                title={provider.source === 'FILE' ? '文件配置的提供商只能在配置文件中删除，可在编辑中停用' : undefined}
                onClick={() => confirmDelete(`provider:${provider.providerId}`,
                  () => deleteProvider.mutateAsync({ providerId: provider.providerId, expectedRevision: provider.revision }),
                  { kind: 'provider', providerId: provider.providerId, revision: provider.revision })}
              >
                {armedDelete === `provider:${provider.providerId}` ? '再次点击确认删除' : '删除'}
              </button>
              <button type="button" className="secondary-button" data-testid={`model-add-${provider.providerId}`}
                disabled={busy}
                onClick={() => { setFormError(null); setModelDraft(modelDraftOf(provider.providerId, null)); setProviderDraft(null); }}>
                添加模型
              </button>
            </div>

            {provider.models.length > 0 ? (
                <ul className="settings-model-list" data-testid={`provider-models-${provider.providerId}`}>
                {provider.models.map((model) => (
                  <li key={model.modelId} data-testid={`provider-model-${provider.providerId}-${model.modelId}`}>
                    <details className="settings-model-details">
                      <summary className="settings-model-head">
                        <strong className="settings-model-alias">{model.displayName ?? model.modelId}</strong>
                        {model.displayName && model.displayName !== model.modelId ? (
                          <span className="settings-badge">{model.modelId}</span>
                        ) : null}
                        {model.defaultModel ? <span className="settings-badge feature-state-READY">默认</span> : null}
                        <span className={`settings-badge ${model.enabled ? 'feature-state-READY' : 'feature-state-NOT_ENABLED'}`}>
                          {model.enabled ? '启用' : '停用'}
                        </span>
                        {model.pendingRestart ? <span className="settings-badge apply-SERVICE_RESTART">待生效</span> : null}
                      </summary>
                      <p className="run-meta">
                        {model.remoteModelId && model.remoteModelId !== model.modelId
                          ? `上游名：${model.remoteModelId} · ` : ''}
                        {model.capabilities.length > 0 ? `能力：${model.capabilities.join('、')}` : '未声明能力'}
                        {model.contextWindowTokens != null ? ` · 上下文：${model.contextWindowTokens}` : ''}
                      </p>
                      <div className="settings-feature-actions">
                        <button type="button" className="secondary-button" data-testid={`model-edit-${provider.providerId}-${model.modelId}`}
                          disabled={busy}
                          onClick={() => { setFormError(null); setModelDraft(modelDraftOf(provider.providerId, model)); setProviderDraft(null); }}>
                          编辑
                        </button>
                        {!model.defaultModel ? (
                          <button type="button" className="secondary-button"
                            data-testid={`model-set-default-${provider.providerId}-${model.modelId}`}
                            disabled={busy || !model.enabled || !provider.enabled}
                            title={!provider.enabled ? '提供商停用中的模型不能设为默认' : undefined}
                            onClick={() => setDefault(provider.providerId, model)}>
                            设为默认
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={armedDelete === `model:${provider.providerId}:${model.modelId}` ? 'danger-button' : 'secondary-button'}
                          data-testid={`model-delete-${provider.providerId}-${model.modelId}`}
                          disabled={busy || model.source === 'FILE'}
                          title={model.source === 'FILE' ? '文件配置的模型只能在配置文件中删除，可在编辑中停用' : undefined}
                          onClick={() => confirmDelete(`model:${provider.providerId}:${model.modelId}`,
                            () => deleteModel.mutateAsync({ providerId: provider.providerId, modelId: model.modelId, expectedRevision: model.revision }),
                            { kind: 'model', providerId: provider.providerId, modelId: model.modelId, revision: model.revision })}
                        >
                          {armedDelete === `model:${provider.providerId}:${model.modelId}` ? '再次点击确认删除' : '删除'}
                        </button>
                      </div>
                    </details>
                  </li>
                ))}
                </ul>
            ) : (
              <p className="run-meta">该提供商下暂无模型。</p>
            )}
            </details>
          </li>
        ))}
      </ul>

      {modelDraft ? (
        <SettingsDialog
          title={modelDraft.expectedRevision === undefined ? '添加模型' : '编辑模型'}
          eyebrow={`提供商 · ${modelProvider?.displayName ?? modelDraft.providerId}`}
          description="写入 Service 数据库，保存后立即生效。"
          meta={(
            <>
              <span className="settings-badge">提供商：{modelDraft.providerId}</span>
              <span className="settings-badge">模型 ID：{modelDraft.stored?.modelId ?? '（新建）'}</span>
              {modelDraft.stored?.displayName || modelDraft.displayName ? (
                <span className="settings-badge">命名：{modelDraft.stored?.displayName ?? modelDraft.displayName}</span>
              ) : null}
            </>
          )}
          testId="model-form"
          wide
          onClose={() => { setModelDraft(null); setFormError(null); }}
          footer={(
            <>
              <button type="button" data-testid="model-form-cancel" disabled={busy}
                onClick={() => { setModelDraft(null); setFormError(null); }}>取消</button>
              <button type="button" className="primary-button" data-testid="model-form-save" disabled={busy}
                onClick={submitModel}>保存</button>
            </>
          )}
        >
          {formError ? <SectionError message={friendlySaveError(formError)} /> : null}
          <div className="settings-field-grid">
            <label className="settings-field">
              <span>模型 ID</span>
              <input
                data-testid="model-id-input"
                value={modelDraft.modelId}
                disabled={modelDraft.expectedRevision !== undefined || busy}
                onChange={(event) => setModelDraft({ ...modelDraft, modelId: event.target.value })}
                placeholder="例如 alpha-pro"
              />
            </label>
            <label className="settings-field">
              <span>模型命名（显示名）</span>
              <input
                data-testid="model-name-input"
                value={modelDraft.displayName}
                disabled={busy}
                onChange={(event) => setModelDraft({ ...modelDraft, displayName: event.target.value })}
              />
            </label>
          </div>
          <label className="settings-field">
            <span>上游模型名（发给提供商的名字{modelDraft.expectedRevision !== undefined ? '，创建后不可改' : '，留空则同 ID'}）</span>
            <input
              data-testid="model-remote-id-input"
              value={modelDraft.remoteModelId}
              disabled={modelDraft.expectedRevision !== undefined || busy}
              title={modelDraft.expectedRevision !== undefined
                ? '上游模型名创建后锁定；如需更换请新建模型条目再删除本条'
                : undefined}
              onChange={(event) => setModelDraft({ ...modelDraft, remoteModelId: event.target.value })}
              placeholder="例如 alpha-pro-2025-08-06 或 upstream/alpha-pro"
            />
          </label>
          <details className="settings-advanced">
            <summary>高级配置</summary>
            <div className="settings-advanced-body">
              <div className="settings-field-grid">
                <label className="settings-field">
                  <span>上下文窗口 tokens（可留空）</span>
                  <input
                    data-testid="model-context-input"
                    value={modelDraft.contextWindowTokens}
                    disabled={busy}
                    inputMode="numeric"
                    onChange={(event) => setModelDraft({ ...modelDraft, contextWindowTokens: event.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>最大输出 tokens（可留空）</span>
                  <input
                    data-testid="model-max-output-input"
                    value={modelDraft.maxOutputTokens}
                    disabled={busy}
                    inputMode="numeric"
                    onChange={(event) => setModelDraft({ ...modelDraft, maxOutputTokens: event.target.value })}
                  />
                </label>
              </div>
              <label className="settings-field">
                <span>能力（逗号分隔，如 NATIVE_TOOL_CALLING, IMAGE_INPUT）</span>
                <input
                  data-testid="model-capabilities-input"
                  value={modelDraft.capabilities}
                  disabled={busy}
                  onChange={(event) => setModelDraft({ ...modelDraft, capabilities: event.target.value })}
                />
              </label>
              <div className="settings-field-grid">
                <label className="settings-field">
                  <span>推理档位（逗号分隔，可留空）</span>
                  <input
                    data-testid="model-efforts-input"
                    value={modelDraft.reasoningEfforts}
                    disabled={busy}
                    onChange={(event) => setModelDraft({ ...modelDraft, reasoningEfforts: event.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>推理模式</span>
                  <SettingSelect
                    ariaLabel="推理模式"
                    testId="model-thinking-mode"
                    value={modelDraft.thinkingMode}
                    disabled={busy}
                    options={THINKING_MODE_OPTIONS}
                    onChange={(value) => setModelDraft({ ...modelDraft, thinkingMode: value })}
                  />
                </label>
              </div>
              <div className="settings-field-grid">
                <label className="settings-field">
                  <span>成本层级</span>
                  <SettingSelect
                    ariaLabel="成本层级"
                    testId="model-cost-tier"
                    value={modelDraft.costTier}
                    disabled={busy}
                    options={COST_TIER_OPTIONS}
                    onChange={(value) => setModelDraft({ ...modelDraft, costTier: value })}
                  />
                </label>
                <label className="settings-field">
                  <span>延迟层级</span>
                  <SettingSelect
                    ariaLabel="延迟层级"
                    testId="model-latency-tier"
                    value={modelDraft.latencyTier}
                    disabled={busy}
                    options={LATENCY_TIER_OPTIONS}
                    onChange={(value) => setModelDraft({ ...modelDraft, latencyTier: value })}
                  />
                </label>
              </div>
              <div className="settings-field-grid">
                <label className="settings-field">
                  <span>质量层级</span>
                  <SettingSelect
                    ariaLabel="质量层级"
                    testId="model-quality-tier"
                    value={modelDraft.qualityTier}
                    disabled={busy}
                    options={QUALITY_TIER_OPTIONS}
                    onChange={(value) => setModelDraft({ ...modelDraft, qualityTier: value })}
                  />
                </label>
                <label className="settings-field">
                  <span>图像输入配置（声明 IMAGE_INPUT 能力时必填）</span>
                  <SettingSelect
                    ariaLabel="图像输入配置"
                    testId="model-image-profile"
                    value={modelDraft.imageInputProfile}
                    disabled={busy}
                    options={IMAGE_PROFILE_OPTIONS}
                    onChange={(value) => setModelDraft({ ...modelDraft, imageInputProfile: value })}
                  />
                </label>
              </div>
              <label className="settings-field">
                <span>缓存 TTL（逗号分隔，可留空）</span>
                <input
                  data-testid="model-cache-ttls-input"
                  value={modelDraft.cacheTtls}
                  disabled={busy}
                  onChange={(event) => setModelDraft({ ...modelDraft, cacheTtls: event.target.value })}
                  placeholder="例如 5m, 1h"
                />
              </label>
              <label className="settings-field">
                <span>推理显示配置（JSON 对象，可留空）</span>
                <textarea
                  data-testid="model-reasoning-wire-input"
                  value={modelDraft.reasoningWireJson}
                  disabled={busy}
                  rows={4}
                  onChange={(event) => setModelDraft({ ...modelDraft, reasoningWireJson: event.target.value })}
                  placeholder='例如 {"format":"CHAT_TEXT","support":"SUPPORTED","textField":"reasoning_content"}'
                />
              </label>
            </div>
          </details>
          <label className="settings-field-inline">
            <input
              type="checkbox"
              data-testid="model-enabled"
              checked={modelDraft.enabled}
              disabled={busy}
              onChange={(event) => setModelDraft({ ...modelDraft, enabled: event.target.checked })}
            />
            <span>启用该模型</span>
          </label>
        </SettingsDialog>
      ) : null}
    </SettingSection>
  );
}
