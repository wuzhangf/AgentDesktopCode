import type { SessionStatusView } from '../sessionStatus';
import { runStateTone } from '../sessionStatus';
import { Icon } from '../Icon';
import type { IconName } from '../Icon';
import { Menu, MenuRadioItem, Popover } from '../ui/Popover';
import { useRef, useState } from 'react';
import type {ReactNode} from 'react';

/**
 * WU05 (design §5.2): the conversation-level header. It sits above the
 * scrolling transcript and hosts the session facts (workspace + current
 * status) plus the flat actions that used to crowd the composer tool row:
 * 变更、状态（活动托盘）、终端、证据、导出（ui-polish-plan-2026-10 §6.3）。
 *
 * Below 1280px the labels collapse to icon-only (CSS); every control keeps
 * an aria-label/title so the action name is still announced.
 */

export function HeaderAction(props: {
  testId?: string;
  label: string;
  icon: IconName;
  /** When set, the left icon is replaced by an 8px run-state dot (§6.3). */
  dotTone?: string | null;
  /** Tooltip override — e.g. the reason a disabled action is unavailable. */
  title?: string;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`header-action${props.selected ? ' selected' : ''}`}
      aria-label={props.label}
      title={props.title ?? props.label}
      data-testid={props.testId}
      disabled={Boolean(props.disabled)}
      onClick={props.onClick}
    >
      {props.dotTone
        ? <span className={`header-action-dot session-status-dot tone-${props.dotTone}`} aria-hidden="true" />
        : <Icon name={props.icon} size={14} />}
      <span className="header-action-label">{props.label}</span>
    </button>
  );
}

