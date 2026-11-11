// 测试实验室: entry points to environments that are SEPARATE from this
// console's manage data — the worker lab (:8796) and the analytics shell.
import { Link } from 'react-router-dom';
import { ArrowUpRight, ExternalLink, FlaskConical, GaugeCircle, ShieldCheck } from 'lucide-react';
import { Card } from '../../components/ui/primitives';

const LABS = [
  {
    icon: FlaskConical,
    title: 'Worker Lab 测试页',
    body: <>独立测试环境 <span className="mono">:8796 /worker.html</span>，由 <span className="mono">start-worker-lab.ps1</span> 启动。
      与该 lab 的 worker-control 通道交互，不读写本管理台的登记数据。</>,
    link: { href: 'http://127.0.0.1:8796/worker.html', text: 'http://127.0.0.1:8796/worker.html', external: true },
    note: '仅在 lab 已启动时可打开',
  },
  {
    icon: GaugeCircle,
    title: '观测分析台',
    body: <>本 SPA 内的只读观测分析页（数据源、窗口筛选独立），查看运营指标与执行历史。</>,
    link: { href: '/analysis/overview', text: '/analysis/overview', external: false },
    note: '内部路由，独立于管理数据',
  },
  {
    icon: ShieldCheck,
    title: '企业隔离体验',
    body: <>企业环境演示入口 <span className="mono">http://127.0.0.1:8827</span>（独立环境）。</>,
    link: { href: 'http://127.0.0.1:8827', text: 'http://127.0.0.1:8827', external: true },
    note: '独立环境，仅在服务运行时可打开',
  },
];

export default function LabPage() {
  return (
    <div className="col" style={{ gap: 14 }}>
      <h1 className="page-title">测试实验室</h1>
      <p className="page-sub">以下环境各自独立运行，与“我的 Workers”管理数据互不影响。</p>
      <div className="grid cols-12">
        {LABS.map((l) => (
          <Card key={l.title} span={4} title={<span className="row" style={{ gap: 8 }}><l.icon size={15} color="var(--accent)" /> {l.title}</span>}>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10 }}>{l.body}</div>
            {l.link.external ? (
              <a href={l.link.href} target="_blank" rel="noreferrer" className="row" style={{ gap: 5, fontSize: 12 }}>
                <ExternalLink size={12} /> {l.link.text}
              </a>
            ) : (
              <Link to={l.link.href} className="row" style={{ gap: 5, fontSize: 12 }}>
                <ArrowUpRight size={12} /> {l.link.text}
              </Link>
            )}
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>{l.note}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}
