export type Completeness = 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';
export type MetricState =
  | 'AVAILABLE' | 'PARTIAL' | 'NO_DATA' | 'UNSUPPORTED' | 'UNKNOWN';
export type Measurement =
  | 'REPORTED' | 'MEASURED' | 'ESTIMATED' | 'DERIVED' | 'UNKNOWN';
export type MetricUnit = 'count' | 'ratio' | 'ms' | 'tokens' | 'bytes' | 'money';

export interface MetricComparison {
  value: number | string | null;
  delta: number | null;
  deltaKind: 'ABSOLUTE' | 'PERCENT' | 'PERCENTAGE_POINT';
  comparable: boolean;
  reason?: string;
}

export interface MetricValue {
  metricId: string;
  value: number | string | null;
  knownSubtotal?: number | string | null;
  unit: MetricUnit;
  currency?: string;
  state: MetricState;
  completeness: Completeness;
  measurement: Measurement;
  numerator?: number;
  denominator?: number;
  sampleCount: number;
  knownCount: number;
  unknownCount: number;
  excludedCount: number;
  coverageRatio: number | null;
  reasonCodes: string[];
  cohortBasis: string;
  comparison?: MetricComparison;
  drilldown: { path: string; filters: Record<string, unknown> };
}

