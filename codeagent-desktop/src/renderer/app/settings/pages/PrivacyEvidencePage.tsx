/**
 * Privacy & Evidence page (settings design §6.7).
 *
 * Section-level draft with one sticky Save carrying a single expected
 * revision; telemetryMinimal stays a read-only Service-derived projection
 * (never a third switch). Retention is validated locally (1..365) and the
 * Service validates again.
 */

import { useQueryClient } from '@tanstack/react-query';
import {
  ConflictPanel,
  SaveBar,
  SectionError,
  SettingRow,
  SettingSection,
  SettingToggle,
  SkeletonRows,
  UnavailableState
} from '../components';
import { friendlySaveError } from '../settingsPresentation';
import { settingsKeys } from '../settingsKeys';
import { useProductSettings, useUpdateProductSettings } from '../useSettingsQueries';
import { useSettingsDraft } from '../useSettingsDraft';
import { operationGateAllows, type SettingsPageContext } from '../settingsContext';
import { useReportDirty } from '../useDirtyRegistry';

interface PrivacyDraft {
  localOnly: boolean;
  traceExportEnabled: boolean;
  eventJournalRetentionDays: number;
}

export function PrivacyEvidencePage(props: { context: SettingsPageContext }): React.JSX.Element {
  const queryClient = useQueryClient();
  const settings = useProductSettings();
  const updateSettings = useUpdateProductSettings();

  const handle = useSettingsDraft<PrivacyDraft>({
    base: settings.data
      ? {
        localOnly: settings.data.localOnly,
        traceExportEnabled: settings.data.traceExportEnabled,
        eventJournalRetentionDays: settings.data.eventJournalRetentionDays
      }
      : undefined,
    baseRevision: settings.data?.revision,
    onSave: async (draft, baseRevision) => updateSettings.mutateAsync({
      localOnly: draft.localOnly,
      traceExportEnabled: draft.traceExportEnabled,
      eventJournalRetentionDays: draft.eventJournalRetentionDays,
      expectedRevision: baseRevision ?? 0
    })
  });

  useReportDirty('PRIVACY_EVIDENCE', handle.hasChanges);

  const draft = handle.draft;
  const retentionInvalid = draft !== null
    && (draft.eventJournalRetentionDays < 1 || draft.eventJournalRetentionDays > 365);

  // Draft edits preview the derived telemetryMinimal projection; the value
  // after save still comes from the server response (§6.7.2).
  const previewTelemetryMinimal = draft ? !draft.traceExportEnabled && draft.localOnly : false;
  const savedTelemetryMinimal = settings.data?.telemetryMinimal ?? false;

  if (!operationGateAllows(props.context.capabilities, 'settings.manage')) {
    return <UnavailableState title="隐私与证据不可用" message="当前 Service 未声明 settings.manage 能力；按安全规则不提供编辑入口。" reasonCode="UNAVAILABLE" />;
  }
  if (settings.isPending) {
    return <SettingSection title="隐私与证据" description="数据只在你的机器上处理，直到你明确开启导出。" hideHeader><SkeletonRows /></SettingSection>;
  }
  if (settings.isError || !settings.data || draft === null) {
    const message = settings.error instanceof Error ? settings.error.message : String(settings.error);
    const offline = message.includes('SERVICE_NOT_CONNECTED')
      || (settings.error as (Error & { code?: string }) | null | undefined)?.code === 'SERVICE_NOT_CONNECTED';
    return offline
      ? <UnavailableState title="隐私与证据不可用" message="Service 未连接。隐私设置保存在 Service 中，离线时不会用旧缓存冒充当前值。" reasonCode="SERVICE_NOT_CONNECTED" />
      : <SectionError message={`无法读取隐私设置：${message}`} onRetry={() => void settings.refetch()} />;
  }

  return (
    <>
      <SettingSection
        title="隐私与证据"
        description="local-only 与 Trace 导出立即影响 Service 的遥测行为；事件保留天数决定 Journal 清理周期。"
        hideHeader
        testId="privacy-section"
      >
        <SettingRow
          label="仅在本机处理（local-only）"
          description="开启后运行内容只保留在本地 Service 状态中。关闭不会自动打开 Trace 导出。"
          scope="SERVICE_INSTANCE"
          source="Service 设置"
          applyMode="IMMEDIATE"
          effective={draft.localOnly ? '开启' : '关闭'}
          testId="settings-local-only"
          advanced={<span className="run-meta">canonical: localOnly</span>}
        >
          <SettingToggle
            label="仅在本机处理"
            testId="settings-local-only-toggle"
            checked={draft.localOnly}
            disabled={handle.saveState === 'SAVING'}
            onChange={(checked) => handle.setField('localOnly', checked)}
          />
        </SettingRow>

        <SettingRow
          label="导出运行追踪（Trace）"
          description="开启后可能向 Service 已配置的 Trace 后端导出 public-safe 追踪；是否上传内容取决于后端配置。"
          scope="SERVICE_INSTANCE"
          source="Service 设置"
          applyMode="IMMEDIATE"
          effective={draft.traceExportEnabled ? '开启' : '关闭'}
          testId="settings-trace"
          advanced={<span className="run-meta">canonical: traceExportEnabled</span>}
        >
          <SettingToggle
            label="导出运行追踪"
            testId="settings-trace-toggle"
            checked={draft.traceExportEnabled}
            disabled={handle.saveState === 'SAVING'}
            onChange={(checked) => handle.setField('traceExportEnabled', checked)}
          />
        </SettingRow>

        <SettingRow
          label="事件记录保留天数"
          description="1–365 天。保存后由 Service 再次校验。"
          scope="SERVICE_INSTANCE"
          source="Service 设置"
          applyMode="IMMEDIATE"
          effective={`${draft.eventJournalRetentionDays} 天`}
          testId="settings-retention"
          advanced={<span className="run-meta">canonical: eventJournalRetentionDays</span>}
        >
          <input
            type="number"
            className={`setting-number ${retentionInvalid ? 'setting-number-invalid' : ''}`}
            data-testid="settings-retention-input"
            value={draft.eventJournalRetentionDays}
            min={1}
            max={365}
            disabled={handle.saveState === 'SAVING'}
            aria-label="事件记录保留天数"
            aria-invalid={retentionInvalid || undefined}
            onChange={(event) => {
              const parsed = event.target.valueAsNumber;
              if (Number.isFinite(parsed)) handle.setField('eventJournalRetentionDays', Math.floor(parsed));
            }}
          />
        </SettingRow>

        <SettingRow
          label="最小遥测（派生）"
          description="由 Service 派生：local-only 开启且 Trace 关闭时为真。不能单独编辑。"
          scope="SERVICE_INSTANCE"
          source="Service 派生"
          mutability="READ_ONLY"
          effective={savedTelemetryMinimal ? '最小收集' : '超出最小范围'}
          testId="telemetry-minimal"
          advanced={<span className="run-meta">telemetryMinimal = !traceExportEnabled && localOnly</span>}
        >
          <span className={`settings-badge ${savedTelemetryMinimal ? 'availability-AVAILABLE' : 'availability-DEGRADED'}`} data-testid="telemetry-minimal-value">
            {savedTelemetryMinimal ? '最小收集' : '超出最小范围'}
          </span>
        </SettingRow>
        <p className="settings-hint" data-testid="telemetry-preview">
          当前草稿的预期结果：{previewTelemetryMinimal ? '最小收集' : '超出最小范围'}（保存后以 Service 返回为准）
        </p>

        {handle.saveState === 'CONFLICT' ? (
          <ConflictPanel
            serverValue={`local-only ${settings.data.localOnly ? '开' : '关'} · Trace ${settings.data.traceExportEnabled ? '开' : '关'} · 保留 ${settings.data.eventJournalRetentionDays} 天`}
            draftValue={`local-only ${draft.localOnly ? '开' : '关'} · Trace ${draft.traceExportEnabled ? '开' : '关'} · 保留 ${draft.eventJournalRetentionDays} 天`}
            onReload={() => {
              handle.adoptServerState();
              void queryClient.invalidateQueries({ queryKey: settingsKeys.product });
            }}
          />
        ) : null}
        {handle.remoteChanged && handle.saveState !== 'CONFLICT' ? (
          <p className="settings-remote-changed" data-testid="settings-remote-changed">权威设置已在后台更新；你的修改仍保留在草稿中。</p>
        ) : null}
        {handle.errorMessage ? <SectionError message={friendlySaveError(handle.errorMessage)} /> : null}
      </SettingSection>

      <SaveBar
        saveState={handle.saveState}
        hasChanges={handle.hasChanges}
        applyMode="IMMEDIATE"
        saveSuccess={handle.saveSuccess}
        invalidHint={retentionInvalid ? '保留天数必须在 1–365 之间' : null}
        onSave={handle.save}
        onCancel={handle.discard}
      />
    </>
  );
}
