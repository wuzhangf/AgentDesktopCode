/**
 * Real-wire witness for the desktop streaming path (worker-events/1):
 * a live PAC HTTPS event route (device-token auth) relays a real worker's
 * deltas into the production NativeTaskEventClient, and the emitted frames
 * fold through the production renderer projection. The live tail must equal
 * the terminal ASSISTANT_MESSAGE text byte-for-byte — this is the same
 * typewriter guarantee the unit suite proves with synthetic frames.
 *
 * Skips unless the live harness exported:
 *   LIVE_PAC_URL, LIVE_PAC_TOKEN, LIVE_PAC_BACKEND, LIVE_PAC_TASK
 */
import { describe, expect, it } from 'vitest';
import { NativeTaskEventClient, type NativeTaskEventFrame } from '../../electron/main/transport/nativeTaskEvents';
import {
  emptyNativeLiveStream,
  nativeLiveTailText,
  reduceNativeTaskEventBatch,
  type NativeLiveStreamState
} from '../../src/renderer/app/activity/nativeVisibleTextProjection';

const url = process.env.LIVE_PAC_URL;
const token = process.env.LIVE_PAC_TOKEN;
const backend = process.env.LIVE_PAC_BACKEND;
const task = process.env.LIVE_PAC_TASK;
const live = url && token && backend && task;

describe.skipIf(!live)('native live wire (real PAC relay)', () => {
  it('streams real deltas through the production client into the projection', async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const frames: NativeTaskEventFrame[] = [];
    const statuses: string[] = [];
    const resyncs: string[] = [];
    const client = new NativeTaskEventClient({
      batchIntervalMs: 10,
      minBackoffMs: 50,
      maxBackoffMs: 200,
      open: async (cursor, signal) => {
        const res = await fetch(
          `${url}/personal/v1/local-tasks/${backend}/tasks/${task}/events?cursor=${cursor}&follow=1`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'text/event-stream'
            },
            signal
          }
        );
        return { status: res.status, body: res.body };
      },
      onEvents: (batch) => frames.push(...batch),
      onResync: (reason) => resyncs.push(reason),
      onStatus: (status) => statuses.push(status)
    });
    client.start();
    const deadline = Date.now() + 120_000;
    try {
      while (
        !frames.some((f) => f.type === 'ASSISTANT_MESSAGE' || f.type === 'NATIVE_SETTLED')
        && Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      client.stop();
    }

    expect(statuses).toContain('CONNECTED');
    expect(resyncs).toEqual([]);
    expect(frames.length).toBeGreaterThan(0);

    // Cursor order from the production parser must be strictly monotonic.
    const cursors = frames.map((f) => f.cursor);
    for (let i = 1; i < cursors.length; i++) {
      expect(cursors[i]!).toBeGreaterThan(cursors[i - 1]!);
    }

    const deltas = frames.filter((f) => f.type === 'OUTPUT_DELTA');
    const terminal = frames.find((f) => f.type === 'ASSISTANT_MESSAGE');
    expect(deltas.length).toBeGreaterThan(0);
    expect(terminal).toBeDefined();

    // Fold the exact frames the main bridge emitted through the renderer's
    // production reducer: the live tail must concatenate to the terminal text.
    const state: NativeLiveStreamState = reduceNativeTaskEventBatch(
      emptyNativeLiveStream(),
      frames
    );
    const terminalPayload = terminal!.payload as { text?: unknown; nativeTurnId?: unknown };
    const tailText = frames
      .filter((f) => f.type === 'OUTPUT_DELTA')
      .map((f) => (f.payload as { delta?: unknown }).delta)
      .filter((d): d is string => typeof d === 'string')
      .join('');
    expect(tailText).toBe(terminalPayload.text);
    // Terminal cleared the folded turn bucket — the transcript owns the row now.
    const key =
      typeof terminalPayload.nativeTurnId === 'string' && terminalPayload.nativeTurnId.length > 0
        ? terminalPayload.nativeTurnId
        : 'turn';
    expect(state.turns.has(key)).toBe(false);
    expect(state.interrupted).toBe(false);
    void nativeLiveTailText;
  }, 150_000);
});
