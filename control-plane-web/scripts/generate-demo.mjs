// Demo DB generator (§10.5 DEMO mode): copies the obs_* schema from the
// bundled snapshot and synthesizes a plausible 7-day dataset — runs, steps,
// attempts, usage (partly unknown), tools, commands, a delegation chain,
// plan revisions, context snapshots/transforms, costs, and a few
// registration issues. Deterministic via seeded RNG.
// Usage: node scripts/generate-demo.mjs
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const SCHEMA_DB = resolve(appRoot, 'data/observations.db');
const OUT = resolve(appRoot, 'demo-data/agent-operations-demo.db');

// --- seeded RNG (mulberry32) ---
let seed = 0x5eed;
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const rint = (lo, hi) => Math.floor(lo + rnd() * (hi - lo + 1));
const id = (p) => `demo-${p}-${((counters[p] = (counters[p] ?? 0) + 1)).toString(36).padStart(4, '0')}`;
const counters = {};

const SCOPE = 'local';
const SRC = 'demo-source-1';
const NOW = Date.now();
const DAY = 86_400_000;

if (!existsSync(SCHEMA_DB)) {
  console.error(`schema donor not found: ${SCHEMA_DB}`);
  process.exit(1);
}
const donor = new DatabaseSync(SCHEMA_DB, { readOnly: true });
const ddl = donor.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name LIKE 'obs_%' ORDER BY name").all().map((r) => r.sql);
donor.close();

mkdirSync(dirname(OUT), { recursive: true });
if (existsSync(OUT)) rmSync(OUT);
const db = new DatabaseSync(OUT);
db.exec('PRAGMA journal_mode=DELETE');
db.exec('BEGIN');
for (const sql of ddl) db.exec(sql);
db.prepare('INSERT INTO obs_schema_migration (version, checksum, applied_at) VALUES (?,?,?)')
  .run(1, 'demo', NOW);

