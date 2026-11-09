/**
 * Composer permission-mode chip + menu (ui-polish-plan-2026-10 §6.1).
 *
 * The chip always shows the session's current mode; the menu reuses
 * usePermissionModeModel so its affordances fail closed under the exact same
 * rules as the settings-page PermissionModeSelector. Selecting FULL_ACCESS is
 * the grant — the menu calls onChange directly, no local confirmation.
 */
import { useRef } from 'react';
import { Icon } from '../Icon';
import { Menu, MenuRadioItem, Popover } from '../ui/Popover';
import {
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_SHORT_LABELS,
  usePermissionModeModel,
  type PermissionMode,
  type PermissionModeModelProps
} from './PermissionModeSelector';

const MODE_ICONS = { STANDARD: 'shield', AUTO_APPROVE: 'play', FULL_ACCESS: 'alert' } as const;

export function PermissionModeMenu(props: PermissionModeModelProps & {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Pending approvals for this session; the jump row only renders above zero. */
  pendingApprovalCount?: number;
  onJumpToApprovals?: () => void;
  /** Automation dispatch row — rendered only when the capability is wired. */
  automation?: {
    paused: boolean;
    pending: boolean;
    disabled: boolean;
    onToggle: () => void;
  };
  onOpenProjectDefaults?: () => void;
}): React.JSX.Element {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const model = usePermissionModeModel(props);
  const { mode, canChange, supported, locked } = model;
  const shortLabel = PERMISSION_MODE_SHORT_LABELS[mode];
  const warn = mode === 'FULL_ACCESS' || model.activationWarning !== null;
  const pendingApprovals = props.pendingApprovalCount ?? 0;

  return (
    <span className="popover-anchor permission-mode-anchor">
      <button
        ref={anchorRef}
        type="button"
        className={`composer-chip permission-mode-chip${warn ? ' warn' : ''}${props.open ? ' selected' : ''}`}
        data-testid="permission-mode-chip"
        title={`权限模式：${shortLabel}`}
        aria-label={`权限模式：${shortLabel}`}
        aria-expanded={props.open}
        aria-controls="approval-settings-panel"
        onClick={props.onToggle}
      >
        <Icon name={warn ? 'alert' : 'shield'} size={13} />
        {shortLabel}
        <Icon name="chevron" size={11} className="chip-chevron" />
      </button>
      <Popover
        open={props.open}
        onClose={props.onClose}
        anchorRef={anchorRef}
        placement="top"
        align="start"
        className="permission-mode-menu"
        id="approval-settings-panel"
        testId="approval-settings-panel"
        ariaLabel="权限模式"
      >
        <div className="menu-caption">权限模式 · 作用于当前会话</div>
        {!canChange ? <p className="menu-status" role="status">{model.status}</p> : null}
        {model.activationWarning ? (
          <p className="menu-status warn" role="status" data-testid="permission-mode-activation">{model.activationWarning}</p>
        ) : null}
        {mode === 'FULL_ACCESS' && model.legacySemantics ? (
          <p className="menu-status" data-testid="permission-mode-semantics">
            当前为旧版授权语义（逐项确认）；重新选择完全访问权限可升级为直接授权。
          </p>
        ) : null}
        <div data-testid="permission-mode-row">
          <Menu ariaLabel="权限模式" autoFocus={false}>
            {PERMISSION_MODE_ORDER.map((candidate) => {
              const isLocked = locked.includes(candidate);
              const isSupported = supported.includes(candidate);
              const disabled = !canChange || props.pending === true || isLocked || !isSupported;
              const reason = isLocked
                ? (props.lockReasons?.[candidate] ?? '已被组织策略锁定')
                : !isSupported ? '当前会话不支持此模式' : undefined;
              return (
                <MenuRadioItem
                  key={candidate}
                  icon={MODE_ICONS[candidate]}
                  title={PERMISSION_MODE_SHORT_LABELS[candidate]}
                  description={PERMISSION_MODE_DESCRIPTIONS[candidate]}
                  checked={mode === candidate}
                  disabled={disabled}
                  disabledReason={reason}
                  testId={`permission-mode-item-${candidate}`}
                  onSelect={() => {
                    if (disabled) return;
                    model.select(candidate);
                    props.onClose();
                  }}
                />
              );
            })}
          </Menu>
        </div>
        {pendingApprovals > 0 || props.automation || props.onOpenProjectDefaults ? (
          <div className="menu-extra">
            <div className="menu-caption">运行与审批</div>
            {pendingApprovals > 0 ? (
              <div className="menu-extra-row" data-testid="approval-pending-summary">
                <span>{pendingApprovals} 项审批等待决定</span>
                {props.onJumpToApprovals ? (
                  <button type="button" className="link-button" onClick={() => { props.onJumpToApprovals?.(); props.onClose(); }}>跳转</button>
                ) : null}
              </div>
            ) : null}
            {props.automation ? (
              <div className="menu-extra-row" data-testid="automation-control">
                <span>自动批准调度：{props.automation.paused ? '已暂停' : '运行中'}</span>
                <button
                  type="button"
                  className="secondary-button small"
                  data-testid="automation-control-toggle"
                  disabled={props.automation.disabled || props.automation.pending}
                  onClick={props.automation.onToggle}
                >{props.automation.paused ? '恢复' : '暂停'}</button>
              </div>
            ) : null}
            {props.onOpenProjectDefaults ? (
              <button
                type="button"
                className="menu-extra-link"
                onClick={() => { props.onOpenProjectDefaults?.(); props.onClose(); }}
              >项目默认权限在 设置 › 项目与会话 中修改<Icon name="chevron" size={11} className="menu-extra-arrow" /></button>
            ) : null}
          </div>
        ) : null}
      </Popover>
    </span>
  );
}
