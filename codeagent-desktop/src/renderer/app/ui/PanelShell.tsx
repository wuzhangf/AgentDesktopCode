import { useId } from 'react';
import { Icon } from '../Icon';

/**
 * Shared floating-panel chrome (ui-polish-plan-2026-10 §5.1): one header
 * (title + optional status/subtitle + actions + close), a scrollable body and
 * an optional sticky footer. No eyebrow labels — the title is the only
 * heading. Styles live in styles/panels.css.
 */
export function PanelHeader(props: {
  title: string;
  titleId?: string;
  subtitle?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
  closeLabel: string;
}): React.JSX.Element {
  return (
    <header className="panel-shell-header">
      <div className="panel-shell-heading">
        <div className="panel-shell-title-row">
          <h2 className="panel-shell-title" id={props.titleId}>{props.title}</h2>
          {props.status}
        </div>
        {props.subtitle != null && props.subtitle !== '' ? (
          <p className="panel-shell-subtitle" title={typeof props.subtitle === 'string' ? props.subtitle : undefined}>
            {props.subtitle}
          </p>
        ) : null}
      </div>
      <div className="panel-shell-actions">
        {props.actions}
        <button
          type="button"
          className="icon-button"
          title={props.closeLabel}
          aria-label={props.closeLabel}
          onClick={props.onClose}
        ><Icon name="x" size={16} /></button>
      </div>
    </header>
  );
}

export function PanelShell(props: {
  title: string;
  titleId?: string;
  subtitle?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  onClose: () => void;
  closeLabel: string;
  footer?: React.ReactNode;
  testId?: string;
  className?: string;
  bodyClassName?: string;
  role?: string;
  ariaLabel?: string;
  ariaModal?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const autoTitleId = useId();
  const titleId = props.titleId ?? autoTitleId;
  return (
    <section
      className={`panel-shell${props.className ? ` ${props.className}` : ''}`}
      data-testid={props.testId}
      role={props.role}
      aria-modal={props.role === 'dialog' ? props.ariaModal ?? false : undefined}
      aria-label={props.ariaLabel}
      aria-labelledby={props.ariaLabel ? undefined : titleId}
    >
      <PanelHeader
        title={props.title}
        titleId={titleId}
        subtitle={props.subtitle}
        status={props.status}
        actions={props.actions}
        onClose={props.onClose}
        closeLabel={props.closeLabel}
      />
      <div className={`panel-shell-body${props.bodyClassName ? ` ${props.bodyClassName}` : ''}`}>
        {props.children}
      </div>
      {props.footer != null ? <footer className="panel-shell-footer">{props.footer}</footer> : null}
    </section>
  );
}
