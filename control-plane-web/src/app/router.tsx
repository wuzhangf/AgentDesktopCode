import { lazy, Suspense, useEffect, type ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './AppShell';
import { Skeleton } from '../components/ui/primitives';
import { ANALYSIS_ROOTS } from '../state/filters';

// Personal Worker console — the main SPA surface.
const ManageOverviewPage = lazy(() => import('../manage/pages/ManageOverviewPage'));
const WorkersPage = lazy(() => import('../manage/pages/WorkersPage'));
const WorkerDetailPage = lazy(() => import('../manage/pages/WorkerDetailPage'));



const SettingsPage = lazy(() => import('../manage/pages/SettingsPage'));
const LabPage = lazy(() => import('../manage/pages/LabPage'));

// Read-only analytics — demoted under /analysis/* (unchanged pages).
const OverviewPage = lazy(() => import('../pages/OverviewPage'));
const RunsPage = lazy(() => import('../pages/RunsPage'));
const RunDetailPage = lazy(() => import('../pages/RunDetailPage'));
const TaskDetailPage = lazy(() => import('../pages/TaskDetailPage'));
const ModelsPage = lazy(() => import('../pages/ModelsPage'));
const ModelAttemptDetailPage = lazy(() => import('../pages/ModelAttemptDetailPage'));
const ContextPage = lazy(() => import('../pages/ContextPage'));
const CollaborationPage = lazy(() => import('../pages/CollaborationPage'));
const ToolsPage = lazy(() => import('../pages/ToolsPage'));
const EfficiencyPage = lazy(() => import('../pages/EfficiencyPage'));
const QualityPage = lazy(() => import('../pages/QualityPage'));
const ExplorerPage = lazy(() => import('../pages/ExplorerPage'));

const Fallback = <div className="col"><Skeleton h={110} /><Skeleton h={260} /></div>;
const lazy$ = (el: ReactElement) => <Suspense fallback={Fallback}>{el}</Suspense>;

/**
 * Bare legacy analytics paths (bookmarks, stored detailRef links like
 * '/models?callId=…') re-root under /analysis/*; everything else → /manage.
 */
function LegacyRedirect() {
  const loc = useLocation();
  const root = loc.pathname.split('/')[1] ?? '';
  const to = ANALYSIS_ROOTS.has(root) ? `/analysis${loc.pathname}${loc.search}` : '/manage';
  return <Navigate to={to} replace />;
}

function PersonalRedirect({page}: {page:string}) {
  useEffect(() => { window.location.replace(`./personal.html#/${page}`); },[page]);
  return <a href={`./personal.html#/${page}`}>进入个人{page === 'projects' ? '项目' : '任务'}页面</a>;
}
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/manage" replace />} />
        <Route path="/manage" element={lazy$(<ManageOverviewPage />)} />
        <Route path="/manage/workers" element={lazy$(<WorkersPage />)} />
        <Route path="/manage/workers/:key" element={lazy$(<WorkerDetailPage />)} />
        <Route path="/manage/tasks" element={<PersonalRedirect page="tasks" />} />
        <Route path="/manage/projects" element={<PersonalRedirect page="projects" />} />
        <Route path="/manage/usage" element={<PersonalRedirect page="tasks" />} />
        <Route path="/manage/settings" element={lazy$(<SettingsPage />)} />
        <Route path="/manage/lab" element={lazy$(<LabPage />)} />
        <Route path="/analysis/overview" element={lazy$(<OverviewPage />)} />
        <Route path="/analysis/runs" element={lazy$(<RunsPage />)} />
        <Route path="/analysis/runs/:runId" element={lazy$(<RunDetailPage />)} />
        <Route path="/analysis/tasks/:taskId" element={lazy$(<TaskDetailPage />)} />
        <Route path="/analysis/models" element={lazy$(<ModelsPage />)} />
        <Route path="/analysis/models/attempts/:attemptId" element={lazy$(<ModelAttemptDetailPage />)} />
        <Route path="/analysis/context" element={lazy$(<ContextPage />)} />
        <Route path="/analysis/collaboration" element={lazy$(<CollaborationPage />)} />
        <Route path="/analysis/tools" element={lazy$(<ToolsPage />)} />
        <Route path="/analysis/efficiency" element={lazy$(<EfficiencyPage />)} />
        <Route path="/analysis/quality" element={lazy$(<QualityPage />)} />
        <Route path="/analysis/explorer" element={lazy$(<ExplorerPage />)} />
        <Route path="*" element={<LegacyRedirect />} />
      </Route>
    </Routes>
  );
}
