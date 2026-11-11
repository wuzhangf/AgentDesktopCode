/**
 * Shared Settings Center presentation components (settings design §7.1/§11).
 *
 * Every row renders scope, effective value, source and apply mode as text —
 * never color-only. Managed rows show a lock reason; unavailable sections
 * show a typed state instead of fake controls. Mutations go through the
 * sticky review bar, never through hidden instant submits.
 */

import { useEffect, useId } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../Icon';
import {
  APPLY_MODE_LABELS,
  MUTABILITY_LABELS,
  SCOPE_LABELS,
  availabilityLabel,
  reasonLabel
} from './settingsPresentation';
import type { ApplyMode, Availability, SettingMutability } from './settingsPresentation';
import type { DraftSaveState, SettingsScope } from './useSettingsDraft';

export function ScopeBadge(props: { scope: SettingsScope | string }): React.JSX.Element {
  return <span className={`settings-badge scope-${props.scope}`}>{SCOPE_LABELS[props.scope as SettingsScope] ?? props.scope}</span>;
}

export function ApplyModeBadge(props: { applyMode: ApplyMode | string }): React.JSX.Element {
  return <span className={`settings-badge apply-${props.applyMode}`}>{APPLY_MODE_LABELS[props.applyMode as ApplyMode] ?? props.applyMode}</span>;
}

export function AvailabilityBadge(props: { availability: Availability | string; reasonCode?: string | null }): React.JSX.Element {
  const reason = reasonLabel(props.reasonCode);
  return (
    <span className={`settings-badge availability-${props.availability}`}>
      {availabilityLabel(props.availability)}
      {reason ? <span className="settings-badge-reason"> · {reason}</span> : null}
    </span>
  );
}

export function MutabilityBadge(props: { mutability: SettingMutability }): React.JSX.Element {
  return <span className={`settings-badge mutability-${props.mutability}`}>{MUTABILITY_LABELS[props.mutability]}</span>;
}

/**
 * One setting row: label, description, scope/effective/source/apply line,
 * then the control or its locked reason. Advanced metadata stays in a
 * disclosure instead of a tooltip so screen readers can reach it.
 */
export function SettingRow(props: {
  label: string;
  description?: string;
  scope?: SettingsScope | string;
  source?: string;
  effective?: string;
  applyMode?: ApplyMode | string;
  mutability?: SettingMutability;
  lockedReason?: string | null;
  advanced?: ReactNode;
  testId?: string;
  children?: ReactNode;
}): React.JSX.Element {
  const rowId = useId();
  const locked = props.mutability === 'MANAGED_LOCKED' || props.mutability === 'READ_ONLY' || props.mutability === 'UNAVAILABLE';
  return (
    <div className={`setting-row ${locked ? 'setting-row-locked' : ''}`} data-testid={props.testId}>
      <div className="setting-row-main">
        <div className="setting-row-heading">
          <span className="setting-row-label" id={`${rowId}-label`}>{props.label}</span>
          {props.scope ? <ScopeBadge scope={props.scope} /> : null}
          {props.mutability ? <MutabilityBadge mutability={props.mutability} /> : null}
        </div>
        {props.description ? <p className="setting-row-description">{props.description}</p> : null}
        <p className="setting-row-meta">
          {props.effective !== undefined ? <span>当前：<strong>{props.effective}</strong></span> : null}
          {props.source ? <span>来源：{props.source}</span> : null}
          {props.applyMode ? <span>{APPLY_MODE_LABELS[props.applyMode as ApplyMode] ?? props.applyMode}</span> : null}
        </p>
        {props.mutability === 'MANAGED_LOCKED' || props.lockedReason ? (
          <p className="setting-row-locked-reason">
            <span aria-hidden="true">🔒</span> {props.lockedReason ?? '由上层策略固定，无法在此修改。'}
          </p>
        ) : null}
        {props.advanced ? <details className="setting-row-advanced"><summary>技术详情</summary>{props.advanced}</details> : null}
      </div>
      <div className="setting-row-control" aria-labelledby={`${rowId}-label`}>{props.children}</div>
    </div>
  );
}

