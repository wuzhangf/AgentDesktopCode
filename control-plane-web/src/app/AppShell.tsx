import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ClipboardList, Coins, Compass, FlaskConical, FolderKanban, GaugeCircle,
  LayoutDashboard, Moon, Server, Settings, Sun,
} from 'lucide-react';
import { FilterBar } from '../features/filters/FilterBar';
import { useFilters } from '../state/filters';
import { motionPref, setMotionPref, themePref, setThemePref, type MotionPref } from '../lib/motion';
import { useState } from 'react';
import { Banner } from '../components/ui/primitives';

const NAV = [
  { to: '/manage', label: '总览', icon: LayoutDashboard, end: true },
  { to: '/manage/workers', label: '我的 Workers', icon: Server },
  { to: '/manage/tasks', label: '任务', icon: ClipboardList },
  { to: '/manage/projects', label: '项目', icon: FolderKanban },
  { to: '/manage/usage', label: '用量', icon: Coins },
  { to: '/manage/settings', label: '设置', icon: Settings },
  { to: '/manage/lab', label: '测试实验室', icon: FlaskConical },
];

export function AppShell() {
  const { isDemo, source } = useFilters();
  const [theme, setTheme] = useState(themePref());
  const [motion, setMotion] = useState<MotionPref>(motionPref());
  // FilterBar / demo banner / data-source row only apply to the analytics shell.
  const onAnalysis = useLocation().pathname.startsWith('/analysis');

  return (
    <div className="shell">
      <nav className="sidenav" aria-label="主导航">
        <div className="brand"><GaugeCircle size={17} color="var(--accent)" /><span>Worker 管理台</span></div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} aria-label={n.label} title={n.label}
            className={({ isActive }) => (isActive ? 'active' : '')}>
            <n.icon size={15} aria-hidden /><span className="nav-label">{n.label}</span>
          </NavLink>
        ))}
        <div className="bottom">
          {/* PAE P8: 个人管理面入口（独立 Vite 入口 personal.html，P6 壳内已有回链）。 */}
          <a href="./personal.html"><span className="nav-label">个人管理 ↗</span></a>
          {onAnalysis && (
            <div className="row full" style={{ padding: '4px 10px', fontSize: 11.5, color: 'var(--text-faint)' }}>
              <Compass size={13} /> {source ? `${source.label}` : '无数据源'}
            </div>
          )}
          <div className="row full" style={{ padding: '0 10px 6px', gap: 6 }}>
            <button className="ghost" aria-label="切换主题" title="深浅主题"
              onClick={() => { const t = theme === 'dark' ? 'light' : 'dark'; setTheme(t); setThemePref(t); }}>
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <select aria-label="动效" value={motion} style={{ fontSize: 11, padding: '2px 6px' }}
              onChange={(e) => { const m = e.target.value as MotionPref; setMotion(m); setMotionPref(m); }}>
              <option value="standard">动效·标准</option>
              <option value="reduced">动效·减少</option>
              <option value="off">动效·关闭</option>
            </select>
          </div>
        </div>
      </nav>
      <div className="main">
        {onAnalysis && <FilterBar />}
        <main className="content">
          {onAnalysis && isDemo && <Banner kind="demo">当前为演示数据源 — 全部数字来自生成的演示库，不是真实执行记录。</Banner>}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
