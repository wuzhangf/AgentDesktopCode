/**
 * Settings Center shell (settings design §5, SET-1).
 *
 * Independent full-height surface with its own nav, local search, typed
 * sub-routes and responsive degradation. The shell never owns settings
 * business state: sections register dirty state for the navigation guard,
 * and every mutation stays inside its page. Service-owned pages show typed
 * unavailable states offline; General/Appearance stay usable (Main-owned).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { routeDefinition, searchSettingsRoutes, SETTINGS_ROUTE_GROUP_LABELS, SETTINGS_ROUTES, type SettingsRoute, type SettingsRouteGroup } from './settingsRoutes';
export type { SettingsRoute } from './settingsRoutes';
import { SettingsDirtyContext } from './useDirtyRegistry';
import type { SettingsPageContext } from './settingsContext';
import { OverviewPage } from './pages/OverviewPage';
import { GeneralPage } from './pages/GeneralPage';
import { AppearancePage } from './pages/AppearancePage';
import { ModelsPage } from './pages/ModelsPage';
import { PermissionsPage } from './pages/PermissionsPage';
import { ProjectsSessionsPage } from './pages/ProjectsSessionsPage';
import { PrivacyEvidencePage } from './pages/PrivacyEvidencePage';
import { KnowledgePage } from './pages/KnowledgePage';
import { DiagnosticsPage, ExtensionsPage, RuntimePage, AboutPage } from './pages/AdvancedPages';
import { FeaturesPage } from './pages/FeaturesPage';
import { ServicePage } from './pages/ServicePage';


export function SettingsCenter(props: {
  context: SettingsPageContext;
  initialRoute?: SettingsRoute;
  onAppearancePreview?: (draft: { theme: 'SYSTEM' | 'DARK' | 'LIGHT'; density: 'SUMMARY' | 'STANDARD' | 'DETAILED'; uiScalePercent: 90 | 100 | 110 | 125; codeFontSizePx: number; reduceMotion: 'SYSTEM' | 'ON' | 'OFF' } | null) => void;
  routeRequest?: { route: SettingsRoute; nonce: number } | null;
  onDone: () => void;
}): React.JSX.Element {
  const [route, setRoute] = useState<SettingsRoute>(props.initialRoute ?? 'OVERVIEW');
  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingRoute, setPendingRoute] = useState<SettingsRoute | null>(null);
  const [pendingExit, setPendingExit] = useState(false);
  const dirtyRoutesRef = useRef(new Set<SettingsRoute>());
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const contentHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const registerDirty = useCallback((dirtyRoute: SettingsRoute, dirty: boolean) => {
    if (dirty) dirtyRoutesRef.current.add(dirtyRoute);
    else dirtyRoutesRef.current.delete(dirtyRoute);
  }, []);
  const dirtyRegistry = useMemo(() => ({ registerDirty }), [registerDirty]);

  const requestRoute = useCallback((target: SettingsRoute) => {
    if (target === route) {
      setDrawerOpen(false);
      return;
    }
    if (dirtyRoutesRef.current.has(route)) {
      setPendingRoute(target);
      return;
    }
    setRoute(target);
    setSearch('');
    setDrawerOpen(false);
    // Move real focus to the new heading, not just scroll (§5.4).
    window.setTimeout(() => contentHeadingRef.current?.focus(), 0);
  }, [route]);

  // A Command Palette deep-link overrides the internal route selection.
  const lastNonceRef = useRef(0);
  useEffect(() => {
    if (!props.routeRequest || props.routeRequest.nonce === lastNonceRef.current) return;
    lastNonceRef.current = props.routeRequest.nonce;
    setRoute(props.routeRequest.route);
    setSearch('');
    window.setTimeout(() => contentHeadingRef.current?.focus(), 0);
  }, [props.routeRequest]);

  const definition = routeDefinition(route);
  const searchResults = searchSettingsRoutes(search);

  const requestExit = useCallback(() => {
    if (dirtyRoutesRef.current.has(route)) {
      setPendingExit(true);
      return;
    }
    props.onDone();
  }, [route, props.onDone]);

  // Section-level keyboard semantics (§12.1): Ctrl/Cmd+F focuses settings
  // search, Ctrl/Cmd+S saves the active dirty section, Esc closes overlays
  // but never discards drafts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (modifier && event.key.toLowerCase() === 's') {
        const saveButton = contentRef.current?.querySelector<HTMLButtonElement>(
          '[data-testid="settings-save"]:not([disabled])'
        );
        if (saveButton) {
          event.preventDefault();
          saveButton.click();
        }
        return;
      }
      if (event.key === 'Escape' && drawerOpen) {
        setDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const renderPage = (): React.JSX.Element => {
    switch (route) {
      case 'OVERVIEW': return <OverviewPage context={props.context} />;
      case 'GENERAL': return <GeneralPage />;
      case 'APPEARANCE': return <AppearancePage onPreview={props.onAppearancePreview} />;
      case 'MODELS': return <ModelsPage context={props.context} />;
      case 'PERMISSIONS': return <PermissionsPage capabilities={props.context.capabilities} />;
      case 'PROJECTS_SESSIONS': return <ProjectsSessionsPage context={props.context} />;
      case 'PRIVACY_EVIDENCE': return <PrivacyEvidencePage context={props.context} />;
      case 'KNOWLEDGE': return <KnowledgePage context={props.context} />;
      case 'EXTENSIONS': return <ExtensionsPage context={props.context} />;
      case 'FEATURES': return <FeaturesPage context={props.context} />;
      case 'SERVICE': return <ServicePage context={props.context} onRestarted={() => undefined} />;
      case 'RUNTIME': return <RuntimePage context={props.context} />;
      case 'DIAGNOSTICS': return <DiagnosticsPage />;
      case 'ABOUT': return <AboutPage context={props.context} />;
      default: return <OverviewPage context={props.context} />;
    }
  };

  const navCategories = SETTINGS_ROUTES;
  // §10.4: route ids unchanged; nav groups them under four headings.
  const navGroups: SettingsRouteGroup[] = ['common', 'governance', 'capabilities', 'advanced'];

  return (
    <div className={`settings-center ${drawerOpen ? 'settings-drawer-open' : ''}`} data-testid="settings-center">
      <header className="settings-header">
        <div className="settings-header-title">
          <span className="settings-header-name">设置</span>
          <span className={`settings-connection settings-connection-${props.context.connection === 'CONNECTED' ? 'ok' : 'bad'}`}>
            <i className="status-dot" aria-hidden="true" />
            Service {props.context.connection === 'CONNECTED' ? '已连接' : props.context.connection}
          </span>
        </div>
        <button type="button" className="settings-drawer-toggle" aria-expanded={drawerOpen} aria-label="打开设置分类" onClick={() => setDrawerOpen((open) => !open)}>
          分类
        </button>
        <button type="button" className="secondary-button" data-testid="settings-done" onClick={requestExit}>完成</button>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类" data-testid="settings-nav">
          <button type="button" className="settings-back link-button" data-testid="settings-back" onClick={requestExit}>← 返回</button>
          <label className="settings-search">
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索设置…"
              aria-label="搜索设置"
              data-testid="settings-search"
            />
          </label>
          {searchResults.length > 0 ? (
            <ul className="settings-search-results" data-testid="settings-search-results">
              {searchResults.map((result) => (
                <li key={result.id}>
                  <button type="button" onClick={() => requestRoute(result.id)}>
                    <span className="settings-search-result-label">{result.label}</span>
                    <span className="run-meta">{SETTINGS_ROUTE_GROUP_LABELS[result.group]} · {result.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="settings-category-list">
              {navGroups.map((group) => (
                <li key={group}>
                  <details className="settings-nav-group" open>
                    <summary className="settings-category-group">{SETTINGS_ROUTE_GROUP_LABELS[group]}</summary>
                    <ul className="settings-category-sublist">
                      {navCategories.filter((category) => category.group === group).map((category) => (
                        <li key={category.id}>
                          <button
                            type="button"
                            className={`settings-category ${route === category.id ? 'selected' : ''}`}
                            aria-current={route === category.id ? 'page' : undefined}
                            onClick={() => requestRoute(category.id)}
                          >
                            {category.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          )}
          <p className="settings-scope-summary">
            作用域：桌面 · 项目 · 会话各有独立所有者；修改只会写入对应权威源。
          </p>
        </nav>

        <div className="settings-content" ref={contentRef} data-route={route} data-testid="settings-content">
          <div className="settings-content-inner">
          {pendingExit ? (
            <div className="settings-nav-guard" role="alertdialog" aria-label="有未保存的修改" data-testid="settings-exit-guard">
              <span>当前分类有未保存的修改。返回工作台将放弃这些修改（不影响已保存的设置）。</span>
              <span className="settings-save-actions">
                <button type="button" onClick={() => setPendingExit(false)}>留在设置</button>
                <button
                  type="button"
                  className="danger-button"
                  data-testid="settings-exit-guard-leave"
                  onClick={() => {
                    dirtyRoutesRef.current.delete(route);
                    setPendingExit(false);
                    props.onDone();
                  }}
                >
                  放弃修改并返回
                </button>
              </span>
            </div>
          ) : null}
          {pendingRoute !== null ? (
            <div className="settings-nav-guard" role="alertdialog" aria-label="有未保存的修改" data-testid="settings-nav-guard">
              <span>当前分类有未保存的修改。离开将放弃这些修改（不影响已保存的设置）。</span>
              <span className="settings-save-actions">
                <button type="button" onClick={() => setPendingRoute(null)}>留在本页</button>
                <button
                  type="button"
                  className="danger-button"
                  data-testid="settings-nav-guard-leave"
                  onClick={() => {
                    dirtyRoutesRef.current.delete(route);
                    const target = pendingRoute;
                    setPendingRoute(null);
                    if (target) {
                      setRoute(target);
                      setSearch('');
                      setDrawerOpen(false);
                    }
                  }}
                >
                  放弃修改并离开
                </button>
              </span>
            </div>
          ) : null}
          <h1 className="settings-page-heading" tabIndex={-1} ref={contentHeadingRef}>{definition.label}</h1>
          <p className="settings-page-description">{definition.description}</p>
          <SettingsDirtyContext.Provider value={dirtyRegistry}>
            {renderPage()}
          </SettingsDirtyContext.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}
