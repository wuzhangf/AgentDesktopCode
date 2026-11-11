import { useEffect, useState } from 'react';

type WindowAction = 'MINIMIZE' | 'TOGGLE_MAXIMIZE' | 'CLOSE';

export function DesktopTitleBar(props: { title?: string | null }): React.JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const unsubscribe = window.codeAgentDesktop.onWindowState?.((state) => {
      setIsMaximized(state.isMaximized);
    });
    return unsubscribe;
  }, []);

  const control = (action: WindowAction): void => {
    void window.codeAgentDesktop.controlWindow?.(action);
  };

  return (
    <header className="desktop-titlebar" data-testid="desktop-titlebar">
      <div className="desktop-titlebar-brand no-drag">
        <span className="desktop-titlebar-mark" aria-hidden="true">✦</span>
        <span>CodeAgent</span>
      </div>
      <div className="desktop-titlebar-drag" aria-label="拖动窗口">
        <span className="desktop-title">{props.title?.trim() || '新会话'}</span>
      </div>
      <div className="desktop-window-controls no-drag" aria-label="窗口控制">
        <button type="button" aria-label="最小化窗口" title="最小化" onClick={() => control('MINIMIZE')}>—</button>
        <button
          type="button"
          aria-label={isMaximized ? '还原窗口' : '最大化窗口'}
          title={isMaximized ? '还原' : '最大化'}
          onClick={() => control('TOGGLE_MAXIMIZE')}
        >{isMaximized ? '❐' : '□'}</button>
        <button type="button" className="window-close" aria-label="关闭窗口" title="关闭" onClick={() => control('CLOSE')}>×</button>
      </div>
    </header>
  );
}
