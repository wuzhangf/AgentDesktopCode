/**
 * Advanced / Service page (settings design §6.10).
 *
 * Shows attach state, instance fingerprint, protocol and token persistence
 * without ever exposing the token value. Restart is an impact-checked
 * action: active runs are listed first, the user confirms inline, and the
 * handshake result decides success — a failed restart lands in the degraded
 * path instead of a fake "saved and applied".
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EmptyState, SectionError, SettingRow, SettingSection } from '../components';
import type { SettingsPageContext } from '../settingsContext';
import { useServiceStatus } from '../useSettingsQueries';

export function ServicePage(props: { context: SettingsPageContext; onRestarted: () => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const status = useServiceStatus(Boolean(props.context.capabilities));
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [restartState, setRestartState] = useState<'idle' | 'restarting' | 'failed'>('idle');
  const [restartMessage, setRestartMessage] = useState<string | null>(null);
  const [instanceChanged, setInstanceChanged] = useState<string | null>(null);

  const instanceId = props.context.capabilities?.serviceInstanceId;

  const performRestart = (): void => {
    setRestartState('restarting');
    setRestartMessage(null);
    void window.codeAgentDesktop.restartService().then((bootstrap) => {
      if (bootstrap.status === 'ATTACHED' || bootstrap.status === 'OWNED_READY') {
        const newInstance = bootstrap.serviceInstanceId;
        if (newInstance && instanceId && newInstance !== instanceId) {
          setInstanceChanged('已连接到不同的 Service 实例；所有 Service 数据已重新读取。');
        }
        // Instance change or restart: re-read every Service-owned snapshot;
        // desktop preferences stay untouched.
        void queryClient.invalidateQueries({
          predicate: (query) => !(query.queryKey[0] === 'settings' && query.queryKey[1] === 'desktop-preferences')
        });
        setRestartState('idle');
        setConfirmingRestart(false);
        props.onRestarted();
        window.location.reload();
      } else {
        setRestartState('failed');
        setRestartMessage(bootstrap.message ?? 'Service 重启失败；桌面本地设置仍可使用。');
      }
    }).catch((err: unknown) => {
      setRestartState('failed');
      setRestartMessage(`Service 重启失败：${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const activeRunHint = props.context.sessionActiveRun
    ? `当前会话有活动中的 Run（${props.context.sessionActiveRun.runId.slice(0, 8)} · ${props.context.sessionActiveRun.state}），重启会中断它并需要恢复。`
    : '当前会话没有活动中的 Run。重启会短暂中断所有会话的事件流。';

  return (
    <SettingSection
      title="Service"
      description="连接与实例信息；重启属于有影响操作，需要确认。"
      hideHeader
      testId="service-section"
    >
      {status.data ? (
        <>
          <SettingRow label="Service 状态" scope="SERVICE_INSTANCE" mutability="READ_ONLY" source="桌面本体" effective={status.data.state} testId="service-state" />
          <SettingRow
            label="attach 模式"
            scope="SERVICE_INSTANCE"
            mutability="READ_ONLY"
            source="桌面本体"
            effective={status.data.ownedPid ? 'owned（桌面托管）' : 'attached（外部实例）'}
            testId="service-attach-mode"
            advanced={<span className="run-meta">pid {status.data.ownedPid ?? '—'} · port {status.data.ownedPort ?? '—'}</span>}
          />
          <SettingRow
            label="实例指纹"
            scope="SERVICE_INSTANCE"
            mutability="READ_ONLY"
            source="握手"
            effective={instanceId ? instanceId.slice(0, 12) : '未知'}
            testId="service-instance-id"
          />
          <SettingRow
            label="协议版本"
            scope="SERVICE_INSTANCE"
            mutability="READ_ONLY"
            source="握手"
            effective={props.context.protocolVersion ?? '未知'}
            testId="service-protocol"
          />
          <SettingRow
            label="token 持久化"
            scope="USER"
            mutability="READ_ONLY"
            source="桌面本体"
            effective={status.data.encryptionAvailable
              ? (status.data.tokenPersisted ? 'OS 加密存储' : '加密可用，尚未写入')
              : '仅会话内（OS 加密不可用，未写入磁盘）'}
            testId="service-token-persistence"
          />
        </>
      ) : status.isPending ? <EmptyState message="正在读取 Service 状态…" /> : (
        <SectionError message={`无法读取 Service 状态：${String(status.error)}`} onRetry={() => void status.refetch()} />
      )}

      <div className="settings-danger-zone">
        {confirmingRestart ? (
          <div className="settings-restart-confirm" data-testid="service-restart-confirm" role="alertdialog" aria-label="确认重启 Service">
            <strong>确认重启 Service？</strong>
            <p>{activeRunHint}</p>
            <div className="settings-save-actions">
              <button type="button" onClick={() => setConfirmingRestart(false)} disabled={restartState === 'restarting'}>取消</button>
              <button type="button" className="danger-button" data-testid="service-restart-go" onClick={performRestart} disabled={restartState === 'restarting'} aria-busy={restartState === 'restarting'}>
                {restartState === 'restarting' ? '重启中…' : '重启 Service'}
              </button>
            </div>
          </div>
        ) : (
          <div className="settings-restart-row">
            <button type="button" data-testid="service-restart" onClick={() => setConfirmingRestart(true)} disabled={restartState === 'restarting'}>重启 Service</button>
            <button type="button" data-testid="service-reconnect" onClick={performRestart} disabled={restartState === 'restarting'}>重新连接</button>
          </div>
        )}
        {restartState === 'failed' && restartMessage ? <SectionError message={restartMessage} /> : null}
        {instanceChanged ? <p className="settings-hint" data-testid="service-instance-changed" role="status">{instanceChanged}</p> : null}
      </div>
    </SettingSection>
  );
}
