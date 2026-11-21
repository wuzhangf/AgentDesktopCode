import { Temporal } from '@js-temporal/polyfill';
import { exact, fail, GatewayError, hash, id, isRecord, permitsLaunchTarget, text, type LaunchScope } from './protocol.js';
import type { GatewayStoreView } from './context.js';
import type { Devices } from './devices.js';
import type { LocalResult, LocalTaskAccess } from './local-tasks.js';
import type { UpdatePreparation } from './update-preparation.js';

type Json = Record<string, unknown>;
type Schedule = { kind: 'interval'; everySeconds: number }
  | { kind: 'daily'; timeOfDay: string } | { kind: 'weekly'; timeOfDay: string; dayOfWeek: number };
type Configuration = {
  target: LaunchScope;
  instruction: string;
  schedule: Schedule;
  timezone: string;
  dstPolicy: 'fire' | 'skip';
  offlinePolicy: 'queue' | 'skip';
  catchUpSeconds: number;
};
type PhoneBinding = { deviceId: string; grantRevision: number };
type Rule = Configuration & {
  ruleId: string;
  requestDigest: string;
  owner: 'local';
  revision: number;
  paused: boolean;
  removed: boolean;
  nextFire: number;
  sequence: number;
  phone?: PhoneBinding;
};
type Occurrence = {
  id: string;
  ruleId: string;
  sequence: number;
  fireAt: number;
  validUntil: number;
  revision: number;
  target: LaunchScope;
  instruction: string;
  requestKey: string;
  phone?: PhoneBinding;
  state: 'pending' | 'submitting' | 'accepted' | 'succeeded' | 'failed' | 'cancelled'
    | 'skipped' | 'missed' | 'rejected';
  taskId?: string;
  sourceState?: string;
  code?: string;
};

const rules = 'local-schedule-rules';
const active = 'local-schedule-active';
// Previous Link builds only understand owner rules. Keep paired rules and
// dispatch records invisible to those schedulers if an update rolls back.
const pairedRules = 'local-schedule-phone-rules';
const pairedActive = 'local-schedule-phone-active';
const activeKind = (occurrence: Occurrence) => occurrence.phone ? pairedActive : active;
const history = (ruleId: string) => `local-schedule-history:${ruleId}`;
const live = new Set<Occurrence['state']>(['pending', 'submitting', 'accepted']);
const intervalMillis = 5_000;
const maxRulesPerTick = 50;
const hoursAndMinutes = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const configFields = ['target', 'instruction', 'schedule', 'timezone', 'dstPolicy', 'offlinePolicy', 'catchUpSeconds'];

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_SCHEDULE', 400);
  }
  return value;
}

function configuration(value: Json, prior?: Configuration): Configuration {
  const body = { ...prior, ...value };
  const scope = exact(body.target, 'backendStoreId', 'projectId', 'engineId');
  const target = { backendStoreId: text(scope, 'backendStoreId'), projectId: text(scope, 'projectId'),
    engineId: text(scope, 'engineId') };
  [target.backendStoreId, target.projectId, target.engineId].forEach(id);
  if (target.engineId === 'macos') fail('SCHEDULE_TARGET_UNSUPPORTED', 409);
  const instruction = body.instruction;
  if (typeof instruction !== 'string' || !instruction.trim() || Buffer.byteLength(instruction) > 16_384) {
    fail('INVALID_INSTRUCTION', 400);
  }
  const timezone = text(body, 'timezone');
  if (!/^[A-Za-z]/.test(timezone)) fail('INVALID_SCHEDULE', 400);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { fail('INVALID_SCHEDULE', 400); }
  const dstPolicy = body.dstPolicy ?? 'fire';
  const offlinePolicy = body.offlinePolicy ?? 'queue';
  if ((dstPolicy !== 'fire' && dstPolicy !== 'skip') || (offlinePolicy !== 'queue' && offlinePolicy !== 'skip')) {
    fail('INVALID_SCHEDULE', 400);
  }
  const catchUpSeconds = integer(body.catchUpSeconds ?? 3600, 0, 86_400);
  const raw = body.schedule;
  if (!isRecord(raw)) fail('INVALID_SCHEDULE', 400);
  let schedule: Schedule;
  if (raw.kind === 'interval') {
    exact(raw, 'kind', 'everySeconds');
    schedule = { kind: 'interval', everySeconds: integer(raw.everySeconds, 300, 2_592_000) };
  } else {
    const timeOfDay = raw.timeOfDay;
    if (typeof timeOfDay !== 'string' || !hoursAndMinutes.test(timeOfDay)) fail('INVALID_SCHEDULE', 400);
    if (raw.kind === 'daily') {
      exact(raw, 'kind', 'timeOfDay');
      schedule = { kind: 'daily', timeOfDay };
    } else if (raw.kind === 'weekly') {
      exact(raw, 'kind', 'timeOfDay', 'dayOfWeek');
      schedule = { kind: 'weekly', timeOfDay, dayOfWeek: integer(raw.dayOfWeek, 0, 6) };
    } else fail('INVALID_SCHEDULE', 400);
  }
  return { target, instruction, schedule, timezone, dstPolicy, offlinePolicy, catchUpSeconds };
}

