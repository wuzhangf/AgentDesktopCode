/**
 * Query keys for the Settings Center (settings design §8.1).
 *
 * Keys are namespaced under ['settings', ...] so a shell route subscribes
 * only to what it renders. Never fall back to a broad global invalidate:
 * durable events must map to exactly these keys (design §8.2).
 * Session data intentionally reuses the workbench cache key so Settings and
 * the conversation surface share one authoritative copy.
 */

export const settingsKeys = {
  product: ['settings', 'product'] as const,
  policyLayers: ['settings', 'policy-layers'] as const,
  modelCatalog: ['settings', 'model-catalog'] as const,
  knowledge: ['settings', 'knowledge'] as const,
  desktopPreferences: ['settings', 'desktop-preferences'] as const,
  serviceStatus: ['settings', 'service-status'] as const,
  diagnostics: ['settings', 'diagnostics'] as const,
  /** Reserved for the future Service Configuration Overview contract (SET-4). */
  configurationOverview: ['settings', 'configuration-overview'] as const,
  /** Environment capability cards (desired/effective/readiness per feature). */
  environmentFeatures: ['settings', 'environment-features'] as const,
  /** Two-level managed model catalog (provider → models, desired state). */
  managedModelProviders: ['settings', 'managed-model-providers'] as const,
  /** Managed web-search records (V026; one enabled profile, desired state). */
  webSearchProviders: ['settings', 'web-search-providers'] as const,
  session: (sessionId: string) => ['sessions', sessionId] as const
};
