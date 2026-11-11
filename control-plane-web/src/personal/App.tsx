// PAE P6 — 个人管理面外壳（任务单 §9.1/§9.6）。
// 主导航：总览/项目/任务/我的Workers/报告；设置/用量为辅助入口（底部）。
// 旧分析控制台与 Worker 实验室保留为外链，互不混入（§9.1、P8 §11.7）。
// 本壳独立于 src/app/AppShell.tsx（P8 接入）；窄屏沿用既有响应式断点。
import { lazy, Suspense } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import {
  Boxes, Compass, Cpu, FileText, GaugeCircle, LayoutDashboard, Play, RefreshCw,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Skeleton } from '../components/ui/primitives';
import { usePersonalSurface } from './hooks';

const OverviewPage = lazy(() => import('./pages/OverviewPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const ProjectEnvironmentPage = lazy(() => import('./pages/ProjectEnvironmentPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage'));
const WorkersPage = lazy(() => import('./pages/WorkersPage'));
// P8 mount: the P7 reports subsystem page fills the shell's /reports slot
// (PERSONAL_REPORTS_ROUTE); the simpler P6 placeholder page stays unmounted.
const ReportsPage = lazy(() => import('./reports/ReportsPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

const NAV = [
  { to: '/overview', label: '总览', icon: LayoutDashboard },
  { to: '/projects', label: '项目', icon: Boxes },
  { to: '/tasks', label: '任务', icon: Play },
  { to: '/workers', label: '我的 Workers', icon: Cpu },
  { to: '/reports', label: '报告', icon: FileText },
];

const Fallback = <div className="col"><Skeleton h={110} /><Skeleton h={260} /></div>;

export function PersonalApp() {
  const surface = usePersonalSurface();
  const qc = useQueryClient();
  return (
    <div className="shell">
      <nav className="sidenav" aria-label="主导航">
        <div className="brand"><GaugeCircle size={17} color="var(--accent)" /><span>个人管理</span></div>
        {NAV.map(n => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? 'active' : '')}>
            <n.icon size={15} aria-hidden /><span className="nav-label">{n.label}</span>
          </NavLink>
        ))}
        <div className="bottom">
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            <Compass size={15} aria-hidden /><span className="nav-label">设置与用量</span>
          </NavLink>
          <a href="./index.html#/analysis/overview"><span className="nav-label">运行分析 ↗</span></a>
          <a href="./index.html#/manage/workers"><span className="nav-label">Worker 管理 ↗</span></a>
          <button className="ghost" onClick={() => void qc.invalidateQueries({ queryKey: ['personal'] })}
            aria-label="刷新全部" style={{ alignSelf: 'start' }}>
            <RefreshCw size={13} />
          </button>
          <div style={{ padding: '0 10px', fontSize: 11, color: 'var(--text-faint)' }}>{surface.label}</div>
        </div>
      </nav>
      <div className="main">
        <main className="content">
          {surface.kind === 'demo' && (
            <Banner kind="demo">示例数据——未连接真实管理服务；页面与冻结 DTO 对齐，操作仅在本会话内演示。</Banner>
          )}
          {surface.readonly && (
            <Banner kind="info">只读视图——当前面不提供可执行按钮（窄接口/未授权写场景）。</Banner>
          )}
          <Routes>
            <Route index element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<Suspense fallback={Fallback}><OverviewPage /></Suspense>} />
            <Route path="/projects" element={<Suspense fallback={Fallback}><ProjectsPage /></Suspense>} />
            <Route path="/projects/:projectId" element={<Suspense fallback={Fallback}><ProjectEnvironmentPage /></Suspense>} />
            <Route path="/tasks" element={<Suspense fallback={Fallback}><TasksPage /></Suspense>} />
            <Route path="/tasks/:taskId" element={<Suspense fallback={Fallback}><TaskDetailPage /></Suspense>} />
            <Route path="/workers" element={<Suspense fallback={Fallback}><WorkersPage /></Suspense>} />
            <Route path="/reports" element={<Suspense fallback={Fallback}><ReportsPage /></Suspense>} />
            <Route path="/settings" element={<Suspense fallback={Fallback}><SettingsPage /></Suspense>} />
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
