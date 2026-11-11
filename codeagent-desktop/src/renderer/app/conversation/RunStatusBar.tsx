import type { RunDisplayModel } from '../activity/runDisplayModel';
import { formatCliElapsed } from './CliActivityRow';

function phaseLabel(phase: RunDisplayModel['phase']): string {
  switch (phase) {
    case 'SUBMITTING': return '正在提交…';
    case 'QUEUED': return '已进入队列';
    case 'WAITING_APPROVAL': return '等待你的批准';
    case 'PAUSED': return '已暂停，可继续';
    case 'STOP_REQUESTED': return '正在请求停止…';
    case 'SUCCEEDED': return '已完成';
    case 'FAILED': return '执行失败';
    case 'CANCELLED': return '已停止';
    case 'GENERATING': return '正在生成回答';
    case 'RUNNING': return '正在运行';
    case 'UNKNOWN': return '状态待同步';
    default: return '就绪';
  }
}

function glyphFor(model: RunDisplayModel): string {
  if (model.connection !== 'connected') return 'Ⅱ';
  switch (model.phase) {
    case 'RUNNING': case 'GENERATING': case 'SUBMITTING': return '⠋';
    case 'WAITING_APPROVAL': return 'Ⅱ';
    case 'PAUSED': return 'Ⅱ';
    case 'SUCCEEDED': return '✓';
    case 'FAILED': return '!';
    case 'CANCELLED': return '×';
    default: return '·';
  }
}

function connectionMessage(model: RunDisplayModel): string | null {
  if (model.connection === 'connected') return null;
  if (model.connection === 'syncing') return `正在同步 · 上次确认：${model.headline}`;
  if (model.connection === 'reconnecting') return `连接中断 · 上次确认：${model.headline}`;
  return `连接状态未知 · 上次确认：${model.headline}`;
}

export function RunStatusBar(props: {
  model: RunDisplayModel;
  stopPending?: boolean;
  recoverPending?: boolean;
  approvalSyncing?: boolean;
  onStop: () => void;
  onRecover?: () => void;
}): React.JSX.Element {
  const { model } = props;
  const headline = props.approvalSyncing && model.phase === 'WAITING_APPROVAL'
    ? '审批已接收 · 状态同步中'
    : model.headline;
  const elapsed = formatCliElapsed(model.elapsedMs);
  const silence = model.noNewOutputSeconds;
  const warning = silence !== null && silence >= 15 && (model.phase === 'RUNNING' || model.phase === 'GENERATING')
    ? `${silence >= 60 ? '60s' : `${silence}s`} 无新输出，工具可能仍在执行`
    : null;
  const disconnected = connectionMessage(model);
  const detailSuffix = model.headlineDetail && headline.endsWith(` · ${model.headlineDetail}`)
    ? model.headlineDetail : null;
  const headlineBase = detailSuffix ? headline.slice(0, headline.length - detailSuffix.length - 3) : headline;
  return (
    <aside className={`cli-execution-status-bar phase-${model.phase.toLowerCase()} connection-${model.connection}`} data-testid="run-status-bar" role="status" aria-label={`运行状态：${headline}`}>
      <div className="cli-status-main">
        <span className={`cli-status-glyph${model.connection === 'connected' && (model.phase === 'RUNNING' || model.phase === 'GENERATING') ? ' is-running' : ''}`} aria-hidden="true">{glyphFor(model)}</span>
        <div className="cli-status-copy">
          <span className="cli-status-headline">{headlineBase}{detailSuffix ? <> · <code className="cli-status-detail">{detailSuffix}</code></> : null}</span>
          {model.currentActivityIds.length > 1 ? <span className="cli-status-count">· {model.currentActivityIds.length} 项操作</span> : null}
          {model.phase === 'RUNNING' && model.currentActivityIds.length > 0 && model.hasVisibleOutput ? <span className="cli-status-secondary-inline">· 回答生成中</span> : null}
          {elapsed ? <span className="cli-status-elapsed">{model.elapsedEstimated ? '已观察运行约 ' : '总历时 '}{elapsed}</span> : null}
        </div>
        {model.canRequestStop || model.phase === 'PAUSED' ? <div className="cli-status-actions">
          {model.canRequestStop ? <button type="button" className="cli-status-action cli-status-stop" data-testid="stop-generation" aria-label={props.stopPending ? '正在请求停止…' : '停止生成'} title={props.stopPending ? '正在请求停止…' : '停止生成'} onClick={props.onStop} disabled={props.stopPending}>{props.stopPending ? '正在请求停止…' : '停止'}</button> : null}
          {model.phase === 'PAUSED' && props.onRecover ? <button type="button" className="cli-status-action" onClick={props.onRecover} disabled={props.recoverPending}>{props.recoverPending ? '正在继续…' : '继续运行'}</button> : null}
        </div> : null}
      </div>
      {(model.phase === 'RUNNING' || model.phase === 'GENERATING' || model.phase === 'QUEUED') && model.connection === 'connected' ? <div className="cli-indeterminate-progress" aria-hidden="true"><span /></div> : null}
      {disconnected ? <div className="cli-status-connection">{disconnected}</div> : null}
      {warning ? <div className="cli-status-silence">{warning}</div> : null}
      {!model.activitiesAvailable && (model.phase === 'RUNNING' || model.phase === 'GENERATING') ? <div className="cli-status-secondary">当前服务未提供执行明细</div> : null}
    </aside>
  );
}