export function SettingSection(props: {
  title: string;
  description?: string;
  /**
   * Drop the section heading when the page head already renders the same
   * label (settings pages render definition.label themselves). The
   * description still renders when it carries extra information.
   */
  hideHeader?: boolean;
  actions?: ReactNode;
  testId?: string;
  children: ReactNode;
}): React.JSX.Element {
  const showHeader = !props.hideHeader || props.description != null || props.actions != null;
  return (
    <section className="setting-section" data-testid={props.testId}>
      {showHeader ? (
        <header className="setting-section-header">
          <div>
            {props.hideHeader ? null : <h2>{props.title}</h2>}
            {props.description ? <p>{props.description}</p> : null}
          </div>
          {props.actions ? <div className="setting-section-actions">{props.actions}</div> : null}
        </header>
      ) : null}
      {props.children}
    </section>
  );
}

export function SettingToggle(props: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  testId?: string;
  title?: string;
  ariaDescribedBy?: string;
}): React.JSX.Element {
  return (
    <label className="setting-toggle" title={props.title}>
      <input
        type="checkbox"
        role="switch"
        data-testid={props.testId}
        checked={props.checked}
        disabled={props.disabled}
        aria-describedby={props.ariaDescribedBy}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="sr-only">{props.label}</span>
    </label>
  );
}

export function SettingSelect<T extends string>(props: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  disabled?: boolean;
  onChange: (value: T) => void;
  ariaLabel: string;
  testId?: string;
}): React.JSX.Element {
  return (
    <select
      data-testid={props.testId}
      value={props.value}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      onChange={(event) => props.onChange(event.target.value as T)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
      ))}
    </select>
  );
}

export function SettingNumber(props: {
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  invalid?: boolean;
  onChange: (value: number | null) => void;
  ariaLabel: string;
  testId?: string;
}): React.JSX.Element {
  return (
    <input
      type="number"
      className={`setting-number ${props.invalid ? 'setting-number-invalid' : ''}`}
      data-testid={props.testId}
      value={Number.isFinite(props.value) ? props.value : ''}
      min={props.min}
      max={props.max}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      aria-invalid={props.invalid || undefined}
      onChange={(event) => {
        const parsed = event.target.valueAsNumber;
        props.onChange(Number.isFinite(parsed) ? parsed : null);
      }}
    />
  );
}

/** Section footer review bar per §7.2: one Save per authoritative section. */
export function SaveBar(props: {
  saveState: DraftSaveState;
  hasChanges: boolean;
  applyMode: ApplyMode;
  saveSuccess: boolean;
  invalidHint?: string | null;
  onSave: () => void;
  onCancel: () => void;
  saveLabel?: string;
}): React.JSX.Element | null {
  const saving = props.saveState === 'SAVING';
  // Idle renders nothing: a permanently docked bar with two disabled
  // buttons was visual noise and its sticky position covered row content.
  if (!saving && !props.hasChanges && !props.saveSuccess && !props.invalidHint) {
    return null;
  }
  return (
    <div className="settings-save-bar" data-testid="settings-save-bar">
      <span className="settings-save-feedback" aria-live="polite">
        {props.saveState === 'SAVING' ? '正在保存…' : null}
        {props.saveState !== 'SAVING' && props.saveSuccess ? saveFeedbackText(props.applyMode) : null}
        {props.saveState !== 'SAVING' && !props.saveSuccess && props.invalidHint ? <span className="settings-error-text">{props.invalidHint}</span> : null}
        {props.saveState !== 'SAVING' && !props.saveSuccess && !props.invalidHint && props.hasChanges ? '有未保存的修改' : null}
      </span>
      <span className="settings-save-actions">
        <button type="button" data-testid="settings-cancel" onClick={props.onCancel} disabled={!props.hasChanges || saving}>放弃修改</button>
        <button
          type="button"
          className="primary-button"
          data-testid="settings-save"
          aria-busy={saving}
          onClick={props.onSave}
          disabled={!props.hasChanges || saving || Boolean(props.invalidHint)}
        >
          {saving ? '保存中…' : props.saveLabel ?? '保存'}
        </button>
      </span>
    </div>
  );
}

