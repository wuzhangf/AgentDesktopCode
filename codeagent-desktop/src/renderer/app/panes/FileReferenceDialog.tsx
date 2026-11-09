import { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { DesktopProxyError, type FileReadLike } from '../queries';

/**
 * Read-only file viewer. Content, revision and hash are service-returned;
 * the renderer never reads the local filesystem or joins absolute paths.
 */
export function FileReferenceDialog(props: {
  fileRef: string;
  /** Optional 1-based line to scroll into view (e.g. a search hit line). */
  startLine?: number | null;
  query: { isPending: boolean; isError: boolean; error: unknown; data?: FileReadLike };
  revealPending: boolean;
  canReveal: boolean;
  onReveal: (fileRef: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { fileRef, query } = props;
  // FILE_NOT_FOUND means the referenced path does not exist in the resolved
  // workspace — reveal would fail identically, so the action is disabled.
  const fileMissing = query.isError
    && query.error instanceof DesktopProxyError
    && query.error.code === 'FILE_NOT_FOUND';
  const contentRef = useRef<HTMLPreElement | null>(null);
  const startLine = typeof props.startLine === 'number' && Number.isInteger(props.startLine) && props.startLine >= 1
    ? props.startLine : null;
  // Jump the content viewport to the requested line once text lands; the
  // line height tracks the .file-reference-content font metrics.
  useEffect(() => {
    if (startLine === null || !query.data?.contentText) return;
    const pre = contentRef.current;
    if (!pre) return;
    const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight) || 19;
    pre.scrollTop = Math.max(0, (startLine - 4) * lineHeight);
  }, [startLine, query.data?.contentText]);
  return (
    <div
      className="modal-backdrop file-reference-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      <section className="file-reference-pane" role="dialog" aria-modal="true" aria-label="文件查看">
        <header className="modal-header">
          <div>
            <span className="eyebrow">只读文件</span>
            <h2>文件引用</h2>
            <p>文件内容只能由 Service 返回；Renderer 不读取本地文件系统。</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭文件查看" onClick={props.onClose}><Icon name="x" size={17} /></button>
        </header>
        <div className="file-reference-path"><Icon name="file" size={15} /><code>{fileRef}</code></div>
        {query.isPending ? <p className="surface-note">正在从 Service 读取受限文件投影…</p>
          : query.isError ? (
            <p className="error-text">{fileMissing
              ? '引用的文件在该工作区不存在——可能已删除、改名，或活动记录的路径不完整。'
              : `文件读取失败：${String(query.error)}`}</p>
          )
            : query.data ? (
              <>
                <div className="file-reference-meta">
                  <span>{query.data.mediaType}</span>
                  <span>{query.data.contentBytes} bytes</span>
                  <span>sha256 {query.data.sha256.slice(0, 12)}…</span>
                  {query.data.truncated ? <span className="badge stale">内容已截断</span> : null}
                </div>
                {query.data.encoding === 'BINARY'
                  ? <p className="surface-note">二进制文件不会在 Renderer 中解码或展示。</p>
                  : <pre ref={contentRef} className="file-reference-content">{query.data.contentText ?? ''}</pre>}
              </>
            ) : <p className="surface-note">未返回文件内容。</p>}
        <p className="surface-note">内容、revision 和哈希均由 Service 返回；Renderer 不生成、拼接或直读绝对路径。</p>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={props.onClose}>关闭</button>
          <button type="button" className="primary-button" onClick={() => props.onReveal(fileRef)} disabled={props.revealPending || !props.canReveal || fileMissing} title={fileMissing ? '文件不存在，无法在资源管理器中定位' : undefined}><Icon name="external" size={14} />定位文件</button>
        </div>
      </section>
    </div>
  );
}
