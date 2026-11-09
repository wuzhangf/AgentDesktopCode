// Keyset pagination cursors (§11.4): base64url JSON carrying sourceEpoch,
// scope, filter hash and the last row's sort keys. Never concatenated into SQL.
import { createHash } from 'node:crypto';
import { badRequest, conflict } from './errors.mjs';

export function filterHash(obj) {
  const stable = JSON.stringify(obj, Object.keys(obj).sort());
  return createHash('sha1').update(stable).digest('base64url').slice(0, 12);
}

export function encodeCursor({ sourceEpoch, scopeId, filterHash: fh, sortValues, entityId }) {
  return Buffer.from(JSON.stringify({
    v: 1, e: sourceEpoch, s: scopeId, f: fh, k: sortValues, id: entityId,
  })).toString('base64url');
}

export function decodeCursor(raw, { sourceEpoch, scopeId, filterHash: fh }) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
  } catch {
    badRequest('invalid cursor');
  }
  if (parsed?.v !== 1 || !Array.isArray(parsed.k) || typeof parsed.id !== 'string') {
    badRequest('invalid cursor');
  }
  if (parsed.e !== sourceEpoch) conflict('source epoch changed; restart pagination');
  if (parsed.s !== scopeId || parsed.f !== fh) badRequest('cursor does not match current filters');
  return { sortValues: parsed.k, entityId: parsed.id };
}
