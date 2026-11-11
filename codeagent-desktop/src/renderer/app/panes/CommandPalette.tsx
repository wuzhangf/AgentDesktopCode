import { useMemo, useState } from 'react';
import { Icon } from '../Icon';
import type { IconName } from '../Icon';

export interface PaletteCommand {
  label: string;
  icon: IconName;
  shortcut?: string;
  action: () => void;
}

/** Command picker: the list is declared by the caller; the palette owns
 * filtering and keyboard selection only. */
export function CommandPalette(props: {
  onClose: () => void;
  onNewSession: () => void;
  onOpenAttention: () => void;
  onOpenMissions: () => void;
  onOpenExtensions: () => void;
  onOpenSettings: (route: 'OVERVIEW' | 'PERMISSIONS' | 'PRIVACY_EVIDENCE' | 'MODELS' | 'DIAGNOSTICS') => void;
  onOpenGit: () => void;
  /** Session-scoped pane openers — only passed when a session is selected. */
  onOpenPlan?: () => void;
  onOpenMissionPane?: () => void;
  onOpenDetails?: () => void;
  /** Task-level actions — surfaced only while the wiring exists. */
  onStopRun?: () => void;
  onExportSession?: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [
      { label: '新建会话', icon: 'plus', shortcut: 'Ctrl N', action: props.onNewSession },
      { label: '打开待处理', icon: 'alert', action: props.onOpenAttention },
      { label: '打开任务编排', icon: 'list', action: props.onOpenMissions },
      { label: '打开扩展', icon: 'panel', action: props.onOpenExtensions },
      { label: '打开设置 · 概览', icon: 'settings', action: () => props.onOpenSettings('OVERVIEW') },
      { label: '打开设置 · 权限', icon: 'shield', action: () => props.onOpenSettings('PERMISSIONS') },
      { label: '打开设置 · 隐私与证据', icon: 'shield', action: () => props.onOpenSettings('PRIVACY_EVIDENCE') },
      { label: '打开设置 · Agent 与模型', icon: 'settings', action: () => props.onOpenSettings('MODELS') },
      { label: '打开设置 · 诊断', icon: 'terminal', action: () => props.onOpenSettings('DIAGNOSTICS') },
      { label: '打开 Git', icon: 'file', action: props.onOpenGit }
    ];
    if (props.onOpenPlan) list.push({ label: '打开计划面板', icon: 'list', action: props.onOpenPlan });
    if (props.onOpenMissionPane) list.push({ label: '打开任务编排面板', icon: 'chart', action: props.onOpenMissionPane });
    if (props.onOpenDetails) list.push({ label: '打开会话详情', icon: 'panel', action: props.onOpenDetails });
    if (props.onStopRun) list.push({ label: '停止当前运行', icon: 'stop', action: props.onStopRun });
    if (props.onExportSession) list.push({ label: '导出当前会话', icon: 'download', action: props.onExportSession });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onNewSession, props.onOpenAttention, props.onOpenMissions, props.onOpenExtensions, props.onOpenSettings, props.onOpenGit, props.onOpenPlan, props.onOpenMissionPane, props.onOpenDetails, props.onStopRun, props.onExportSession]);

  const normalized = query.trim().toLowerCase();
  const visible = normalized
    ? commands.filter((command) => command.label.toLowerCase().includes(normalized))
    : commands;
  const active = Math.min(activeIndex, Math.max(0, visible.length - 1));

  const run = (command: PaletteCommand) => () => {
    props.onClose();
    command.action();
  };
  return (
    <div
      className="modal-backdrop command-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="command-search"><Icon name="search" size={16} /><input
          autoFocus
          placeholder="输入命令或搜索…"
          aria-label="搜索命令"
          value={query}
          data-testid="command-palette-search"
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(Math.min(active + 1, visible.length - 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(Math.max(active - 1, 0)); }
            else if (event.key === 'Enter' && visible[active]) { event.preventDefault(); run(visible[active])(); }
          }}
        /></div>
        <div className="command-list" role="listbox" aria-label="命令">
          {visible.map((command, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? 'active' : undefined}
              key={command.label}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={run(command)}
            ><Icon name={command.icon} size={15} /><span>{command.label}</span>{command.shortcut ? <kbd>{command.shortcut}</kbd> : null}</button>
          ))}
          {visible.length === 0 ? <p className="command-empty" data-testid="command-empty">没有匹配的命令。</p> : null}
        </div>
        <div className="command-hint"><kbd>Esc</kbd> 关闭 · <kbd>↑↓</kbd> 选择 · <kbd>Enter</kbd> 执行</div>
      </div>
    </div>
  );
}
