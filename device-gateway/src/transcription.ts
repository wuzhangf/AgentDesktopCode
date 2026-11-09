/**
 * PersonalTranscriptionService port — durable transcription requests against
 * the generic kind→payload store. Reads/restarts never issue a second
 * provider call: records persist in kind 'transcription'; on boot, rows still
 * ACCEPTED/DISPATCHED are marked UNKNOWN HOST_RESTARTED_NO_RETRY.
 *
 * Java's ThreadPoolExecutor(2,2,queue=4,AbortPolicy) is reproduced as a
 * bounded async queue: 2 in-flight dispatches, 4 queued, overflow →
 * TRANSCRIPTION_QUEUE_FULL 429 (record left NOT_DISPATCHED).
 */
import { fail, hash, hashBytes, id } from './protocol.js';
import type { Device } from './protocol.js';
import type { GatewayAuth, GatewayStoreView, GatewayTranscription, JsonObject } from './context.js';

const KIND = 'transcription';
const TEXT_TTL = 86_400_000;
const RECORD_TTL = 31 * 86_400_000;
const HISTORY_LIMIT = 128;
const MAX_AUDIO = 1_920_044;
const MAX_QUEUE = 4;
const WORKERS = 2;

export interface TranscriptionProvider {
  /** Stable provider identity string bound into the record fingerprint. */
  binding(): string;
  /** Returns transcript text; must honor cancelled() promptly. */
  transcribe(requestId: string, pcm: Uint8Array, language: string, cancelled: () => boolean): Promise<string> | string;
  close?(): void;
}

interface Record_ {
  id: string;
  deviceId: string;
  sessionId: string;
  audioHash: string;
  language: string;
  fingerprint: string;
  providerBinding: string;
  state: string;               // ACCEPTED | DISPATCHED | SUCCEEDED | FAILED | UNKNOWN | CANCELLED | EXPIRED | NOT_DISPATCHED
  text?: string;
  code?: string;
  createdAt: number;
  observedAt: number;
  dispatched: boolean;
}

/** Strict single-channel 16kHz PCM16 WAV decoder, produced by the Android recorder. */
export function pcm(wav: Uint8Array): Uint8Array {
  const ascii = (p: number, s: string): boolean => {
    for (let i = 0; i < s.length; i++) if (wav[p + i] !== s.charCodeAt(i)) return false;
    return true;
  };
  const u16 = (p: number): number => wav[p] | (wav[p + 1] << 8);
  const u32 = (p: number): number => u16(p) + u16(p + 2) * 0x10000;
  if (wav.length < 44 || wav.length > MAX_AUDIO
    || !ascii(0, 'RIFF') || !ascii(8, 'WAVE') || !ascii(12, 'fmt ') || !ascii(36, 'data')
    || u32(4) !== wav.length - 8 || u32(16) !== 16 || u16(20) !== 1 || u16(22) !== 1
    || u32(24) !== 16000 || u32(28) !== 32000 || u16(32) !== 2 || u16(34) !== 16
    || u32(40) !== wav.length - 44 || (wav.length - 44) % 2 !== 0 || wav.length < 6444) {
    fail('AUDIO_FORMAT_INVALID', 422);
  }
  return wav.slice(44);
}

