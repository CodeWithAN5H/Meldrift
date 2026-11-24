import type { StreamPreset, VoiceIceCandidate } from '@shared/protocol';
import { candidateInit } from '@/lib/voice/model';
import {
  readReceiverReport,
  readSenderReport,
  type EncodeState,
  type ReceiverStatsSummary,
  type SenderStatsSummary,
  type StreamSample,
  type StreamQualityReason,
} from './model';

/* --------------------------------------------------------------------------
   Video sessions.

   Video deliberately uses its own RTCPeerConnections, one per viewer, instead
   of adding a video transceiver to the existing voice connections. Voice SDP
   stays untouched (a broken video negotiation cannot interrupt audio), viewers
   do not have to be in voice, and video can stop/restart without renegotiating
   audio. The host is always the offerer, so no glare handling is needed.

   A source switch or quality change uses replaceTrack/setParameters, never a
   new peer connection, unless a viewer is replaced.
   -------------------------------------------------------------------------- */

export type OutgoingStreamSignal =
  | { t: 'stream.offer'; to: string; sdp: string }
  | { t: 'stream.answer'; to: string; sdp: string }
  | { t: 'stream.ice'; to: string; candidate: VoiceIceCandidate };

export type VideoConnectionState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface HostDeps {
  iceServers: RTCIceServer[];
  stream: () => MediaStream | null;
  send: (event: OutgoingStreamSignal) => void;
  onViewerState: (userId: string, state: VideoConnectionState) => void;
  onError: (message: string) => void;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

export interface ViewerDeps {
  iceServers: RTCIceServer[];
  send: (event: OutgoingStreamSignal) => void;
  onTrack: (stream: MediaStream) => void;
  onState: (state: VideoConnectionState) => void;
  onError: (message: string) => void;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

interface HostPeer {
  userId: string;
  pc: RTCPeerConnection;
  pending: RTCIceCandidateInit[];
  remoteSet: boolean;
  offered: boolean;
  state: VideoConnectionState;
}

interface ViewerPeer {
  pc: RTCPeerConnection;
  pending: RTCIceCandidateInit[];
  remoteSet: boolean;
}

interface Totals {
  packetsSent: number;
  packetsLost: number;
  bytesSent: number;
  framesEncoded: number;
}

const EMPTY_TOTALS: Totals = { packetsSent: 0, packetsLost: 0, bytesSent: 0, framesEncoded: 0 };

export interface HostStats {
  sample: StreamSample;
  /** Payload bits per second over the sampling interval, all viewers summed. */
  bitrateKbps: number;
  bytesSent: number;
  framesEncoded: number;
  framesPerSecond: number | null;
  frameWidth: number | null;
  frameHeight: number | null;
  encoder: string | null;
  codec: string | null;
  quality: StreamQualityReason;
}

function mapState(state: RTCPeerConnectionState): VideoConnectionState {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'disconnected':
      return 'reconnecting';
    case 'failed':
    case 'closed':
      return 'failed';
    default:
      return 'new';
  }
}

function codecMap(report: RTCStatsReport): Map<string, string> {
  const map = new Map<string, string>();
  report.forEach((stat) => {
    if (stat.type === 'codec' && typeof stat.mimeType === 'string') map.set(stat.id, stat.mimeType);
  });
  return map;
}

export class StreamHostSession {
  private peers = new Map<string, HostPeer>();
  private track: MediaStreamTrack | null = null;
  private readonly totals = new Map<string, Totals>();

  constructor(private readonly deps: HostDeps) {
    const stream = deps.stream();
    this.track = stream?.getVideoTracks()[0] ?? null;
  }

  get viewerCount(): number {
    return this.peers.size;
  }

  has(userId: string): boolean {
    return this.peers.has(userId);
  }

  /** A viewer (re)joining always gets a fresh connection, never a stale one. */
  async addViewer(userId: string): Promise<void> {
    const stream = this.deps.stream();
    const track = stream?.getVideoTracks()[0] ?? this.track;
    if (!stream || !track) {
      this.deps.onError('The capture has stopped, so nobody can be added to the stream.');
      return;
    }
    this.track = track;
    this.closePeer(userId);

    const config: RTCConfiguration = { iceServers: this.deps.iceServers, bundlePolicy: 'max-bundle' };
    const create = this.deps.createPeerConnection;
    const pc = create ? create(config) : new RTCPeerConnection(config);
    const peer: HostPeer = {
      userId,
      pc,
      pending: [],
      remoteSet: false,
      offered: false,
      state: 'new',
    };
    this.peers.set(userId, peer);
    this.totals.set(userId, { ...EMPTY_TOTALS });

    pc.addTrack(track, stream);
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.deps.send({
        t: 'stream.ice',
        to: userId,
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment,
        },
      });
    };
    pc.onconnectionstatechange = () => {
      const state = mapState(pc.connectionState);
      peer.state = state;
      this.deps.onViewerState(userId, state);
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
      if (sdp) {
        this.deps.send({ t: 'stream.offer', to: userId, sdp });
        peer.offered = true;
      }
    } catch {
      this.deps.onError('The video offer could not be created.');
      this.closePeer(userId);
    }
  }

  async handleAnswer(from: string, sdp: string): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp });
      peer.remoteSet = true;
      await this.flush(peer);
    } catch {
      this.deps.onError('A viewer rejected the video description.');
      this.closePeer(from);
    }
  }

  async handleIce(from: string, candidate: VoiceIceCandidate): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) return;
    const init = candidateInit(candidate);
    if (!peer.remoteSet) {
      peer.pending.push(init);
      return;
    }
    try {
      await peer.pc.addIceCandidate(init);
    } catch {
      // Candidate for an abandoned negotiation.
    }
  }

  /** Source switching keeps every viewer and every negotiated connection. */
  async replaceTrack(track: MediaStreamTrack): Promise<void> {
    this.track = track;
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((item) => item.track?.kind === 'video');
      if (sender) {
        try {
          await sender.replaceTrack(track);
        } catch {
          this.deps.onError('The new capture could not replace the shared track.');
        }
      }
    }
  }

  /** Applies bitrate/framerate/scale to every sender without renegotiating. */
  async applyEncoding(state: EncodeState, preset: StreamPreset): Promise<void> {
    const degradationPreference =
      preset === 'smooth'
        ? 'maintain-framerate'
        : preset === 'quality'
          ? 'maintain-resolution'
          : 'balanced';
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((item) => item.track?.kind === 'video');
      if (!sender) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        for (const encoding of params.encodings) {
          encoding.maxBitrate = state.bitrateKbps * 1000;
          encoding.maxFramerate = state.maxFps;
          encoding.scaleResolutionDownBy = state.scale;
          encoding.networkPriority = 'high';
        }
        params.degradationPreference = degradationPreference;
        await sender.setParameters(params);
      } catch {
        // Some WebRTC builds reject mutable sender parameters; the stream still runs.
      }
    }
  }

  async collectStats(): Promise<HostStats> {
    const aggregate: Totals = { ...EMPTY_TOTALS };
    let sample: StreamSample = {
      packetsSentDelta: 0,
      packetsLostDelta: 0,
    };
    let bytesSent = 0;
    let framesPerSecond: number | null = null;
    let frameWidth: number | null = null;
    let frameHeight: number | null = null;
    let encoder: string | null = null;
    let codec: string | null = null;
    let quality: StreamQualityReason = 'unknown';
    let available: number | undefined;
    let rtt: number | undefined;

    for (const peer of this.peers.values()) {
      let report: RTCStatsReport;
      try {
        report = await peer.pc.getStats();
      } catch {
        continue;
      }
      const lookup = codecMap(report);
      const summary: SenderStatsSummary = readSenderReport(
        report as unknown as Iterable<{ type: string; [key: string]: unknown }>,
        (id) => lookup.get(id) ?? null,
      );
      const previous = this.totals.get(peer.userId) ?? EMPTY_TOTALS;

      const sentDelta = Math.max(0, summary.sample.packetsSentDelta - previous.packetsSent);
      const lostDelta = Math.max(0, summary.sample.packetsLostDelta - previous.packetsLost);
      const bytesDelta = Math.max(0, summary.bytesSent - previous.bytesSent);
      const framesDelta = Math.max(0, summary.framesEncoded - previous.framesEncoded);
      this.totals.set(peer.userId, {
        packetsSent: summary.sample.packetsSentDelta,
        packetsLost: summary.sample.packetsLostDelta,
        bytesSent: summary.bytesSent,
        framesEncoded: summary.framesEncoded,
      });

      aggregate.packetsSent += sentDelta;
      aggregate.packetsLost += lostDelta;
      aggregate.bytesSent += bytesDelta;
      aggregate.framesEncoded += framesDelta;
      bytesSent += summary.bytesSent;
      if (summary.framesPerSecond !== null) {
        framesPerSecond = Math.max(framesPerSecond ?? 0, summary.framesPerSecond);
      }
      frameWidth = summary.frameWidth ?? frameWidth;
      frameHeight = summary.frameHeight ?? frameHeight;
      encoder = summary.encoder ?? encoder;
      codec = summary.codec ?? codec;
      if (summary.sample.availableOutgoingKbps !== undefined) {
        available = Math.min(available ?? Infinity, summary.sample.availableOutgoingKbps);
      }
      if (summary.sample.rttMs !== undefined) rtt = Math.max(rtt ?? 0, summary.sample.rttMs);
      if (summary.qualityLimitationReason === 'bandwidth') quality = 'bandwidth';
      else if (summary.qualityLimitationReason === 'cpu' && quality !== 'bandwidth') quality = 'cpu';
      else if (summary.qualityLimitationReason === 'none') quality = quality === 'unknown' ? 'healthy' : quality;
    }

    const elapsedSeconds = 2;
    const bitrateKbps = Math.round((aggregate.bytesSent * 8) / elapsedSeconds / 1000);
    sample = {
      packetsSentDelta: aggregate.packetsSent,
      packetsLostDelta: aggregate.packetsLost,
      availableOutgoingKbps: available,
      rttMs: rtt,
      qualityLimitationReason:
        quality === 'bandwidth' ? 'bandwidth' : quality === 'cpu' ? 'cpu' : undefined,
      framesPerSecond: framesPerSecond ?? undefined,
    };

    return {
      sample,
      bitrateKbps,
      bytesSent,
      framesEncoded: aggregate.framesEncoded,
      framesPerSecond,
      frameWidth,
      frameHeight,
      encoder,
      codec,
      quality,
    };
  }

  closePeer(userId: string): void {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.peers.delete(userId);
    this.totals.delete(userId);
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
    try {
      peer.pc.close();
    } catch {
      // Already closed.
    }
  }

  closeAll(): void {
    for (const userId of [...this.peers.keys()]) this.closePeer(userId);
  }

  private async flush(peer: HostPeer): Promise<void> {
    const queued = peer.pending;
    peer.pending = [];
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch {
        // Stale candidate.
      }
    }
  }
}

