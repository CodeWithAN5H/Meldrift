import type { VoiceIceCandidate } from '@shared/protocol';
import { candidateInit, levelFromRms, type RemoteMonitor, type VoiceConnectionState } from './model';

/* --------------------------------------------------------------------------
   WebRTC voice mesh

   One RTCPeerConnection per remote participant, Opus audio, DTLS-SRTP. The
   browser (WebView2's Chromium) owns echo cancellation, noise suppression,
   gain control, jitter buffering and Opus, which is why voice runs in the
   WebView rather than in Rust: it is the mature, maintained WebRTC stack and
   it costs no extra runtime.

   Offer direction is deterministic: the participant who joins later offers to
   everyone already in the channel. The existing participants answer. That
   removes glare entirely without a perfect-negotiation implementation, and it
   makes re-joining idempotent because a duplicate participant is replaced
   before any peer is created.
   -------------------------------------------------------------------------- */

export type OutgoingVoiceSignal =
  | { t: 'voice.offer'; to: string; sdp: string }
  | { t: 'voice.answer'; to: string; sdp: string }
  | { t: 'voice.ice'; to: string; candidate: VoiceIceCandidate };

export interface MeshDeps {
  iceServers: RTCIceServer[];
  localStream: () => MediaStream | null;
  send: (event: OutgoingVoiceSignal) => void;
  onPeerState: (userId: string, state: VoiceConnectionState) => void;
  onRemoteLevel: (userId: string, level: number) => void;
  onAudioError: (message: string) => void;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  createAudioElement?: () => HTMLAudioElement;
  attachAudio?: (audio: HTMLAudioElement) => void;
  createMonitor?: (stream: MediaStream) => RemoteMonitor;
}

interface Peer {
  userId: string;
  pc: RTCPeerConnection;
  /** True for the participant who joined later and therefore creates offers. */
  offerer: boolean;
  audio: HTMLAudioElement | null;
  monitor: RemoteMonitor | null;
  pending: RTCIceCandidateInit[];
  remoteSet: boolean;
  /** An offer has already been sent; a duplicate join must not renegotiate. */
  offered: boolean;
  state: VoiceConnectionState;
  restarting: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

const MONITOR_INTERVAL_MS = 120;
const MAX_OPUS_BITRATE = 48_000;

let sharedContext: AudioContext | null = null;

function audioContext(): AudioContext {
  if (!sharedContext) {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedContext = new Ctor({ latencyHint: 'interactive' });
  }
  if (sharedContext.state === 'suspended') void sharedContext.resume();
  return sharedContext;
}

/** Default remote-speech detector: the level of the audio we actually receive. */
function defaultMonitor(stream: MediaStream): RemoteMonitor {
  const context = audioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.55;
  source.connect(analyser);
  const buffer = new Uint8Array(analyser.fftSize);
  return {
    level() {
      analyser.getByteTimeDomainData(buffer);
      let sum = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const value = (buffer[index] - 128) / 128;
        sum += value * value;
      }
      return levelFromRms(Math.sqrt(sum / buffer.length));
    },
    close() {
      source.disconnect();
      analyser.disconnect();
    },
  };
}

export class VoiceMesh {
  private peers = new Map<string, Peer>();
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private deafened = false;
  private volume = 1;
  private sinkDeviceId = 'default';

  constructor(private readonly deps: MeshDeps) {}

  get size(): number {
    return this.peers.size;
  }

  get connectionStates(): VoiceConnectionState[] {
    return [...this.peers.values()].map((peer) => peer.state);
  }

  has(userId: string): boolean {
    return this.peers.has(userId);
  }

