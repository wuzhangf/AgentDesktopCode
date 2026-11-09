/**
 * General page (settings design §6.2).
 *
 * Only Main-owned preferences with a real business effect render controls.
 * Rows whose behaviour is not implemented in this build display
 * "本版本未提供" without any control — never a fake toggle. Send shortcut,
 * notifications and startup recovery apply immediately after the section Save.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  SaveBar,
  SectionError,
  SettingRow,
  SettingSection,
  SettingSelect,
  SettingToggle,
  SkeletonRows
} from '../components';
import { LANGUAGE_LABELS, SEND_SHORTCUT_LABELS } from '../settingsPresentation';
import { settingsKeys } from '../settingsKeys';
import { useDesktopPreferences, useUpdateDesktopPreferences } from '../useSettingsQueries';
import { useSettingsDraft } from '../useSettingsDraft';
import { useReportDirty } from '../useDirtyRegistry';

interface GeneralDraft {
  notificationsEnabled: boolean;
  sendShortcut: 'ENTER' | 'MOD_ENTER';
  initialWorkspaceListing: boolean;
  restoreLastSurface: boolean;
}

/** U5 T4: renderer-local preference (no Main field yet) — localStorage only. */
const TERMINAL_AUTO_START_KEY = 'codeagent.terminal.autoStart';

function readTerminalAutoStart(): boolean {
  try {
    return window.localStorage.getItem(TERMINAL_AUTO_START_KEY) !== '0';
  } catch {
    return true;
  }
}

