// PAE P6 — 个人管理面入口（worker/main.tsx 先例：独立 Vite input，
// 不改 src/app/router.tsx 与 AppShell.tsx——P8 统一接入）。
// 宿主面解析只在此发生一次：?demo=1 示例数据 / Desktop 窄桥 / 同源 fetch；
// ?readonly=1 或 ?surface=mobile 进入只读窄接口面（手机式展示预留）。
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter } from 'react-router-dom';
import { motionPref, themePref } from '../lib/motion';
import { resolvePersonalSurface } from './port';
import { PersonalGatewayProvider } from './hooks';
import { PersonalApp } from './App';
import '../styles/global.css';
import './personal.css';

const queries = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 4_000, retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: false },
  },
});

const surface = resolvePersonalSurface();

function Root() {
  useEffect(() => {
    document.documentElement.dataset.theme = themePref();
    document.documentElement.dataset.motion = motionPref();
  }, []);
  return (
    <QueryClientProvider client={queries}>
      <HashRouter>
        <PersonalGatewayProvider surface={surface}>
          <PersonalApp />
        </PersonalGatewayProvider>
      </HashRouter>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