  async offerTo(userId: string): Promise<void> {
    const peer = this.ensurePeer(userId, true);
    if (peer.remoteSet || peer.offered) return;
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await this.tune(peer);
      const sdp = peer.pc.localDescription?.sdp ?? offer.sdp ?? '';
      if (sdp) {
        this.deps.send({ t: 'voice.offer', to: userId, sdp });
        peer.offered = true;
      }
    } catch {
      this.fail(peer, 'The voice offer could not be created');
    }
  }

  async handleOffer(from: string, sdp: string): Promise<void> {
    const peer = this.ensurePeer(from, false);
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp });
      peer.remoteSet = true;
      await this.flush(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      await this.tune(peer);
      const localSdp = peer.pc.localDescription?.sdp ?? answer.sdp ?? '';
      if (localSdp) this.deps.send({ t: 'voice.answer', to: from, sdp: localSdp });
    } catch {
      this.fail(peer, 'The voice answer could not be created');
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
      this.fail(peer, 'The voice answer was rejected');
    }
  }

  async handleIce(from: string, candidate: VoiceIceCandidate): Promise<void> {
    const peer = this.ensurePeer(from, false);
    const init = candidateInit(candidate);
    if (!peer.remoteSet) {
      peer.pending.push(init);
      return;
    }
    try {
      await peer.pc.addIceCandidate(init);
    } catch {
      // A candidate that belongs to an abandoned negotiation is not fatal.
    }
  }

  replaceTrack(track: MediaStreamTrack): void {
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((item) => item.track?.kind === 'audio');
      if (sender) void sender.replaceTrack(track).catch(() => undefined);
    }
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    for (const peer of this.peers.values()) {
      if (peer.audio) peer.audio.muted = deafened;
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    for (const peer of this.peers.values()) {
      if (peer.audio) peer.audio.volume = this.volume;
    }
  }

  setSinkDevice(deviceId: string): void {
    this.sinkDeviceId = deviceId;
    for (const peer of this.peers.values()) {
      if (peer.audio) void this.applySink(peer.audio);
    }
  }

  closePeer(userId: string): void {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.peers.delete(userId);
    if (peer.restartTimer) clearTimeout(peer.restartTimer);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    try {
      peer.pc.close();
    } catch {
      // Already closed.
    }
    peer.monitor?.close();
    if (peer.audio) {
      peer.audio.srcObject = null;
      peer.audio.remove();
    }
    if (this.peers.size === 0) this.stopMonitor();
  }

  closeAll(): void {
    for (const userId of [...this.peers.keys()]) this.closePeer(userId);
  }

  /* ---- internals ------------------------------------------------------- */

  private ensurePeer(userId: string, offerer: boolean): Peer {
    const existing = this.peers.get(userId);
    if (existing) return existing;

    const create = this.deps.createPeerConnection;
    const pc = create
      ? create({ iceServers: this.deps.iceServers })
      : new RTCPeerConnection({ iceServers: this.deps.iceServers, bundlePolicy: 'max-bundle' });

    const stream = this.deps.localStream();
    const track = stream?.getAudioTracks()[0] ?? null;
    if (track) {
      pc.addTrack(track, stream ?? new MediaStream([track]));
    }

    const peer: Peer = {
      userId,
      pc,
      offerer,
      audio: null,
      monitor: null,
      pending: [],
      remoteSet: false,
      offered: false,
      state: 'new',
      restarting: false,
      restartTimer: null,
    };
    this.peers.set(userId, peer);

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate: VoiceIceCandidate = {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment,
      };
      this.deps.send({ t: 'voice.ice', to: userId, candidate });
    };

    pc.ontrack = (event) => {
      const remote = event.streams[0] ?? new MediaStream([event.track]);
      this.attachRemote(peer, remote);
    };

    pc.onconnectionstatechange = () => {
      const state = this.mapConnectionState(pc.connectionState);
      peer.state = state;
      this.deps.onPeerState(userId, state);
      if (state === 'failed') this.scheduleIceRestart(peer);
    };

    this.startMonitor();
    return peer;
  }

  private attachRemote(peer: Peer, stream: MediaStream): void {
    if (peer.audio) {
      peer.audio.srcObject = stream;
      return;
    }
    const create = this.deps.createAudioElement ?? (() => new Audio());
    const audio = create();
    audio.autoplay = true;
    audio.srcObject = stream;
    audio.muted = this.deafened;
    audio.volume = this.volume;
    (this.deps.attachAudio ?? ((element) => document.body.appendChild(element)))(audio);
    peer.audio = audio;
    void this.applySink(audio);
    void audio.play().catch(() => undefined);

    const monitor = (this.deps.createMonitor ?? defaultMonitor)(stream);
    peer.monitor = monitor;
  }

  private async applySink(audio: HTMLAudioElement): Promise<void> {
    if (this.sinkDeviceId === 'default') return;
    const target = audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof target.setSinkId !== 'function') return;
    try {
      await target.setSinkId(this.sinkDeviceId);
    } catch {
      this.deps.onAudioError('That speaker is no longer available. Using the system default.');
      this.sinkDeviceId = 'default';
    }
  }

  private async flush(peer: Peer): Promise<void> {
    const queued = peer.pending;
    peer.pending = [];
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch {
        // Stale candidate from a previous negotiation.
      }
    }
  }

  /** Opus is speech: ~48 kbps is transparent enough and DTX saves idle bandwidth. */
  private async tune(peer: Peer): Promise<void> {
    try {
      const sender = peer.pc.getSenders().find((item) => item.track?.kind === 'audio');
      if (!sender) return;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      for (const encoding of params.encodings) {
        encoding.maxBitrate = MAX_OPUS_BITRATE;
        (encoding as RTCRtpEncodingParameters & { dtx?: boolean }).dtx = true;
      }
      await sender.setParameters(params);
    } catch {
      // Not all WebRTC implementations expose mutable sender parameters.
    }
  }

  private scheduleIceRestart(peer: Peer): void {
    if (!peer.offerer || peer.restarting) return;
    peer.restarting = true;
    peer.restartTimer = setTimeout(async () => {
      if (!this.peers.has(peer.userId)) return;
      try {
        const offer = await peer.pc.createOffer({ iceRestart: true });
        await peer.pc.setLocalDescription(offer);
        const sdp = peer.pc.localDescription?.sdp ?? offer.sdp ?? '';
        if (sdp) this.deps.send({ t: 'voice.offer', to: peer.userId, sdp });
      } catch {
        // The store surfaces the failed connection state; a later rejoin retries.
      }
    }, 900 + Math.random() * 400);
  }

  private fail(peer: Peer, message: string): void {
    peer.state = 'failed';
    this.deps.onPeerState(peer.userId, 'failed');
    this.deps.onAudioError(message);
  }

  private mapConnectionState(state: RTCPeerConnectionState): VoiceConnectionState {
    switch (state) {
      case 'connected':
        return 'connected';
      case 'connecting':
        return 'connecting';
      case 'disconnected':
        return 'reconnecting';
      case 'failed':
        return 'failed';
      case 'closed':
        return 'failed';
      default:
        return 'new';
    }
  }

  private startMonitor(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => {
      for (const peer of this.peers.values()) {
        if (!peer.monitor) continue;
        this.deps.onRemoteLevel(peer.userId, peer.monitor.level());
      }
    }, MONITOR_INTERVAL_MS);
  }

  private stopMonitor(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }
}
