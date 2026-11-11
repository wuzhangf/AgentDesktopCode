import { useEffect, useRef } from 'react';
import { Icon, type IconName } from '../Icon';

/**
 * Anchored popover + menu primitives (ui-polish-plan-2026-10 §5.2). The
 * trigger pattern: wrap the trigger button and <Popover> in a
 * `.popover-anchor` element, hold `open` state in the caller.
 */

/** Close on outside mousedown and Escape. Clicks on `anchor` do not dismiss —
 * the trigger's own toggle handles that case. */
export function useDismiss(
  panelRef: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  options?: { active?: boolean; anchor?: React.RefObject<HTMLElement | null> }
): void {
  const active = options?.active ?? true;
  const anchor = options?.anchor;
  useEffect(() => {
    if (!active) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (panelRef.current?.contains(event.target)) return;
      if (anchor?.current?.contains(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [active, anchor, onClose, panelRef]);
}

export function Popover(props: {
  open: boolean;
  onClose: () => void;
  /** Trigger button — clicks are ignored by dismiss and focus returns here on close. */
  anchorRef: React.RefObject<HTMLElement | null>;
  placement?: 'top' | 'bottom';
  align?: 'start' | 'end';
  className?: string;
  /** Element id — referenced by the trigger's aria-controls. */
  id?: string;
  testId?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  useDismiss(panelRef, props.onClose, { active: props.open, anchor: props.anchorRef });
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (props.open) {
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      props.anchorRef.current?.focus();
    }
  }, [props.open, props.anchorRef]);
  if (!props.open) return null;
  return (
    <div
      ref={panelRef}
      id={props.id}
      data-testid={props.testId}
      className={`popover popover-${props.placement ?? 'top'} popover-align-${props.align ?? 'start'}${props.className ? ` ${props.className}` : ''}`}
      role="dialog"
      aria-label={props.ariaLabel}
    >
      {props.children}
    </div>
  );
}

const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]';

/** role="menu" container with ↑/↓ keyboard navigation between enabled items. */
export function Menu(props: {
  ariaLabel: string;
  autoFocus?: boolean;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.autoFocus !== false) {
      menuRef.current?.querySelector<HTMLElement>(`${MENU_ITEM_SELECTOR}:not(:disabled)`)?.focus();
    }
  }, []);
  const move = (delta: number): void => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(`${MENU_ITEM_SELECTOR}:not(:disabled)`) ?? []
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + delta + items.length) % items.length]?.focus();
  };
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={props.ariaLabel}
      className={`menu${props.className ? ` ${props.className}` : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
      }}
    >
      {props.children}
    </div>
  );
}

/** Plain role="menuitem" row for action menus (no checked state). */
export function MenuItem(props: {
  icon?: IconName;
  title: string;
  description?: string;
  disabled?: boolean;
  onSelect: () => void;
  testId?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className="menu-item"
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.icon ? <Icon name={props.icon} size={15} className="menu-item-icon" /> : null}
      <span className="menu-item-text">
        <span className="menu-item-title">{props.title}</span>
        {props.description ? <span className="menu-item-desc">{props.description}</span> : null}
      </span>
    </button>
  );
}

/** role="menuitemradio" row: icon + title + one-line description + right ✓.
 * A disabled item keeps its reason visible as the description line. */
export function MenuRadioItem(props: {
  icon?: IconName;
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
  testId?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={props.checked}
      className={`menu-item${props.checked ? ' checked' : ''}`}
      data-testid={props.testId}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      {props.icon ? <Icon name={props.icon} size={15} className="menu-item-icon" /> : null}
      <span className="menu-item-text">
        <span className="menu-item-title">{props.title}</span>
        {props.disabled && props.disabledReason
          ? <span className="menu-item-desc">{props.disabledReason}</span>
          : props.description ? <span className="menu-item-desc">{props.description}</span> : null}
      </span>
      {props.checked ? <Icon name="check" size={14} className="menu-item-check" /> : null}
    </button>
  );
}
