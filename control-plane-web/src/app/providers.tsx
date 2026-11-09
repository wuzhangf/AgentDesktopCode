import { useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HashRouter } from 'react-router-dom';
import { FilterProvider } from '../state/filters';
import { motionPref, setMotionPref, setThemePref, themePref } from '../lib/motion';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 4_000,
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  },
});

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.theme = themePref();
    document.documentElement.dataset.motion = motionPref();
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <FilterProvider>{children}</FilterProvider>
      </HashRouter>
    </QueryClientProvider>
  );
}

export { setMotionPref, setThemePref };
