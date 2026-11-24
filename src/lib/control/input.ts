/* --------------------------------------------------------------------------
   Input wire format and safety guards.

   Input travels over the WebRTC data channel of the control connection — never
   through the signaling server. It is a reliable, ordered channel:

   - key/button transitions keep their order and are never dropped;
   - mouse movement is coalesced into one relative delta per frame to avoid
     flooding the network;
   - every frame carries a sequence number, and the host ignores anything not
     newer than the last accepted frame, so a late frame cannot act after a
     revoke (the session is also destroyed on revoke);
   - ordinary mouse-only frames are rate-limited; key/button frames are always
     processed so a released key can never be lost to a limiter.
   -------------------------------------------------------------------------- */

export const INPUT_MAX_KEYS = 24;
export const INPUT_MAX_MOVES = 8;
export const INPUT_MAX_BUTTONS = 12;
export const INPUT_MAX_DELTA = 4_000;
export const INPUT_MAX_WHEEL = 6_000;
export const INPUT_MAX_MESSAGE_BYTES = 4_096;
export const INPUT_MAX_BUFFERED_BYTES = 64_000;
export const INPUT_FRAMES_PER_SECOND = 600;
/** The controller flushes mouse movement at most this often. */
export const INPUT_FLUSH_MS = 8;

export interface WireKey {
  scan: number;
  vk: number;
  extended: boolean;
  down: boolean;
}

export interface WireButton {
  button: 1 | 2 | 3;
  down: boolean;
}

export interface InputFrame {
  t: 'input';
  seq: number;
  /** Controller performance.now(), used only for round-trip measurement. */
  sentAt: number;
  keys: WireKey[];
  moves: Array<{ dx: number; dy: number }>;
  buttons: WireButton[];
  wheel: number;
}

export type InputMessage =
  | { t: 'hello'; grantId: string; token: string }
  | InputFrame
  | { t: 'ack'; seq: number };

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isBool(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** Parses untrusted channel data, returning a sanitised message or null. */
export function parseInputMessage(raw: unknown): InputMessage | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > INPUT_MAX_MESSAGE_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;

  if (message.t === 'hello') {
    if (typeof message.grantId !== 'string' || message.grantId.length > 64) return null;
    if (typeof message.token !== 'string' || message.token.length > 128) return null;
    return { t: 'hello', grantId: message.grantId, token: message.token };
  }

  if (message.t === 'ack') {
    if (!isInt(message.seq) || message.seq < 0) return null;
    return { t: 'ack', seq: message.seq };
  }

  if (message.t !== 'input') return null;
  if (!isInt(message.seq) || message.seq < 1 || message.seq > 2_147_483_647) return null;
  if (typeof message.sentAt !== 'number' || !Number.isFinite(message.sentAt)) return null;

  const keysRaw = Array.isArray(message.keys) ? message.keys : [];
  if (keysRaw.length > INPUT_MAX_KEYS) return null;
  const keys: WireKey[] = [];
  for (const entry of keysRaw) {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    if (!isInt(item.scan) || item.scan < 1 || item.scan > 0xff) return null;
    if (!isInt(item.vk) || item.vk < 1 || item.vk > 0xff) return null;
    if (!isBool(item.extended) || !isBool(item.down)) return null;
    keys.push({ scan: item.scan, vk: item.vk, extended: item.extended, down: item.down });
  }

  const movesRaw = Array.isArray(message.moves) ? message.moves : [];
  if (movesRaw.length > INPUT_MAX_MOVES) return null;
  const moves: Array<{ dx: number; dy: number }> = [];
  for (const entry of movesRaw) {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    if (!isInt(item.dx) || !isInt(item.dy)) return null;
    if (Math.abs(item.dx) > INPUT_MAX_DELTA || Math.abs(item.dy) > INPUT_MAX_DELTA) return null;
    moves.push({ dx: item.dx, dy: item.dy });
  }

  const buttonsRaw = Array.isArray(message.buttons) ? message.buttons : [];
  if (buttonsRaw.length > INPUT_MAX_BUTTONS) return null;
  const buttons: WireButton[] = [];
  for (const entry of buttonsRaw) {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    if (item.button !== 1 && item.button !== 2 && item.button !== 3) return null;
    if (!isBool(item.down)) return null;
    buttons.push({ button: item.button, down: item.down });
  }

  const wheel = message.wheel ?? 0;
  if (!isInt(wheel) || Math.abs(wheel) > INPUT_MAX_WHEEL) return null;

  return { t: 'input', seq: message.seq, sentAt: message.sentAt, keys, moves, buttons, wheel };
}

