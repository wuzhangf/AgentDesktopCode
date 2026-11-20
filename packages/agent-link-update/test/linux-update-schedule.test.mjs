import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inMaintenanceWindow, scheduledUpdate } from '../../../agent-link-linux/update-schedule.mjs';

test('Linux installation windows support local times across midnight', t => {
  const root = mkdtempSync(join(tmpdir(), 'link-linux-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = join(root, 'update-policy.json');
  const at = (h, m) => new Date(2026, 10, 21, h, m);
  assert.equal(inMaintenanceWindow(root, at(12, 0)), true);
  writeFileSync(policy, '{"start":"23:30","end":"02:00"}');
  assert.equal(inMaintenanceWindow(root, at(23, 29)), false);
  assert.equal(inMaintenanceWindow(root, at(23, 30)), true);
  assert.equal(inMaintenanceWindow(root, at(1, 59)), true);
  assert.equal(inMaintenanceWindow(root, at(2, 0)), false);
  writeFileSync(policy, '{"start":"15:45","end":"17:30"}');
  assert.equal(inMaintenanceWindow(root, at(15, 45)), true);
  assert.equal(inMaintenanceWindow(root, at(17, 30)), false);
  writeFileSync(policy, '{"start":"12:00","end":"12:00"}');
  assert.throws(() => inMaintenanceWindow(root), /different start and end/);
});

test('Linux automatic checks keep jitter, back off and reopen waiting windows', t => {
  const root = mkdtempSync(join(tmpdir(), 'link-linux-schedule-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'automatic.json');
  const schedule = scheduledUpdate(root, root);
  const before = Date.now();
  const next = () => JSON.parse(readFileSync(state)).nextCheckAt;
  assert.equal(schedule.due(), false);
  assert.ok(next() >= before + 60_000 && next() <= Date.now() + 30 * 60_000);
  schedule.begin();
  assert.ok(next() >= before + 15 * 60_000 && next() <= Date.now() + 15 * 60_000);
  assert.equal(schedule.due(), false);
  schedule.finish('busy');
  assert.equal(schedule.due(), false);
  schedule.finish('waiting-window');
  assert.equal(schedule.due(), true);
  schedule.finish('committed');
  assert.equal(schedule.due(), false);
  assert.ok(next() >= before + 1410 * 60_000 && next() <= Date.now() + 1470 * 60_000);
});
