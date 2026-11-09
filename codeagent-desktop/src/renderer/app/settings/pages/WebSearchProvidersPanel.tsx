/**
 * Managed web-search records panel (settings design V026).
 *
 * The database-desired view from /api/v2/web-search-providers: several
 * profiles may coexist and at most one is enabled — the enabled record
 * owns the whole web.* profile applied at the next Service restart.
 * apiKey is write-only — the service protects it into the record's DPAPI
 * blob and responses only ever carry credentialConfigured.
 */

import { useState } from 'react';
import type {
  EnvironmentFeatureField,
  WebSearchProvider,
  WebSearchProviderRequest
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
import {
  CREDENTIAL_KIND_LABELS,
  MANAGED_SOURCE_LABELS,
  friendlySaveError
} from '../settingsPresentation';
import {
  useDeleteWebSearchProvider,
  useUpsertWebSearchProvider,
  useWebSearchProviders
} from '../useSettingsQueries';

const PROVIDER_KIND_OPTIONS = [
  { value: '', label: '（不搜索 · 仅抓取）' },
  { value: 'tavily', label: 'Tavily' },
  { value: 'brave', label: 'Brave' },
  { value: 'exa', label: 'Exa' }
];

const CREDENTIAL_OPTIONS = [
  { value: 'NONE', label: '无凭据' },
  { value: 'ENV', label: '环境变量（env:NAME）' },
  { value: 'SECRET', label: '加密存储（系统保护）' }
];

/** Group label for a web.* key's second segment (web.fetch.* → 网页抓取). */
const ENTRY_GROUP_LABELS: Record<string, string> = {
  network: '网络',
  fetch: '网页抓取',
  search: '搜索',
  http: 'HTTP',
  budget: '限额与并发'
};

interface RecordDraft {
  providerId: string;
  displayName: string;
  /** '' keeps "fetch-only" (no search provider). */
  providerKind: string;
  credentialKind: 'NONE' | 'ENV' | 'SECRET';
  credentialEnvName: string;
  /** Write-only; blank keeps the stored credential. */
  apiKey: string;
  enabled: boolean;
  expectedRevision?: number;
  /** Entry drafts keyed by field spec key. */
  entryDraft: Record<string, string>;
  stored: WebSearchProvider | null;
}

function recordDraftOf(record: WebSearchProvider | null): RecordDraft {
  const entryDraft: Record<string, string> = {};
  // The service ships the typed dictionary on each stored record; a new
  // record seeds from the same dictionary's static mirror below.
  for (const field of record?.fields ?? NEW_RECORD_FIELDS) {
    entryDraft[field.key] = field.sensitive ? '' : (field.value ?? '');
  }
  return {
    providerId: record?.providerId ?? '',
    displayName: record?.displayName ?? '',
    providerKind: record?.providerKind ?? '',
    credentialKind: record?.credentialKind === 'ENV'
      ? 'ENV' : record?.credentialKind === 'SECRET' ? 'SECRET' : 'NONE',
    credentialEnvName: record?.credentialEnvName ?? '',
    apiKey: '',
    enabled: record?.enabled ?? false,
    expectedRevision: record?.revision,
    entryDraft,
    stored: record
  };
}

export function WebSearchProvidersPanel(): React.JSX.Element {
  const catalog = useWebSearchProviders(true);
  const upsert = useUpsertWebSearchProvider();
  const remove = useDeleteWebSearchProvider();

  const [draft, setDraft] = useState<RecordDraft | null>(null);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const busy = upsert.isPending || remove.isPending;

  const mutate = (action: Promise<unknown>, successText: string): void => {
    setFormError(null);
    setFormSuccess(null);
    void action.then(() => {
      setDraft(null);
      setArmedDelete(null);
      setFormSuccess(successText);
    }).catch((failure) => {
      setFormError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  const submit = (): void => {
    if (!draft) return;
    const providerId = draft.providerId.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(providerId)) {
      setFormError('记录 ID 只能以字母或数字开头，包含字母、数字、点、下划线与连字符');
      return;
    }
    const stored = draft.stored;
    // entries replace the stored map wholesale: send every non-empty
    // draft value plus null markers for keys the draft cleared.
    const entries: Record<string, string | null> = {};
    for (const field of stored?.fields ?? NEW_RECORD_FIELDS) {
      const value = (draft.entryDraft[field.key] ?? '').trim();
      if (value !== '') entries[field.key] = value;
      else if (stored?.entries?.[field.key] != null) entries[field.key] = null;
    }
    const unsetFields: string[] = [];
    const body: WebSearchProviderRequest = {
      providerKind: draft.providerKind || undefined,
      displayName: draft.displayName.trim() || undefined,
      entries,
      enabled: draft.enabled,
      expectedRevision: draft.expectedRevision
    };
    if (!draft.providerKind && stored?.providerKind != null) unsetFields.push('providerKind');
    if (!draft.displayName.trim() && stored?.displayName != null) unsetFields.push('displayName');
    if (unsetFields.length > 0) body.unsetFields = unsetFields;
    if (draft.credentialKind === 'NONE') {
      body.credentialKind = 'NONE';
    } else if (draft.credentialKind === 'ENV') {
      const envName = draft.credentialEnvName.trim();
      if (!envName) {
        setFormError('环境变量凭据需要填写变量名');
        return;
      }
      body.credentialKind = 'ENV';
      body.credentialEnvName = envName;
    } else if (draft.apiKey.trim()) {
      body.credentialKind = 'SECRET';
      body.apiKey = draft.apiKey.trim();
    } else if (draft.expectedRevision === undefined
        || stored?.credentialKind !== 'SECRET') {
      setFormError('加密存储凭据需要填写 API Key（只写入不显示）');
      return;
    }
    mutate(upsert.mutateAsync({ providerId, body }), '已保存 · 重启 Service 后生效');
  };

  const confirmDelete = (record: WebSearchProvider): void => {
    if (armedDelete === record.providerId) {
      mutate(remove.mutateAsync({
        providerId: record.providerId,
        expectedRevision: record.revision
      }), '已删除 · 重启 Service 后生效');
    } else {
      setArmedDelete(record.providerId);
    }
  };

  const toggleEnabled = (record: WebSearchProvider, enabled: boolean): void => {
    mutate(upsert.mutateAsync({
      providerId: record.providerId,
      body: { enabled, expectedRevision: record.revision }
    }), enabled ? '已启用该记录 · 重启 Service 后生效' : '已停用该记录 · 重启 Service 后生效');
  };

  const providers = catalog.data?.providers ?? [];

  return (
    <SettingSection
      title="搜索配置记录"
      description="可保存多条 web 搜索/抓取配置，同一时间仅启用一条。参数写入 Service 数据库，重启 Service 后生效；API Key 只写入不显示。"
      testId="web-search-providers-section"
      actions={catalog.data ? (
        <button
          type="button"
          className="secondary-button"
          data-testid="websearch-add-open"
          disabled={busy}
          onClick={() => { setFormError(null); setDraft(recordDraftOf(null)); }}
        >
          添加记录
        </button>
      ) : undefined}
    >
      {catalog.isPending ? <SkeletonRows rows={2} /> : null}
      {catalog.isError ? (() => {
        const message = catalog.error instanceof Error ? catalog.error.message : String(catalog.error);
        const offline = message.includes('SERVICE_NOT_CONNECTED')
          || (catalog.error as (Error & { code?: string }) | null | undefined)?.code === 'SERVICE_NOT_CONNECTED';
        return offline
          ? <UnavailableState title="搜索配置不可用" message="Service 未连接；离线时不显示旧配置。" reasonCode="SERVICE_NOT_CONNECTED" />
          : <SectionError message={`无法读取搜索配置：${message}`} onRetry={() => void catalog.refetch()} />;
      })() : null}
      {catalog.data && providers.length === 0
        ? <EmptyState message="还没有搜索配置记录。添加一条以启用 web 搜索。" /> : null}
      {catalog.data ? (
        <p className="run-meta" data-testid="websearch-enabled-record">
          当前启用记录：{catalog.data.enabledProviderId ?? '无'}
        </p>
      ) : null}
      {formSuccess ? <p className="settings-hint" data-testid="websearch-save-success">{formSuccess}</p> : null}
      {formError && !draft ? <SectionError message={friendlySaveError(formError)} /> : null}

      {providers.length > 0 ? (
        <ul className="settings-feature-list" data-testid="websearch-record-list">
          {providers.map((record) => (
            <li key={record.providerId} className="settings-feature-card"
              data-testid={`websearch-record-${record.providerId}`}>
              <details className="settings-model-details">
                <summary className="settings-model-head">
                  <strong>{record.displayName ?? record.providerId}</strong>
                  <code className="settings-param-key">{record.providerId}</code>
                  {record.providerKind ? (
                    <span className="settings-badge">{record.providerKind}</span>
                  ) : (
                    <span className="settings-badge">仅抓取</span>
                  )}
                  <span className="settings-badge" data-testid={`websearch-credential-${record.providerId}`}>
                    {CREDENTIAL_KIND_LABELS[record.credentialKind] ?? record.credentialKind}
                    {record.credentialKind !== 'NONE'
                      ? (record.credentialConfigured ? ' · 已配置' : ' · 未配置')
                      : ''}
                  </span>
                  {record.enabled ? (
                    <span className="settings-badge feature-state-READY"
                      data-testid={`websearch-enabled-${record.providerId}`}>已启用</span>
                  ) : null}
                  {record.pendingRestart ? (
                    <span className="settings-badge apply-SERVICE_RESTART">重启后生效</span>
                  ) : null}
                </summary>
              <div className="settings-feature-actions">
                <SettingToggle
                  testId={`websearch-enable-${record.providerId}`}
                  label="启用此记录"
                  checked={record.enabled}
                  disabled={busy}
                  onChange={(checked) => toggleEnabled(record, checked)}
                />
                <button
                  type="button"
                  className="secondary-button"
                  data-testid={`websearch-edit-${record.providerId}`}
                  disabled={busy}
                  onClick={() => { setFormError(null); setDraft(recordDraftOf(record)); }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className={armedDelete === record.providerId ? 'danger-button' : 'secondary-button'}
                  data-testid={`websearch-delete-${record.providerId}`}
                  disabled={busy}
                  onClick={() => confirmDelete(record)}
                >
                  {armedDelete === record.providerId ? '确认删除' : '删除'}
                </button>
                <span className="run-meta">
                  来源：{MANAGED_SOURCE_LABELS[record.source] ?? record.source}
                </span>
              </div>
              </details>
            </li>
          ))}
        </ul>
      ) : null}

      {draft ? (
        <SettingsDialog
          title={draft.expectedRevision === undefined ? '添加搜索记录' : '编辑搜索记录'}
          eyebrow="Web 搜索与抓取"
          description="记录写入 Service 数据库并加密保管凭据；启用一条记录后重启 Service 生效。"
          meta={draft.stored ? (
            <span className="settings-badge">记录 ID：{draft.providerId}</span>
          ) : undefined}
          wide
          testId="websearch-form"
          onClose={() => { setDraft(null); setFormError(null); }}
          footer={(
            <>
              <button type="button" data-testid="websearch-form-cancel" disabled={busy}
                onClick={() => { setDraft(null); setFormError(null); }}>取消</button>
              <button type="button" className="primary-button" data-testid="websearch-form-save"
                disabled={busy} onClick={submit}>保存</button>
            </>
          )}
        >
          {formError ? <SectionError message={friendlySaveError(formError)} /> : null}
          <label className="settings-field">
            <span>记录 ID</span>
            <input
              data-testid="websearch-form-id"
              value={draft.providerId}
              disabled={busy || draft.stored != null}
              placeholder="例如 tavily-main"
              onChange={(event) => setDraft((current) => current
                ? { ...current, providerId: event.target.value } : current)}
            />
          </label>
          <label className="settings-field">
            <span>显示名称</span>
            <input
              data-testid="websearch-form-name"
              value={draft.displayName}
              disabled={busy}
              onChange={(event) => setDraft((current) => current
                ? { ...current, displayName: event.target.value } : current)}
            />
          </label>
          <label className="settings-field">
            <span>搜索提供商</span>
            <SettingSelect
              ariaLabel="搜索提供商"
              testId="websearch-form-kind"
              value={draft.providerKind}
              disabled={busy}
              options={PROVIDER_KIND_OPTIONS}
              onChange={(next) => setDraft((current) => current
                ? { ...current, providerKind: next } : current)}
            />
          </label>
          <label className="settings-field">
            <span>凭据方式</span>
            <SettingSelect
              ariaLabel="凭据方式"
              testId="websearch-form-credential"
              value={draft.credentialKind}
              disabled={busy}
              options={CREDENTIAL_OPTIONS}
              onChange={(next) => setDraft((current) => current
                ? { ...current, credentialKind: next as RecordDraft['credentialKind'] }
                : current)}
            />
          </label>
          {draft.credentialKind === 'ENV' ? (
            <label className="settings-field">
              <span>环境变量名</span>
              <input
                data-testid="websearch-form-env"
                value={draft.credentialEnvName}
                disabled={busy}
                placeholder="例如 TAVILY_API_KEY"
                onChange={(event) => setDraft((current) => current
                  ? { ...current, credentialEnvName: event.target.value } : current)}
              />
            </label>
          ) : null}
          {draft.credentialKind === 'SECRET' ? (
            <label className="settings-field">
              <span>API Key{draft.stored?.credentialConfigured ? '（已配置，输入以替换）' : ''}</span>
              <input
                data-testid="websearch-form-apikey"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                disabled={busy}
                onChange={(event) => setDraft((current) => current
                  ? { ...current, apiKey: event.target.value } : current)}
              />
            </label>
          ) : null}
          <div className="settings-feature-toggle">
            <SettingToggle
              testId="websearch-form-enabled"
              label="启用此记录（启用后将停用其它记录）"
              checked={draft.enabled}
              disabled={busy}
              onChange={(checked) => setDraft((current) => current
                ? { ...current, enabled: checked } : current)}
            />
          </div>
          <RecordEntriesForm
            draft={draft}
            busy={busy}
            onChange={(entryDraft) => setDraft((current) => current
              ? { ...current, entryDraft } : current)}
          />
        </SettingsDialog>
      ) : null}
    </SettingSection>
  );
}

/**
 * The record's typed entries form — driven by the service-owned field
 * dictionary on the record view, grouped by the key's second segment.
 * Blank clears the key (sent as a null removal marker).
 */
function RecordEntriesForm(props: {
  draft: RecordDraft;
  busy: boolean;
  onChange: (entryDraft: Record<string, string>) => void;
}): React.JSX.Element | null {
  const fields = props.draft.stored?.fields
    ?? NEW_RECORD_FIELDS;
  if (fields.length === 0) return null;
  const grouped = new Map<string, EnvironmentFeatureField[]>();
  for (const field of fields) {
    const segment = field.key.split('.')[1] ?? '';
    const bucket = grouped.get(segment);
    if (bucket) bucket.push(field);
    else grouped.set(segment, [field]);
  }
  return (
    <div className="settings-params" data-testid="websearch-form-entries">
      <span className="settings-params-title">配置参数</span>
      {[...grouped.entries()].map(([name, groupFields]) => (
        <div className="settings-param-group" key={name || 'default'}>
          <div className="settings-param-group-title">
            {ENTRY_GROUP_LABELS[name] ?? (name === '' ? '通用' : name)}
          </div>
          {groupFields.map((field) => {
            const value = props.draft.entryDraft[field.key] ?? '';
            const testId = `websearch-field-${field.key}`;
            let input: React.JSX.Element;
            if (field.type === 'BOOLEAN') {
              input = (
                <input
                  type="checkbox"
                  aria-label={field.label}
                  data-testid={testId}
                  checked={value === 'true'}
                  disabled={props.busy}
                  onChange={(event) => props.onChange({
                    ...props.draft.entryDraft,
                    [field.key]: event.target.checked ? 'true' : 'false'
                  })}
                />
              );
            } else if (field.type === 'ENUM') {
              input = (
                <SettingSelect
                  ariaLabel={field.label}
                  testId={testId}
                  value={value}
                  disabled={props.busy}
                  options={[
                    { value: '', label: '（未设置）' },
                    ...field.options.map((option) => ({ value: option, label: option }))
                  ]}
                  onChange={(next) => props.onChange({
                    ...props.draft.entryDraft, [field.key]: next
                  })}
                />
              );
            } else {
              const numeric = field.type === 'INTEGER' || field.type === 'LONG'
                || field.type === 'DECIMAL';
              input = (
                <input
                  data-testid={testId}
                  value={value}
                  disabled={props.busy}
                  inputMode={numeric ? 'numeric' : undefined}
                  autoComplete="off"
                  onChange={(event) => props.onChange({
                    ...props.draft.entryDraft, [field.key]: event.target.value
                  })}
                />
              );
            }
            return (
              <div className="settings-param-row" key={field.key}
                data-testid={`websearch-field-row-${field.key}`}>
                <div className="settings-param-meta">
                  <span className="settings-param-label">
                    {field.label}
                    {field.required ? ' *' : ''}
                    {props.draft.stored?.entries?.[field.key] != null
                      ? <em className="settings-param-set">已设置</em> : null}
                  </span>
                  <code className="settings-param-key">{field.key}</code>
                  {field.description
                    ? <p className="settings-field-hint">{field.description}</p> : null}
                </div>
                <div className="settings-param-control">{input}</div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * Static field dictionary for a brand-new record (before the service has
 * stored one — the create form needs the same keys). Kept in the same
 * order the service dictionary uses; the service remains the validator.
 */
const NEW_RECORD_FIELDS: EnvironmentFeatureField[] = [
  { key: 'web.network.mode', label: '网络模式', type: 'ENUM', options: ['DENY', 'PUBLIC'], sensitive: false, readOnly: false, required: false },
  { key: 'web.fetch.mode', label: '抓取模式', type: 'ENUM', options: ['OFF', 'AUTO', 'REQUIRED'], sensitive: false, readOnly: false, required: false },
  { key: 'web.search.mode', label: '搜索模式', type: 'ENUM', options: ['OFF', 'AUTO', 'REQUIRED'], sensitive: false, readOnly: false, required: false },
  { key: 'web.network.allowSyntheticDnsTunnelAddresses', label: '允许合成 DNS 隧道地址', type: 'BOOLEAN', options: [], sensitive: false, readOnly: false, required: false },
  { key: 'web.fetch.defaultMaxChars', label: '默认抓取字符上限', type: 'INTEGER', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.fetch.maxChars', label: '抓取字符上限', type: 'INTEGER', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.http.defaultTimeoutMillis', label: '默认 HTTP 超时 (ms)', type: 'LONG', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.http.maxTimeoutMillis', label: '最大 HTTP 超时 (ms)', type: 'LONG', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.http.connectTimeoutMillis', label: '连接超时 (ms)', type: 'LONG', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.http.readTimeoutMillis', label: '读超时 (ms)', type: 'LONG', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.http.dnsTimeoutMillis', label: 'DNS 超时 (ms)', type: 'LONG', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.http.maxRedirects', label: '最大重定向数', type: 'INTEGER', options: [], min: 0, sensitive: false, readOnly: false, required: false },
  { key: 'web.fetch.maxResponseBytes', label: '抓取响应上限 (bytes)', type: 'LONG', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.search.maxResponseBytes', label: '搜索响应上限 (bytes)', type: 'LONG', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.fetch.allowedDomains', label: '抓取允许域名', type: 'CSV', options: [], sensitive: false, readOnly: false, required: false, description: '逗号分隔；空表示不限制' },
  { key: 'web.fetch.blockedDomains', label: '抓取拒绝域名', type: 'CSV', options: [], sensitive: false, readOnly: false, required: false },
  { key: 'web.fetch.allowedPorts', label: '抓取允许端口', type: 'CSV', options: [], sensitive: false, readOnly: false, required: false },
  { key: 'web.budget.maxFetchCallsPerRun', label: '单轮抓取次数上限', type: 'INTEGER', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.budget.maxSearchCallsPerRun', label: '单轮搜索次数上限', type: 'INTEGER', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.budget.maxHttpRequestsPerRun', label: '单轮 HTTP 请求上限', type: 'INTEGER', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.budget.maxConcurrent', label: '全局并发上限', type: 'INTEGER', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.budget.maxConcurrentSearch', label: '搜索并发上限', type: 'INTEGER', options: [], min: 1, sensitive: false, readOnly: false, required: false },
  { key: 'web.budget.perHostConcurrent', label: '单主机并发上限', type: 'INTEGER', options: [], min: 1, sensitive: false, readOnly: false, required: false }
];
