// API v2 contract types (design doc §11.3). Frontend uses these types;
// the .mjs server produces the same shapes (checked by integration tests).

import type { MetricValue } from '../../../codeagent-desktop/packages/protocol/src/metrics';
export type { Completeness, MetricState, Measurement, MetricUnit, MetricComparison, MetricValue } from '../../../codeagent-desktop/packages/protocol/src/metrics';
export type SourceMode = 'SNAPSHOT' | 'LIVE' | 'DEMO';

export interface QueryWarning {
  code: string;
  affectedCount?: number;
  message: string;
}

export interface QueryMeta {
  apiVersion: '2';
  metricVersion: string;
  sourceId: string;
  sourceEpoch: string;
  mode: SourceMode;
  scopeId: string;
  schemaVersion: number;
  snapshotId: string;
  queriedAt: number;
  dataAsOf: number | null;
  from?: number;
  to?: number;
  timezone: string;
  grain?: string;
  filtersApplied: Record<string, unknown>;
  filtersIgnored?: Record<string, unknown>;
  warnings: QueryWarning[];
  queryDurationMs: number;
}

export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
  truncated: boolean;
}

export interface Envelope<T> {
  meta: QueryMeta;
  data: T;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
  };
}

// ---- meta ----

export interface SourceInfo {
  id: string;
  label: string;
  mode: SourceMode;
  available: boolean;
  unavailableReason?: string;
  schemaVersion: number | null;
  sourceEpoch: string;
  dataAsOf: number | null;
  scopes: string[];
  isDefault: boolean;
}

export interface CapabilityEntry {
  key: string;
  schemaAvailable: boolean;
  sourceDeclared: 'YES' | 'NO' | 'UNKNOWN';
  observedRows: number;
  usableSamples: number | null;
  note?: string;
}

// ---- analytics payloads ----

export interface AttentionItem {
  ruleId: string;
  severity: 'INFO' | 'WARN' | 'ERROR';
  metricId?: string;
  sampleCount: number;
  message: string;
  drilldown: { path: string; filters: Record<string, unknown> };
}

export interface TrendPoint {
  bucketStart: number;
  [seriesId: string]: number | null;
}

export interface OverviewData {
  kpis: MetricValue[];
  registeredTrend: TrendPoint[];
  completedTrend: TrendPoint[];
  outcomeDistribution: { outcome: string; count: number }[];
  outcomeKnownCoverage: number | null;
  tokenTrend: TrendPoint[];
  topModels: ModelRankRow[];
  topTools: ToolRankRow[];
  attention: AttentionItem[];
  recentRuns: RunRow[];
}

export interface ModelRankRow {
  providerId: string | null;
  resolvedModel: string | null;
  callCount: number;
  attemptCount: number;
  knownTotalTokens: number | null;
  usageSampleCount: number;
  usageKnownCount: number;
}

export interface ToolRankRow {
  canonicalToolName: string | null;
  requestedToolName?: string | null;
  callCount: number;
  succeededCount: number;
  failedCount: number;
  terminalKnownCount: number;
  knownDurationMs: number | null;
  resultBytes: number | null;
}

export interface RunRow {
  runId: string;
  taskId: string | null;
  sessionId: string | null;
  parentRunId: string | null;
  rootRunId: string;
  runKind: string;
  productName: string | null;
  productVersion: string | null;
  configRevision: string | null;
  lifecycle: string;
  outcome: string | null;
  nativeStatus: string | null;
  activityState: string;
  relationState: string;
  registeredAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  timingQuality: string;
  wallClockMs: number | null;
  coverage: string;
  stepCount: number;
  callCount: number;
  transportAttemptCount: number;
  toolCallCount: number;
  commandCount: number;
  knownTotalTokens: number | null;
  usageKnownCount: number;
  qualityReasons: string[];
}

// ---- run detail / timeline ----

export interface TimelineNode {
  nodeId: string;
  kind: string;
  entityId: string;
  parentNodeId: string | null;
  relationshipState: string;
  label: string;
  registeredAt: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  timingQuality: string | null;
  lastObservedAt: number | null;
  activityState: string;
  lifecycle: string;
  outcome: string | null;
  nativeStatus: string | null;
  resourceSummary: Record<string, unknown>;
  qualityReasons: string[];
  childrenCount: number;
  detailRef: string | null;
  markers?: TimelineMarker[];
}

export interface TimelineMarker {
  kind: 'FIRST_RESPONSE' | 'FIRST_ANSWER' | 'FIRST_REASONING' | 'BACKOFF';
  atMs: number;
  label: string;
}

export interface RunTimelineData {
  runId: string;
  originAt: number | null;
  nodes: TimelineNode[];
  truncated: boolean;
  relationAnomalies: { runId: string; reason: string }[];
}

export interface RunSummaryData {
  run: RunRow;
  task: { taskId: string; lifecycle: string; outcome: string | null } | null;
  segments: {
    segment_id: string; segment_no: number; segment_end_reason: string | null;
    resume_of_segment_id: string | null; lifecycle: string; outcome: string | null;
    started_at: number | null; ended_at: number | null; registered_at: number | null;
  }[];
  stats: MetricValue[];
  childRuns: { runId: string; runKind: string; lifecycle: string; outcome: string | null; relationState: string; viaDelegation: boolean }[];
  delegations: {
    delegationId: string; childRunId: string | null; role: string | null;
    requestedAt: number | null; acceptedAt: number | null; startedAt: number | null;
    completedAt: number | null; lifecycle: string; outcome: string | null;
  }[];
  relationAnomalies: { runId: string; reason: string }[];
  excludedRelationCount: number;
  includeDescendants: boolean;
  descendantIds: string[];
}

export interface FactRow {
  [key: string]: unknown;
}
