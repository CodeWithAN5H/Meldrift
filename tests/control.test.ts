import { describe, expect, it, vi } from 'vitest';
import type { ControlGrantView, VoiceIceCandidate } from '@shared/protocol';
import {
  CONTROL_KEY_MAP,
  isBlockedCombination,
  keyStrokeFor,
} from '@/lib/control/keys';
import {
  HeldInput,
  InjectionPump,
  InputBatcher,
  InputReceiver,
  encodeInputMessage,
  parseInputMessage,
  type InputFrame,
} from '@/lib/control/input';
import {
  ControlControllerSession,
  ControlHostSession,
  type ControlClientSignal,
} from '@/lib/control/session';

/* Remote-control client tests. The peer connections and data channels are
   fakes, so these verify protocol handling, ordering, release behaviour and
   authorization rather than real network or Windows injection. */

const grant: ControlGrantView = {
  roomId: 'room-1',
  grantId: 'grant-1',
  token: 'secret-token',
  hostUserId: 'host-1',
  controller: { userId: 'viewer-1', displayName: 'Rohan', avatarColor: '#7c4df2' },
  targetLabel: 'RDR2 · rdr2.exe',
  expiresAt: Date.now() + 60_000,
};

function frame(seq: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return {
    t: 'input',
    seq,
    sentAt: 0,
    keys: [],
    moves: [{ dx: 5, dy: -2 }],
    buttons: [],
    wheel: 0,
    ...overrides,
  };
}

