/**
 * Permission mode affordance for the composer dock.
 *
 * The renderer may display the product's standard permission vocabulary, but
 * it must not turn a local select change into an authorization grant. The
 * caller must provide both the service capability and the real mutation
 * callback before the control becomes interactive.
 */
import type { DesktopCapabilities } from '../../../../electron/shared/api-types';

export type PermissionMode = 'STANDARD' | 'AUTO_APPROVE' | 'FULL_ACCESS';

export interface PermissionModeModelProps {
  capabilities?: DesktopCapabilities;
  value?: PermissionMode;
  supportedModes?: PermissionMode[];
  lockedModes?: PermissionMode[];
  lockReasons?: Record<string, string>;
  pending?: boolean;
  /** Grant semantics generation of the current row (2 = direct grant). */
  permissionSemanticsVersion?: number;
  /** Service-reported grant activation; non-ACTIVE rows surface reasons. */
  activationStatus?: string;
  blockingReasons?: string[];
  onChange?: (mode: PermissionMode) => void | Promise<void>;
}

interface PermissionModeSelectorProps extends PermissionModeModelProps {
  /** Visible title and select aria-label; defaults to 权限模式. */
  label?: string;
}

export const PERMISSION_MODE_ORDER: PermissionMode[] = ['STANDARD', 'AUTO_APPROVE', 'FULL_ACCESS'];

/** Short chip/menu labels (U2) — the long option text stays in the selector. */
export const PERMISSION_MODE_SHORT_LABELS: Record<PermissionMode, string> = {
  STANDARD: '标准',
  AUTO_APPROVE: '自动批准',
  FULL_ACCESS: '完全访问'
};

export const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  STANDARD: '需要时询问',
  AUTO_APPROVE: '延时后自动继续',
  FULL_ACCESS: '不再逐次询问'
};

function permissionModeOperation(capabilities: DesktopCapabilities | undefined) {
  return capabilities?.operations?.find((operation) => operation.id === 'execution.policy.update')
    ?? capabilities?.operations?.find((operation) => operation.id === 'permission.mode.update');
}

/**
 * Shared fail-closed decision model (ui-polish-plan-2026-10 §6.1): the
 * settings-page <select> and the composer PermissionModeMenu must derive
 * canChange / status / locked modes from exactly one rule set so neither can
 * offer a grant the other would refuse.
 */
export function usePermissionModeModel(props: PermissionModeModelProps) {
  const mode = props.value ?? 'STANDARD';
  const operation = permissionModeOperation(props.capabilities);
  // A capability alone is not enough: a real service-backed mutation must be
  // wired by the caller before changing the select can have any effect.
  const canChange = operation?.availability === 'AVAILABLE' && typeof props.onChange === 'function';
  const supported = props.supportedModes ?? PERMISSION_MODE_ORDER;
  const locked = props.lockedModes ?? [];
  const status = !props.capabilities
    ? '服务能力尚未完成握手，保持标准权限'
    : !operation
      ? '服务未声明权限模式 API，保持标准权限'
      : operation.availability !== 'AVAILABLE'
        ? `权限模式暂不可用（${operation.reasonCode ?? operation.availability}）`
        : canChange
          ? '权限由服务确认后生效'
          : '权限更新尚未接入，保持标准权限';

  const select = (next: PermissionMode): void => {
    if (!canChange || props.pending === true) return;
    if (!supported.includes(next) || locked.includes(next)) return;
    // FULL_ACCESS semantics v2: selecting the mode IS the grant —
    // no second confirmation step; the service persists it directly.
    void props.onChange?.(next);
  };

  const legacySemantics = typeof props.permissionSemanticsVersion === 'number'
    && props.permissionSemanticsVersion < 2;
  const blockingReasons = (props.blockingReasons ?? []).filter((reason) => reason.trim().length > 0);
  const statusText = typeof props.activationStatus === 'string' && props.activationStatus.trim().length > 0
    ? props.activationStatus : null;
  const activationWarning = props.activationStatus !== undefined && props.activationStatus !== 'ACTIVE'
    ? blockingReasons.length > 0
      ? `授权未生效：${blockingReasons.join('；')}`
      : statusText ? `授权未生效（${statusText}）` : '授权未生效，服务未返回原因'
    : null;

  return { mode, operation, canChange, supported, locked, status, select, legacySemantics, activationWarning };
}

export function PermissionModeSelector(props: PermissionModeSelectorProps): React.JSX.Element {
  const model = usePermissionModeModel(props);
  const { mode, canChange, supported, locked, status } = model;

  return (
    <div className="permission-mode-selector" data-testid="permission-mode-selector">
      <div className="permission-mode-label">
        <span className="permission-mode-title">{props.label ?? '权限模式'}</span>
        <span className="permission-mode-status" role="status">{status}</span>
      </div>
      <select
        aria-label={props.label ?? '权限模式'}
        value={mode}
        disabled={!canChange || props.pending === true}
        onChange={(event) => model.select(event.target.value as PermissionMode)}
      >
        <option value="STANDARD" disabled={!supported.includes('STANDARD')}>标准权限 · 需要时询问{locked.includes('STANDARD') ? '（已锁定）' : ''}</option>
        <option value="AUTO_APPROVE" disabled={!supported.includes('AUTO_APPROVE')}>自动批准 · 延时继续{locked.includes('AUTO_APPROVE') ? '（已锁定）' : ''}</option>
        <option value="FULL_ACCESS" disabled={!supported.includes('FULL_ACCESS')}>完全访问权限 · 不逐次询问{locked.includes('FULL_ACCESS') ? '（已锁定）' : ''}</option>
      </select>
      {mode === 'FULL_ACCESS' && props.lockReasons?.FULL_ACCESS ? (
        <p className="permission-mode-lock-reason">{props.lockReasons.FULL_ACCESS}</p>
      ) : null}
      {mode === 'FULL_ACCESS' && model.legacySemantics ? (
          <p className="permission-mode-semantics" data-testid="permission-mode-semantics">
            当前为旧版授权语义（逐项确认）；重新选择完全访问权限可升级为直接授权。
          </p>
        ) : null}
      {model.activationWarning ? (
        <p className="permission-mode-activation" role="status" data-testid="permission-mode-activation">
          {model.activationWarning}
        </p>
      ) : null}
    </div>
  );
}