export function encodeInputMessage(message: InputMessage): string {
  return JSON.stringify(message);
}

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, Math.round(value)));
}

/* ---- Controller -------------------------------------------------------- */

/**
 * Accumulates input between animation frames. Mouse deltas are summed; key and
 * button transitions keep their order. A frame is capped so one slow flush can
 * never produce an oversized message.
 */
export class InputBatcher {
  private keys: WireKey[] = [];
  private buttons: WireButton[] = [];
  private movesDx = 0;
  private movesDy = 0;
  private hasMove = false;
  private wheel = 0;
  private seq = 0;

  addKey(stroke: { scan: number; vk: number; extended: boolean }, down: boolean): void {
    if (this.keys.length >= INPUT_MAX_KEYS) return;
    this.keys.push({ scan: stroke.scan, vk: stroke.vk, extended: stroke.extended, down });
  }

  addMove(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return;
    this.movesDx = clamp(this.movesDx + dx, INPUT_MAX_DELTA);
    this.movesDy = clamp(this.movesDy + dy, INPUT_MAX_DELTA);
    this.hasMove = true;
  }

  /** Used by release-all, where the key is already resolved to a scan code. */
  addWireKey(key: WireKey): void {
    if (this.keys.length >= INPUT_MAX_KEYS) return;
    this.keys.push({ ...key });
  }

  addWireButton(button: WireButton): void {
    if (this.buttons.length >= INPUT_MAX_BUTTONS) return;
    this.buttons.push({ ...button });
  }

  addButton(button: 1 | 2 | 3, down: boolean): void {
    if (this.buttons.length >= INPUT_MAX_BUTTONS) return;
    this.buttons.push({ button, down });
  }

  addWheel(delta: number): void {
    if (!Number.isFinite(delta)) return;
    this.wheel = clamp(this.wheel + delta, INPUT_MAX_WHEEL);
  }

  get pending(): boolean {
    return (
      this.keys.length > 0 ||
      this.buttons.length > 0 ||
      this.hasMove ||
      this.wheel !== 0
    );
  }

  /** Takes the next frame; returns null when nothing is pending. */
  flush(sentAt: number): InputFrame | null {
    if (!this.pending) return null;
    this.seq += 1;
    const frame: InputFrame = {
      t: 'input',
      seq: this.seq,
      sentAt,
      keys: this.keys.splice(0, INPUT_MAX_KEYS),
      moves: this.hasMove ? [{ dx: this.movesDx, dy: this.movesDy }] : [],
      buttons: this.buttons.splice(0, INPUT_MAX_BUTTONS),
      wheel: this.wheel,
    };
    this.movesDx = 0;
    this.movesDy = 0;
    this.hasMove = false;
    this.wheel = 0;
    return frame;
  }

  reset(): void {
    this.keys = [];
    this.buttons = [];
    this.movesDx = 0;
    this.movesDy = 0;
    this.hasMove = false;
    this.wheel = 0;
    this.seq = 0;
  }
}

/** Tracks what the controller is holding, so release-all can be exact. */
export class HeldInput {
  private keys = new Map<string, { scan: number; vk: number; extended: boolean }>();
  private buttons = new Set<1 | 2 | 3>();

  pressKey(code: string, stroke: { scan: number; vk: number; extended: boolean }): boolean {
    if (this.keys.has(code)) return false;
    this.keys.set(code, stroke);
    return true;
  }

