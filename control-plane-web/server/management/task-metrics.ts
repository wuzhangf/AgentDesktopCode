import { canonicalDigest } from './canonical';
import { ReaderPool } from '../db/workerPool.mjs';
import { loadSourceConfig } from '../config/sources.mjs';
import { unknownTaskMetrics } from '../repositories/personalTask.mjs';
import type { PersonalTaskMetrics, AcsTaskLaunchFacts } from '../../../codeagent-desktop/packages/protocol/src/personal-task';

export class TaskMetricsReader {
  private pool?: ReaderPool;
  readonly binding?: { sourceId: string; scopeId: string; fingerprint: string };
  constructor(sourceId?: string, scopeId = 'local') {
    if (!sourceId) return;
    const config = loadSourceConfig();
    const source = config.sources.find((s: {id: string; mode: string; path: string}) => s.id === sourceId && s.mode === 'LIVE');
    if (!source) return;
    this.binding = { sourceId, scopeId, fingerprint: canonicalDigest({ sourceId, path: source.path, scopeId }) };
    this.pool = new ReaderPool([source], []);
  }
  async read(f?: AcsTaskLaunchFacts): Promise<PersonalTaskMetrics> {
    const unknown = (reason: string) => ({ sourceId: this.binding?.sourceId ?? null, observedAt: null, ...unknownTaskMetrics(reason) }) as PersonalTaskMetrics;
    if (!this.binding || !this.pool) return unknown('OBSERVATION_NOT_BOUND');
    if (!f?.observation || canonicalDigest(f.observation) !== canonicalDigest(this.binding)) return unknown('OBSERVATION_BINDING_CHANGED');
    if (!f.runId || !f.session || !f.acceptance?.taskId) return unknown('RUN_NOT_BOUND');
    try {
      const result = await this.pool.exec(this.binding.sourceId, 'obs.personalTaskMetrics', {
        scopeId: this.binding.scopeId, runId: f.runId, sessionId: f.session.sessionId, taskId: f.acceptance.taskId,
      });
      return { sourceId: this.binding.sourceId, observedAt: result.dataAsOf == null ? null : new Date(result.dataAsOf).toISOString(), ...result.result } as PersonalTaskMetrics;
    } catch { return unknown('OBSERVATION_UNAVAILABLE'); }
  }
  async close() { await this.pool?.destroy(); }
}