export class PersonalTranscription implements GatewayTranscription {
  private readonly cancellations = new Map<string, { value: boolean }>();
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly store: GatewayStoreView,
    private readonly auth: Pick<GatewayAuth, 'authorize' | 'authorizeDevice'>,
    private readonly provider: TranscriptionProvider,
  ) {
    store.transaction(() => {
      for (const r of store.list<Record_>(KIND)) {
        if (r.state === 'ACCEPTED' || r.state === 'DISPATCHED') {
          r.state = 'UNKNOWN';
          r.code = 'HOST_RESTARTED_NO_RETRY';
          r.observedAt = Date.now();
          store.put(KIND, r.id, r);
        }
      }
    });
  }

  async submit(
    token: string, requestId: string, sessionId: string, audioHash: string,
    wav: Uint8Array, language: string,
  ): Promise<JsonObject> {
    id(requestId);
    id(sessionId);
    const device: Device = await this.auth.authorize(token, sessionId, 'INTERACT');
    const pcmBytes = pcm(wav);
    try {
      if (hashBytes(wav) !== audioHash) fail('AUDIO_DIGEST_MISMATCH', 409);
      // The handler passes 'auto' when metadata lacks the field.
      if (language !== 'auto') fail('INVALID_LANGUAGE', 400);
      const lang = language;

      const admitted = this.store.transaction((): Record_ | null => {
        const now = Date.now();
        const records = this.store.list<Record_>(KIND);
        for (const old of records) {
          if (old.createdAt + RECORD_TTL < now) {
            this.store.delete(KIND, old.id);
          } else if (old.createdAt + TEXT_TTL < now && old.text !== undefined) {
            delete old.text;
            old.state = 'EXPIRED';
            this.store.put(KIND, old.id, old);
          }
        }
        const fingerprint = hash(JSON.stringify([device.id, sessionId, audioHash, lang, this.provider.binding()]));
        const existing = this.store.get<Record_>(KIND, requestId);
        if (existing !== undefined) {
          if (existing.deviceId !== device.id) fail('REQUEST_KEY_UNAVAILABLE', 409);
          if (existing.fingerprint !== fingerprint) fail('IDEMPOTENCY_PAYLOAD_MISMATCH', 409);
          if (existing.createdAt + TEXT_TTL < now) fail('TRANSCRIPTION_EXPIRED', 410);
          return existing;
        }
        if (this.store.list<Record_>(KIND).length >= HISTORY_LIMIT) fail('TRANSCRIPTION_HISTORY_LIMIT', 429);
        const row: Record_ = {
          id: requestId,
          deviceId: device.id,
          sessionId,
          audioHash,
          language: lang,
          fingerprint,
          providerBinding: this.provider.binding(),
          state: 'ACCEPTED',
          createdAt: now,
          observedAt: now,
          dispatched: false,
        };
        this.store.put(KIND, row.id, row);
        return null;
      });
      if (admitted !== null) return this.view(admitted);

      const cancelled = { value: false };
      this.cancellations.set(requestId, cancelled);
      if (!this.enqueue(() => this.dispatch(requestId, pcmBytes, cancelled))) {
        this.cancellations.delete(requestId);
        this.outcome(requestId, 'NOT_DISPATCHED', undefined, 'TRANSCRIPTION_QUEUE_FULL');
        fail('TRANSCRIPTION_QUEUE_FULL', 429);
      }
      return await this.get(token, requestId);
    } finally {
      // Java zeroes the PCM copy in the service; upload.audio is zeroed by
      // the handler (PersonalAudioMultipart caller finally block).
      pcmBytes.fill(0);
    }
  }

  private enqueue(work: () => void): boolean {
    if (this.running >= WORKERS && this.queue.length >= MAX_QUEUE) return false;
    this.queue.push(work);
    void this.pump();
    return true;
  }

  private async pump(): Promise<void> {
    if (this.running >= WORKERS) return;
    const work = this.queue.shift();
    if (!work) return;
    this.running++;
    try {
      work();
    } finally {
      this.running--;
      if (this.queue.length > 0) void this.pump();
    }
  }

  private async dispatch(requestId: string, pcmBytes: Uint8Array, cancelled: { value: boolean }): Promise<void> {
    try {
      const r = this.store.transaction(() => {
        const row = this.store.get<Record_>(KIND, requestId);
        return row !== undefined && row.state === 'ACCEPTED' ? row : null;
      });
      if (r === null) return;
      await this.auth.authorizeDevice(r.deviceId, r.sessionId, 'INTERACT');
      const admitted = this.store.transaction(() => {
        const row = this.store.get<Record_>(KIND, requestId);
        if (row === undefined || row.state !== 'ACCEPTED' || cancelled.value) return false;
        row.state = 'DISPATCHED';
        row.dispatched = true;
        row.observedAt = Date.now();
        this.store.put(KIND, requestId, row);
        return true;
      });
      if (!admitted) return;
      const text = await this.provider.transcribe(requestId, pcmBytes, r.language, () => cancelled.value);
      await this.auth.authorizeDevice(r.deviceId, r.sessionId, 'OBSERVE');
      if (text === null || text === undefined || text.trim() === '') {
        this.outcome(requestId, 'FAILED', undefined, 'NO_SPEECH');
      } else if ([...text].length > 16000) {
        this.outcome(requestId, 'FAILED', undefined, 'TRANSCRIPT_TOO_LARGE');
      } else {
        this.outcome(requestId, 'SUCCEEDED', text, undefined);
      }
    } catch {
      this.outcome(requestId, cancelled.value ? 'CANCELLED' : 'UNKNOWN',
        undefined, cancelled.value ? 'CANCELLED_PROVIDER_MAY_HAVE_RUN' : 'TRANSCRIPTION_OUTCOME_UNKNOWN');
    } finally {
      pcmBytes.fill(0);
      this.cancellations.delete(requestId);
    }
  }

  private outcome(requestId: string, state: string, text: string | undefined, code: string | undefined): void {
    this.store.transaction(() => {
      const row = this.store.get<Record_>(KIND, requestId);
      if (row !== undefined && row.state !== 'CANCELLED') {
        row.state = state;
        if (text !== undefined) row.text = text;
        else delete row.text;
        if (code !== undefined) row.code = code;
        else delete row.code;
        row.observedAt = Date.now();
        this.store.put(KIND, requestId, row);
      }
    });
  }

  async get(token: string, requestId: string): Promise<JsonObject> {
    id(requestId);
    const r = this.store.transaction(() => this.store.get<Record_>(KIND, requestId));
    if (r === undefined) fail('NOT_FOUND', 404);
    const d = await this.auth.authorize(token, r.sessionId, 'OBSERVE');
    if (d.id !== r.deviceId) fail('NOT_FOUND', 404);
    if (r.createdAt + TEXT_TTL < Date.now()) fail('TRANSCRIPTION_EXPIRED', 410);
    const out = this.view(r);
    await this.auth.authorize(token, r.sessionId, 'OBSERVE');
    return out;
  }

  async cancel(token: string, requestId: string): Promise<JsonObject> {
    await this.get(token, requestId);
    const r = this.store.transaction(() => this.store.get<Record_>(KIND, requestId))!;
    await this.auth.authorize(token, r.sessionId, 'INTERACT');
    const pending = this.cancellations.get(requestId);
    if (pending !== undefined) pending.value = true;
    this.store.transaction(() => {
      const row = this.store.get<Record_>(KIND, requestId)!;
      if (row.state === 'SUCCEEDED' || row.state === 'FAILED') fail('TRANSCRIPTION_ALREADY_COMPLETED', 409);
      row.state = 'CANCELLED';
      delete row.text;
      row.code = row.dispatched ? 'CANCELLED_PROVIDER_MAY_HAVE_RUN' : 'CANCELLED_BEFORE_DISPATCH';
      row.observedAt = Date.now();
      this.store.put(KIND, requestId, row);
    });
    return this.get(token, requestId);
  }

  private view(r: Record_): JsonObject {
    const out: JsonObject = {
      requestKey: r.id,
      sessionId: r.sessionId,
      audioSha256: r.audioHash,
      state: r.state,
      providerBinding: r.providerBinding,
      providerMayHaveRun: r.dispatched,
      observedAt: r.observedAt,
    };
    if (r.text !== undefined && r.state === 'SUCCEEDED') out.text = r.text;
    if (r.code !== undefined) out.code = r.code;
    return out;
  }

  close(): void {
    for (const c of this.cancellations.values()) c.value = true;
    this.queue.length = 0;
    this.provider.close?.();
  }
}