const entities = [];
const events = [];
const issues = [];
const usageRows = [];
const insertEntity = db.prepare(`INSERT INTO obs_entity
  (scope_id, entity_id, schema_version, entity_kind, owner_source_id, owner_generation,
   root_run_id, run_id, parent_entity_id, current_revision, lifecycle, outcome,
   native_status, effect_state, registered_at, started_at, ended_at, duration_ms,
   timing_quality, reason_code, coverage, last_event_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insertEvent = db.prepare(`INSERT INTO obs_event
  (scope_id, event_id, schema_version, entity_id, entity_kind, entity_revision,
   event_type, source_instance_id, owner_generation, occurred_at, recorded_at,
   payload_version, payload_hash, payload_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Register entity + lifecycle events. Returns entity_id. */
function ent({ kind, id: eid, runId = null, rootRunId = null, parent = null, registered, started = null, ended = null, outcome = null, lifecycle = null, durationMs = null, native = null, coverage = 'UNKNOWN', timing = 'MONOTONIC' }) {
  const lc = lifecycle ?? (ended != null ? 'TERMINAL' : started != null ? 'STARTED' : 'REGISTERED');
  const evs = [{ type: 'REGISTERED', at: registered }];
  if (started != null) evs.push({ type: 'STARTED', at: started });
  if (lc === 'TERMINAL' && ended != null) evs.push({ type: 'TERMINAL', at: ended });
  if (lc === 'OUTCOME_UNKNOWN') evs.push({ type: 'OUTCOME_UNKNOWN', at: ended ?? registered });
  const lastEventId = `${eid}-ev${evs.length}`;
  insertEntity.run(SCOPE, eid, 1, kind, SRC, 1, rootRunId, runId, parent, evs.length,
    lc, outcome, native, 'NONE', registered, started, ended, durationMs, timing, null, coverage, lastEventId);
  evs.forEach((e, i) => {
    insertEvent.run(SCOPE, `${eid}-ev${i + 1}`, 1, eid, kind, i + 1, e.type, SRC, 1,
      e.at, e.at + rint(5, 900), 1, hash(`${eid}:${i}`), JSON.stringify({ demo: true, event: e.type }));
  });
  entities.push(eid);
  return eid;
}

// --- sources ---
db.prepare('INSERT INTO obs_source (scope_id, source_instance_id, schema_version, boot_at, heartbeat_at, stopped_at, host_ref, build_revision, capabilities_json) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(SCOPE, SRC, 1, NOW - 8 * DAY, NOW - 60_000, null, 'demo-host', 'demo-r1', JSON.stringify({ usage: 'YES', reasoning: 'PARTIAL' }));

const insTask = db.prepare('INSERT INTO obs_task (scope_id, task_id, schema_version, external_task_id, session_id, task_kind, workspace_ref) VALUES (?,?,?,?,?,?,?)');
const insRun = db.prepare('INSERT INTO obs_run (scope_id, run_id, schema_version, task_id, session_id, business_run_id, product_run_id, parent_run_id, root_run_id, run_kind, product_name, product_version, config_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insSeg = db.prepare('INSERT INTO obs_run_segment (scope_id, segment_id, schema_version, run_id, segment_no, segment_end_reason) VALUES (?,?,?,?,?,?)');
const insStep = db.prepare('INSERT INTO obs_step (scope_id, step_id, schema_version, run_id, segment_id, plan_revision_id, logical_step_key, step_kind, ordinal) VALUES (?,?,?,?,?,?,?,?,?)');
const insSatt = db.prepare('INSERT INTO obs_step_attempt (scope_id, step_attempt_id, schema_version, step_id, segment_id, attempt_no) VALUES (?,?,?,?,?,?)');
const insCall = db.prepare('INSERT INTO obs_model_call (scope_id, call_id, schema_version, run_id, segment_id, step_attempt_id, purpose, requested_model, context_id, validation_outcome) VALUES (?,?,?,?,?,?,?,?,?,?)');
const insAtt = db.prepare(`INSERT INTO obs_model_attempt (scope_id, attempt_id, schema_version, call_id, product_attempt_no, route_attempt_no, transport_attempt_no, visibility, dispatch_state, provider_id, router_id, requested_model, resolved_model, response_model, streaming, http_status, transport_outcome, first_response_ms, first_answer_delta_ms, first_reasoning_delta_ms, backoff_before_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insUsage = db.prepare(`INSERT INTO obs_model_usage (scope_id, attempt_id, schema_version, usage_revision, input_tokens, uncached_input_tokens, cache_read_input_tokens, output_tokens, reasoning_tokens, total_tokens, input_coverage, reasoning_relation, total_source, measurement_source, reported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insTool = db.prepare(`INSERT INTO obs_tool_call (scope_id, tool_call_id, schema_version, run_id, segment_id, step_attempt_id, origin_model_call_id, requested_tool_name, canonical_tool_name, execution_attempt_no, arguments_bytes, result_bytes, failure_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insCmd = db.prepare(`INSERT INTO obs_command (scope_id, command_id, schema_version, run_id, segment_id, tool_call_id, parent_command_id, origin_kind, executable_family, subcommand_key, exit_code, stdout_bytes, stderr_bytes, failure_class) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insDlg = db.prepare(`INSERT INTO obs_delegation (scope_id, delegation_id, schema_version, parent_run_id, child_run_id, role, requested_at, accepted_at, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
const insPlan = db.prepare(`INSERT INTO obs_plan_revision (scope_id, plan_revision_id, schema_version, run_id, plan_id, revision_no, change_reason, approval_state) VALUES (?,?,?,?,?,?,?,?)`);
const insCtx = db.prepare(`INSERT INTO obs_context_snapshot (scope_id, context_id, schema_version, call_id, request_revision, message_count, tool_schema_count, input_tokens_estimated, estimate_quality, window_tokens, usable_input_tokens, largest_message_utf16_units, capture_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insComp = db.prepare(`INSERT INTO obs_context_component (scope_id, context_id, component_key, schema_version, component_kind, measurement_basis, unit, measured_value, quality) VALUES (?,?,?,?,?,?,?,?,?)`);
const insTrans = db.prepare(`INSERT INTO obs_context_transform (scope_id, transform_id, schema_version, run_id, segment_id, step_attempt_id, before_context_id, after_context_id, transform_kind, reason_code, before_estimate, after_estimate, removed_messages) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const insReas = db.prepare(`INSERT INTO obs_reasoning_output (scope_id, attempt_id, schema_version, integration_state, output_mode, status, block_count, observed_text_bytes, capture_state) VALUES (?,?,?,?,?,?,?,?,?)`);
const insCost = db.prepare(`INSERT INTO obs_cost_observation (scope_id, cost_id, schema_version, attempt_id, category, source, authority_key, revision, amount_decimal, currency, completeness, observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
const insIssue = db.prepare(`INSERT INTO obs_registration_issue (scope_id, issue_id, schema_version, entity_id, issue_code, severity, first_seen_at, last_seen_at, occurrence_count, safe_detail) VALUES (?,?,?,?,?,?,?,?,?,?)`);

const MODELS = ['demo-coder-a', 'demo-chat-b', 'demo-reasoner-c'];
const TOOLS = ['workspace_search', 'workspace_read', 'workspace_list', 'workspace_batch_read', 'shell_exec', 'complete', 'delegate_readonly_research'];
const KINDS = ['CODE', 'CODE', 'CODE', 'CHAT'];

function makeRun({ taskId, parentRunId = null, t0, kind, index }) {
  const runId = id('run');
  const rootRunId = parentRunId ? parentRunId : runId;
  const dur = rint(20_000, 480_000);
  const started = t0 + rint(500, 5_000);
  const failed = rnd() < 0.16;
  const timedOut = !failed && rnd() < 0.06;
  const unclosed = !failed && !timedOut && rnd() < 0.08;
  const ended = unclosed ? null : started + dur;
  const outcome = unclosed ? null : failed ? 'FAILED' : timedOut ? 'TIMED_OUT' : 'SUCCEEDED';
  ent({ kind: 'RUN', id: runId, runId, rootRunId, registered: t0, started, ended, outcome, durationMs: ended ? dur : null });
  insRun.run(SCOPE, runId, 1, taskId, `demo-sess-${index % 4}`, null, null, parentRunId, rootRunId, kind, 'BusinessAgent', '0.9.4', `cfg-${1 + (index % 3)}`);

  const segId = id('seg');
  ent({ kind: 'RUN_SEGMENT', id: segId, runId, rootRunId, parent: runId, registered: t0, started, ended, outcome, durationMs: ended ? dur : null });
  insSeg.run(SCOPE, segId, 1, runId, 0, ended ? 'NATURAL_END' : null);

  const stepCount = rint(2, 6);
  let cursor = started;
  for (let si = 0; si < stepCount; si++) {
    const stepId = id('step');
    const s0 = cursor;
    const s1 = s0 + rint(6_000, 90_000);
    const stepOutcome = ended == null ? null : (failed && si === stepCount - 1 ? 'FAILED' : 'SUCCEEDED');
    ent({ kind: 'STEP', id: stepId, runId, rootRunId, parent: segId, registered: s0 - 40, started: s0, ended: ended ? s1 : null, outcome: stepOutcome, durationMs: ended ? s1 - s0 : null });
    insStep.run(SCOPE, stepId, 1, runId, segId, null, `k${si}`, pick(['THINK', 'ACT', 'OBSERVE']), si);

    const sattId = id('satt');
    ent({ kind: 'STEP_ATTEMPT', id: sattId, runId, rootRunId, parent: stepId, registered: s0 - 30, started: s0, ended: ended ? s1 : null, outcome: stepOutcome, durationMs: ended ? s1 - s0 : null });
    insSatt.run(SCOPE, sattId, 1, stepId, segId, 0);

    // logical model call + transport attempts (some retried)
    const callId = id('call');
    const cStart = s0 + rint(100, 1500);
    const nAtt = rnd() < 0.22 ? 2 : 1;
    const cEnd = ended ? cStart + rint(3_000, 60_000) : null;
    ent({ kind: 'MODEL_CALL', id: callId, runId, rootRunId, parent: sattId, registered: cStart - 60, started: cStart, ended: cEnd, outcome: stepOutcome, durationMs: cEnd ? cEnd - cStart : null });
    insCall.run(SCOPE, callId, 1, runId, segId, sattId, pick(['ANSWER', 'PLAN', 'TOOL_DECIDE']), pick(MODELS), null, ended ? 'PASSED' : null);

    for (let ai = 1; ai <= nAtt; ai++) {
      const attId = id('att');
      const aStart = cStart + (ai - 1) * rint(2_000, 8_000);
      const aEnd = cEnd ? Math.max(aStart + 50, Math.min(cEnd, aStart + rint(2_000, 40_000))) : null;
      const attOutcome = aEnd == null ? null : (ai < nAtt ? 'FAILED' : stepOutcome);
      ent({
        kind: 'MODEL_ATTEMPT', id: attId, runId, rootRunId, parent: callId,
        registered: aStart - 30, started: aStart, ended: aEnd, outcome: attOutcome,
        durationMs: aEnd ? aEnd - aStart : null, native: attOutcome === 'FAILED' ? 'FAILED' : null,
      });
      const model = pick(MODELS);
      insAtt.run(SCOPE, attId, 1, callId, ai, ai, ai, 'TRANSPORT_ATTEMPT', 'ATTEMPTED',
        'demo-provider', 'router-a', model, model, model, 1,
        aEnd ? (attOutcome === 'FAILED' ? 503 : 200) : null,
        aEnd ? (attOutcome === 'FAILED' ? 'FAILED' : 'SUCCEEDED') : null,
        rint(200, 2400), rint(400, 3200), rint(300, 1500), ai > 1 ? rint(800, 4000) : null);
      // usage: ~75% reported, rest NULL (unknown ≠ 0)
      if (rnd() < 0.75) {
        const inp = rint(800, 9000), out = rint(200, 4000), rea = rnd() < 0.5 ? rint(100, 1500) : null;
        insUsage.run(SCOPE, attId, 1, 1, inp, inp, rnd() < 0.3 ? rint(0, inp) : null, out, rea,
          inp + out + (rea ?? 0), 'COMPLETE', rea != null ? 'SEPARATE' : 'UNKNOWN', 'PROVIDER', 'PROVIDER', aEnd);
      } else {
        insUsage.run(SCOPE, attId, 1, 1, null, null, null, null, null, null, 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', aEnd);
        usageRows.push(attId);
      }
      if (rnd() < 0.4) {
        insReas.run(SCOPE, attId, 1, 'INTEGRATED', 'TEXT', 'OK', rint(1, 4), rint(500, 8000), 'AVAILABLE');
      }
      if (rnd() < 0.5) {
        const costId = id('cost');
        ent({ kind: 'COST_OBSERVATION', id: costId, runId, rootRunId, parent: callId, registered: aEnd ?? aStart });
        insCost.run(SCOPE, costId, 1, attId, 'MODEL_TOKENS', 'PROVIDER_REPORTED', `att:${attId}`, 1,
          (rint(1, 900) / 10000).toFixed(6), 'USD', 'COMPLETE', aEnd ?? aStart);
      }
    }

    // tools + commands
    const nTools = rint(0, 3);
    for (let ti = 0; ti < nTools; ti++) {
      const toolId = id('tool');
      const tt0 = s0 + rint(200, 3000);
      const tt1 = ended ? tt0 + rint(200, 12_000) : null;
      const toolFailed = ended && rnd() < 0.1;
      ent({ kind: 'TOOL_CALL', id: toolId, runId, rootRunId, parent: sattId, registered: tt0 - 20, started: tt0, ended: tt1, outcome: tt1 == null ? null : toolFailed ? 'FAILED' : 'SUCCEEDED', durationMs: tt1 ? tt1 - tt0 : null });
      const tool = pick(TOOLS);
      insTool.run(SCOPE, toolId, 1, runId, segId, sattId, callId, tool, tool, 1, rint(60, 4000), rint(100, 60000), toolFailed ? 'EXECUTION' : null);
      if (tool === 'shell_exec' && rnd() < 0.8) {
        const cmdId = id('cmd');
        const c0 = tt0 + 50, c1 = tt1 ? Math.max(c0 + 100, tt0 + rint(200, Math.max(300, tt1 - tt0))) : null;
        ent({ kind: 'COMMAND', id: cmdId, runId, rootRunId, parent: toolId, registered: c0 - 10, started: c0, ended: c1, outcome: c1 == null ? null : toolFailed ? 'FAILED' : 'SUCCEEDED', durationMs: c1 ? c1 - c0 : null });
        insCmd.run(SCOPE, cmdId, 1, runId, segId, toolId, null, 'AGENT_TOOL', 'pnpm', pick(['test', 'build', 'lint']), toolFailed ? 1 : 0, rint(200, 30000), toolFailed ? rint(200, 4000) : 0, toolFailed ? 'EXIT_NONZERO' : null);
      }
    }

    // context snapshot on some calls
    if (rnd() < 0.5) {
      const ctxId = id('ctx');
      ent({ kind: 'CONTEXT_SNAPSHOT', id: ctxId, runId, rootRunId, parent: callId, registered: cStart - 50, coverage: 'UNKNOWN' });
      const usable = 128_000;
      const est = rint(4_000, 120_000);
      insCtx.run(SCOPE, ctxId, 1, callId, 0, rint(8, 60), rint(0, 12), est, 'ESTIMATED', 160_000, usable, rint(200, 9000), 'AVAILABLE');
      insComp.run(SCOPE, ctxId, 'system', 1, 'SYSTEM_PROMPT', 'COUNTED', 'tokens', rint(400, 2000), 'KNOWN');
      insComp.run(SCOPE, ctxId, 'history', 1, 'HISTORY', 'ESTIMATED', 'tokens', Math.max(0, est - 3000), 'ESTIMATED');
      if (est / usable > 0.85) {
        const trId = id('tr');
        ent({ kind: 'CONTEXT_TRANSFORM', id: trId, runId, rootRunId, parent: stepId, registered: cStart - 40 });
        insTrans.run(SCOPE, trId, 1, runId, segId, sattId, ctxId, null, 'TRUNCATE_HISTORY', 'BUDGET_PRESSURE', est, Math.round(est * 0.6), rint(2, 10));
      }
      // link call → context
      db.prepare('UPDATE obs_model_call SET context_id=? WHERE scope_id=? AND call_id=?').run(ctxId, SCOPE, callId);
    }
    cursor = s1 + rint(200, 2000);
  }
  return { runId, started, ended, outcome };
}

// --- generate ---
let runIndex = 0;
const runSummaries = [];
for (let day = 6; day >= 0; day--) {
  const dayStart = NOW - day * DAY;
  const n = day === 0 ? 2 : rint(1, 4);
  for (let i = 0; i < n; i++) {
    runIndex += 1;
    const taskId = rnd() < 0.7 ? id('task') : null;
    if (taskId) {
      ent({ kind: 'TASK', id: taskId, registered: dayStart + rint(0, 4_000_000), started: dayStart + rint(4_100_000, 8_000_000), ended: dayStart + rint(8_100_000, 20_000_000), outcome: 'SUCCEEDED' });
      insTask.run(SCOPE, taskId, 1, `ext-${runIndex}`, `demo-sess-${runIndex % 4}`, pick(['IMPLEMENT', 'REVIEW', 'RESEARCH']), 'demo-workspace');
    }
    const t0 = dayStart + rint(1_000_000, 20 * 3_600_000);
    runSummaries.push(makeRun({ taskId, t0, kind: pick(KINDS), index: runIndex }));
  }
}

// one delegation chain: parent run → child run
{
  runIndex += 1;
  const p = makeRun({ taskId: null, t0: NOW - 2 * DAY + 3_600_000, kind: 'CODE', index: runIndex });
  const c = makeRun({ taskId: null, parentRunId: p.runId, t0: NOW - 2 * DAY + 4_000_000, kind: 'CODE', index: runIndex + 1 });
  const dlgId = id('dlg');
  ent({ kind: 'DELEGATION', id: dlgId, runId: p.runId, rootRunId: p.runId, parent: p.runId, registered: c.started - 30_000, started: c.started - 20_000, ended: c.ended, outcome: c.outcome });
  insDlg.run(SCOPE, dlgId, 1, p.runId, c.runId, 'readonly-research', c.started - 30_000, c.started - 25_000, c.started, c.ended);
  db.prepare('UPDATE obs_run SET root_run_id=? WHERE scope_id=? AND run_id=?').run(p.runId, SCOPE, c.runId);
  db.prepare("UPDATE obs_entity SET root_run_id=? WHERE scope_id=? AND run_id=?").run(p.runId, SCOPE, c.runId);
}

// plan revisions on first run
{
  const planId = id('plan');
  for (let r = 0; r < 3; r++) {
    const prId = id('prev');
    ent({ kind: 'PLAN_REVISION', id: prId, runId: runSummaries[0].runId, rootRunId: runSummaries[0].runId, registered: NOW - 5 * DAY + r * 120_000 });
    insPlan.run(SCOPE, prId, 1, runSummaries[0].runId, planId, r, r === 0 ? null : pick(['REPLAN', 'STEP_ADJUST']), pick(['APPROVED', 'AUTO']));
  }
}

// a few registration issues
insIssue.run(SCOPE, id('issue'), 1, entities[3], 'EVENT_HASH_CONFLICT', 'WARN', NOW - 3 * DAY, NOW - 2 * DAY, 2, '重复事件哈希，保留先见记录');
insIssue.run(SCOPE, id('issue'), 1, null, 'SQLITE_UNAVAILABLE', 'ERROR', NOW - 6 * DAY, NOW - 6 * DAY, 4, '短暂不可用后恢复');
insIssue.run(SCOPE, id('issue'), 1, entities[7], 'SEQUENCE_GAP', 'INFO', NOW - DAY, NOW - DAY, 1, '可见序列跳号');

db.exec('COMMIT');
const counts = db.prepare("SELECT entity_kind, COUNT(*) n FROM obs_entity GROUP BY entity_kind").all();
db.close();
console.log(`demo db written: ${OUT}`);
for (const c of counts) console.log(`  ${c.entity_kind}: ${c.n}`);
