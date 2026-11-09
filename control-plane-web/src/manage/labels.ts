// Display maps for manage domain + ISO time helpers. Null → '未采集'/灰,
// never 0 or a faked value.
import type {
  AcceptingState, AttentionSeverity, LayerName, LayerState,
  OperationKind, OperationState, WorkerKind,
} from '../../shared/management/api';
import { fmtTimeShort } from '../lib/format';

export const KIND_LABEL: Record<WorkerKind, string> = { MANAGED: '受管', EXTERNAL: '外部' };

export const LAYER_LABEL: Record<LayerName, string> = {
  HOST: '主机', DAEMON: 'Daemon', ENGINE: '引擎', TOOLCHAIN: '工具链',
};

export const LAYER_STATE: Record<LayerState, { label: string; tone: string; color: string }> = {
  OK: { label: '正常', tone: 'success', color: 'var(--success)' },
  DEGRADED: { label: '降级', tone: 'warning', color: 'var(--warning)' },
  DOWN: { label: '断开', tone: 'failure', color: 'var(--failure)' },
  UNKNOWN: { label: '未知', tone: 'unknown', color: 'var(--unknown)' },
  UNMANAGED: { label: '未托管', tone: 'plain', color: 'var(--unknown)' },
};

export const ACCEPTING: Record<AcceptingState, { label: string; tone: string; hint: string }> = {
  YES: { label: '接单中', tone: 'success', hint: 'daemon 就绪、未排水、install-gate 开放' },
  NO_GATE: { label: '已停止接单', tone: 'warning', hint: 'install-gate 已 ARM：可通过“恢复接单”撤销，可逆' },
  NO_DRAINING: { label: 'DRAINING', tone: 'failure', hint: 'daemon 锁存排水状态，需重启进程才能恢复接单' },
  NO_NOT_READY: { label: '未就绪', tone: 'warning', hint: 'daemon 进程存活但未 ready' },
  UNKNOWN: { label: '未知', tone: 'unknown', hint: '无法连接或未托管，接单状态未知' },
};

export const GATE_STATE: Record<string, { label: string; tone: string }> = {
  ARMED: { label: 'gate 已停止接单', tone: 'warning' },
  DISARMED: { label: 'gate 开放', tone: 'success' },
  UNMOUNTED: { label: 'gate 未挂载', tone: 'unknown' },
  UNREADABLE: { label: 'gate 不可读', tone: 'warning' },
  UNKNOWN: { label: 'gate 未知', tone: 'unknown' },
};

export const OP_KIND_LABEL: Record<OperationKind, string> = {
  START: '启动', STOP: '停止', RESTART: '重启', GATE_ARM: '停止接单', GATE_DISARM: '恢复接单',
};

export const OP_STATE: Record<OperationState, { label: string; tone: string }> = {
  PENDING: { label: '排队中', tone: 'plain' },
  RUNNING: { label: '执行中', tone: 'info' },
  SUCCEEDED: { label: '成功', tone: 'success' },
  FAILED: { label: '失败', tone: 'failure' },
  VERIFY_FAILED: { label: '校验失败', tone: 'conflict' },
};

export const SEVERITY: Record<AttentionSeverity, { label: string; tone: string }> = {
  ACTION: { label: '需处理', tone: 'failure' },
  WARN: { label: '注意', tone: 'warning' },
  INFO: { label: '提示', tone: 'plain' },
};

export function fmtIso(iso: string | null | undefined): string {
  if (!iso) return '未采集';
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? fmtTimeShort(ms) : '未采集';
}

/** Relative freshness for ISO timestamps; null/invalid → '未采集'. */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '未采集';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '未采集';
  const diff = Date.now() - ms;
  if (diff < 5_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return fmtTimeShort(ms);
}
