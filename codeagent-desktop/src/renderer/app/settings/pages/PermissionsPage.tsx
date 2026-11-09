/**
 * Permissions page (settings design §6.5).
 *
 * The default view speaks user language (组织上限/项目限制/个人限制/当前有效);
 * raw enums, revisions and reason codes stay behind a disclosure. Managed is
 * always locked; project/user rows can only keep or tighten their parent —
 * the frontend pre-filters options but the Service stays the final judge.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ConflictPanel,
  SaveBar,
  SectionError,
  SettingRow,
  SettingSection,
  SettingSelect,
  SkeletonRows,
  UnavailableState
} from '../components';
import { AUTONOMY_LABELS, friendlySaveError, reasonLabel } from '../settingsPresentation';
import { settingsKeys } from '../settingsKeys';
import { usePolicyLayers, useUpdatePolicyLayer } from '../useSettingsQueries';
import { useMyExecutionPolicyDefaults, unwrap } from '../../queries';
import type { PermissionMode } from '../../conversation/PermissionModeSelector';
import { useSettingsDraft } from '../useSettingsDraft';
import { useReportDirty } from '../useDirtyRegistry';
import type { DesktopCapabilities } from '../../../../../electron/shared/api-types';

const AUTONOMY_ORDER = ['OFF', 'LOW', 'MEDIUM', 'HIGH'] as const;
type Autonomy = (typeof AUTONOMY_ORDER)[number];

interface PolicyDraft {
  PROJECT: string | null;
  USER: string | null;
}

function autonomyRank(value: string | null | undefined): number {
  if (!value) return AUTONOMY_ORDER.indexOf('HIGH') + 1; // unset inherits the ceiling
  const index = AUTONOMY_ORDER.indexOf(value as Autonomy);
  return index >= 0 ? index : AUTONOMY_ORDER.length;
}

function autonomyLabel(value: string | null | undefined): string {
  return value ? (AUTONOMY_LABELS[value] ?? value) : '继承上层';
}

const MODE_LABELS: Record<PermissionMode, string> = {
  STANDARD: '标准审批',
  AUTO_APPROVE: '自动批准',
  FULL_ACCESS: '完全访问'
};

export function PermissionsPage(props: { capabilities?: DesktopCapabilities } = {}): React.JSX.Element {
  const queryClient = useQueryClient();
  const layers = usePolicyLayers();
  const updateLayer = useUpdatePolicyLayer();
  const myDefaults = useMyExecutionPolicyDefaults();
  const updateMyDefaults = useMutation({
    mutationFn: async (mode: PermissionMode) => {
      unwrap(await window.codeAgentDesktop.updateMyExecutionPolicyDefaults({
        expectedRevision: myDefaults.data?.revision ?? 0,
        requestedMode: mode,
        permissionSemanticsVersion: mode === 'FULL_ACCESS' ? 2 : undefined,
        fullAccessConfirmation: mode === 'FULL_ACCESS',
        pendingApprovalAction: 'RECONCILE_SESSION'
      }));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['execution-policy-defaults'] })
  });

  const managed = layers.data?.layers.find((layer) => layer.layer === 'MANAGED');
  const project = layers.data?.layers.find((layer) => layer.layer === 'PROJECT');
  const user = layers.data?.layers.find((layer) => layer.layer === 'USER');

  const handle = useSettingsDraft<PolicyDraft>({
    base: layers.data ? { PROJECT: project?.maximumAutonomy ?? null, USER: user?.maximumAutonomy ?? null } : undefined,
    baseRevision: undefined,
    conflictMarkers: ['STATE_VERSION_CONFLICT'],
    onSave: async (draft) => {
      // Sequential per-layer saves; each carries its own optimistic revision
      // read fresh from the cached projection (§7.2: one Save may only span
      // ONE authority here — the policy chain, never desktop settings).
      if (draft.PROJECT !== (project?.maximumAutonomy ?? null)) {
        await updateLayer.mutateAsync({ layer: 'PROJECT', request: { maximumAutonomy: draft.PROJECT as Autonomy, expectedRevision: project?.revision ?? null } });
      }
      if (draft.USER !== (user?.maximumAutonomy ?? null)) {
        await updateLayer.mutateAsync({ layer: 'USER', request: { maximumAutonomy: draft.USER as Autonomy, expectedRevision: user?.revision ?? null } });
      }
      // Adopt the authoritative projection from the last mutation response.
      const authoritative = queryClient.getQueryData<{ layers: Array<{ layer: string; maximumAutonomy?: string | null; revision: number }>; effectiveMaximumAutonomy: string }>(settingsKeys.policyLayers);
      const nextProject = authoritative?.layers.find((layer) => layer.layer === 'PROJECT');
      const nextUser = authoritative?.layers.find((layer) => layer.layer === 'USER');
      return { PROJECT: nextProject?.maximumAutonomy ?? null, USER: nextUser?.maximumAutonomy ?? null };
    }
  });

  useReportDirty('PERMISSIONS', handle.hasChanges);

  const draft = handle.draft;

  if (layers.isPending) {
    return <SettingSection title="权限" description="策略链只能收紧；有效上限由 Service 裁决。" hideHeader><SkeletonRows /></SettingSection>;
  }
  if (layers.isError || !layers.data) {
    const message = layers.error instanceof Error ? layers.error.message : String(layers.error);
    const offline = message.includes('SERVICE_NOT_CONNECTED');
    return offline
      ? <UnavailableState title="权限不可用" message="Service 未连接。策略保存在 Service 中，离线时不显示旧值。" reasonCode="SERVICE_NOT_CONNECTED" />
      : <SectionError message={`无法读取策略：${message}`} onRetry={() => void layers.refetch()} />;
  }

  const effectiveManagedCeiling = managed?.maximumAutonomy ?? null;
  // The project layer may not exceed the managed ceiling; the user layer may
  // not exceed the project's effective ceiling (project value or managed).
  const projectCeiling = effectiveManagedCeiling;
  // draft is null until the first adoption effect runs — stay null-safe here.
  const userCeiling = (draft?.PROJECT ?? effectiveManagedCeiling);

  const layerOptions = (ceiling: string | null, inherited: boolean): Array<{ value: string; label: string }> => {
    const options: Array<{ value: string; label: string }> = [];
    if (inherited) options.push({ value: '', label: '继承上层' });
    const maxRank = ceiling ? autonomyRank(ceiling) : AUTONOMY_ORDER.length - 1;
    for (const value of AUTONOMY_ORDER) {
      if (autonomyRank(value) <= maxRank) options.push({ value, label: AUTONOMY_LABELS[value] ?? value });
    }
    return options;
  };

  const effectiveLabel = layers.data.effectiveMaximumAutonomy;
  const automationOperation = props.capabilities?.operations?.find((operation) => operation.id === 'automation.control');
  const automationReason = !props.capabilities
    ? 'CAPABILITY_HANDSHAKE_PENDING'
    : automationOperation?.availability === 'UNAVAILABLE'
      ? (automationOperation.reasonCode ?? 'AUTOMATION_CONTROL_UNAVAILABLE')
      : automationOperation?.availability === 'DEGRADED'
        ? (automationOperation.reasonCode ?? 'AUTOMATION_CONTROL_DEGRADED')
          : automationOperation
            ? 'AUTOMATION_CONTROL_CLIENT_NOT_WIRED'
            : 'AUTOMATION_CONTROL_NOT_DECLARED';
  const automationAvailable = automationOperation?.availability === 'AVAILABLE'
    && typeof window.codeAgentDesktop.getAutomationControl === 'function'
    && typeof window.codeAgentDesktop.controlAutomation === 'function';

  return (
    <>
      <SettingSection
        title="权限"
        description="组织上限冻结生效；项目与个人限制只能保持或收紧，最终由 Service 裁决。"
        hideHeader
        testId="permissions-section"
      >
        <SettingRow
          label="组织上限"
          description="由管理员部署冻结，所有层都不能放宽这一限制。"
          scope="MANAGED"
          mutability="MANAGED_LOCKED"
          effective={autonomyLabel(effectiveManagedCeiling)}
          testId="policy-layer-MANAGED"
          advanced={managed ? <span className="run-meta">MANAGED · ceiling {managed.maximumAutonomy ?? '—'} · rev {managed.revision ?? 0}</span> : null}
        >
          <span className="settings-badge mutability-MANAGED_LOCKED">只读</span>
        </SettingRow>

        <SettingRow
          label="项目限制"
          description="作用于该项目新建的会话与运行；不能高于组织上限。"
          scope="PROJECT"
          mutability="EDITABLE"
          source="Service 策略"
          applyMode="NEW_SESSION"
          effective={autonomyLabel(draft?.PROJECT ?? null)}
          testId="policy-layer-PROJECT"
          advanced={project ? <span className="run-meta">PROJECT · rev {project.revision ?? 0}</span> : null}
        >
          <SettingSelect
            ariaLabel="项目限制"
            testId="policy-select-PROJECT"
            value={draft?.PROJECT ?? ''}
            disabled={handle.saveState === 'SAVING'}
            options={layerOptions(projectCeiling, true)}
            onChange={(value) => handle.setField('PROJECT', value === '' ? null : value)}
          />
        </SettingRow>

        <SettingRow
          label="个人限制"
          description="仅影响你本人的新会话；不能高于项目限制。"
          scope="USER"
          mutability="EDITABLE"
          source="Service 策略"
          applyMode="NEW_SESSION"
          effective={autonomyLabel(draft?.USER ?? null)}
          testId="policy-layer-USER"
          advanced={user ? <span className="run-meta">USER · rev {user.revision ?? 0}</span> : null}
        >
          <SettingSelect
            ariaLabel="个人限制"
            testId="policy-select-USER"
            value={draft?.USER ?? ''}
            disabled={handle.saveState === 'SAVING'}
            options={layerOptions(userCeiling, true)}
            onChange={(value) => handle.setField('USER', value === '' ? null : value)}
          />
        </SettingRow>

        <div className="settings-effective-line" data-testid="policy-effective" title={`canonical: ${effectiveLabel}`}>
          当前有效：<strong>{AUTONOMY_LABELS[effectiveLabel] ?? effectiveLabel}</strong>
        </div>

        {handle.saveState === 'CONFLICT' ? (
          <ConflictPanel
            serverValue={`项目 ${autonomyLabel(project?.maximumAutonomy ?? null)} · 个人 ${autonomyLabel(user?.maximumAutonomy ?? null)}`}
            draftValue={`项目 ${autonomyLabel(draft?.PROJECT ?? null)} · 个人 ${autonomyLabel(draft?.USER ?? null)}`}
            onReload={() => {
              handle.adoptServerState();
              void queryClient.invalidateQueries({ queryKey: settingsKeys.policyLayers });
            }}
          />
        ) : null}
        {handle.remoteChanged && handle.saveState !== 'CONFLICT' ? (
          <p className="settings-remote-changed" data-testid="settings-remote-changed">策略已在后台更新；你的修改仍保留在草稿中。</p>
        ) : null}
        {handle.errorMessage ? <SectionError message={friendlySaveError(handle.errorMessage)} /> : null}
      </SettingSection>

      <SettingSection
        title="新会话默认权限"
        description="选择后立即写入 Service 的持久用户默认；每个新会话都继承它。完全访问即服务端直授，无需二次确认。"
        testId="session-defaults-section"
      >
        {myDefaults.isError ? (
          <SectionError message="无法读取用户默认权限（Service 未提供 /me 默认值）。" />
        ) : (
          <SettingRow
            label="默认权限模式"
            description="新会话未显式选择模式时使用；会话内可随时覆盖。"
            scope="USER"
            mutability="EDITABLE"
            source="Service 策略"
            applyMode="NEW_SESSION"
            effective={myDefaults.data?.mode ? (MODE_LABELS[myDefaults.data.mode as PermissionMode] ?? myDefaults.data.mode) : '…'}
            testId="session-defaults-row"
            advanced={myDefaults.data ? <span className="run-meta">USER · rev {myDefaults.data.revision ?? 0}</span> : null}
          >
            <SettingSelect
              ariaLabel="新会话默认权限模式"
              testId="session-default-mode"
              value={myDefaults.data?.mode ?? ''}
              disabled={!myDefaults.data || updateMyDefaults.isPending}
              options={(myDefaults.data?.supportedModes?.length
                ? myDefaults.data.supportedModes
                : ['STANDARD', 'AUTO_APPROVE', 'FULL_ACCESS']
              ).map((mode) => ({ value: mode, label: MODE_LABELS[mode as PermissionMode] ?? mode }))}
              onChange={(value) => {
                if (!myDefaults.data || !value || value === myDefaults.data.mode) return;
                updateMyDefaults.mutate(value as PermissionMode);
              }}
            />
          </SettingRow>
        )}
        {updateMyDefaults.isError ? (
          <SectionError message={friendlySaveError(String(updateMyDefaults.error))} />
        ) : null}
      </SettingSection>

      <SettingSection
        title="自动批准调度"
        description="延时策略由 Service 执行；没有可验证的调度控制能力时不显示暂停/恢复按钮。"
        testId="automation-controls-section"
      >
        {automationAvailable ? <div className="settings-effective-line" data-testid="automation-controls-available">
          Service 已提供真实的自动批准队列控制；请在具体会话的输入区上方暂停或恢复自动派发。
        </div> : <UnavailableState
          title="调度控制暂不可用"
          message="当前客户端不会伪造自动批准的暂停或恢复操作；请处理输入区中的权威审批状态。"
          reasonCode={automationReason}
        />}
      </SettingSection>

      <SaveBar
        saveState={handle.saveState}
        hasChanges={handle.hasChanges}
        applyMode="NEW_SESSION"
        saveSuccess={handle.saveSuccess}
        onSave={handle.save}
        onCancel={handle.discard}
        saveLabel="保存策略"
      />
      <p className="settings-hint">
        策略修改影响新会话与运行；已冻结的目录不变。已记录 reason：{reasonLabel('POLICY_ELEVATION_FORBIDDEN')}
      </p>
    </>
  );
}
