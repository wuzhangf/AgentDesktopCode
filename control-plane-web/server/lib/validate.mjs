// Request parameter validation for /api/v2 (§11.1). Every endpoint declares the
// filters it supports; unsupported filters return 400 rather than being ignored.
import { badRequest, unprocessable } from './errors.mjs';
import { GRAIN_MS } from '../../shared/contracts/enums.mjs';

export const MAX_ANALYTICS_RANGE_MS = 90 * 86_400_000;
export const MAX_POINTS = 600;

const ID_RE = /^[\w:.\-/]{1,128}$/u;

export function parseId(value, name = 'id') {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    badRequest(`invalid ${name}`);
  }
  return value;
}

export function parseEpochMs(value, name) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    badRequest(`${name} must be a finite non-negative epoch ms integer`);
  }
  return n;
}

export function parseTimezone(value) {
  const tz = value || 'Asia/Shanghai';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    badRequest('invalid IANA timezone');
  }
  return tz;
}

export function parseGrain(value) {
  if (value == null || value === '') return null;
  if (!(value in GRAIN_MS)) badRequest(`grain must be one of ${Object.keys(GRAIN_MS).join('/')}`);
  return value;
}

/** Elevate grain so bucket count <= MAX_POINTS; returns the actual grain. */
export function effectiveGrain(from, to, requested) {
  const span = to - from;
  const order = ['1m', '5m', '15m', '1h', '1d'];
  let g = requested ?? '1h';
  for (const candidate of order.slice(order.indexOf(g))) {
    if (Math.ceil(span / GRAIN_MS[candidate]) <= MAX_POINTS) return candidate;
  }
  return '1d';
}

export function parseLimit(value, { def = 50, max = 200 } = {}) {
  if (value == null || value === '') return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    badRequest(`limit must be an integer between 1 and ${max}`);
  }
  return n;
}

export function parseBool(value, def = false) {
  if (value == null || value === '') return def;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  badRequest('boolean parameter must be true/false');
}

/**
 * Parse the common analytics window params. `supported` lists optional filter
 * keys the endpoint accepts; any other filter-ish key present → 400.
 */
export function parseWindowParams(sp, { supported = [], requireWindow = true } = {}) {
  const knownReserved = new Set([
    'sourceId', 'scopeId', 'from', 'to', 'timezone', 'grain', 'compare',
    'limit', 'cursor', 'sort', 'dir', ...supported,
  ]);
  for (const key of sp.keys()) {
    if (!knownReserved.has(key)) badRequest(`unsupported filter: ${key}`);
  }
  const timezone = parseTimezone(sp.get('timezone'));
  const to = parseEpochMs(sp.get('to'), 'to') ?? Date.now();
  const from = parseEpochMs(sp.get('from'), 'from') ?? (to - 24 * 3_600_000);
  if (requireWindow && from >= to) badRequest('from must be < to');
  if (requireWindow && to - from > MAX_ANALYTICS_RANGE_MS) {
    badRequest('analytics window may not exceed 90 days');
  }
  const grain = effectiveGrain(from, to, parseGrain(sp.get('grain')));
  const compare = sp.get('compare') === 'prev';
  const filters = {};
  for (const key of supported) {
    const v = sp.get(key);
    if (v != null && v !== '') filters[key] = v;
  }
  return { from, to, timezone, grain, compare, filters };
}

export function requireEnum(value, allowed, name) {
  if (value == null || value === '') return null;
  if (!allowed.includes(value)) unprocessable(`${name} must be one of ${allowed.join(', ')}`);
  return value;
}

export function parseSort(sort, dir, allowed, fallback) {
  const field = sort || fallback.field;
  if (!allowed.includes(field)) badRequest(`sort must be one of ${allowed.join(', ')}`);
  const direction = dir === 'asc' ? 'ASC' : 'DESC';
  if (dir && dir !== 'asc' && dir !== 'desc') badRequest('dir must be asc|desc');
  return { field, direction };
}
