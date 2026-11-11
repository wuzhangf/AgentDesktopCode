/**
 * src/approvals.ts — terminal-session tool approvals.
 *
 * A local agent hook (Claude Code PreToolUse, Codex, ...) asks on a loopback
 * surface whether a tool call may run; a paired phone answers through the
 * ordinary device-authorized /personal/v1 surface. The record is the source of
 * truth: the hook polls it until a decision lands or the ask expires.
 *
 * Trust shape mirrors the rest of the gateway: loopback hook traffic needs the
 * hooks token (a local credential like the owner bearer), phone traffic needs
 * an active device grant. Any active device of this host may decide — the
 * first decision wins and is recorded with the answering device id.
 *
 * States: PENDING → APPROVED | DENIED | EXPIRED | CANCELLED. Terminal states
 * never move again. A PENDING record past expiresAt reports EXPIRED lazily —
 * there is no background timer, the next read settles it.
 */
import {
  exact,
  fail,
  id,
  isRecord,
  text,
  type Device,
} from './protocol';
import type { GatewayStoreView, JsonObject, MaybePromise } from './context';

export const APPROVAL_KIND = 'approval';
const TERMINAL = new Set(['APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED']);
const DECISIONS = new Set(['APPROVED', 'DENIED', 'APPROVED_SESSION']);
const MAX_PENDING = 64;
const DEFAULT_TTL_MS = 300_000;
const MAX_TTL_MS = 600_000;
const KEEP_DECIDED_MS = 3600_000;

export interface Approval {
  approvalId: string;
  agent: string;
  toolName: string;
  toolInput?: JsonObject;
  question: string;
  options: string[];
  projectDir?: string;
  sessionRef?: string;
  state: string;
  decision?: string;
  reason?: string;
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  decidedByDeviceId?: string;
}

export type ApprovalsStoreLike = Pick<GatewayStoreView, 'get' | 'put' | 'list' | 'delete' | 'transaction'>;
export type ApprovalsAuthLike = { activeDevices(): MaybePromise<Device[]> };

export class GatewayApprovals {
  constructor(
    private readonly store: ApprovalsStoreLike,
    private readonly auth: ApprovalsAuthLike,
    private readonly now: () => number = Date.now,
  ) {}

  private get(idValue: string): Approval | undefined {
    return this.store.get<Approval>(APPROVAL_KIND, idValue);
  }

  /** Lazily settle a pending record past its expiry; returns the effective row. */
  private settle(row: Approval | undefined): Approval | undefined {
    if (row !== undefined && row.state === 'PENDING' && row.expiresAt <= this.now()) {
      row = { ...row, state: 'EXPIRED', decidedAt: this.now() };
      this.store.put(APPROVAL_KIND, row.approvalId, row);
    }
    return row;
  }

  /** Whether a paired phone exists to answer: the hook's mobile-mode check. */
  async enabled(): Promise<boolean> {
    try {
      return (await this.auth.activeDevices()).length > 0;
    } catch {
      return false;
    }
  }

  /** Hook side: create or idempotently return the pending ask. */
  submit(body: unknown): JsonObject {
    const input = exact(body, 'approvalId', 'agent', 'toolName', 'toolInput',
      'question', 'options', 'projectDir', 'sessionRef', 'ttlMillis');
    id(input.approvalId);
    const agent = text(input, 'agent');
    const toolName = text(input, 'toolName');
    const question = text(input, 'question');
    if (input.toolInput !== undefined && !isRecord(input.toolInput)) fail('INVALID_REQUEST', 400);
    const options = Array.isArray(input.options)
      ? input.options.filter((o): o is string => typeof o === 'string' && o.length > 0 && o.length <= 120).slice(0, 6)
      : [];
    const ttl = typeof input.ttlMillis === 'number' && Number.isInteger(input.ttlMillis)
      ? Math.min(MAX_TTL_MS, Math.max(5_000, input.ttlMillis))
      : DEFAULT_TTL_MS;
    return this.store.transaction(() => {
      const existing = this.settle(this.get(input.approvalId as string));
      if (existing !== undefined) return this.view(existing);
      const pending = this.store.list<Approval>(APPROVAL_KIND)
        .filter((r) => r.state === 'PENDING' && r.expiresAt > this.now());
      if (pending.length >= MAX_PENDING) fail('APPROVAL_LIMIT', 429);
      const row: Approval = {
        approvalId: input.approvalId as string,
        agent, toolName, question, options,
        ...(input.toolInput !== undefined ? { toolInput: input.toolInput as JsonObject } : {}),
        ...(typeof input.projectDir === 'string' && input.projectDir.length <= 4096
          ? { projectDir: input.projectDir } : {}),
        ...(typeof input.sessionRef === 'string' && input.sessionRef.length <= 4096
          ? { sessionRef: input.sessionRef } : {}),
        state: 'PENDING',
        createdAt: this.now(),
        expiresAt: this.now() + ttl,
      };
      this.store.put(APPROVAL_KIND, row.approvalId, row);
      return this.view(row);
    });
  }