  releaseKey(code: string): boolean {
    return this.keys.delete(code);
  }

  pressButton(button: 1 | 2 | 3): boolean {
    if (this.buttons.has(button)) return false;
    this.buttons.add(button);
    return true;
  }

  releaseButton(button: 1 | 2 | 3): boolean {
    return this.buttons.delete(button);
  }

  get holding(): boolean {
    return this.keys.size > 0 || this.buttons.size > 0;
  }

  get keyCount(): number {
    return this.keys.size;
  }

  get buttonCount(): number {
    return this.buttons.size;
  }

  /** Everything still held, cleared in one step. */
  releaseAll(): { keys: WireKey[]; buttons: WireButton[] } {
    const keys = [...this.keys.values()].map((stroke) => ({ ...stroke, down: false as const }));
    const buttons = [...this.buttons].map((button) => ({ button, down: false as const }));
    this.keys.clear();
    this.buttons.clear();
    return { keys, buttons };
  }
}

/* ---- Host -------------------------------------------------------------- */

export type FrameVerdict = 'accepted' | 'stale' | 'not-ready' | 'throttled';

/**
 * Host-side gate for one grant. The session object is replaced on every grant,
 * so an old token cannot be reused, and sequence numbers must increase.
 */
export class InputReceiver {
  private ready = false;
  private lastSeq = 0;
  private windowStart = 0;
  private windowCount = 0;

  constructor(
    readonly grantId: string,
    private readonly token: string,
    private readonly maxFramesPerSecond = INPUT_FRAMES_PER_SECOND,
  ) {}

  get active(): boolean {
    return this.ready;
  }

  handshake(message: { grantId: string; token: string }): boolean {
    if (this.ready) return false;
    if (message.grantId !== this.grantId || message.token !== this.token) return false;
    this.ready = true;
    return true;
  }

  accept(frame: InputFrame): FrameVerdict {
    if (!this.ready) return 'not-ready';
    if (frame.seq <= this.lastSeq) return 'stale';

    // Safety transitions are never throttled.
    const hasTransition = frame.keys.length > 0 || frame.buttons.length > 0;
    if (!hasTransition) {
      const now = Date.now();
      if (now - this.windowStart >= 1_000) {
        this.windowStart = now;
        this.windowCount = 0;
      }
      if (this.windowCount >= this.maxFramesPerSecond) return 'throttled';
      this.windowCount += 1;
    }

    this.lastSeq = frame.seq;
    return 'accepted';
  }
}

/**
 * Serialises host injection through the Tauri bridge. IPC is asynchronous; a
 * short queue smooths bursts, and mouse-only frames are discarded when it is
 * full while key frames are always kept.
 */
interface PendingFrame {
  frame: InputFrame;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class InjectionPump {
  private queue: PendingFrame[] = [];
  private running = false;

  constructor(
    private readonly inject: (frame: InputFrame) => Promise<void>,
    private readonly onError: (message: string) => void,
  ) {}

  /** Resolves after the host has actually injected this frame. */
  push(frame: InputFrame): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.queue.length > 24) {
        const hasTransition = frame.keys.length > 0 || frame.buttons.length > 0;
        if (!hasTransition) {
          resolve();
          return;
        }
        const mouseOnly = this.queue.findIndex(
          (item) => item.frame.keys.length === 0 && item.frame.buttons.length === 0,
        );
        if (mouseOnly !== -1) {
          this.queue[mouseOnly].resolve();
          this.queue.splice(mouseOnly, 1);
        }
      }
      this.queue.push({ frame, resolve, reject });
      void this.drain();
    });
  }

  clear(): void {
    for (const item of this.queue) item.resolve();
    this.queue = [];
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          await this.inject(item.frame);
          item.resolve();
        } catch (error) {
          this.onError(error instanceof Error ? error.message : 'Remote input failed.');
          item.reject(error);
          for (const pending of this.queue) pending.resolve();
          this.queue = [];
        }
      }
    } finally {
      this.running = false;
    }
  }
}