export function GeneralPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const preferences = useDesktopPreferences();
  const updatePreferences = useUpdateDesktopPreferences();
  const [terminalAutoStart, setTerminalAutoStart] = useState(readTerminalAutoStart);

  const handle = useSettingsDraft<GeneralDraft>({
    base: preferences.data
      ? {
        notificationsEnabled: preferences.data.notificationsEnabled,
        sendShortcut: preferences.data.sendShortcut,
        initialWorkspaceListing: preferences.data.initialWorkspaceListing !== false,
        restoreLastSurface: preferences.data.restoreLastSurface === true
      }
      : undefined,
    baseRevision: preferences.data?.revision,
    conflictMarkers: ['STATE_VERSION_CONFLICT'],
    onSave: async (draft, baseRevision) => {
      const response = await updatePreferences.mutateAsync({
        expectedRevision: baseRevision ?? 0,
        notificationsEnabled: draft.notificationsEnabled,
        sendShortcut: draft.sendShortcut,
        restoreLastSurface: draft.restoreLastSurface,
        initialWorkspaceListing: draft.initialWorkspaceListing
      });
      return {
        notificationsEnabled: response.notificationsEnabled,
        sendShortcut: response.sendShortcut,
        initialWorkspaceListing: response.initialWorkspaceListing !== false,
        restoreLastSurface: response.restoreLastSurface === true
      };
    }
  });

  useReportDirty('GENERAL', handle.hasChanges);

  if (preferences.isPending) {
    return <SettingSection title="通用" description="由桌面本体持有，离线也可修改。" hideHeader><SkeletonRows /></SettingSection>;
  }
  if (preferences.isError || !preferences.data) {
    const message = preferences.error instanceof Error ? preferences.error.message : String(preferences.error);
    return <SectionError message={`无法读取桌面偏好：${message}`} onRetry={() => void preferences.refetch()} />;
  }

  const draft = handle.draft;

  return (
    <>
      <SettingSection
        title="通用"
        description="桌面偏好由 Electron Main 安全保存；Service 离线时仍可使用。"
        hideHeader
        testId="general-section"
      >
        <SettingRow
          label="系统通知"
          description="Service 生命周期事件（如异常退出）的系统通知。"
          scope="USER"
          source="桌面本体"
          applyMode="IMMEDIATE"
          effective={draft?.notificationsEnabled ? '开启' : '关闭'}
          testId="preferences-notifications"
          advanced={<span className="run-meta">canonical: notificationsEnabled</span>}
        >
          <SettingToggle
            label="系统通知"
            testId="preferences-notifications-toggle"
            checked={draft?.notificationsEnabled ?? true}
            disabled={handle.saveState === 'SAVING'}
            onChange={(checked) => handle.setField('notificationsEnabled', checked)}
          />
        </SettingRow>

        <SettingRow
          label="首轮自动列出工作区"
          description="创建新会话时，先执行一次 workspace_list 了解工作区；同一会话后续轮次不会重复执行。"
          scope="USER"
          source="桌面本体"
          applyMode="NEW_SESSION"
          effective={draft?.initialWorkspaceListing !== false ? '开启' : '关闭'}
          testId="preferences-initial-workspace-listing"
          advanced={<span className="run-meta">canonical: initialWorkspaceListing</span>}
        >
          <SettingToggle
            label="首轮自动列出工作区"
            testId="preferences-initial-workspace-listing-toggle"
            checked={draft?.initialWorkspaceListing !== false}
            disabled={handle.saveState === 'SAVING'}
            onChange={(checked) => handle.setField('initialWorkspaceListing', checked)}
          />
        </SettingRow>

        <SettingRow
          label="发送快捷键"
          description="输入法组合输入的 IME 保护始终开启，不可关闭。"
          scope="USER"
          source="桌面本体"
          applyMode="IMMEDIATE"
          effective={SEND_SHORTCUT_LABELS[draft?.sendShortcut ?? 'ENTER'] ?? 'Enter 发送'}
          testId="preferences-send-shortcut"
          advanced={<span className="run-meta">canonical: sendShortcut</span>}
        >
          <SettingSelect
            ariaLabel="发送快捷键"
            testId="preferences-send-shortcut-select"
            value={draft?.sendShortcut ?? 'ENTER'}
            disabled={handle.saveState === 'SAVING'}
            options={[
              { value: 'ENTER', label: SEND_SHORTCUT_LABELS.ENTER ?? 'Enter 发送' },
              { value: 'MOD_ENTER', label: SEND_SHORTCUT_LABELS.MOD_ENTER ?? 'Ctrl/Cmd+Enter 发送' }
            ]}
            onChange={(value) => handle.setField('sendShortcut', value)}
          />
        </SettingRow>

        <SettingRow
          label="打开终端面板时自动启动 Shell"
          description="打开终端面板且当前会话没有可用终端时，自动创建一个 PowerShell。暂由本机 localStorage 保存。"
          scope="USER"
          source="桌面本体"
          applyMode="IMMEDIATE"
          effective={terminalAutoStart ? '开启' : '关闭'}
          testId="preferences-terminal-autostart"
        >
          <SettingToggle
            label="打开终端面板时自动启动 Shell"
            testId="preferences-terminal-autostart-toggle"
            checked={terminalAutoStart}
            onChange={(checked) => {
              setTerminalAutoStart(checked);
              try { window.localStorage.setItem(TERMINAL_AUTO_START_KEY, checked ? '1' : '0'); } catch { /* localStorage may be unavailable */ }
            }}
          />
        </SettingRow>

        <SettingRow
          label="界面语言"
          scope="USER"
          mutability="READ_ONLY"
          source="桌面本体"
          effective={`${LANGUAGE_LABELS[preferences.data.language] ?? preferences.data.language}（跟随系统）`}
          testId="preferences-language"
        >
          <span className="run-meta">本版本暂不支持切换界面语言</span>
        </SettingRow>

        <SettingRow
          label="开机自动启动 CodeAgent Desktop"
          scope="USER"
          mutability="READ_ONLY"
          source="桌面本体"
          effective="已注册：当前用户登录时启动 8766 Service 和桌面端"
          testId="preferences-launch"
        >
          <span className="run-meta">Windows 计划任务：CodeAgentDesktop-8766</span>
        </SettingRow>

        <SettingRow
          label="重启后恢复工作台"
          description="重启桌面后恢复上次会话和页面；如果有等待授权或授权失效的 Run，始终优先打开全局提示。"
          scope="USER"
          source="桌面本体"
          applyMode="IMMEDIATE"
          effective={draft?.restoreLastSurface ? '开启' : '关闭'}
          testId="preferences-restore-surface"
        >
          <SettingToggle
            label="重启后恢复工作台"
            testId="preferences-restore-surface-toggle"
            checked={draft?.restoreLastSurface === true}
            disabled={handle.saveState === 'SAVING'}
            onChange={(checked) => handle.setField('restoreLastSurface', checked)}
          />
        </SettingRow>

        {handle.saveState === 'CONFLICT' ? (
          <SectionError message="桌面偏好已在别处被修改。请放弃修改后重试。" />
        ) : null}
        {handle.errorMessage ? <SectionError message={handle.errorMessage} /> : null}
      </SettingSection>

      <SaveBar
        saveState={handle.saveState}
        hasChanges={handle.hasChanges}
        applyMode="IMMEDIATE"
        saveSuccess={handle.saveSuccess}
        onSave={handle.save}
        onCancel={() => {
          handle.discard();
          void queryClient.invalidateQueries({ queryKey: settingsKeys.desktopPreferences });
        }}
      />
    </>
  );
}