export interface ViewerRuntime {
  state: VideoConnectionState;
  stats: ReceiverStatsSummary | null;
}

export class StreamViewerSession {
  private peer: ViewerPeer | null = null;

  constructor(private readonly deps: ViewerDeps) {}

  async handleOffer(from: string, sdp: string): Promise<void> {
    try {
      if (!this.peer) {
        const config: RTCConfiguration = {
          iceServers: this.deps.iceServers,
          bundlePolicy: 'max-bundle',
        };
        const create = this.deps.createPeerConnection;
        const pc = create ? create(config) : new RTCPeerConnection(config);
        const peer: ViewerPeer = { pc, pending: [], remoteSet: false };
        this.peer = peer;

        pc.onicecandidate = (event) => {
          if (!event.candidate) return;
          this.deps.send({
            t: 'stream.ice',
            to: from,
            candidate: {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              usernameFragment: event.candidate.usernameFragment,
            },
          });
        };
        pc.ontrack = (event) => {
          const stream = event.streams[0] ?? new MediaStream([event.track]);
          this.deps.onTrack(stream);
        };
        pc.onconnectionstatechange = () => {
          const state = mapState(pc.connectionState);
          this.deps.onState(state);
          if (state === 'failed') {
            this.deps.onError('The stream connection failed. Rejoin the stream to retry.');
          }
        };
      }
      await this.peer.pc.setRemoteDescription({ type: 'offer', sdp });
      this.peer.remoteSet = true;
      for (const candidate of this.peer.pending.splice(0)) {
        await this.peer.pc.addIceCandidate(candidate).catch(() => undefined);
      }
      const answer = await this.peer.pc.createAnswer();
      await this.peer.pc.setLocalDescription(answer);
      const localSdp = this.peer.pc.localDescription?.sdp ?? answer.sdp ?? '';
      if (localSdp) this.deps.send({ t: 'stream.answer', to: from, sdp: localSdp });
    } catch {
      this.deps.onError('The stream description could not be answered.');
    }
  }

  async handleIce(_from: string, candidate: VoiceIceCandidate): Promise<void> {
    if (!this.peer) return;
    const init = candidateInit(candidate);
    if (!this.peer.remoteSet) {
      this.peer.pending.push(init);
      return;
    }
    try {
      await this.peer.pc.addIceCandidate(init);
    } catch {
      // Candidate for an abandoned negotiation.
    }
  }

  async collectStats(): Promise<ReceiverStatsSummary | null> {
    if (!this.peer) return null;
    try {
      const report = await this.peer.pc.getStats();
      const lookup = codecMap(report);
      return readReceiverReport(
        report as unknown as Iterable<{ type: string; [key: string]: unknown }>,
        (id) => lookup.get(id) ?? null,
      );
    } catch {
      return null;
    }
  }

  close(): void {
    const peer = this.peer;
    if (!peer) return;
    this.peer = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    try {
      peer.pc.close();
    } catch {
      // Already closed.
    }
  }
}