function saveFeedbackText(applyMode: ApplyMode): string {
  switch (applyMode) {
    case 'IMMEDIATE': return '已保存 · 立即生效';
    case 'NEXT_SAFE_REQUEST': return '已保存 · 下一个安全请求生效';
    case 'NEXT_RUN': return '已保存 · 对新运行生效';
    case 'NEW_SESSION': return '已保存 · 对新会话生效';
    case 'RECONNECT': return '已保存 · 重新连接后生效';
    case 'SERVICE_RESTART': return '已保存 · 重启 Service 后生效';
    default: return '已保存';
  }
}

/** 409 projection per §7.3: keep the draft, show both values, offer reload. */
export function ConflictPanel(props: {
  serverValue: string;
  draftValue: string;
  onReload: () => void;
}): React.JSX.Element {
  return (
    <div className="settings-conflict" role="alert" data-testid="settings-conflict">
      <strong>保存冲突</strong>
      <p>设置已被其他窗口或服务端修改。你的修改尚未写入，请选择加载最新值或放弃。</p>
      <dl>
        <dt>已保存的值</dt>
        <dd>{props.serverValue}</dd>
        <dt>你的修改</dt>
        <dd>{props.draftValue}</dd>
      </dl>
      <button type="button" data-testid="settings-conflict-reload" onClick={props.onReload}>加载最新值（放弃我的修改）</button>
    </div>
  );
}

export function RemoteChangedNotice(props: { onReload: () => void }): React.JSX.Element {
  return (
    <div className="settings-remote-changed" data-testid="settings-remote-changed">
      <span>权威设置已在后台更新；你的修改仍保留在草稿中。</span>
      <button type="button" onClick={props.onReload}>查看最新值</button>
    </div>
  );
}

export function SectionError(props: { message: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="settings-section-error" role="alert">
      <p>{props.message}</p>
      {props.onRetry ? <button type="button" onClick={props.onRetry}>重试</button> : null}
    </div>
  );
}

export function UnavailableState(props: { title: string; message: string; reasonCode?: string | null }): React.JSX.Element {
  return (
    <div className="settings-unavailable" data-testid="settings-unavailable">
      <h2>{props.title}</h2>
      <p>{props.message}</p>
      {props.reasonCode ? <p className="run-meta">{reasonLabel(props.reasonCode) ?? props.reasonCode}</p> : null}
    </div>
  );
}

export function EmptyState(props: { message: string }): React.JSX.Element {
  return <p className="settings-empty">{props.message}</p>;
}

export function SkeletonRows(props: { rows?: number }): React.JSX.Element {
  const count = props.rows ?? 3;
  return (
    <div className="settings-skeleton" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => <div key={index} className="settings-skeleton-row" />)}
    </div>
  );
}

/**
 * Floating window for a dense settings editor (Cursor-style modal detail):
 * the page lists items, the dialog owns the form. Backdrop click and
 * Escape both cancel; drafts live only while the dialog is open.
 */
export function SettingsDialog(props: {
  title: string;
  /** Small context line above the title (e.g. the owning provider). */
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** Identity chips under the title (e.g. provider / model id / naming). */
  meta?: ReactNode;
  role?: 'dialog' | 'alertdialog';
  wide?: boolean;
  testId?: string;
  closeTestId?: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  const titleId = useId();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
  return (
    <div
      className="modal-backdrop settings-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      <section
        className={`settings-dialog${props.wide ? ' settings-dialog-wide' : ''}`}
        role={props.role ?? 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={props.testId}
      >
        <header className="settings-dialog-header">
          <div className="settings-dialog-heading">
            {props.eyebrow ? <span className="settings-dialog-eyebrow">{props.eyebrow}</span> : null}
            <h2 id={titleId}>{props.title}</h2>
            {props.description ? <p>{props.description}</p> : null}
            {props.meta ? <div className="settings-dialog-meta">{props.meta}</div> : null}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            data-testid={props.closeTestId}
            onClick={props.onClose}
          >
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="settings-dialog-body">{props.children}</div>
        {props.footer ? <footer className="settings-dialog-footer">{props.footer}</footer> : null}
      </section>
    </div>
  );
}