/** Shared chrome; actions and status remain owned by the source adapter. */
export function ConversationHeaderFrame(props: {
  title: string;
  status: Pick<SessionStatusView, 'label' | 'tone'> | null;
  statusTestId?: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return <header className="conversation-header" data-testid="conversation-header">
    <div className="conversation-header-meta">
      <span className="conversation-header-workspace" title={props.title}>{props.title}</span>
      {props.status ? <span className={`status-pill tone-${props.status.tone}`} data-tone={props.status.tone} data-testid={props.statusTestId}>
        <span className="session-status-dot" aria-hidden="true" />{props.status.label}
      </span> : null}
      {props.meta}
    </div>
    <div className="conversation-header-actions">{props.children}</div>
  </header>;
}

export function ConversationHeader(props: {
  workspaceAlias: string | null | undefined;
  status: SessionStatusView | null;
  /** State of the session's latest run — feeds the dot on the 状态 action. */
  latestRunState?: string | null;
  gitSelected: boolean;
  statusSelected: boolean;
  evidenceSelected: boolean;
  terminalSelected: boolean;
  exportSelected: boolean;
  evidenceDisabled: boolean;
  terminalDisabled: boolean;
  exportDisabled: boolean;
  /** Why a disabled action is unavailable — shown as the button tooltip. */
  evidenceTitle?: string;
  terminalTitle?: string;
  exportTitle?: string;
  /** Side-channel (旁路讨论) toggle — surfaced as a header action so the
   * floating panel never needs to cover pane or header controls. */
  collaborationSelected?: boolean;
  collaborationDisabled?: boolean;
  collaborationTitle?: string;
  planSelected?: boolean;
  missionSelected?: boolean;
  detailsSelected?: boolean;
  onOpenGit: () => void;
  onOpenStatus: () => void;
  onOpenEvidence: () => void;
  onOpenTerminal: () => void;
  onToggleExport: () => void;
  onToggleCollaboration?: () => void;
  onOpenPlan?: () => void;
  onOpenMission?: () => void;
  onOpenDetails?: () => void;
}): React.JSX.Element {
  const status = props.status;
  const statusDotTone = props.latestRunState ? runStateTone(props.latestRunState) : null;
  const [panesOpen, setPanesOpen] = useState(false);
  const panesAnchorRef = useRef<HTMLButtonElement>(null);
  const panesSelected = Boolean(
    props.terminalSelected || props.evidenceSelected || props.planSelected
    || props.missionSelected || props.detailsSelected
  );
  return (
    <ConversationHeaderFrame title={props.workspaceAlias || '普通对话'} status={status}>
        <HeaderAction
          testId="conversation-header-git"
          label="变更"
          icon="branch"
          selected={props.gitSelected}
          onClick={props.onOpenGit}
        />
        <HeaderAction
          testId="conversation-header-status"
          label="状态"
          icon="play"
          dotTone={statusDotTone}
          selected={props.statusSelected}
          onClick={props.onOpenStatus}
        />
        <span className="popover-anchor">
          <button
            ref={panesAnchorRef}
            type="button"
            className={`header-action${panesOpen || panesSelected ? ' selected' : ''}`}
            aria-label="面板"
            title="面板"
            aria-expanded={panesOpen}
            aria-controls="conversation-header-panes-menu"
            data-testid="conversation-header-panes"
            onClick={() => setPanesOpen((value) => !value)}
          >
            <Icon name="panel" size={14} />
            <span className="header-action-label">面板</span>
            <Icon name="chevron" size={11} className="chip-chevron" />
          </button>
          <Popover
            open={panesOpen}
            onClose={() => setPanesOpen(false)}
            anchorRef={panesAnchorRef}
            placement="bottom"
            align="end"
            id="conversation-header-panes-menu"
            testId="conversation-header-panes-menu"
            ariaLabel="面板"
          >
            <Menu ariaLabel="面板">
              <MenuRadioItem
                icon="terminal"
                title="终端"
                checked={Boolean(props.terminalSelected)}
                disabled={props.terminalDisabled}
                disabledReason={props.terminalTitle}
                testId="conversation-header-terminal"
                onSelect={() => { if (!props.terminalDisabled) { props.onOpenTerminal(); setPanesOpen(false); } }}
              />
              <MenuRadioItem
                icon="shield"
                title="证据"
                checked={Boolean(props.evidenceSelected)}
                disabled={props.evidenceDisabled}
                disabledReason={props.evidenceTitle}
                testId="conversation-header-evidence"
                onSelect={() => { if (!props.evidenceDisabled) { props.onOpenEvidence(); setPanesOpen(false); } }}
              />
              {props.onOpenPlan ? <MenuRadioItem
                icon="list"
                title="计划"
                checked={Boolean(props.planSelected)}
                testId="conversation-header-plan"
                onSelect={() => { props.onOpenPlan?.(); setPanesOpen(false); }}
              /> : null}
              {props.onOpenMission ? <MenuRadioItem
                icon="chart"
                title="任务编排"
                checked={Boolean(props.missionSelected)}
                testId="conversation-header-mission"
                onSelect={() => { props.onOpenMission?.(); setPanesOpen(false); }}
              /> : null}
              {props.onOpenDetails ? <MenuRadioItem
                icon="panel"
                title="详情"
                checked={Boolean(props.detailsSelected)}
                testId="conversation-header-details"
                onSelect={() => { props.onOpenDetails?.(); setPanesOpen(false); }}
              /> : null}
            </Menu>
          </Popover>
        </span>
        <HeaderAction
          testId="conversation-export-button"
          label="导出"
          icon="download"
          selected={props.exportSelected}
          disabled={props.exportDisabled}
          title={props.exportDisabled ? props.exportTitle : undefined}
          onClick={props.onToggleExport}
        />
        {props.onToggleCollaboration ? <HeaderAction
          testId="conversation-collaboration-button"
          label="旁路"
          icon="chat"
          selected={props.collaborationSelected}
          disabled={props.collaborationDisabled}
          title={props.collaborationDisabled ? props.collaborationTitle : '旁路讨论与主 Agent 协作'}
          onClick={props.onToggleCollaboration}
        /> : null}
    </ConversationHeaderFrame>
  );
}