  /** Hook side: read the current state (settles expiry lazily). */
  poll(approvalId: string): JsonObject {
    id(approvalId);
    return this.store.transaction(() => {
      const row = this.settle(this.get(approvalId));
      if (row === undefined) fail('NOT_FOUND', 404);
      return this.view(row);
    });
  }

  /** Hook side: give up waiting — the phone card disappears. */
  cancel(approvalId: string): JsonObject {
    id(approvalId);
    return this.store.transaction(() => {
      let row = this.settle(this.get(approvalId));
      if (row === undefined) fail('NOT_FOUND', 404);
      if (row.state === 'PENDING') {
        row = { ...row, state: 'CANCELLED', decidedAt: this.now() };
        this.store.put(APPROVAL_KIND, row.approvalId, row);
      }
      return this.view(row);
    });
  }

  /** Loopback surfaces (Agent Link popover, diagnostics): live pending only. */
  pending(): JsonObject {
    return this.store.transaction(() => {
      const items = this.store.list<Approval>(APPROVAL_KIND)
        .map((r) => this.settle(r))
        .filter((r): r is Approval => r !== undefined && r.state === 'PENDING')
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((r) => this.view(r));
      return { schemaVersion: 'personal-approvals/1', items };
    });
  }

  /**
   * Phone side: pending asks plus decisions made in the last hour.
   * waitMillis > 0 turns the read into a short long-poll: hold the request
   * until a PENDING ask appears or the budget runs out, so a connected phone
   * sees a new card within ~0.4s instead of on its next poll tick. Callers on
   * serialized transports (PAC relay lanes) must not use it — a held request
   * occupies the lane.
   */
  async list(_device: Device, waitMillis = 0): Promise<JsonObject> {
    const deadline = this.now() + Math.max(0, Math.min(15_000, waitMillis));
    for (;;) {
      const page = this.page();
      const hasPending = (page.items as JsonObject[]).some((i) => i.state === 'PENDING');
      if (hasPending || this.now() >= deadline) return page;
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  private page(): JsonObject {
    return this.store.transaction(() => {
      const horizon = this.now() - KEEP_DECIDED_MS;
      const items = this.store.list<Approval>(APPROVAL_KIND)
        .map((r) => this.settle(r))
        .filter((r): r is Approval => r !== undefined
          && (r.state === 'PENDING' || (r.decidedAt ?? 0) >= horizon))
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-100)
        .map((r) => this.view(r));
      return { schemaVersion: 'personal-approvals/1', items };
    });
  }

  /** Phone side: first decision wins; everything else is a conflict. */
  async decide(device: Device, approvalId: string, body: unknown): Promise<JsonObject> {
    id(approvalId);
    const input = exact(body, 'decision', 'reason');
    const decision = text(input, 'decision');
    if (!DECISIONS.has(decision)) fail('INVALID_REQUEST', 400);
    const reason = typeof input.reason === 'string' ? input.reason.slice(0, 1024) : undefined;
    return this.store.transaction(() => {
      let row = this.settle(this.get(approvalId));
      if (row === undefined) fail('NOT_FOUND', 404);
      if (TERMINAL.has(row.state)) {
        if (row.state === 'APPROVED' && decision !== 'DENIED') return this.view(row);
        if (row.state === 'DENIED' && decision === 'DENIED') return this.view(row);
        fail('APPROVAL_RESOLVED', 409);
      }
      const mapped = decision === 'APPROVED_SESSION' ? 'APPROVED' : decision;
      row = {
        ...row, state: mapped, decision, decidedAt: this.now(),
        decidedByDeviceId: device.id,
        ...(reason !== undefined ? { reason } : {}),
      };
      this.store.put(APPROVAL_KIND, row.approvalId, row);
      return this.view(row);
    });
  }

  private view(row: Approval): JsonObject {
    const out: JsonObject = {
      approvalId: row.approvalId,
      agent: row.agent,
      toolName: row.toolName,
      question: row.question,
      options: row.options,
      state: row.state,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
    if (row.toolInput !== undefined) out.toolInput = row.toolInput;
    if (row.projectDir !== undefined) out.projectDir = row.projectDir;
    if (row.sessionRef !== undefined) out.sessionRef = row.sessionRef;
    if (row.decision !== undefined) out.decision = row.decision;
    if (row.reason !== undefined) out.reason = row.reason;
    if (row.decidedAt !== undefined) out.decidedAt = row.decidedAt;
    return out;
  }
}