export function nextLocalFire(rule: Pick<Configuration, 'schedule' | 'timezone' | 'dstPolicy'>, after: number): number {
  if (rule.schedule.kind === 'interval') return after + rule.schedule.everySeconds * 1000;

  const { schedule, timezone, dstPolicy } = rule;
  const firstDay = Temporal.Instant.fromEpochMilliseconds(after).toZonedDateTimeISO(timezone).toPlainDate();
  // The compatible mapping chooses the first side of a fold and moves a gap
  // forward by the change in offset, matching the Hosted wall-clock rules.
  for (let offset = 0; offset < 16; offset++) {
    const day = firstDay.add({ days: offset });
    if (schedule.kind === 'weekly' && day.dayOfWeek - 1 !== schedule.dayOfWeek) continue;
    const wall = day.toPlainDateTime(schedule.timeOfDay);
    const candidate = wall.toZonedDateTime(timezone, { disambiguation: 'compatible' });
    if (dstPolicy === 'skip' && !candidate.toPlainDateTime().equals(wall)) continue;
    if (candidate.epochMilliseconds > after) return candidate.epochMilliseconds;
  }
  fail('INVALID_SCHEDULE', 400);
}

const compact = (target: LaunchScope): Json => ({ projectId: target.projectId, engineId: target.engineId });
const terminal = new Map<string, Occurrence['state']>([
  ['SUCCEEDED', 'succeeded'], ['FAILED', 'failed'], ['TIMED_OUT', 'failed'], ['CANCELLED', 'cancelled'],
]);

export class LocalSchedules {
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private ticking = false;
  private readonly startedAt: number;

  constructor(private readonly store: GatewayStoreView, private readonly hostId: string,
    private readonly tasks: Pick<LocalTaskAccess, 'ownerCatalog' | 'linkTargets' | 'nativeCall'>,
    private readonly updates?: UpdatePreparation, private readonly now: () => number = Date.now,
    private readonly devices?: Pick<Devices, 'activeDevice' | 'appendLaunchedTask'>) {
    this.startedAt = this.now();
  }

