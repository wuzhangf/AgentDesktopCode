import type { JsonObject } from './context.js';
import type { ConnectionRowLite, LocalTransport } from './local-transport.js';
import { fail, isRecord } from './protocol.js';

const PREPARE_TIMEOUT_MS = 5_000;
const RESERVATION_MS = 30_000;
const WORKER_RESERVATION = '/update-reservation';

type Transport = Pick<LocalTransport, 'workerLocalRows' | 'raw'>;
type Worker = { connectionId: string; storeId: string; bootId: string };
type Reservation = { operationId: string; workers: Worker[]; expiresAt: number; checking: boolean };

/** Freezes gateway/Worker intake while an owner coordinates an installation. */
export class UpdatePreparation {
  private inFlight = 0;
  private reservation: Reservation | undefined;

  constructor(
    private readonly bootId: string,
    private readonly transport: Transport,
    private readonly hasPendingApproval: () => boolean,
  ) {}

  private current(): Reservation | undefined {
    if (this.reservation && !this.reservation.checking && this.reservation.expiresAt <= Date.now()) {
      this.reservation = undefined;
    }
    return this.reservation;
  }

  get preparing(): boolean { return this.current() !== undefined; }

  admit(): () => void {
    if (this.preparing) fail('UPDATE_IN_PROGRESS', 503);
    this.inFlight++;
    return () => { this.inFlight--; };
  }

  status(): JsonObject {
    const reservation = this.current();
    if (!reservation) return { state: 'idle', bootId: this.bootId };
    if (reservation.checking) return { state: 'checking', bootId: this.bootId };
    return { state: 'held', bootId: this.bootId, operationId: reservation.operationId,
      expiresAt: reservation.expiresAt, workerCount: reservation.workers.length };
  }

  async prepare(operationId: string): Promise<JsonObject> {
    const current = this.checkedOwner(operationId);
    const busyReason = this.inFlight ? 'GATEWAY_ACTIVITY' : this.hasPendingApproval() ? 'PENDING_APPROVAL' : undefined;
    if (busyReason) {
      if (current) await this.clear(current);
      return this.busy(busyReason);
    }
    const reservation: Reservation = current ?? { operationId, workers: [], expiresAt: 0, checking: true };
    this.reservation = reservation;
    reservation.checking = true;
    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    try {
      const rows = this.transport.workerLocalRows();
      const results = await Promise.allSettled(rows.map(async row => {
        const worker = await this.identity(row, deadline);
        // Track even a missing response. A successful request whose reply was
        // lost can reserve the Worker and still needs an explicit release.
        if (!reservation.workers.some(item => item.connectionId === worker.connectionId &&
            item.storeId === worker.storeId && item.bootId === worker.bootId)) {
          reservation.workers.push(worker);
        }
        const reply = await this.transport.raw(row.connectionId, 'POST', WORKER_RESERVATION,
          { operationId }, undefined, worker.storeId, deadline);
        if (reply.status !== 200 || !isRecord(reply.data) ||
            reply.data.schemaVersion !== 'worker-update-reservation/1' ||
            reply.data.storeId !== worker.storeId || reply.data.bootId !== worker.bootId ||
            reply.data.operationId !== operationId) {
          throw new Error('WORKER_RESERVATION_UNCONFIRMED');
        }
        if (reply.data.state === 'busy') return null;
        const expiresAt = reply.data.expiresAt;
        if (reply.data.state !== 'held' || typeof expiresAt !== 'number' ||
            !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
          throw new Error('WORKER_RESERVATION_UNCONFIRMED');
        }
        const again = await this.identity(row, deadline);
        if (again.storeId !== worker.storeId || again.bootId !== worker.bootId) {
          throw new Error('WORKER_RESTARTED');
        }
        return expiresAt;
      }));
      if (results.some(result => result.status === 'rejected') ||
          this.workerSet(rows) !== this.workerSet(this.transport.workerLocalRows())) {
        return this.busy('WORKER_UNCONFIRMED');
      }
      if (results.some(result => result.status === 'fulfilled' && result.value === null)) {
        return this.busy('WORKER_ACTIVITY');
      }
      reservation.expiresAt = Math.min(Date.now() + RESERVATION_MS, ...results.flatMap(result =>
        result.status === 'fulfilled' && result.value !== null ? [result.value] : []));
      if (reservation.expiresAt <= Date.now()) return this.busy('WORKER_UNCONFIRMED');
      reservation.checking = false;
      return this.status();
    } finally {
      if (reservation.checking) await this.clear(reservation);
    }
  }

  async release(operationId: string): Promise<JsonObject> {
    const reservation = this.checkedOwner(operationId);
    if (reservation) await this.clear(reservation);
    return this.status();
  }

  private checkedOwner(operationId: string): Reservation | undefined {
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
      fail('INVALID_UPDATE_OPERATION', 400);
    }
    const current = this.current();
    if (current && (current.checking || current.operationId !== operationId)) fail('UPDATE_RESERVED', 409);
    return current;
  }

  private async identity(row: ConnectionRowLite, deadline: number): Promise<Worker> {
    const reply = await this.transport.raw(row.connectionId, 'GET', '/identity',
      undefined, undefined, undefined, deadline);
    if (reply.status !== 200 || !isRecord(reply.data) ||
        typeof reply.data.storeId !== 'string' || !reply.data.storeId ||
        typeof reply.data.bootId !== 'string' || !reply.data.bootId) throw new Error('WORKER_IDENTITY_UNAVAILABLE');
    return { connectionId: row.connectionId, storeId: reply.data.storeId, bootId: reply.data.bootId };
  }

  private workerSet(rows: ConnectionRowLite[]): string {
    return JSON.stringify(rows.map(row => [row.connectionId, row.baseUrl]).sort());
  }

  private async clear(reservation: Reservation): Promise<void> {
    reservation.checking = true;
    const deadline = Date.now() + PREPARE_TIMEOUT_MS;
    await Promise.allSettled(reservation.workers.map(worker => this.transport.raw(worker.connectionId,
      'POST', WORKER_RESERVATION + '/release', { operationId: reservation.operationId },
      undefined, worker.storeId, deadline)));
    if (this.reservation === reservation) this.reservation = undefined;
  }

  private busy(reason: string): JsonObject { return { state: 'busy', bootId: this.bootId, reason }; }
}
