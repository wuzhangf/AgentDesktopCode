import { randomInt } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './slots.mjs';

const minute = 60_000;
const clock = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

function readJson(path) {
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size > 4096) throw new Error('Invalid update settings file');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function inMaintenanceWindow(config, now = new Date()) {
  const policy = readJson(join(config, 'update-policy.json'));
  if (policy === undefined) return true;
  if (typeof policy?.start !== 'string' || typeof policy.end !== 'string' ||
      !clock.test(policy.start) || !clock.test(policy.end) || policy.start === policy.end) {
    throw new Error('Update policy requires different start and end times in HH:mm');
  }
  const local = [now.getHours(), now.getMinutes()].map(part => String(part).padStart(2, '0')).join(':');
  return policy.start < policy.end
    ? local >= policy.start && local < policy.end
    : local >= policy.start || local < policy.end;
}

export function scheduledUpdate(updateRoot, config) {
  const path = join(updateRoot, 'automatic.json');
  function record(outcome, delay = (1440 + randomInt(-30, 31)) * minute) {
    writeAtomic(path, JSON.stringify({ outcome, nextCheckAt: Date.now() + delay }));
  }
  return {
    due() {
      const state = readJson(path);
      if (state === undefined) {
        record('scheduled', randomInt(1, 31) * minute);
        return false;
      }
      if (!Number.isSafeInteger(state?.nextCheckAt) || state.nextCheckAt < 0 ||
          typeof state.outcome !== 'string') throw new Error('Invalid automatic update state');
      return Date.now() >= state.nextCheckAt &&
        (!['waiting-window', 'busy'].includes(state.outcome) || inMaintenanceWindow(config));
    },
    begin() { record('checking', 15 * minute); },
    finish(outcome) {
      if (outcome === 'waiting-window') record(outcome, 0);
      else if (outcome === 'busy' || outcome === 'retry') record(outcome, 15 * minute);
      else record(outcome);
    },
  };
}
