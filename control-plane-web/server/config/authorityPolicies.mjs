// Cost authority policy (§4.7): decides which authority class counts toward a
// charged-cost view. Without a configured policy the API keeps provider/router/
// estimate facets separate and never produces a cross-source grand total.
export const AUTHORITY_SOURCES = ['PROVIDER_REPORTED', 'ROUTER_REPORTED', 'LOCAL_ESTIMATE'];

export function resolveAuthorityPolicy(source) {
  const p = source?.costAuthorityPolicy;
  if (!p || !AUTHORITY_SOURCES.includes(p.preferredSource)) return null;
  return { preferredSource: p.preferredSource, label: p.label || p.preferredSource };
}
