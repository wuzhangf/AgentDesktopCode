import { describe, expect, it } from 'vitest';
import { NotificationCoordinator } from '../../electron/main/native/notifications';

describe('notification deduplication (design §6.2/§15.2)', () => {
  it('suppresses identical content for the same key', () => {
    const coordinator = new NotificationCoordinator();
    const first = coordinator.update('run-1', { title: '任务完成', body: '3 files changed' });
    expect(first).toEqual({ show: true, replace: false });
    const again = coordinator.update('run-1', { title: '任务完成', body: '3 files changed' });
    expect(again.show).toBe(false);
  });

  it('replaces the slot when content changes', () => {
    const coordinator = new NotificationCoordinator();
    coordinator.update('run-1', { title: '运行中', body: 'phase MODEL' });
    const update = coordinator.update('run-1', { title: '运行中', body: 'phase VERIFYING' });
    expect(update).toEqual({ show: true, replace: true });
    expect(coordinator.size()).toBe(1);
  });

  it('keeps distinct keys independent', () => {
    const coordinator = new NotificationCoordinator();
    coordinator.update('run-1', { title: 'A', body: 'a' });
    coordinator.update('run-2', { title: 'B', body: 'b' });
    expect(coordinator.size()).toBe(2);
  });

  it('dismiss removes the slot so the next event shows again', () => {
    const coordinator = new NotificationCoordinator();
    coordinator.update('run-1', { title: 'A', body: 'a' });
    coordinator.dismiss('run-1');
    const decision = coordinator.update('run-1', { title: 'A', body: 'a' });
    expect(decision.show).toBe(true);
    expect(decision.replace).toBe(false);
  });
});
