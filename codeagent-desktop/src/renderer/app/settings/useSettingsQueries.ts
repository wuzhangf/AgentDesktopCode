/**
 * Settings Center data layer (settings design §8).
 *
 * Queries are route-scoped by key; mutations always adopt the authoritative
 * response into the cache (no optimistic fake success) and invalidate only
 * the keys a durable event would invalidate — never the whole client.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DesktopDiagnostics,
  DesktopServiceStatus,
  KnowledgeListResponse,
  PolicyLayerUpdateRequest,
  PolicyLayersResponse,
  ProductSettingsResponse,
  SessionResponse
} from '../../../../electron/shared/api-types';
import type { DesktopPreferencesResponse, DesktopPreferencesUpdateRequest } from '../../../../electron/shared/settings-types';
import type { ModelCatalogResponse, SessionModelSettings } from '../../../../packages/protocol/src/index.js';
import type {
  EnvironmentFeatureCard,
  EnvironmentFeaturesResponse,
  ManagedDeleteResponse,
  ManagedModel,
  ManagedModelProvider,
  ManagedModelProviderRequest,
  ManagedModelProvidersResponse,
  ManagedModelRequest,
  WebSearchProvider,
  WebSearchProviderRequest,
  WebSearchProvidersResponse
} from '../../../../packages/protocol/src/index.js';
import { unwrap } from '../queries';
import { settingsKeys } from './settingsKeys';

export function useProductSettings(enabled = true) {
  return useQuery({
    queryKey: settingsKeys.product,
    enabled,
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getProductSettings()) as ProductSettingsResponse
  });
}

export function usePolicyLayers(enabled = true) {
  return useQuery({
    queryKey: settingsKeys.policyLayers,
    enabled,
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.listPolicyLayers()) as PolicyLayersResponse
  });
}

export function useSettingsKnowledge(enabled = true) {
  return useQuery({
    queryKey: settingsKeys.knowledge,
    enabled,
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.listKnowledge()) as KnowledgeListResponse
  });
}

export function useModelCatalog(enabled = true) {
  return useQuery({
    queryKey: settingsKeys.modelCatalog,
    enabled,
    retry: false,
    refetchInterval: 2000,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getModelCatalog()) as ModelCatalogResponse
  });
}

export function useDesktopPreferences() {
  return useQuery({
    queryKey: settingsKeys.desktopPreferences,
    // Main-owned: works while the Service is offline; no retry loop.
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getDesktopPreferences()) as DesktopPreferencesResponse
  });
}

export function useServiceStatus(enabled = true) {
  return useQuery({
    queryKey: settingsKeys.serviceStatus,
    enabled,
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.serviceStatus()) as DesktopServiceStatus
  });
}

export function useSettingsDiagnostics(enabled = true) {
  return useQuery({
    queryKey: settingsKeys.diagnostics,
    enabled,
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.diagnostics()) as DesktopDiagnostics
  });
}

/** Precise invalidation for settings-scoped durable events (§8.2). */
export function useSettingsEventInvalidation(): (type: string) => void {
  const queryClient = useQueryClient();
  return (type: string) => {
    if (type === 'settings.updated') {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.product });
      void queryClient.invalidateQueries({ queryKey: ['attention'] });
    } else if (type === 'policy.updated') {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.policyLayers });
      void queryClient.invalidateQueries({ queryKey: ['project-session-preflight'] });
    } else if (type === 'memory.knowledge.confirmed') {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.knowledge });
    }
  };
}

export interface SettingsSaveOutcome {
  ok: boolean;
  /** public-safe user copy for the failure; raw codes stay in details */
  message?: string;
  conflict?: boolean;
}

export function useUpdateProductSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      localOnly?: boolean;
      traceExportEnabled?: boolean;
      eventJournalRetentionDays?: number;
      expectedRevision: number;
    }) => unwrap(await window.codeAgentDesktop.updateProductSettings(body)) as ProductSettingsResponse,
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKeys.product, data);
    }
  });
}

export function useUpdatePolicyLayer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { layer: 'PROJECT' | 'USER'; request: PolicyLayerUpdateRequest }) =>
      unwrap(await window.codeAgentDesktop.updatePolicyLayer(input.layer, input.request.maximumAutonomy, input.request.expectedRevision ?? undefined)) as PolicyLayersResponse,
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKeys.policyLayers, data);
    }
  });
}

export function useConfirmSettingsKnowledge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (knowledgeId: string) =>
      unwrap(await window.codeAgentDesktop.confirmKnowledge(knowledgeId)),
    onSuccess: () => {
      // The confirm response is one item; the list projection (items/facts)
      // is server-shaped, so re-read the authoritative list instead of
      // splicing local state.
      void queryClient.invalidateQueries({ queryKey: settingsKeys.knowledge });
    }
  });
}

/** User-proposed knowledge: lands as PENDING and still needs explicit
 * confirmation before it becomes fact — same authority rule as service
 * suggestions. */
