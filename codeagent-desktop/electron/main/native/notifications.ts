/**
 * Notification deduplication policy (desktop design §6.2/§15.2).
 * Notifications carry task title and status only — never source, command
 * arguments, model content or secrets. The same task updates one slot
 * instead of stacking; identical content is not re-shown.
 */

export interface NotificationContent {
  title: string;
  body: string;
}

export interface NotificationDecision {
  /** whether an OS notification should be emitted at all */
  show: boolean;
  /** true when an existing notification for this key should be replaced */
  replace: boolean;
}

export class NotificationCoordinator {
  private readonly shown = new Map<string, NotificationContent>();

  update(key: string, content: NotificationContent): NotificationDecision {
    const existing = this.shown.get(key);
    if (existing && existing.title === content.title && existing.body === content.body) {
      return { show: false, replace: false };
    }
    this.shown.set(key, { title: content.title, body: content.body });
    return { show: true, replace: existing !== undefined };
  }

  dismiss(key: string): void {
    this.shown.delete(key);
  }

  size(): number {
    return this.shown.size;
  }
}
