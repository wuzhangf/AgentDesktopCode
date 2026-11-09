import { Icon } from '../Icon';
import { PanelHeader } from '../ui/PanelShell';

/**
 * Floating/docked work pane chrome: shared panel header, dock toggle, close
 * button and the left-edge resize handle. Content stays owned by the caller.
 */
export function WorkPane(props: {
  label: string;
  title: string;
  subtitle?: React.ReactNode;
  closeLabel: string;
  docked: boolean;
  floatingWidth: string;
  className?: string;
  onResizeStart: (event: React.PointerEvent) => void;
  onToggleDock: () => void;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <aside
      className={`work-pane work-pane-floating ${props.className ?? ''}`.trim()}
      aria-label={props.label}
      style={props.docked ? undefined : { width: props.floatingWidth }}
    >
      <div
        className="work-pane-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        onPointerDown={props.onResizeStart}
      />
      <PanelHeader
        title={props.title}
        subtitle={props.subtitle}
        onClose={props.onClose}
        closeLabel={props.closeLabel}
        actions={(
          <button
            type="button"
            className={`icon-button${props.docked ? ' selected' : ''}`}
            title={props.docked ? '取消停靠' : '停靠到右侧'}
            aria-label={props.docked ? '取消停靠' : '停靠到右侧'}
            aria-pressed={props.docked}
            onClick={props.onToggleDock}
          ><Icon name="pin" size={15} /></button>
        )}
      />
      {props.children}
    </aside>
  );
}
