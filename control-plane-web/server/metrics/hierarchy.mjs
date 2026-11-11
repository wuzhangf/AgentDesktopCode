// Run hierarchy validation (§4.1.6, §12.7): parent links are *unverified*
// until they pass same-scope/parent-exists/root-consistency/cycle checks.
import { RELATION_STATE } from '../../shared/contracts/enums.mjs';

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;

/**
 * runs: rows of obs_run joined with entity (need run_id, parent_run_id,
 * root_run_id, scope_id). Returns Map(runId → {relationState, anomalies[]}).
 */
export function validateRunRelations(runs) {
  const byId = new Map(runs.map((r) => [r.run_id, r]));
  const result = new Map();
  for (const r of runs) {
    const anomalies = [];
    let state = RELATION_STATE.VERIFIED;
    const parent = r.parent_run_id ? byId.get(r.parent_run_id) : null;
    if (r.parent_run_id && !parent) {
      anomalies.push('MISSING_PARENT');
      state = RELATION_STATE.MISSING_PARENT;
    }
    if (r.parent_run_id && r.root_run_id === r.run_id) {
      anomalies.push('SELF_ROOT_WITH_PARENT');
      if (state === RELATION_STATE.VERIFIED) state = RELATION_STATE.SELF_ROOT_WITH_PARENT;
    }
    if (parent && parent.root_run_id !== r.root_run_id) {
      anomalies.push('ROOT_MISMATCH');
      if (state === RELATION_STATE.VERIFIED) state = RELATION_STATE.ROOT_MISMATCH;
    }
    result.set(r.run_id, { relationState: anomalies.length ? state : RELATION_STATE.VERIFIED, anomalies });
  }
  // Cycle detection on raw parent edges.
  for (const r of runs) {
    const seen = new Set([r.run_id]);
    let cur = r;
    let hops = 0;
    while (cur?.parent_run_id && hops <= MAX_DEPTH) {
      const p = byId.get(cur.parent_run_id);
      if (!p) break;
      if (seen.has(p.run_id)) {
        result.get(r.run_id).anomalies.push('CYCLE');
        result.get(r.run_id).relationState = RELATION_STATE.CYCLE;
        break;
      }
      seen.add(p.run_id);
      cur = p;
      hops += 1;
    }
  }
  return result;
}

/**
 * Verified descendants of `runId` following only clean parent edges
 * (no missing parent, no root mismatch, no self-root-with-parent, no cycle).
 * Delegation edges are handled separately by callers.
 */
export function verifiedDescendants(runId, runs, relationMap) {
  const childrenOf = new Map();
  for (const r of runs) {
    if (!r.parent_run_id) continue;
    const rel = relationMap.get(r.run_id);
    if (!rel || rel.anomalies.length > 0) continue;
    if (!childrenOf.has(r.parent_run_id)) childrenOf.set(r.parent_run_id, []);
    childrenOf.get(r.parent_run_id).push(r.run_id);
  }
  const out = [];
  const visited = new Set([runId]);
  const queue = [[runId, 0]];
  while (queue.length) {
    const [id, depth] = queue.shift();
    if (depth >= MAX_DEPTH || out.length >= MAX_NODES) break;
    for (const child of childrenOf.get(id) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      out.push(child);
      queue.push([child, depth + 1]);
    }
  }
  return out;
}
