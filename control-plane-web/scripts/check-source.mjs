// W0 baseline check: read-only inspection of every configured source.
// Reports schema version, table counts, NULL coverage and event bounds —
// never writes. Usage: node scripts/check-source.mjs
import { loadSourceConfig } from '../server/config/sources.mjs';
import { openReadonlyDb, inspectSchema } from '../server/db/readonly.mjs';

const config = loadSourceConfig();

function fmt(ms) {
  return ms == null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 23);
}

for (const s of config.sources) {
  console.log(`\n=== ${s.id} [${s.mode}] ===`);
  console.log(`path: ${s.path}`);
  if (!s.available) { console.log('  (missing — skipped)'); continue; }
  const db = openReadonlyDb(s.path);
  try {
    const schema = inspectSchema(db);
    console.log(`schema version: ${schema.version} · tables: ${schema.tables.size}`);
    // Older sources may lack newer tables — report 'n/a' instead of crashing.
    const q = (label, fn) => {
      try { console.log(label, fn()); } catch (err) { console.log(label, `n/a (${err.message})`); }
    };
    q('events:', () => {
      const ev = db.prepare('SELECT COUNT(*) n, MIN(recorded_at) lo, MAX(recorded_at) hi FROM obs_event').get();
      return `${ev.n} · ${fmt(ev.lo)} → ${fmt(ev.hi)}`;
    });
    for (const t of ['obs_entity','obs_task','obs_run','obs_run_segment','obs_plan_revision','obs_step','obs_step_attempt','obs_model_call','obs_model_attempt','obs_model_usage','obs_context_snapshot','obs_context_component','obs_context_transform','obs_tool_call','obs_command','obs_delegation','obs_reasoning_output','obs_reasoning_block','obs_cost_observation','obs_artifact','obs_registration_issue','obs_source']) {
      q(`  ${t}:`, () => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
    }
    q('usage completeness:', () => {
      const u = db.prepare(`SELECT COUNT(*) n, COUNT(input_tokens) i, COUNT(output_tokens) o, COUNT(reasoning_tokens) r, COUNT(total_tokens) t FROM obs_model_usage`).get();
      return `${u.n} rows · input ${u.i} · output ${u.o} · reasoning ${u.r} · total ${u.t}`;
    });
    q('ended entities:', () => {
      const dur = db.prepare(`SELECT COUNT(*) n, COUNT(duration_ms) d FROM obs_entity WHERE ended_at IS NOT NULL`).get();
      return `${dur.n} · with duration_ms: ${dur.d}`;
    });
    q('state conflicts:', () =>
      db.prepare(`SELECT COUNT(*) n FROM obs_entity WHERE (lifecycle IN ('REGISTERED','STARTED') AND outcome IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','REJECTED','SKIPPED')) OR (lifecycle='STARTED' AND native_status IN ('FAILED','ERROR','CANCELLED'))`).get().n);
    q('run relation anomalies:', () =>
      db.prepare(`SELECT COUNT(*) n FROM obs_run r LEFT JOIN obs_run p ON p.scope_id=r.scope_id AND p.run_id=r.parent_run_id WHERE r.parent_run_id IS NOT NULL AND (p.run_id IS NULL OR r.root_run_id = r.run_id OR p.root_run_id <> r.root_run_id)`).get().n);
    q('registration issues:', () => {
      const iss = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(occurrence_count),0) oc FROM obs_registration_issue`).get();
      return `${iss.n} records · ${iss.oc} cumulative occurrences`;
    });
  } finally {
    db.close();
  }
}

for (const g of config.guiSources) {
  console.log(`\n=== gui ${g.id} ===`);
  console.log(`path: ${g.path} · ${g.available ? 'available' : 'missing'}`);
}
