// PAE P6 — 常用动作面板（任务单 §9.3 / E05）。
// 项目动作 / 临时计划 / 保存状态分列；「试跑」与「保存」是两个独立效果：
// 试跑成功 ≠ 保存成功；保存失败只显示保存错误，绝不触发再次执行。
// inputs 只收声明的有界输入，不接受脚本字节或 argv。
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Card, EmptyState, ErrorBanner, Skeleton } from '../../components/ui/primitives';
import { usePersonal, usePersonalGateway, usePersonalSurface } from '../hooks';
import { canWrite, fmtIso } from '../viewmodel';
import { checkStatusLabel, checkStatusTone } from '../labels';
import type { ActionTrialReceiptView, AdaptiveActionScope } from '../../../../codeagent-desktop/packages/protocol/src/personal';

interface TrialState { busy: boolean; receipt?: ActionTrialReceiptView; error?: string }
interface SaveState { busy: boolean; done?: string; error?: string }

export function ActionsPanel({ taskId }: { taskId: string }) {
  const surface = usePersonalSurface();
  const gateway = usePersonalGateway();
  const qc = useQueryClient();
  const actions = usePersonal(['taskActions', taskId], g => g.listTaskActions(taskId));
  const meta = actions.data?.meta;
  const canRun = canWrite(meta, 'ACTION_RUN', surface.readonly);
  const canSave = canWrite(meta, 'ACTION_SAVE', surface.readonly);

  const [trials, setTrials] = useState<Record<string, TrialState>>({});
  const [saves, setSaves] = useState<Record<string, SaveState>>({});
  const [saveForm, setSaveForm] = useState<Record<string, { name: string; scope: AdaptiveActionScope | '' }>>({});

  const setTrial = (id: string, patch: Partial<TrialState>) => setTrials(s => ({ ...s, [id]: { ...(s[id] ?? { busy: false }), ...patch } }));
  const setSave = (id: string, patch: Partial<SaveState>) => setSaves(s => ({ ...s, [id]: { ...(s[id] ?? { busy: false }), ...patch } }));

  const run = async (actionId: string) => {
    if (trials[actionId]?.busy) return;
    setTrial(actionId, { busy: true, error: undefined, receipt: undefined });
    try {
      const res = await gateway.runTaskAction(taskId, actionId, {});
      setTrial(actionId, { busy: false, receipt: res.data });
    } catch (e) {
      setTrial(actionId, { busy: false, error: (e as Error).message || '试跑未确认' });
    }
  };

  // 保存是独立效果：只调 :save；失败仅记录保存错误，不重跑试跑。
  const save = async (actionId: string) => {
    if (saves[actionId]?.busy) return;
    const form = saveForm[actionId] ?? { name: '', scope: '' };
    setSave(actionId, { busy: true, error: undefined, done: undefined });
    try {
      const res = await gateway.saveTaskAction(taskId, actionId, {
        name: form.name || undefined,
        scope: form.scope || undefined,
      });
      setSave(actionId, { busy: false, done: res.data.revision ? `已保存 · 修订 ${res.data.revision}` : '已保存为项目动作' });
      await qc.invalidateQueries({ queryKey: ['personal', 'taskActions', taskId] });
    } catch (e) {
      setSave(actionId, { busy: false, error: (e as Error).message || '保存未确认——执行结果不受影响' });
    }
  };

  if (actions.isPending) return <Skeleton h={160} />;
  if (actions.isError) return <ErrorBanner error={actions.error} onRetry={() => actions.refetch()} />;
  const rows = actions.data?.data ?? [];

  return (
    <Card title="常用动作" sub="项目已有动作与本次任务的临时计划；运行与保存是两个独立效果">
      {rows.length === 0 && <EmptyState title="暂无已声明动作" hint="任务内生成的临时计划会出现在这里" />}
      <div className="col" style={{ gap: 10 }}>
        {rows.map(a => {
          const trial = trials[a.actionId] ?? {};
          const saveS = saves[a.actionId] ?? {};
          const form = saveForm[a.actionId] ?? { name: '', scope: '' };
          return (
            <div key={a.actionId} className="card raised" style={{ padding: '10px 12px' }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <b style={{ fontSize: 12.5 }}>{a.name ?? a.actionId}</b>
                <Badge tone="plain">{a.scope === 'TASK' ? '本次任务' : a.scope === 'PROJECT' ? '项目' : (a.scope ?? '未知范围')}</Badge>
                {a.saved ? <Badge tone="success">已保存</Badge> : <Badge tone="unknown">临时计划</Badge>}
                {a.provenance && <span className="muted" style={{ fontSize: 11 }}>{a.provenance}</span>}
                <span className="muted right" style={{ fontSize: 11 }}>v{a.actionVersion ?? '—'} · 修订 {a.revision ?? '—'}</span>
              </div>
              {a.objective && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{a.objective}</div>}
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                {canRun && <button disabled={trial.busy} onClick={() => void run(a.actionId)}>试跑</button>}
                {canSave && !a.saved && (
                  <button disabled={saveS.busy}
                    onClick={() => setSaveForm(s => ({ ...s, [a.actionId]: { name: a.name ?? '', scope: 'PROJECT' } }))}>
                    保存为项目动作…
                  </button>
                )}
                {!canRun && !canSave && !surface.readonly && (
                  <span className="muted" style={{ fontSize: 11.5 }}>管理服务未声明动作写操作——未声明即不支持</span>
                )}
                {surface.readonly && <span className="muted" style={{ fontSize: 11.5 }}>只读视图</span>}
              </div>

              {saveForm[a.actionId] && !a.saved && canSave && (
                <div className="row wrap" style={{ marginTop: 8, gap: 8, alignItems: 'end' }}>
                  <label className="col" style={{ gap: 4, fontSize: 12 }}>
                    <span className="muted">动作名</span>
                    <input value={form.name} style={{ width: 200 }}
                      onChange={e => setSaveForm(s => ({ ...s, [a.actionId]: { ...form, name: e.target.value } }))} />
                  </label>
                  <label className="col" style={{ gap: 4, fontSize: 12 }}>
                    <span className="muted">适用范围</span>
                    <select value={form.scope} onChange={e => setSaveForm(s => ({ ...s, [a.actionId]: { ...form, scope: e.target.value as AdaptiveActionScope | '' } }))}>
                      <option value="PROJECT">项目（保存后可复用）</option>
                      <option value="TASK">仅本任务</option>
                    </select>
                  </label>
                  <button className="primary" disabled={saveS.busy} onClick={() => void save(a.actionId)}>确认保存</button>
                  <button className="ghost" onClick={() => setSaveForm(s => { const n = { ...s }; delete n[a.actionId]; return n; })}>取消</button>
                </div>
              )}

              {trial.receipt && (
                <div className="p6-receipt" role="status">
                  <Badge tone={checkStatusTone(trial.receipt.evidenceVerdict)}>试跑{checkStatusLabel(trial.receipt.evidenceVerdict)}</Badge>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    exit {trial.receipt.exitStatus ?? '—'} · {fmtIso(trial.receipt.startedAt)} → {fmtIso(trial.receipt.endedAt)}
                  </span>
                  {trial.receipt.outputRefs?.length ? <span className="muted" style={{ fontSize: 11 }}>输出 {trial.receipt.outputRefs.length} 份</span> : null}
                  {trial.receipt.reportRefs?.length ? <span className="muted" style={{ fontSize: 11 }}>报告 {trial.receipt.reportRefs.length} 份</span> : null}
                </div>
              )}
              {trial.error && <p role="alert" style={{ color: 'var(--failure)', fontSize: 12, margin: '6px 0 0' }}>试跑：{trial.error}</p>}
              {saveS.done && <p role="status" style={{ color: 'var(--success)', fontSize: 12, margin: '6px 0 0' }}>保存：{saveS.done}</p>}
              {saveS.error && <p role="alert" style={{ color: 'var(--failure)', fontSize: 12, margin: '6px 0 0' }}>保存失败：{saveS.error}（未再次执行）</p>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