export function useSuggestKnowledge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { content: string; sourceRef: string | null }) =>
      unwrap(await window.codeAgentDesktop.suggestKnowledge(input.content, input.sourceRef)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.knowledge });
    }
  });
}

export function useUpdateDesktopPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: DesktopPreferencesUpdateRequest) =>
      unwrap(await window.codeAgentDesktop.updateDesktopPreferences(body)) as DesktopPreferencesResponse,
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKeys.desktopPreferences, data);
    }
  });
}

/** Environment capability cards (desired + effective state, checks, actions). */
export function useEnvironmentFeatures(enabled = true) {
  return useQuery({
    queryKey: settingsKeys.environmentFeatures,
    enabled: enabled && typeof window.codeAgentDesktop.getEnvironmentFeatures === 'function',
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.getEnvironmentFeatures()) as EnvironmentFeaturesResponse
  });
}

export function useUpdateEnvironmentFeature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { featureId: string; enabled?: boolean; entries?: Record<string, string | null>; expectedRevision?: number }) =>
      unwrap(await window.codeAgentDesktop.updateEnvironmentFeature(input.featureId, {
        enabled: input.enabled,
        entries: input.entries,
        expectedRevision: input.expectedRevision
      })) as EnvironmentFeatureCard,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.environmentFeatures });
    }
  });
}

export function usePreflightEnvironmentFeature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (featureId: string) =>
      unwrap(await window.codeAgentDesktop.preflightEnvironmentFeature(featureId)) as EnvironmentFeatureCard,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.environmentFeatures });
    }
  });
}

/** Managed model catalog (database-desired view; applies at Service restart). */
export function useManagedModelProviders(enabled = true) {
  return useQuery({
    queryKey: settingsKeys.managedModelProviders,
    enabled: enabled && typeof window.codeAgentDesktop.listManagedModelProviders === 'function',
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.listManagedModelProviders()) as ManagedModelProvidersResponse
  });
}

export function useUpsertModelProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { providerId: string; body: ManagedModelProviderRequest }) =>
      unwrap(await window.codeAgentDesktop.upsertModelProvider(input.providerId, input.body)) as ManagedModelProvider,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.managedModelProviders });
    }
  });
}

export function useDeleteModelProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { providerId: string; expectedRevision?: number; replaceDefault?: string }) =>
      unwrap(await window.codeAgentDesktop.deleteModelProvider(
        input.providerId, input.expectedRevision, input.replaceDefault)) as ManagedDeleteResponse,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.managedModelProviders });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.environmentFeatures });
    }
  });
}

export function useUpsertProviderModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { providerId: string; modelId: string; body: ManagedModelRequest }) =>
      unwrap(await window.codeAgentDesktop.upsertProviderModel(input.providerId, input.modelId, input.body)) as ManagedModel,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.managedModelProviders });
    }
  });
}

export function useDeleteProviderModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { providerId: string; modelId: string; expectedRevision?: number; replaceDefault?: string }) =>
      unwrap(await window.codeAgentDesktop.deleteProviderModel(
        input.providerId, input.modelId, input.expectedRevision, input.replaceDefault)) as ManagedDeleteResponse,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.managedModelProviders });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.environmentFeatures });
    }
  });
}

/** Managed web-search records (V026 desired state; applies at restart). */
export function useWebSearchProviders(enabled = true) {
  return useQuery({
    queryKey: settingsKeys.webSearchProviders,
    enabled: enabled && typeof window.codeAgentDesktop.listWebSearchProviders === 'function',
    retry: false,
    queryFn: async () => unwrap(await window.codeAgentDesktop.listWebSearchProviders()) as WebSearchProvidersResponse
  });
}

export function useUpsertWebSearchProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { providerId: string; body: WebSearchProviderRequest }) =>
      unwrap(await window.codeAgentDesktop.upsertWebSearchProvider(input.providerId, input.body)) as WebSearchProvider,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.webSearchProviders });
      // The enabled selection feeds the WEBSEARCH feature fingerprint —
      // a record write can flip the card's pending state too.
      void queryClient.invalidateQueries({ queryKey: settingsKeys.environmentFeatures });
    }
  });
}

export function useDeleteWebSearchProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { providerId: string; expectedRevision?: number }) =>
      unwrap(await window.codeAgentDesktop.deleteWebSearchProvider(
        input.providerId, input.expectedRevision)) as ManagedDeleteResponse,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.webSearchProviders });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.environmentFeatures });
    }
  });
}

/** Current-session model change; the SessionResponse is the only truth. */
export function usePatchSessionModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { sessionId: string; modelAlias: string | null; expectedSessionVersion: number; modelSettings?: SessionModelSettings | null }) =>
      unwrap(await window.codeAgentDesktop.patchSession(input.sessionId, {
        expectedSessionVersion: input.expectedSessionVersion,
        modelAlias: input.modelAlias,
        modelSettings: input.modelSettings ?? undefined
      })) as SessionResponse,
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKeys.session(data.sessionId), data);
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    }
  });
}
