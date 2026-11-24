import type { ControlGrantView, VoiceIceCandidate } from '@shared/protocol';
import { candidateInit } from '@/lib/voice/model';
import {
  INPUT_MAX_BUFFERED_BYTES,
  InputReceiver,
  encodeInputMessage,
  parseInputMessage,
  type InputFrame,
} from './input';

/* --------------------------------------------------------------------------
   Control transport.

   Input uses its own RTCPeerConnection with one reliable, ordered data
   channel. It is deliberately separate from video and voice:

   - a voice negotiation can never affect input, and vice versa;
   - the controller is the offerer (the host always offers video), so a person
     can control without watching and a video restart cannot drop input;
   - the host answers only while it holds a grant for that controller, checks
     the grant token in the channel's hello message, and destroys the whole
     connection on revoke. Late frames therefore have nowhere to go.

   Nothing here trusts the network for authorization: the server decides who may
   signal, and the host independently checks the grant and sequence numbers.
   -------------------------------------------------------------------------- */

export type ControlClientSignal =
  | { t: 'control.offer'; to: string; grantId: string; sdp: string }
  | { t: 'control.answer'; to: string; grantId: string; sdp: string }
  | {
      t: 'control.ice';
      to: string;
      grantId: string;
      candidate: VoiceIceCandidate;
    };

export interface ControllerDeps {
  iceServers: RTCIceServer[];
  send: (signal: ControlClientSignal) => void;
  onOpen: () => void;
  onClosed: (reason: string) => void;
  onLatency: (ms: number) => void;
  onError: (message: string) => void;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

export interface HostControlDeps {
  iceServers: RTCIceServer[];
  grant: ControlGrantView;
  send: (signal: ControlClientSignal) => void;
  /** The verified input channel is open and the token matched. */
  onActive: () => void;
  /** The channel died without a revoke; the host must invalidate the grant. */
  onClosed: (reason: string) => void;
  onInput: (frame: InputFrame) => Promise<void>;
  onError: (message: string) => void;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

function mapState(state: RTCPeerConnectionState): string | null {
  if (state === 'failed' || state === 'closed') return 'The control connection failed.';
  return null;
}

export class ControlControllerSession {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private grant: ControlGrantView | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private open = false;
  private closedByUs = false;
  private sent = new Map<number, number>();

  constructor(private readonly deps: ControllerDeps) {}

  get isOpen(): boolean {
    return this.open;
  }

  async start(grant: ControlGrantView): Promise<void> {
    this.stop();
    this.closedByUs = false;
    this.grant = grant;

    const config: RTCConfiguration = {
      iceServers: this.deps.iceServers,
      bundlePolicy: 'max-bundle',
    };
    const create = this.deps.createPeerConnection;
    const pc = create ? create(config) : new RTCPeerConnection(config);
    this.pc = pc;

    pc.onicecandidate = (event) => {
      if (!event.candidate || !this.grant) return;
      this.deps.send({
        t: 'control.ice',
        // Candidates belong to the host's peer, never to the controller.
        to: this.grant.hostUserId,
        grantId: this.grant.grantId,
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment,
        },
      });
    };
    pc.onconnectionstatechange = () => {
      const failure = mapState(pc.connectionState);
      if (failure && !this.closedByUs) {
        this.deps.onError(failure);
        this.stop();
      }
    };

    const channel = pc.createDataChannel('meldrift-input', { ordered: true });
    this.channel = channel;
    channel.onopen = () => {
      if (!this.grant) return;
      channel.send(
        encodeInputMessage({
          t: 'hello',
          grantId: this.grant.grantId,
          token: this.grant.token,
        }),
      );
      this.open = true;
      this.deps.onOpen();
    };
    channel.onclose = () => {
      if (this.closedByUs) return;
      const wasOpen = this.open;
      this.open = false;
      if (wasOpen) this.deps.onClosed('The control channel closed.');
    };
    channel.onmessage = (event) => {
      const message = parseInputMessage(event.data);
      if (!message || message.t !== 'ack') return;
      const sentAt = this.sent.get(message.seq);
      if (sentAt === undefined) return;
      this.sent.delete(message.seq);
      this.deps.onLatency(Math.max(0, Math.round(performance.now() - sentAt)));
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp ?? offer.sdp ?? '';
      if (!sdp) throw new Error('empty offer');
      this.deps.send({
        t: 'control.offer',
        // The host is the only possible target; the server verifies it.
        to: grant.hostUserId,
        grantId: grant.grantId,
        sdp,
      });
    } catch {
      this.deps.onError('The control channel offer could not be created.');
      this.stop();
    }
  }

  async handleAnswer(grantId: string, sdp: string): Promise<void> {
    if (!this.pc || !this.grant || grantId !== this.grant.grantId) return;
    try {
      await this.pc.setRemoteDescription({ type: 'answer', sdp });
      this.remoteSet = true;
      for (const candidate of this.pendingIce.splice(0)) {
        await this.pc.addIceCandidate(candidate).catch(() => undefined);
      }
    } catch {
      this.deps.onError('The host rejected the control channel.');
      this.stop();
    }
  }