describe('physical key mapping', () => {
  it('maps layout-independent physical keys to scan and virtual keys', () => {
    expect(keyStrokeFor('KeyW')).toEqual({ scan: 0x11, vk: 0x57, extended: false });
    expect(keyStrokeFor('ShiftLeft')).toEqual({ scan: 0x2a, vk: 0xa0, extended: false });
    expect(keyStrokeFor('ArrowUp')).toEqual({ scan: 0x48, vk: 0x26, extended: true });
    expect(keyStrokeFor('ControlRight')).toEqual({ scan: 0x1d, vk: 0xa3, extended: true });
    expect(keyStrokeFor('NumpadEnter')).toEqual({ scan: 0x1c, vk: 0x0d, extended: true });
    expect(keyStrokeFor('NotAKey')).toBeNull();
  });

  it('covers every letter, digit and function key', () => {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(keyStrokeFor(`Key${letter}`)).not.toBeNull();
    }
    for (let digit = 0; digit <= 9; digit += 1) {
      expect(keyStrokeFor(`Digit${digit}`)).not.toBeNull();
    }
    for (let index = 1; index <= 12; index += 1) {
      expect(keyStrokeFor(`F${index}`)).not.toBeNull();
    }
    expect(Object.keys(CONTROL_KEY_MAP).length).toBeGreaterThan(90);
  });

  it('blocks shortcuts that would escape the game or reach the shell', () => {
    expect(isBlockedCombination({ code: 'MetaLeft' })).toBe(true);
    expect(isBlockedCombination({ code: 'F11' })).toBe(true);
    expect(isBlockedCombination({ code: 'Tab', altKey: true })).toBe(true);
    expect(isBlockedCombination({ code: 'F4', altKey: true })).toBe(true);
    expect(isBlockedCombination({ code: 'Escape', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isBlockedCombination({ code: 'KeyW' })).toBe(false);
    expect(isBlockedCombination({ code: 'Tab' })).toBe(false);
    expect(isBlockedCombination({ code: 'Escape' })).toBe(false);
  });
});

describe('input message validation', () => {
  it('round-trips a bounded frame', () => {
    const message = frame(4, {
      keys: [{ scan: 0x11, vk: 0x57, extended: false, down: true }],
      buttons: [{ button: 1, down: true }],
      wheel: 120,
    });
    const parsed = parseInputMessage(encodeInputMessage(message));
    expect(parsed).toEqual(message);
  });

  it('rejects malformed, oversized and unknown values', () => {
    expect(parseInputMessage('not json')).toBeNull();
    expect(parseInputMessage('null')).toBeNull();
    expect(parseInputMessage(JSON.stringify({ t: 'wat' }))).toBeNull();
    expect(parseInputMessage(JSON.stringify(frame(0)))).toBeNull();
    expect(
      parseInputMessage(
        JSON.stringify(frame(1, { keys: [{ scan: 300, vk: 1, extended: false, down: true }] })),
      ),
    ).toBeNull();
    expect(
      parseInputMessage(
        JSON.stringify(frame(1, { buttons: [{ button: 4, down: true } as never] })),
      ),
    ).toBeNull();
    expect(parseInputMessage(JSON.stringify(frame(1, { wheel: 9_000 })))).toBeNull();
    expect(
      parseInputMessage(
        JSON.stringify(
          frame(1, { moves: Array.from({ length: 9 }, () => ({ dx: 1, dy: 1 })) }),
        ),
      ),
    ).toBeNull();
    expect(parseInputMessage('x'.repeat(4_100))).toBeNull();
    expect(
      parseInputMessage(JSON.stringify({ t: 'hello', grantId: 'g', token: 'x'.repeat(200) })),
    ).toBeNull();
  });
});

describe('input batching and release', () => {
  it('coalesces movement and keeps key order with increasing sequence numbers', () => {
    const batcher = new InputBatcher();
    batcher.addMove(5, 5);
    batcher.addMove(3, -2);
    batcher.addKey({ scan: 0x11, vk: 0x57, extended: false }, true);
    batcher.addKey({ scan: 0x11, vk: 0x57, extended: false }, false);

    const first = batcher.flush(10);
    expect(first?.seq).toBe(1);
    expect(first?.moves).toEqual([{ dx: 8, dy: 3 }]);
    expect(first?.keys.map((key) => key.down)).toEqual([true, false]);
    expect(batcher.flush(20)).toBeNull();

    batcher.addWheel(120);
    const second = batcher.flush(30);
    expect(second?.seq).toBe(2);
    expect(second?.wheel).toBe(120);
  });

  it('never exceeds the key cap in one frame', () => {
    const batcher = new InputBatcher();
    for (let index = 0; index < 30; index += 1) {
      batcher.addKey({ scan: (index % 80) + 1, vk: 0x41, extended: false }, true);
    }
    const flushed = batcher.flush(1);
    expect(flushed?.keys).toHaveLength(24);
  });

  it('releases exactly the keys and buttons still held', () => {
    const held = new HeldInput();
    expect(held.pressKey('KeyW', { scan: 0x11, vk: 0x57, extended: false })).toBe(true);
    expect(held.pressKey('KeyW', { scan: 0x11, vk: 0x57, extended: false })).toBe(false);
    expect(held.pressKey('ShiftLeft', { scan: 0x2a, vk: 0xa0, extended: false })).toBe(true);
    expect(held.pressButton(1)).toBe(true);
    expect(held.releaseKey('ShiftLeft')).toBe(true);

    const released = held.releaseAll();
    expect(released.keys).toEqual([
      { scan: 0x11, vk: 0x57, extended: false, down: false },
    ]);
    expect(released.buttons).toEqual([{ button: 1, down: false }]);
    expect(held.holding).toBe(false);
    expect(held.releaseAll()).toEqual({ keys: [], buttons: [] });
  });
});

describe('host input gate', () => {
  it('requires the grant token and strictly increasing sequence numbers', () => {
    const receiver = new InputReceiver('grant-1', 'secret-token');
    expect(receiver.accept(frame(1))).toBe('not-ready');
    expect(receiver.handshake({ grantId: 'grant-1', token: 'wrong' })).toBe(false);
    expect(receiver.handshake({ grantId: 'grant-1', token: 'secret-token' })).toBe(true);
    expect(receiver.handshake({ grantId: 'grant-1', token: 'secret-token' })).toBe(false);

    expect(receiver.accept(frame(1))).toBe('accepted');
    expect(receiver.accept(frame(1))).toBe('stale');
    expect(receiver.accept(frame(0))).toBe('stale');
    expect(receiver.accept(frame(2))).toBe('accepted');
  });

  it('throttles mouse-only frames but never drops a key transition', () => {
    const receiver = new InputReceiver('g', 't', 2);
    receiver.handshake({ grantId: 'g', token: 't' });
    expect(receiver.accept(frame(1))).toBe('accepted');
    expect(receiver.accept(frame(2))).toBe('accepted');
    expect(receiver.accept(frame(3))).toBe('throttled');

    const keyUp = frame(4, {
      keys: [{ scan: 0x11, vk: 0x57, extended: false, down: false }],
      moves: [],
    });
    expect(receiver.accept(keyUp)).toBe('accepted');
    expect(receiver.accept(frame(3))).toBe('stale');
  });
});

class FakeChannel {
  label: string;
  readyState = 'connecting';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(label: string) {
    this.label = label;
  }

  send = vi.fn((data: string) => {
    this.sent.push(data);
  });

  close = vi.fn(() => {
    this.readyState = 'closed';
  });

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }

  receive(data: string): void {
    this.onmessage?.({ data });
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  onicecandidate: ((event: { candidate: unknown | null }) => void) | null = null;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  channels: FakeChannel[] = [];
  addedCandidates: unknown[] = [];
  closed = false;
  config: RTCConfiguration;

  constructor(config: RTCConfiguration) {
    this.config = config;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel = vi.fn((label: string) => {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  });

  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'input-offer' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'input-answer' }));

  setLocalDescription = vi.fn(async (description: { type: string; sdp: string }) => {
    this.localDescription = description;
  });

  setRemoteDescription = vi.fn(async (description: { type: string; sdp: string }) => {
    this.remoteDescription = description;
  });

  addIceCandidate = vi.fn(async (candidate: unknown) => {
    this.addedCandidates.push(candidate);
  });

  close = vi.fn(() => {
    this.closed = true;
    this.connectionState = 'closed';
  });
}

