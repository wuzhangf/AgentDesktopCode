/**
 * Resource vocabulary for the history refresh coordinator
 * (2026-09-05 session-history performance design §8.2). Keys are structural:
 * the renderer maps each resource onto exact TanStack query keys, never onto
 * wildcard prefixes that would fan a single event into every cached query.
 */
export type DirtyReason = 'ordinary' | 'priority';

export type DirtyResource =
  | { kind: 'session-list' }
  | { kind: 'session-detail'; sessionId: string }
  /** Legacy envelopes without a sessionId: one coalesced prefix refresh. */
  | { kind: 'sessions-all' }
  | { kind: 'runs' }
  | { kind: 'attention' };
