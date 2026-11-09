import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface TerminalViewHandle {
  /** Raw bytes (RAW_VT) or text (PLAIN_TEXT) from the Service-owned PTY. */
  write(data: string | Uint8Array): void;
  /** RIS reset: clears screen and scrollback. Used after an output gap. */
  reset(): void;
  focus(): void;
  /** Selection text when present, otherwise the full active buffer. */
  copyText(): string;
  dimensions(): { columns: number; rows: number } | null;
}

export interface TerminalViewProps {
  /** Keystrokes/paste from the emulator; UTF-8 text including escape sequences. */
  onData?: (data: string) => void;
  /** Fired after fit() resizes the emulator; debounce before POSTing resize. */
  onResize?: (columns: number, rows: number) => void;
  /** Pointer/keyboard intent on the surface; the dock uses it to take control. */
  onUserIntent?: () => void;
}

const FIT_DEBOUNCE_MILLIS = 120;

/**
 * xterm.js renderer for a Service-owned PTY session. There is no local
 * process here: output bytes arrive from the Service output cursor and
 * keystrokes leave through the terminal input API.
 */
export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView(props, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const callbacksRef = useRef(props);
    callbacksRef.current = props;

    useImperativeHandle(ref, () => ({
      write(data) {
        terminalRef.current?.write(data);
      },
      reset() {
        terminalRef.current?.reset();
      },
      focus() {
        terminalRef.current?.focus();
      },
      copyText() {
        const term = terminalRef.current;
        if (!term) return '';
        const selection = term.getSelection();
        if (selection) return selection;
        const buffer = term.buffer.active;
        const lines: string[] = [];
        for (let i = 0; i < buffer.length; i += 1) {
          lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
        }
        return lines.join('\n').replace(/\s+$/u, '');
      },
      dimensions() {
        const term = terminalRef.current;
        return term ? { columns: term.cols, rows: term.rows } : null;
      }
    }), []);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
        scrollback: 5000,
        theme: {
          background: '#10100f',
          foreground: '#d8d4c8',
          cursor: '#d8d4c8',
          selectionBackground: 'rgba(216, 212, 200, 0.25)'
        }
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      terminalRef.current = term;
      term.onData((data) => callbacksRef.current.onData?.(data));
      term.onResize(({ cols, rows }) => callbacksRef.current.onResize?.(cols, rows));
      term.attachCustomKeyEventHandler((event) => {
        // Ctrl+C copies when a selection exists, otherwise passes through as
        // \x03 (SIGINT) to the Service-owned process.
        if (event.type === 'keydown' && event.ctrlKey && !event.shiftKey
            && event.key.toLowerCase() === 'c' && term.hasSelection()
            && navigator.clipboard) {
          void navigator.clipboard.writeText(term.getSelection());
          return false;
        }
        return true;
      });

      let fitTimer: number | null = null;
      const scheduleFit = (): void => {
        if (fitTimer !== null) window.clearTimeout(fitTimer);
        fitTimer = window.setTimeout(() => {
          fitTimer = null;
          try {
            fit.fit();
          } catch {
            // Zero-sized containers (hidden pane, jsdom) produce no proposal.
          }
        }, FIT_DEBOUNCE_MILLIS);
      };
      scheduleFit();
      const observer = new ResizeObserver(scheduleFit);
      observer.observe(container);
      return () => {
        observer.disconnect();
        if (fitTimer !== null) window.clearTimeout(fitTimer);
        terminalRef.current = null;
        term.dispose();
      };
    }, []);

    return (
      <div
        className="terminal-view"
        data-testid="terminal-view"
        onMouseDown={() => callbacksRef.current.onUserIntent?.()}
        onFocusCapture={() => callbacksRef.current.onUserIntent?.()}
      >
        <div className="terminal-view-host" ref={containerRef} />
      </div>
    );
  }
);
