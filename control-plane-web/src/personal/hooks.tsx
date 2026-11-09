// PAE P6 个人管理面 — React 绑定：PersonalSurface context + TanStack Query 封装。
// 所有页面经 usePersonalGateway 拿 typed port，经 usePersonalSurface 决定
// 写按钮显隐；组件不接触 transport/IPC/fetch 细节。
import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient, type UseQueryResult, type Query } from '@tanstack/react-query';
import type { PersonalEnvelope, PersonalOperation } from '../../../codeagent-desktop/packages/protocol/src/personal';
import type { PersonalGateway, PersonalSurface } from './port';

const SurfaceCtx = createContext<PersonalSurface | null>(null);

export function PersonalGatewayProvider({ surface, children }: { surface: PersonalSurface; children: ReactNode }) {
  return <SurfaceCtx.Provider value={surface}>{children}</SurfaceCtx.Provider>;
}

export function usePersonalSurface(): PersonalSurface {
  const surface = useContext(SurfaceCtx);
  if (!surface) throw new Error('PersonalGatewayProvider missing');
  return surface;
}

export function usePersonalGateway(): PersonalGateway {
  return usePersonalSurface().gateway;
}

interface UsePersonalOptions<T> {
  /** number 或按查询返回数据决定（操作页按状态轮询）。 */
  refetchInterval?: number | false | ((query: Query<PersonalEnvelope<T>, Error>) => number | false);
  enabled?: boolean;
  staleTime?: number;
}

/** 统一查询入口：queryKey 以 'personal' 开头，整面失效一键完成。 */
export function usePersonal<T>(
  key: readonly unknown[],
  fn: (gateway: PersonalGateway) => Promise<PersonalEnvelope<T>>,
  opts?: UsePersonalOptions<T>,
): UseQueryResult<PersonalEnvelope<T>> {
  const gateway = usePersonalGateway();
  return useQuery<PersonalEnvelope<T>, Error>({
    queryKey: ['personal', ...key],
    queryFn: () => fn(gateway),
    refetchInterval: opts?.refetchInterval,
    enabled: opts?.enabled,
    staleTime: opts?.staleTime ?? 4_000,
    retry: (count, err) => count < 1 && (err as { retryable?: boolean }).retryable === true,
  });
}

/** 写操作后失效整面查询（同一管理服务状态，多端/多视图共享）。 */
export function usePersonalInvalidate(): () => Promise<void> {
  const qc = useQueryClient();
  return async () => { await qc.invalidateQueries({ queryKey: ['personal'] }); };
}

export type { PersonalOperation };