function makePc(): (config: RTCConfiguration) => RTCPeerConnection {
  return (config) => new FakePeerConnection(config) as unknown as RTCPeerConnection;
}

describe('controller input connection', () => {
  function makeController() {
    FakePeerConnection.instances = [];
    const sent: ControlClientSignal[] = [];
    const onOpen = vi.fn();
    const onClosed = vi.fn();
    const onLatency = vi.fn();
    const session = new ControlControllerSession({
      iceServers: [],
      send: (signal) => sent.push(signal),
      onOpen,
      onClosed,
      onLatency,
      onError: vi.fn(),
      createPeerConnection: makePc(),
    });
    return { session, sent, onOpen, onClosed, onLatency };
  }

  it('offers to the host, sends the grant token, and measures round trip', async () => {
    const { session, sent, onOpen, onLatency } = makeController();
    await session.start(grant);

    const pc = FakePeerConnection.instances[0];
    expect(pc.config.bundlePolicy).toBe('max-bundle');
    expect(sent[0]).toEqual({
      t: 'control.offer',
      to: 'host-1',
      grantId: 'grant-1',
      sdp: 'input-offer',
    });

    const channel = pc.channels[0];
    channel.open();
    expect(onOpen).toHaveBeenCalled();
    const hello = JSON.parse(channel.sent[0]) as { t: string; grantId: string; token: string };
    expect(hello).toEqual({ t: 'hello', grantId: 'grant-1', token: 'secret-token' });

    expect(session.send(frame(1))).toBe(true);
    const frameMessage = JSON.parse(channel.sent[1]) as { t: string; seq: number };
    expect(frameMessage.t).toBe('input');
    expect(frameMessage.seq).toBe(1);

    channel.receive(JSON.stringify({ t: 'ack', seq: 1 }));
    expect(onLatency).toHaveBeenCalledWith(expect.any(Number));

    // Local ICE goes to the host, not back to the controller.
    pc.onicecandidate?.({ candidate: { candidate: 'candidate:local', sdpMid: '0', sdpMLineIndex: 0 } });
    const ice = sent.at(-1);
    expect(ice?.t).toBe('control.ice');
    expect(ice && ice.t === 'control.ice' && ice.to).toBe('host-1');

    session.stop();
    expect(channel.close).toHaveBeenCalled();
    expect(pc.closed).toBe(true);
  });

  it('drops mouse-only frames when the channel backs up, but keeps key transitions', async () => {
    const { session } = makeController();
    await session.start(grant);
    const channel = FakePeerConnection.instances[0].channels[0];
    channel.open();

    channel.bufferedAmount = 70_000;
    expect(session.send(frame(1))).toBe(false);
    expect(
      session.send(
        frame(2, {
          keys: [{ scan: 0x11, vk: 0x57, extended: false, down: false }],
        }),
      ),
    ).toBe(true);
    session.stop();
  });

  it('buffers ICE until the answer arrives and ignores other grants', async () => {
    const { session } = makeController();
    await session.start(grant);
    const candidate: VoiceIceCandidate = {
      candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    await session.handleIce('other-grant', candidate);
    expect(FakePeerConnection.instances[0].addedCandidates).toHaveLength(0);

    await session.handleIce('grant-1', candidate);
    expect(FakePeerConnection.instances[0].addedCandidates).toHaveLength(0);
    await session.handleAnswer('grant-1', 'answer-sdp');
    expect(FakePeerConnection.instances[0].remoteDescription).toEqual({
      type: 'answer',
      sdp: 'answer-sdp',
    });
    expect(FakePeerConnection.instances[0].addedCandidates).toHaveLength(1);
    session.stop();
  });
});

describe('host input connection', () => {
  function makeHost(onInput = vi.fn(async () => undefined)) {
    FakePeerConnection.instances = [];
    const sent: ControlClientSignal[] = [];
    const onActive = vi.fn();
    const onClosed = vi.fn();
    const session = new ControlHostSession({
      iceServers: [],
      grant,
      send: (signal) => sent.push(signal),
      onActive,
      onClosed,
      onInput,
      onError: vi.fn(),
      createPeerConnection: makePc(),
    });
    return { session, sent, onActive, onClosed, onInput };
  }

  async function connectChannel(session: ControlHostSession) {
    await session.handleOffer('grant-1', 'input-offer');
    const pc = FakePeerConnection.instances[0];
    const channel = new FakeChannel('meldrift-input');
    pc.ondatachannel?.({ channel });
    // The host receives an already-open channel from the browser.
    channel.open();
    return { pc, channel };
  }

  it('answers and only activates with the grant token', async () => {
    const { session, sent, onActive } = makeHost();
    await session.handleOffer('wrong-grant', 'input-offer');
    expect(FakePeerConnection.instances).toHaveLength(0);

    const { channel } = await connectChannel(session);
    expect(sent[0]).toEqual({
      t: 'control.answer',
      to: 'viewer-1',
      grantId: 'grant-1',
      sdp: 'input-answer',
    });

    channel.receive(JSON.stringify({ t: 'hello', grantId: 'grant-1', token: 'wrong' }));
    expect(onActive).not.toHaveBeenCalled();
    channel.receive(JSON.stringify({ t: 'hello', grantId: 'grant-1', token: 'secret-token' }));
    expect(onActive).toHaveBeenCalledTimes(1);
    expect(session.isActive).toBe(true);
    session.close();
  });

  it('injects input, acknowledges after injection and ignores repeats', async () => {
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onInput = vi.fn(() => pending);
    const { session } = makeHost(onInput);
    const { channel } = await connectChannel(session);
    channel.receive(JSON.stringify({ t: 'hello', grantId: 'grant-1', token: 'secret-token' }));

    channel.receive(
      encodeInputMessage(
        frame(1, { keys: [{ scan: 0x11, vk: 0x57, extended: false, down: true }] }),
      ),
    );
    await Promise.resolve();
    expect(onInput).toHaveBeenCalledTimes(1);
    // No ack before the host has actually injected the frame.
    expect(channel.sent.some((message) => JSON.parse(message).t === 'ack')).toBe(false);

    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(channel.sent.some((message) => JSON.parse(message).t === 'ack')).toBe(true);

    channel.receive(encodeInputMessage(frame(1)));
    await Promise.resolve();
    expect(onInput).toHaveBeenCalledTimes(1);
    session.close();
  });

  it('fails closed when the input channel closes', async () => {
    const { session, onClosed } = makeHost();
    const { channel } = await connectChannel(session);
    channel.receive(JSON.stringify({ t: 'hello', grantId: 'grant-1', token: 'secret-token' }));
    channel.onclose?.();
    expect(onClosed).toHaveBeenCalled();
    expect(session.isActive).toBe(false);
  });

  it('ignores messages on other channel labels', async () => {
    const { session } = makeHost();
    await session.handleOffer('grant-1', 'input-offer');
    const pc = FakePeerConnection.instances[0];
    const other = new FakeChannel('not-input');
    pc.ondatachannel?.({ channel: other });
    expect(other.close).toHaveBeenCalled();
    session.close();
  });
});

describe('injection pump', () => {
  it('serialises frames and resolves only after injection', async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const pump = new InjectionPump(
      async (item) => {
        events.push(`start:${item.seq}`);
        if (item.seq === 1) await first;
        events.push(`end:${item.seq}`);
      },
      vi.fn(),
    );

    const one = pump.push(frame(1));
    const two = pump.push(frame(2));
    await Promise.resolve();
    expect(events).toEqual(['start:1']);

    releaseFirst();
    await one;
    await two;
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });
});