  async handleIce(grantId: string, candidate: VoiceIceCandidate): Promise<void> {
    if (!this.pc || !this.grant || grantId !== this.grant.grantId) return;
    const init = candidateInit(candidate);
    if (!this.remoteSet) {
      this.pendingIce.push(init);
      return;
    }
    try {
      await this.pc.addIceCandidate(init);
    } catch {
      // Candidate for an abandoned negotiation.
    }
  }

  /** Sends one frame. Returns false when the channel is not usable. */
  send(frame: InputFrame): boolean {
    const channel = this.channel;
    if (!this.open || !channel || channel.readyState !== 'open') return false;
    const transitional = frame.keys.length > 0 || frame.buttons.length > 0;
    if (!transitional && channel.bufferedAmount > INPUT_MAX_BUFFERED_BYTES) return false;
    try {
      channel.send(encodeInputMessage(frame));
      this.sent.set(frame.seq, performance.now());
      if (this.sent.size > 120) {
        const oldest = this.sent.keys().next().value;
        if (oldest !== undefined) this.sent.delete(oldest);
      }
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.closedByUs = true;
    this.open = false;
    this.remoteSet = false;
    this.pendingIce = [];
    this.sent.clear();
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onmessage = null;
      try {
        channel.close();
      } catch {
        // Already closed.
      }
    }
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // Already closed.
      }
    }
    this.grant = null;
  }
}

export class ControlHostSession {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private readonly receiver: InputReceiver;
  private closedByUs = false;
  private active = false;

  constructor(private readonly deps: HostControlDeps) {
    this.receiver = new InputReceiver(deps.grant.grantId, deps.grant.token);
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Called only after the host has armed the target and sent the approval. */
  async handleOffer(grantId: string, sdp: string): Promise<void> {
    if (grantId !== this.deps.grant.grantId) {
      this.deps.onError('A control offer arrived for an expired grant.');
      return;
    }

    if (!this.pc) {
      const config: RTCConfiguration = {
        iceServers: this.deps.iceServers,
        bundlePolicy: 'max-bundle',
      };
      const create = this.deps.createPeerConnection;
      const pc = create ? create(config) : new RTCPeerConnection(config);
      this.pc = pc;
      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        this.deps.send({
          t: 'control.ice',
          to: this.deps.grant.controller.userId,
          grantId: this.deps.grant.grantId,
          candidate: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment,
          },
        });
      };
      pc.ondatachannel = (event) => this.attach(event.channel);
      pc.onconnectionstatechange = () => {
        const failure = mapState(pc.connectionState);
        if (failure && !this.closedByUs) this.fail(failure);
      };
    }

    try {
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
      this.remoteSet = true;
      for (const candidate of this.pendingIce.splice(0)) {
        await this.pc.addIceCandidate(candidate).catch(() => undefined);
      }
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      const localSdp = this.pc.localDescription?.sdp ?? answer.sdp ?? '';
      if (!localSdp) throw new Error('empty answer');
      this.deps.send({
        t: 'control.answer',
        to: this.deps.grant.controller.userId,
        grantId: this.deps.grant.grantId,
        sdp: localSdp,
      });
    } catch {
      this.fail('The control channel could not be answered.');
    }
  }

  async handleIce(grantId: string, candidate: VoiceIceCandidate): Promise<void> {
    if (grantId !== this.deps.grant.grantId || !this.pc) return;
    const init = candidateInit(candidate);
    if (!this.remoteSet) {
      this.pendingIce.push(init);
      return;
    }
    try {
      await this.pc.addIceCandidate(init);
    } catch {
      // Candidate for an abandoned negotiation.
    }
  }

  private attach(channel: RTCDataChannel): void {
    if (channel.label !== 'meldrift-input') {
      channel.close();
      return;
    }
    this.channel = channel;
    channel.onmessage = (event) => {
      void this.receive(event.data);
    };
    channel.onclose = () => {
      if (!this.closedByUs) this.fail('The controller’s input channel closed.');
    };
  }

  private async receive(raw: unknown): Promise<void> {
    const message = parseInputMessage(raw);
    if (!message) return;

    if (message.t === 'hello') {
      if (!this.receiver.handshake(message)) return;
      this.active = true;
      this.deps.onActive();
      return;
    }
    if (message.t !== 'input') return;

    if (this.receiver.accept(message) !== 'accepted') return;
    try {
      await this.deps.onInput(message);
    } catch (error) {
      this.deps.onError(
        error instanceof Error ? error.message : 'The host could not apply remote input.',
      );
      return;
    }
    const channel = this.channel;
    if (channel && channel.readyState === 'open') {
      try {
        channel.send(encodeInputMessage({ t: 'ack', seq: message.seq }));
      } catch {
        // Ack loss only affects the latency display.
      }
    }
  }

  private fail(reason: string): void {
    if (this.closedByUs) return;
    this.active = false;
    this.deps.onClosed(reason);
    this.close();
  }

  close(): void {
    this.closedByUs = true;
    this.active = false;
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      channel.onmessage = null;
      channel.onclose = null;
      try {
        channel.close();
      } catch {
        // Already closed.
      }
    }
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      pc.onicecandidate = null;
      pc.ondatachannel = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        // Already closed.
      }
    }
    this.pendingIce = [];
  }
}