  start(): void {
    const repeat = (): void => {
      if (!this.stopping) this.timer = setTimeout(() => void this.tick().catch(() => {}).finally(repeat), intervalMillis);
      this.timer?.unref();
    };
    repeat();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private phoneGrant(deviceId: string, target?: LaunchScope) {
    let device;
    try { device = this.devices?.activeDevice(deviceId); }
    catch (error) {
      if (error instanceof GatewayError && error.httpStatus === 401) return undefined;
      throw error;
    }
    const grant = device?.localScheduleGrant;
    if (!device || !device.actions?.includes('LAUNCH') || grant?.deviceRevision !== device.revision
        || !grant.launchScopes.length) return undefined;
    if (target && (!permitsLaunchTarget(grant, target) || !permitsLaunchTarget(device, target))) return undefined;
    return { device, grant };
  }

  private requirePhoneGrant(deviceId: string, target?: LaunchScope) {
    const access = this.phoneGrant(deviceId, target);
    if (!access) fail('SCHEDULE_GRANT_REQUIRED', 403);
    return access.grant;
  }

  hasPhoneGrant(deviceId: string): boolean {
    return this.phoneGrant(deviceId) !== undefined;
  }

  private authorizedPhone(binding: PhoneBinding, target: LaunchScope) {
    const access = this.phoneGrant(binding.deviceId, target);
    return access?.grant.revision === binding.grantRevision ? access.device : undefined;
  }

  private canRun(rule: Rule): boolean {
    return !rule.phone || this.authorizedPhone(rule.phone, rule.target) !== undefined;
  }

  private view(rule: Rule): Json {
    const { requestDigest: _digest, nextFire, phone, ...publicRule } = rule;
    const authorizationRequired = !this.canRun(rule);
    return { ...publicRule,
      ...(phone && { deviceGrantId: phone.deviceId, authorizationRequired }),
      nextFireAt: rule.removed || authorizationRequired ? null : new Date(nextFire).toISOString() };
  }

  list(deviceId?: string): Json {
    const grant = deviceId ? this.requirePhoneGrant(deviceId) : undefined;
    const items = (grant ? this.store.list<Rule>(pairedRules) : this.allRules()).filter(rule => !rule.removed &&
      (!grant || (rule.phone?.deviceId === deviceId && permitsLaunchTarget(grant, rule.target))));
    return { schemaVersion: 'link-local-schedule-list/1',
      items: items.map(rule => this.view(rule)), ...(grant && { targets: grant.launchScopes }) };
  }

  private allRules(): Rule[] {
    return [...this.store.list<Rule>(rules), ...this.store.list<Rule>(pairedRules)];
  }

  private saveRule(rule: Rule): void {
    this.store.put(rule.phone ? pairedRules : rules, rule.ruleId, rule);
  }

  private requireRule(ruleId: string, deviceId?: string): Rule {
    id(ruleId);
    const value = this.store.get<Rule>(pairedRules, ruleId) ?? (!deviceId ? this.store.get<Rule>(rules, ruleId) : undefined);
    if (!value || (deviceId && value.phone?.deviceId !== deviceId)) fail('NOT_FOUND', 404);
    if (deviceId) this.requirePhoneGrant(deviceId, value.target);
    return value;
  }

  get(ruleId: string, deviceId?: string): Json {
    return this.view(this.requireRule(ruleId, deviceId));
  }

  occurrences(ruleId: string, deviceId?: string): Json {
    this.requireRule(ruleId, deviceId);
    const grant = deviceId ? this.requirePhoneGrant(deviceId) : undefined;
    const items = this.store.listOrdered<Occurrence>(history(ruleId), 0, 100)
      .filter(({ value }) => !grant || permitsLaunchTarget(grant, value.target))
      .map(({ value }) => {
        const { instruction: _instruction, validUntil: _validUntil, phone: _phone, fireAt, ...record } = value;
        return { ...record, fireAt: new Date(fireAt).toISOString() };
      });
    return { schemaVersion: 'link-local-schedule-occurrences/1', items };
  }

  private async requireTarget(target: LaunchScope): Promise<void> {
    const choices = this.tasks.linkTargets(await this.tasks.ownerCatalog()).targets;
    if (!Array.isArray(choices) || !choices.some(t => isRecord(t) && t.sourceKind === 'NATIVE' &&
        t.backendId === target.backendStoreId && t.projectId === target.projectId && t.engineId === target.engineId)) {
      fail('TARGET_UNAVAILABLE', 409);
    }
  }

  async create(value: Json, deviceId?: string): Promise<Json> {
    const body = exact(value, 'requestKey', ...configFields);
    const key = text(body, 'requestKey');
    id(key);
    const config = configuration(body);
    const requestDigest = hash(JSON.stringify(config));
    const keyScope = deviceId ? JSON.stringify([this.hostId, deviceId, key]) : `${this.hostId}:${key}`;
    const ruleId = `local-sched-${hash(keyScope)}`;
    const replay = (): Rule | undefined => {
      const prior = this.store.get<Rule>(deviceId ? pairedRules : rules, ruleId);
      if (prior && prior.requestDigest !== requestDigest) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
      return prior;
    };
    if (deviceId) this.requirePhoneGrant(deviceId, config.target);
    const prior = replay();
    if (prior) return this.view(prior);
    await this.requireTarget(config.target);
    return this.store.transaction(() => {
      const phone = deviceId
        ? { deviceId, grantRevision: this.requirePhoneGrant(deviceId, config.target).revision } : undefined;
      const raced = replay();
      if (raced) return this.view(raced);
      const rule: Rule = { ...config, ruleId, requestDigest, owner: 'local', revision: 1,
        paused: false, removed: false, nextFire: nextLocalFire(config, this.now()), sequence: 0, phone };
      this.saveRule(rule);
      return this.view(rule);
    });
  }

  async update(ruleId: string, value: Json, remove = false, deviceId?: string): Promise<Json> {
    const body = exact(value, 'expectedRevision', ...(!remove ? ['paused', ...configFields] : []));
    const revision = integer(body.expectedRevision, 1, Number.MAX_SAFE_INTEGER);
    const prior = this.requireRule(ruleId, deviceId);
    if (revision !== prior.revision || prior.removed) fail('REVISION_CONFLICT', 409);
    if (!remove && Object.keys(body).length === 1) fail('INVALID_SCHEDULE', 400);
    if (body.paused !== undefined && typeof body.paused !== 'boolean') fail('INVALID_SCHEDULE', 400);
    const config = configuration(body, prior);
    const targetChanged = JSON.stringify(prior.target) !== JSON.stringify(config.target);
    if (deviceId && targetChanged) this.requirePhoneGrant(deviceId, config.target);
    if (targetChanged) await this.requireTarget(config.target);
    return this.store.transaction(() => {
      const current = this.requireRule(ruleId, deviceId);
      if (current.revision !== revision || current.removed) fail('REVISION_CONFLICT', 409);
      const paused = remove || (typeof body.paused === 'boolean' ? body.paused : current.paused);
      let phone = current.phone;
      if (phone && (targetChanged || body.paused === false)) {
        const grant = this.requirePhoneGrant(phone.deviceId, config.target);
        if (body.paused === false && grant.revision !== phone.grantRevision) {
          phone = { ...phone, grantRevision: grant.revision };
        }
      }
      const recompute = ['schedule', 'timezone', 'dstPolicy'].some(field => field in body)
        || (current.paused && !paused) || phone !== current.phone;
      const fresh: Rule = { ...current, ...config, phone, paused, removed: remove,
        revision: revision + 1, nextFire: recompute ? nextLocalFire(config, this.now()) : current.nextFire };
      this.saveRule(fresh);
      return this.view(fresh);
    });
  }

  private save(occurrence: Occurrence): void {
    this.store.transaction(() => {
      this.store.putOrdered(history(occurrence.ruleId), occurrence.id, occurrence);
      if (live.has(occurrence.state)) this.store.put(activeKind(occurrence), occurrence.id, occurrence);
      else this.store.delete(activeKind(occurrence), occurrence.id);
    });
  }

  private reserve(ruleId: string): void {
    this.store.transaction(() => {
      const rule = this.requireRule(ruleId);
      const now = this.now();
      if (rule.paused || rule.removed || rule.nextFire > now || !this.canRun(rule)) return;
      const fireAt = rule.nextFire;
      const sequence = rule.sequence + 1;
      const id = `${rule.ruleId}:${sequence}`;
      // One missed record covers an expired backlog. Keep interval rules on
      // their original cadence and resume at the first eligible occurrence.
      const windowStart = now - rule.catchUpSeconds * 1000;
      let advanceFrom = fireAt;
      if (fireAt < windowStart) {
        if (rule.schedule.kind === 'interval') {
          const step = rule.schedule.everySeconds * 1000;
          advanceFrom += Math.max(0, Math.ceil((windowStart - fireAt) / step) - 1) * step;
        } else advanceFrom = Math.max(fireAt, windowStart - 1);
      }
      this.save({ id, ruleId, sequence, fireAt, validUntil: fireAt + rule.catchUpSeconds * 1000,
        revision: rule.revision, target: rule.target, instruction: rule.instruction, phone: rule.phone,
        requestKey: `local-schedule-${hash(id)}`,
        state: fireAt < windowStart ? 'missed'
          : rule.offlinePolicy === 'skip' && fireAt < this.startedAt ? 'skipped' : 'pending' });
      this.saveRule({ ...rule, sequence, nextFire: nextLocalFire(rule, advanceFrom) });
    });
  }

  private async process(row: Occurrence): Promise<void> {
    const backend = row.target.backendStoreId;
    if (row.state === 'accepted') {
      const result = await this.tasks.nativeCall(backend, 'GET', `/tasks/${row.taskId}`, null);
      if (result.status === 200 && isRecord(result.body) && result.body.taskId === row.taskId
          && typeof result.body.state === 'string' && this.store.get<Occurrence>(activeKind(row), row.id)?.taskId === row.taskId) {
        const sourceState = result.body.state;
        const state = terminal.get(sourceState) ?? 'accepted';
        if (sourceState !== row.sourceState || state !== row.state) this.save({ ...row, sourceState, state });
      }
      return;
    }

    if (row.state === 'submitting') {
      const receipt = await this.tasks.nativeCall(backend, 'GET', `/task-requests/${row.requestKey}`, null);
      if (receipt.status === 200) this.accept(row, receipt);
      return;
    }
    const canStart = (): Rule => {
      const rule = this.requireRule(row.ruleId);
      if (rule.revision !== row.revision || rule.paused || rule.removed) fail('SCHEDULE_SUPERSEDED', 409);
      if (!this.canRun(rule)) fail('SCHEDULE_GRANT_REQUIRED', 403);
      if (this.now() > row.validUntil) fail('SCHEDULE_OCCURRENCE_EXPIRED', 409);
      return rule;
    };
    let submitting = false;
    try {
      canStart();
      const selection = compact(row.target);
      const preflight = await this.tasks.nativeCall(backend, 'POST', '/task-preflights', selection);
      if (preflight.status >= 500) fail('LOCAL_SOURCE_UNAVAILABLE', 503);
      if (preflight.status !== 200 || !isRecord(preflight.body) ||
          typeof preflight.body.optionsRevision !== 'string' || !preflight.body.optionsRevision) {
        fail('SCHEDULE_TARGET_UNAVAILABLE', 409);
      }
      const submit = { ...selection, requestKey: row.requestKey, instruction: row.instruction,
        optionsRevision: preflight.body.optionsRevision };
      const begin = (): number => this.store.transaction(() => {
        if (this.stopping) fail('SCHEDULE_STOPPING', 503);
        canStart();
        const current = this.store.get<Occurrence>(activeKind(row), row.id);
        if (current?.state !== 'pending') fail('SCHEDULE_OUTCOME_UNCONFIRMED', 409);
        this.save({ ...row, state: 'submitting' });
        submitting = true;
        return this.now() + 15_000;
      });
      const result = await this.tasks.nativeCall(backend, 'POST', '/tasks', submit, row.requestKey, undefined, begin);
      if (result.status >= 200 && result.status < 300) this.accept(row, result);
      else if ([400, 403, 409, 422, 428].includes(result.status) &&
               this.store.get<Occurrence>(activeKind(row), row.id)?.state === 'submitting') {
        const code = isRecord(result.body) && typeof result.body.code === 'string' ? result.body.code : 'LOCAL_LAUNCH_REJECTED';
        this.save({ ...row, state: 'rejected', code });
      }
    } catch (error) {
      if (submitting || !(error instanceof GatewayError) || this.stopping) return;
      const { code, httpStatus } = error;
      if (code === 'SCHEDULE_SUPERSEDED' || code === 'SCHEDULE_GRANT_REQUIRED') {
        this.save({ ...row, state: 'cancelled', code });
      }
      else if (code === 'SCHEDULE_OCCURRENCE_EXPIRED') this.save({ ...row, state: 'missed', code });
      else if (httpStatus >= 500 && this.requireRule(row.ruleId).offlinePolicy === 'skip') {
        this.save({ ...row, state: 'skipped', code });
      } else if (httpStatus < 500 && code !== 'SCHEDULE_OUTCOME_UNCONFIRMED') this.save({ ...row, state: 'rejected', code });
    }
  }

  private accept(row: Occurrence, result: LocalResult): void {
    const body = result.body;
    if (this.store.get<Occurrence>(activeKind(row), row.id)?.state !== 'submitting') return;
    if (!isRecord(body) || body.requestKey !== row.requestKey || body.operation !== 'LAUNCH' ||
        body.state !== 'ACCEPTED' || typeof body.taskId !== 'string' || !/^native-[\w.-]{1,120}$/.test(body.taskId)) return;
    const accepted = isRecord(body.result) ? body.result : body;
    if (accepted.taskId === body.taskId && accepted.engineId === row.target.engineId) {
      const taskId = body.taskId;
      this.store.transaction(() => {
        const device = row.phone && this.authorizedPhone(row.phone, row.target);
        if (device) {
          const { backendStoreId, projectId, engineId } = row.target;
          try { this.devices?.appendLaunchedTask(device.id, device.revision, backendStoreId, projectId, engineId, taskId); }
          catch (error) {
            if (!(error instanceof GatewayError) || error.code !== 'SCOPE_RESOURCE_LIMIT') throw error;
          }
        }
        this.save({ ...row, state: 'accepted', taskId });
      });
    }
  }

  async tick(): Promise<void> {
    if (this.stopping || this.ticking || this.updates?.preparing) return;
    const finish = this.updates?.admit();
    this.ticking = true;
    try {
      const candidates = this.allRules()
        .filter(rule => !rule.paused && !rule.removed && rule.nextFire <= this.now() && this.canRun(rule))
        .sort((a, b) => a.nextFire - b.nextFire).slice(0, maxRulesPerTick);
      for (const rule of candidates) this.reserve(rule.ruleId);
      for (const row of [...this.store.list<Occurrence>(active), ...this.store.list<Occurrence>(pairedActive)]) {
        if (this.stopping) break;
        try { await this.process(row); } catch { /* retain the original receipt for the next poll */ }
      }
    } finally {
      this.ticking = false;
      finish?.();
    }
  }
}
