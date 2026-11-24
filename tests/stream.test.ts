import { describe, expect, it, vi } from 'vitest';
import type { StreamPreset, VoiceIceCandidate } from '@shared/protocol';
import {
  adaptEncoding,
  captureBounds,
  describeCaptureError,
  displayCaptureConstraints,
  formatBitrate,
  initialEncodeState,
  readReceiverReport,
  readSenderReport,
  type EncodeState,
} from '@/lib/stream/model';
import {
  StreamHostSession,
  StreamViewerSession,
  type OutgoingStreamSignal,
} from '@/lib/stream/session';

/* Streaming tests. Capture constraint selection and adaptive encoding are pure;
   the host/viewer sessions run against a fake RTCPeerConnection so per-viewer
   offer creation, track replacement, encoding limits and cleanup are verified
   without a browser or a GPU. */

const ceiling = { maxHeight: 1080, maxFps: 60 };

describe('capture constraints', () => {
  it('caps presets by the host settings ceiling', () => {
    expect(captureBounds('auto', { maxHeight: 1080, maxFps: 60 })).toEqual({
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(captureBounds('quality', { maxHeight: 720, maxFps: 30 })).toEqual({
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(captureBounds('quality', ceiling)).toEqual({ width: 1920, height: 1080, fps: 60 });
  });

  it('never offers desktop surfaces in window mode', () => {
    const window = displayCaptureConstraints('window', 'auto', ceiling) as unknown as {
      video: { displaySurface: string };
      monitorTypeSurfaces: string;
      surfaceSwitching: string;
      audio: boolean;
    };
    expect(window.video.displaySurface).toBe('window');
    expect(window.monitorTypeSurfaces).toBe('exclude');
    expect(window.surfaceSwitching).toBe('exclude');
    expect(window.audio).toBe(false);

    const desktop = displayCaptureConstraints('desktop', 'auto', ceiling) as unknown as {
      video: { displaySurface: string };
      monitorTypeSurfaces: string;
    };
    expect(desktop.video.displaySurface).toBe('monitor');
    expect(desktop.monitorTypeSurfaces).toBe('include');
  });

  it('describes capture failures without pretending capture worked', () => {
    expect(describeCaptureError(new DOMException('Permission denied', 'NotAllowedError'))).toContain(
      'did not allow',
    );
    expect(
      describeCaptureError(new DOMException('Capture cancelled', 'NotAllowedError')),
    ).toContain('cancelled');
    expect(
      describeCaptureError(new DOMException('Protected content', 'SecurityError')),
    ).toContain('DRM');
    expect(describeCaptureError(new DOMException('Gone', 'NotReadableError'))).toContain(
      'exclusive-fullscreen',
    );
  });
});

describe('adaptive encoding', () => {
  const start = initialEncodeState('auto', ceiling);

  it('tightens bitrate and scale under loss', () => {
    const result = adaptEncoding(
      start,
      { packetsSentDelta: 900, packetsLostDelta: 100, rttMs: 300 },
      'auto',
      ceiling,
    );
    expect(result.pressure).toBe(true);
    expect(result.state.bitrateKbps).toBeLessThan(start.bitrateKbps);
    expect(result.state.scale).toBeGreaterThan(1);
    expect(result.state.bitrateKbps).toBeGreaterThanOrEqual(500);
  });

  it('keeps frame rate first for smooth and resolution first for quality', () => {
    const smooth = initialEncodeState('smooth', ceiling);
    const afterSmooth = adaptEncoding(
      smooth,
      { packetsSentDelta: 800, packetsLostDelta: 200, availableOutgoingKbps: 300 },
      'smooth',
      ceiling,
    );
    expect(afterSmooth.state.maxFps).toBe(smooth.maxFps);
    expect(afterSmooth.state.scale).toBeGreaterThan(1);

    const quality = initialEncodeState('quality', ceiling);
    let afterQuality: EncodeState = quality;
    for (let step = 0; step < 3; step += 1) {
      afterQuality = adaptEncoding(
        afterQuality,
        { packetsSentDelta: 800, packetsLostDelta: 200 },
        'quality',
        ceiling,
      ).state;
    }
    expect(afterQuality.maxFps).toBeLessThan(quality.maxFps);
  });

  it('recovers when the link is healthy, within preset bounds', () => {
    const tight: EncodeState = { bitrateKbps: 800, scale: 1.5, maxFps: 24 };
    const result = adaptEncoding(
      tight,
      { packetsSentDelta: 1000, packetsLostDelta: 0, availableOutgoingKbps: 20_000, rttMs: 20 },
      'auto',
      ceiling,
    );
    expect(result.pressure).toBe(false);
    expect(result.state.bitrateKbps).toBeGreaterThan(tight.bitrateKbps);
    expect(result.state.bitrateKbps).toBeLessThanOrEqual(3000);
    expect(result.state.scale).toBeLessThan(tight.scale);
    expect(result.state.maxFps).toBeGreaterThan(tight.maxFps);
  });
});

describe('stats parsing and formatting', () => {
  it('reads outbound video counters and quality limitation', () => {
    const report = [
      {
        type: 'outbound-rtp',
        kind: 'video',
        packetsSent: 120,
        bytesSent: 90_000,
        framesEncoded: 60,
        frameWidth: 1280,
        frameHeight: 720,
        framesPerSecond: 30,
        encoderImplementation: 'ExternalEncoder',
        qualityLimitationReason: 'bandwidth',
        codecId: 'codec-1',
      },
      { type: 'codec', id: 'codec-1', mimeType: 'video/VP8' },
      { type: 'remote-inbound-rtp', kind: 'video', packetsLost: 4, roundTripTime: 0.12 },
      { type: 'candidate-pair', state: 'succeeded', availableOutgoingBitrate: 2_500_000 },
    ];
    const summary = readSenderReport(report, () => 'video/VP8');
    expect(summary.bytesSent).toBe(90_000);
    expect(summary.framesPerSecond).toBe(30);
    expect(summary.encoder).toBe('ExternalEncoder');
    expect(summary.qualityLimitationReason).toBe('bandwidth');
    expect(summary.codec).toBe('video/VP8');
    expect(summary.sample.rttMs).toBeCloseTo(120);
    expect(summary.sample.availableOutgoingKbps).toBe(2500);
  });

  it('reads inbound video counters', () => {
    const summary = readReceiverReport(
      [
        {
          type: 'inbound-rtp',
          kind: 'video',
          bytesReceived: 50_000,
          packetsReceived: 100,
          packetsLost: 2,
          jitter: 0.01,
          framesDecoded: 120,
          framesDropped: 3,
          frameWidth: 1920,
          frameHeight: 1080,
          framesPerSecond: 60,
          decoderImplementation: 'ExternalDecoder',
          codecId: 'codec-1',
        },
        { type: 'codec', id: 'codec-1', mimeType: 'video/H264' },
      ],
      () => 'video/H264',
    );
    expect(summary.framesDropped).toBe(3);
    expect(summary.decoder).toBe('ExternalDecoder');
    expect(summary.codec).toBe('video/H264');
    expect(summary.jitterMs).toBeCloseTo(10);
  });

  it('accepts the [id, stat] iteration shape of a real RTCStatsReport', () => {
    const report: Array<[string, Record<string, unknown>]> = [
      [
        'IT01V1',
        { type: 'outbound-rtp', kind: 'video', bytesSent: 12_000, framesEncoded: 30, framesPerSecond: 30 },
      ],
    ];
    const summary = readSenderReport(report as unknown as Iterable<{ type: string }>);
    expect(summary.bytesSent).toBe(12_000);
    expect(summary.framesPerSecond).toBe(30);

    const inbound = readReceiverReport([
      ['IT02V1', { type: 'inbound-rtp', kind: 'video', bytesReceived: 9000, framesDropped: 2 }],
    ] as unknown as Iterable<{ type: string }>);
    expect(inbound.bytesReceived).toBe(9000);
    expect(inbound.framesDropped).toBe(2);
  });

  it('formats bitrate without inventing a number', () => {
    expect(formatBitrate(undefined)).toBe('—');
    expect(formatBitrate(0)).toBe('—');
    expect(formatBitrate(850)).toBe('850 kbps');
    expect(formatBitrate(2500)).toBe('2.5 Mbps');
  });
});

/* ---- Video peer connections with fakes ---------------------------------- */

class FakeSender {
  track: { kind: string } | null;
  replacements: unknown[] = [];
  parameters = { encodings: [{} as Record<string, unknown>] } as {
    encodings: Array<Record<string, unknown>>;
    degradationPreference?: string;
  };

  constructor(kind: string) {
    this.track = { kind };
  }

  replaceTrack = vi.fn(async (next: { kind: string } | null) => {
    this.replacements.push(next);
    this.track = next;
  });
  getParameters = () => this.parameters;
  setParameters = vi.fn(async (next: typeof this.parameters) => {
    this.parameters = next;
  });
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  onicecandidate: ((event: { candidate: unknown | null }) => void) | null = null;
  ontrack: ((event: { streams: MediaStream[]; track: unknown }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  addedCandidates: unknown[] = [];
  closed = false;
  senders = [new FakeSender('video')];
  config: RTCConfiguration;
  stats: unknown[] = [];

  constructor(config: RTCConfiguration) {
    this.config = config;
    FakePeerConnection.instances.push(this);
  }

  addTrack = vi.fn();
  getSenders = () => this.senders;
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'video-offer' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'video-answer' }));
  setLocalDescription = vi.fn(async (description: { type: string; sdp: string }) => {
    this.localDescription = description;
  });
  setRemoteDescription = vi.fn(async (description: { type: string; sdp: string }) => {
    this.remoteDescription = description;
  });
  addIceCandidate = vi.fn(async (candidate: unknown) => {
    this.addedCandidates.push(candidate);
  });
  getStats = vi.fn(async () => ({
    forEach: (callback: (stat: unknown) => void) => this.stats.forEach(callback),
    [Symbol.iterator]: () => this.stats[Symbol.iterator](),
  }));
  close = vi.fn(() => {
    this.closed = true;
    this.connectionState = 'closed';
  });
}

const videoTrack = { kind: 'video' } as unknown as MediaStreamTrack;
const videoStream = {
  getVideoTracks: () => [videoTrack],
} as unknown as MediaStream;

function makeHost() {
  FakePeerConnection.instances = [];
  const sent: OutgoingStreamSignal[] = [];
  const host = new StreamHostSession({
    iceServers: [{ urls: ['stun:stun.example.org'] }],
    stream: () => videoStream,
    send: (event) => sent.push(event),
    onViewerState: vi.fn(),
    onError: vi.fn(),
    createPeerConnection: (config) => new FakePeerConnection(config) as unknown as RTCPeerConnection,
  });
  return { host, sent };
}

describe('host video sessions', () => {
  it('replaces a re-joining viewer connection instead of stacking duplicates', async () => {
    const { host, sent } = makeHost();
    await host.addViewer('viewer-a');
    await host.addViewer('viewer-a');
    await host.addViewer('viewer-b');

    // A retry gets a fresh offer, but the previous connection for that viewer is closed.
    expect(FakePeerConnection.instances).toHaveLength(3);
    expect(FakePeerConnection.instances[0].closed).toBe(true);
    expect(FakePeerConnection.instances.filter((pc) => !pc.closed)).toHaveLength(2);
    expect(sent.filter((event) => event.t === 'stream.offer')).toHaveLength(3);
    expect(host.viewerCount).toBe(2);
    host.closeAll();
  });

  it('answers a viewer and buffers ICE until the remote description exists', async () => {
    const { host, sent } = makeHost();
    await host.addViewer('viewer-a');
    const candidate: VoiceIceCandidate = {
      candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    await host.handleIce('viewer-a', candidate);
    const pc = FakePeerConnection.instances[0];
    expect(pc.addedCandidates).toHaveLength(0);

    await host.handleAnswer('viewer-a', 'answer-sdp');
    expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'answer-sdp' });
    expect(pc.addedCandidates).toHaveLength(1);
    expect(sent.some((event) => event.t === 'stream.offer')).toBe(true);
    host.closeAll();
  });

  it('replaces the track on every viewer without recreating connections', async () => {
    const { host } = makeHost();
    await host.addViewer('viewer-a');
    await host.addViewer('viewer-b');
    const replacement = { kind: 'video', label: 'new game window' } as unknown as MediaStreamTrack;
    await host.replaceTrack(replacement);

    expect(FakePeerConnection.instances).toHaveLength(2);
    for (const pc of FakePeerConnection.instances) {
      expect(pc.senders[0].replacements).toEqual([replacement]);
    }
    host.closeAll();
  });

  it('applies bitrate, frame rate and scale without renegotiation', async () => {
    const { host } = makeHost();
    await host.addViewer('viewer-a');
    const pc = FakePeerConnection.instances[0];
    await host.applyEncoding({ bitrateKbps: 1500, scale: 1.5, maxFps: 24 }, 'quality');

    const sender = pc.senders[0];
    expect(sender.setParameters).toHaveBeenCalled();
    expect(sender.parameters.encodings[0].maxBitrate).toBe(1_500_000);
    expect(sender.parameters.encodings[0].maxFramerate).toBe(24);
    expect(sender.parameters.encodings[0].scaleResolutionDownBy).toBe(1.5);
    expect(sender.parameters.degradationPreference).toBe('maintain-resolution');
    expect(pc.createOffer).toHaveBeenCalledTimes(1);
    host.closeAll();
  });

  it('sums sender stats and closes only the removed viewer', async () => {
    const { host } = makeHost();
    await host.addViewer('viewer-a');
    await host.addViewer('viewer-b');
    FakePeerConnection.instances[0].stats = [
      { type: 'outbound-rtp', kind: 'video', packetsSent: 100, bytesSent: 10_000, framesEncoded: 30 },
    ];
    FakePeerConnection.instances[1].stats = [
      { type: 'outbound-rtp', kind: 'video', packetsSent: 100, bytesSent: 10_000, framesEncoded: 30 },
    ];
    const stats = await host.collectStats();
    expect(stats.bytesSent).toBe(20_000);
    expect(stats.bitrateKbps).toBe(80);
    expect(stats.framesEncoded).toBe(60);

    host.closePeer('viewer-a');
    expect(FakePeerConnection.instances[0].closed).toBe(true);
    expect(FakePeerConnection.instances[1].closed).toBe(false);
    host.closeAll();
  });
});

describe('viewer video sessions', () => {
  function makeViewer() {
    FakePeerConnection.instances = [];
    const sent: OutgoingStreamSignal[] = [];
    const onTrack = vi.fn();
    const viewer = new StreamViewerSession({
      iceServers: [],
      send: (event) => sent.push(event),
      onTrack,
      onState: vi.fn(),
      onError: vi.fn(),
      createPeerConnection: (config) =>
        new FakePeerConnection(config) as unknown as RTCPeerConnection,
    });
    return { viewer, sent, onTrack };
  }

  it('answers the host offer, emits the track and closes cleanly', async () => {
    const { viewer, sent, onTrack } = makeViewer();
    await viewer.handleOffer('host', 'offer-sdp');

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(FakePeerConnection.instances[0].remoteDescription).toEqual({
      type: 'offer',
      sdp: 'offer-sdp',
    });
    expect(sent).toEqual([{ t: 'stream.answer', to: 'host', sdp: 'video-answer' }]);

    const stream = { id: 'remote-video' } as unknown as MediaStream;
    FakePeerConnection.instances[0].ontrack?.({ streams: [stream], track: videoTrack });
    expect(onTrack).toHaveBeenCalledWith(stream);

    viewer.close();
    expect(FakePeerConnection.instances[0].closed).toBe(true);
  });

  it('buffers ICE until the offer is applied', async () => {
    const { viewer } = makeViewer();
    await viewer.handleOffer('host', 'offer-sdp');
    await viewer.handleIce('host', {
      candidate: 'candidate:1 1 udp 1 127.0.0.1 6000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    expect(FakePeerConnection.instances[0].addedCandidates).toHaveLength(1);
    viewer.close();
  });

  it('reads receiver statistics for the viewer overlay', async () => {
    const { viewer } = makeViewer();
    await viewer.handleOffer('host', 'offer-sdp');
    FakePeerConnection.instances[0].stats = [
      {
        type: 'inbound-rtp',
        kind: 'video',
        bytesReceived: 123_000,
        framesDecoded: 90,
        framesDropped: 1,
        frameWidth: 1280,
        frameHeight: 720,
        framesPerSecond: 30,
      },
    ];
    const stats = await viewer.collectStats();
    expect(stats?.bytesReceived).toBe(123_000);
    expect(stats?.framesDropped).toBe(1);
    expect(stats?.frameWidth).toBe(1280);
    viewer.close();
  });
});

/* Keep the preset type honest if the protocol list changes. */
const presets: StreamPreset[] = ['auto', 'smooth', 'balanced', 'quality'];
it('supports every documented preset', () => {
  for (const preset of presets) {
    expect(initialEncodeState(preset, ceiling).bitrateKbps).toBeGreaterThan(0);
  }
});
