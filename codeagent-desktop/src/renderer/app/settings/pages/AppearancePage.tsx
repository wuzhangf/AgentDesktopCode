/**
 * Appearance page (settings design §6.3).
 *
 * Draft edits preview instantly through onPreview, but persistence still
 * goes through the section Save with expectedRevision. "恢复默认" fills the
 * draft with the schema defaults — it does not write behind the user's back.
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  SaveBar,
  SectionError,
  SettingRow,
  SettingSection,
  SettingSelect,
  SettingToggle,
  SkeletonRows
} from '../components';
import { DENSITY_LABELS, REDUCE_MOTION_LABELS, THEME_LABELS } from '../settingsPresentation';
import { settingsKeys } from '../settingsKeys';
import { useDesktopPreferences, useUpdateDesktopPreferences } from '../useSettingsQueries';
import { useSettingsDraft } from '../useSettingsDraft';
import { useReportDirty } from '../useDirtyRegistry';
import type { DesktopPreferencesResponse } from '../../../../../electron/shared/settings-types';

interface AppearanceDraft {
  theme: 'SYSTEM' | 'DARK' | 'LIGHT';
  density: 'SUMMARY' | 'STANDARD' | 'DETAILED';
  uiScalePercent: 90 | 100 | 110 | 125;
  codeFontSizePx: number;
  reduceMotion: 'SYSTEM' | 'ON' | 'OFF';
}

const APPEARANCE_DEFAULTS: AppearanceDraft = {
  theme: 'DARK',
  density: 'STANDARD',
  uiScalePercent: 100,
  codeFontSizePx: 13,
  reduceMotion: 'SYSTEM'
};

export function AppearancePage(props: { onPreview?: (draft: AppearanceDraft | null) => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const preferences = useDesktopPreferences();
  const updatePreferences = useUpdateDesktopPreferences();

  const handle = useSettingsDraft<AppearanceDraft>({
    base: preferences.data
      ? {
        theme: preferences.data.theme,
        density: preferences.data.density,
        uiScalePercent: preferences.data.uiScalePercent,
        codeFontSizePx: preferences.data.codeFontSizePx,
        reduceMotion: preferences.data.reduceMotion
      }
      : undefined,
    baseRevision: preferences.data?.revision,
    conflictMarkers: ['STATE_VERSION_CONFLICT'],
    onSave: async (draft, baseRevision) => {
      const response = await updatePreferences.mutateAsync({
        expectedRevision: baseRevision ?? 0,
        theme: draft.theme,
        density: draft.density,
        uiScalePercent: draft.uiScalePercent,
        codeFontSizePx: draft.codeFontSizePx,
        reduceMotion: draft.reduceMotion
      });
      props.onPreview?.(null); // adopt the authoritative response again
      return {
        theme: response.theme,
        density: response.density,
        uiScalePercent: response.uiScalePercent,
        codeFontSizePx: response.codeFontSizePx,
        reduceMotion: response.reduceMotion
      };
    }
  });

  useReportDirty('APPEARANCE', handle.hasChanges);

  const draft = handle.draft;

  // Instant preview of unsaved edits; null re-adopts the saved values.
  useEffect(() => {
    props.onPreview?.(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.theme, draft?.density, draft?.uiScalePercent, draft?.codeFontSizePx, draft?.reduceMotion]);

  if (preferences.isPending) {
    return <SettingSection title="外观" description="预览立即生效；保存后才持久化。" hideHeader><SkeletonRows /></SettingSection>;
  }
  if (preferences.isError || !preferences.data || draft === null) {
    const message = preferences.error instanceof Error ? preferences.error.message : String(preferences.error);
    return <SectionError message={`无法读取外观偏好：${message}`} onRetry={() => void preferences.refetch()} />;
  }

  return (
    <>
      <SettingSection
        title="外观"
        description="仅影响桌面显示，不影响模型、Service、证据或运行。"
        hideHeader
        testId="appearance-section"
        actions={(
          <button
            type="button"
            data-testid="appearance-reset"
            onClick={() => {
              for (const key of Object.keys(APPEARANCE_DEFAULTS) as Array<keyof AppearanceDraft>) {
                handle.setField(key, APPEARANCE_DEFAULTS[key]);
              }
            }}
          >
            恢复默认
          </button>
        )}
      >
        <SettingRow
          label="主题"
          scope="USER"
          source="桌面本体"
          applyMode="IMMEDIATE"
          effective={THEME_LABELS[draft.theme] ?? draft.theme}
          testId="appearance-theme"
          advanced={<span className="run-meta">canonical: theme</span>}
        >
          <SettingSelect
            ariaLabel="主题"
            testId="appearance-theme-select"
            value={draft.theme}
            disabled={handle.saveState === 'SAVING'}
            options={[
              { value: 'SYSTEM', label: THEME_LABELS.SYSTEM ?? '跟随系统' },
              { value: 'DARK', label: THEME_LABELS.DARK ?? '深色' },
              { value: 'LIGHT', label: THEME_LABELS.LIGHT ?? '浅色' }
            ]}
            onChange={(value) => handle.setField('theme', value)}
          />
        </SettingRow>

        <SettingRow
          label="界面密度"
          scope="USER"
          source="桌面本体"
          applyMode="IMMEDIATE"
          effective={DENSITY_LABELS[draft.density] ?? draft.density}
          testId="appearance-density"
          advanced={<span className="run-meta">canonical: density</span>}
        >
          <SettingSelect
            ariaLabel="界面密度"
            testId="appearance-density-select"
            value={draft.density}
            disabled={handle.saveState === 'SAVING'}
            options={[
              { value: 'SUMMARY', label: DENSITY_LABELS.SUMMARY ?? '紧凑' },
              { value: 'STANDARD', label: DENSITY_LABELS.STANDARD ?? '标准' },
              { value: 'DETAILED', label: DENSITY_LABELS.DETAILED ?? '宽松' }
            ]}
            onChange={(value) => handle.setField('density', value)}
          />
        </SettingRow>

        <SettingRow
          label="界面缩放"
          scope="USER"
          source="桌面本体"
          applyMode="IMMEDIATE"
          effective={`${draft.uiScalePercent}%`}
          testId="appearance-scale"
          advanced={<span className="run-meta">canonical: uiScalePercent</span>}
        >
          <SettingSelect
            ariaLabel="界面缩放"
            testId="appearance-scale-select"
            value={String(draft.uiScalePercent)}
            disabled={handle.saveState === 'SAVING'}
            options={[
              { value: '90', label: '90%' },
              { value: '100', label: '100%' },
              { value: '110', label: '110%' },
              { value: '125', label: '125%' }
            ]}
            onChange={(value) => handle.setField('uiScalePercent', Number(value) as AppearanceDraft['uiScalePercent'])}
          />
        </SettingRow>

        <SettingRow
          label="代码字号"
          description="只影响代码与终端文本，不改变整体布局。"
          scope="USER"
          source="桌面本体"
          applyMode="IMMEDIATE"
          effective={`${draft.codeFontSizePx}px`}
          testId="appearance-code-font"
          advanced={<span className="run-meta">canonical: codeFontSizePx (12–18)</span>}
        >
          <input
            type="number"
            className="setting-number"
            data-testid="appearance-code-font-input"
            value={draft.codeFontSizePx}
            min={12}
            max={18}
            disabled={handle.saveState === 'SAVING'}
            aria-label="代码字号"
            onChange={(event) => {
              const parsed = event.target.valueAsNumber;
              if (Number.isFinite(parsed)) handle.setField('codeFontSizePx', Math.min(18, Math.max(12, Math.round(parsed))));
            }}
          />
        </SettingRow>

        <SettingRow
          label="减少动效"
          description="“跟随系统”使用操作系统的减少动效设置。"
          scope="USER"
          source="桌面本体 · prefers-reduced-motion"
          applyMode="IMMEDIATE"
          effective={REDUCE_MOTION_LABELS[draft.reduceMotion] ?? draft.reduceMotion}
          testId="appearance-reduce-motion"
          advanced={<span className="run-meta">canonical: reduceMotion</span>}
        >
          <SettingSelect
            ariaLabel="减少动效"
            testId="appearance-reduce-motion-select"
            value={draft.reduceMotion}
            disabled={handle.saveState === 'SAVING'}
            options={[
              { value: 'SYSTEM', label: REDUCE_MOTION_LABELS.SYSTEM ?? '跟随系统' },
              { value: 'ON', label: REDUCE_MOTION_LABELS.ON ?? '减少动效' },
              { value: 'OFF', label: REDUCE_MOTION_LABELS.OFF ?? '正常动效' }
            ]}
            onChange={(value) => handle.setField('reduceMotion', value)}
          />
        </SettingRow>

        {handle.saveState === 'CONFLICT' ? (
          <SectionError message="外观偏好已在别处被修改。请放弃修改后重试。" />
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
          props.onPreview?.(null);
          void queryClient.invalidateQueries({ queryKey: settingsKeys.desktopPreferences });
        }}
      />
    </>
  );
}

/** Shared projection used by the workbench to apply appearance tokens. */
export function appearanceFromPreferences(preferences: DesktopPreferencesResponse | undefined): AppearanceDraft | null {
  if (!preferences) return null;
  return {
    theme: preferences.theme,
    density: preferences.density,
    uiScalePercent: preferences.uiScalePercent,
    codeFontSizePx: preferences.codeFontSizePx,
    reduceMotion: preferences.reduceMotion
  };
}
