// PAE P6 — 设置与用量（辅助入口，任务单 §9.1/§9.7）。
// 诚实边界：默认策略（下载/空间/并发/模型预算）与用量汇总不在
// /api/personal/v1 冻结路由内——显示「未提供」而非编造数值；
// 本机显示偏好（主题/动效）是本地设置，与策略分层展示。
// 凭据只存引用（CREDENTIAL_REQUIRED 时来此登记 ref），界面永不出现密钥值。
import { useState } from 'react';
import { DeviceAccessPanel } from '../components/DeviceAccessPanel';
import { Badge, Card, KV, Skeleton } from '../../components/ui/primitives';
import { usePersonal, usePersonalSurface } from '../hooks';
import { fmtIso } from '../viewmodel';
import { motionPref, setMotionPref, setThemePref, themePref, type MotionPref } from '../../lib/motion';

export default function SettingsPage() {
  const surface = usePersonalSurface();
  const overview = usePersonal(['overview'], g => g.overview());
  const meta = overview.data?.meta;
  const [theme, setTheme] = useState(themePref());
  const [motion, setMotion] = useState<MotionPref>(motionPref());

  return (
    <div className="col" style={{ gap: 16 }}>
      <h1 className="page-title">设置与用量</h1>

      <Card title="连接" sub="管理面与服务的连接视图（meta 为服务端权威投影）">
        {overview.isPending && <Skeleton h={80} />}
        {meta && (
          <KV items={[
            ['通道', `${surface.label}${surface.readonly ? ' · 只读' : ''}`],
            ['来源 / 实例', `${meta.source} / ${meta.instance}`],
            ['controlPlaneId', <span className="mono" key="c">{meta.controlPlaneId}</span>],
            ['观测于', fmtIso(meta.observedAt)],
            ['修订', meta.revision],
          ]} />
        )}
        {meta && (
          <div className="row wrap" style={{ gap: 4, marginTop: 10 }}>
            <span className="muted" style={{ fontSize: 11.5 }}>服务端声明的动作：</span>
            {meta.supportedActions.length === 0 && <span className="muted" style={{ fontSize: 11.5 }}>无（全部只读）</span>}
            {meta.supportedActions.map(a => <Badge key={a} tone="info">{a}</Badge>)}
          </div>
        )}
      </Card>

      {surface.kind === 'web' && !surface.readonly && <DeviceAccessPanel />}

      <Card title="显示偏好" sub="仅保存在本机，不影响服务端策略">
        <div className="row wrap" style={{ gap: 12, alignItems: 'end' }}>
          <label className="col" style={{ gap: 4, fontSize: 12 }}>
            <span className="muted">主题</span>
            <select value={theme} onChange={e => { const v = e.target.value as 'dark' | 'light'; setTheme(v); setThemePref(v); }}>
              <option value="dark">深色</option>
              <option value="light">浅色</option>
            </select>
          </label>
          <label className="col" style={{ gap: 4, fontSize: 12 }}>
            <span className="muted">动效</span>
            <select value={motion} onChange={e => { const v = e.target.value as MotionPref; setMotion(v); setMotionPref(v); }}>
              <option value="standard">标准</option>
              <option value="reduced">减少</option>
              <option value="off">关闭</option>
            </select>
          </label>
        </div>
      </Card>

      <Card title="默认策略与用量" sub="环境/核心基础能力不设套餐门槛（§9.7）">
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          下载/空间/并发/模型预算等默认策略与用量汇总：当前 /api/personal/v1
          冻结路由未提供该资源——此处显示「未提供」，不编造数值。
          需要凭据时仅登记引用（CREDENTIAL_REQUIRED），密钥不出管理端。
          用量与价格：以报告回执与 meta 为准；未观测到的金额显示未知。
        </p>
        <KV items={[
          ['下载策略', '未提供'],
          ['空间/并发/预算', '未提供'],
          ['用量汇总', '未知'],
        ]} />
      </Card>
    </div>
  );
}
