// PAE P7 reports leaf — mount slot for P8.
//
// Suggested wiring (router.tsx, inside the personal section):
//   const ReportsPage = lazy(() => import('../personal/reports/ReportsPage'));
//   <Route path="/personal/reports" element={<Suspense ...><ReportsPage /></Suspense>} />
//
// Route name advertised to nav: PERSONAL_REPORTS_ROUTE ('reports' under the
// /personal parent; absolute form PERSONAL_REPORTS_PATH for direct links).
// The page is self-contained: own fetch client to /api/personal/v1/reports*,
// no dependency on the observation FilterBar/sourceId state.
export { default as ReportsPage } from './ReportsPage';
export const PERSONAL_REPORTS_ROUTE = 'reports';
export const PERSONAL_REPORTS_PATH = '/personal/reports';
export const PERSONAL_REPORTS_NAV = { to: PERSONAL_REPORTS_PATH, label: '报告' };
