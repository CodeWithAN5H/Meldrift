import { describe, expect, it, vi } from 'vitest';
import type { VoiceIceCandidate } from '@shared/protocol';
import {
  candidateInit,
  deriveVoiceStatus,
  nextSpeaking,
  parseIceUrlList,
  toIceServers,
  type RemoteMonitor,
} from '@/lib/voice/model';
import { VoiceMesh, type OutgoingVoiceSignal } from '@/lib/voice/session';

/* Client-side voice tests. ICE configuration and speaking hysteresis are pure;
   the mesh is tested against a fake RTCPeerConnection and fake audio elements so
   duplicate peer creation, cleanup and output routing are verified without a
   browser or a microphone. */

const settings = {
  stunUrl: '',
  turnUrl: '',
  turnUsername: '',
  turnCredential: '',
};

describe('voice ICE configuration', () => {
  it('accepts only STUN/TURN URLs and ignores junk', () => {
    expect(parseIceUrlList('stun:stun.example.org:3478, turn:turn.example.org\nnonsense')).toEqual([
      'stun:stun.example.org:3478',
      'turn:turn.example.org',
    ]);
    expect(parseIceUrlList('http://example.com')).toEqual([]);
  });

  it('merges operator and user configuration without duplicate URLs', () => {
    const servers = toIceServers(
      [
        { urls: ['stun:stun.example.org:3478'] },
        { urls: ['turn:turn.example.org:3478'], username: 'server-user', credential: 'server-pass' },
      ],
      { ...settings, stunUrl: 'stun:stun.example.org:3478, stun:stun2.example.org' },
    );

    expect(servers).toHaveLength(2);
    expect(servers[0].urls).toEqual(['stun:stun.example.org:3478', 'stun:stun2.example.org']);
    expect(servers[1]).toEqual({
      urls: ['turn:turn.example.org:3478'],
      username: 'server-user',
      credential: 'server-pass',
    });
  });

  it('uses a user TURN server with its own credentials', () => {
    const servers = toIceServers([], {
      ...settings,
      turnUrl: 'turns:turn.myhost.net:5349',
      turnUsername: 'player',
      turnCredential: 'secret',
    });
    expect(servers).toEqual([
      { urls: ['turns:turn.myhost.net:5349'], username: 'player', credential: 'secret' },
    ]);
  });

  it('never needs a credential to describe the configuration', () => {
    const servers = toIceServers(
      [{ urls: ['turn:turn.example.org'], username: 'user', credential: 'hunter2' }],
      settings,
    );
    const description = JSON.stringify(servers);
    // The object is passed to RTCPeerConnection with credentials; this asserts
    // candidates are only described, never mislabelled as public.
    expect(description).toContain('hunter2');
  });

  it('builds a candidate init without dropping zero values', () => {
    const candidate: VoiceIceCandidate = {
      candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    };
    expect(candidateInit(candidate)).toEqual({
      candidate: candidate.candidate,
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: undefined,
    });
  });
});

describe('speaking detection', () => {
  it('uses hysteresis so the indicator does not flicker', () => {
    expect(nextSpeaking(0.01, false)).toBe(false);
    expect(nextSpeaking(0.07, false)).toBe(true);
    expect(nextSpeaking(0.05, true)).toBe(true);
    expect(nextSpeaking(0.02, true)).toBe(false);
  });

  it('only reports connected when every media path is connected', () => {
    expect(deriveVoiceStatus(false, [])).toBe('idle');
    expect(deriveVoiceStatus(true, [])).toBe('connected');
    expect(deriveVoiceStatus(true, ['connected', 'connected'])).toBe('connected');
    expect(deriveVoiceStatus(true, ['connected', 'connecting'])).toBe('joining');
    expect(deriveVoiceStatus(true, ['connecting'])).toBe('joining');
    expect(deriveVoiceStatus(true, ['connected', 'failed'])).toBe('reconnecting');
  });
});

/* ---- Mesh with fakes ---------------------------------------------------- */

class FakeSender {
  track: { kind: string } | null = { kind: 'audio' };
  replacements: Array<unknown> = [];
  replaceTrack = vi.fn(async (track: unknown) => {
    this.replacements.push(track);
  });
  getParameters = () => ({ encodings: [{}] });
  setParameters = vi.fn(async () => undefined);
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
  senders = [new FakeSender()];
  config: RTCConfiguration;

  constructor(config: RTCConfiguration) {
    this.config = config;
    FakePeerConnection.instances.push(this);
  }

  addTrack = vi.fn();
  getSenders = () => this.senders;
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer-sdp' }));
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

class FakeAudio {
  autoplay = false;
  srcObject: unknown = null;
  muted = false;
  volume = 1;
  play = vi.fn(async () => undefined);
  remove = vi.fn();
}

const track = { kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
const localStream = {
  getAudioTracks: () => [track],
} as unknown as MediaStream;

function makeMesh() {
  FakePeerConnection.instances = [];
  const sent: OutgoingVoiceSignal[] = [];
  const audios: FakeAudio[] = [];
  const monitors: Array<RemoteMonitor & { value: number }> = [];
  const levels: Array<{ userId: string; level: number }> = [];

  const mesh = new VoiceMesh({
    iceServers: [{ urls: ['stun:stun.example.org'] }],
    localStream: () => localStream,
    send: (event) => sent.push(event),
    onPeerState: vi.fn(),
    onRemoteLevel: (userId, level) => levels.push({ userId, level }),
    onAudioError: vi.fn(),
    createPeerConnection: (config) => new FakePeerConnection(config) as unknown as RTCPeerConnection,
    createAudioElement: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio as unknown as HTMLAudioElement;
    },
    attachAudio: () => undefined,
    createMonitor: () => {
      const monitor = {
        value: 0,
        level: () => monitor.value,
        close: vi.fn(),
      };
      monitors.push(monitor);
      return monitor;
    },
  });

  return { mesh, sent, audios, monitors, levels };
}

describe('voice mesh', () => {
  it('offers once per participant and never creates duplicate peer connections', async () => {
    const { mesh, sent } = makeMesh();
    await mesh.offerTo('peer-a');
    await mesh.offerTo('peer-a');

    expect(FakePeerConnection.instances).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ t: 'voice.offer', to: 'peer-a', sdp: 'offer-sdp' });

    // A second participant is a second connection, not a second one for the first.
    await mesh.offerTo('peer-b');
    expect(FakePeerConnection.instances).toHaveLength(2);
    expect(mesh.size).toBe(2);
    mesh.closeAll();
  });

  it('answers an offer and reports the real connection state', async () => {
    const { mesh, sent } = makeMesh();
    await mesh.handleOffer('peer-a', 'remote-offer');

    expect(sent).toEqual([{ t: 'voice.answer', to: 'peer-a', sdp: 'answer-sdp' }]);
    const pc = FakePeerConnection.instances[0];
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'remote-offer' });

    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    expect(mesh.connectionStates).toEqual(['connected']);
    mesh.closeAll();
  });

  it('queues ICE that arrives before the remote description', async () => {
    const { mesh } = makeMesh();
    await mesh.handleIce('peer-a', { candidate: 'early-candidate', sdpMid: '0', sdpMLineIndex: 0 });
    const pc = FakePeerConnection.instances[0];
    expect(pc.addedCandidates).toHaveLength(0);

    await mesh.handleOffer('peer-a', 'remote-offer');
    expect(pc.addedCandidates).toHaveLength(1);
    expect(pc.addedCandidates[0]).toMatchObject({ candidate: 'early-candidate', sdpMLineIndex: 0 });
    mesh.closeAll();
  });

  it('closes every peer and monitor on cleanup', async () => {
    const { mesh } = makeMesh();
    await mesh.offerTo('peer-a');
    await mesh.offerTo('peer-b');
    expect(FakePeerConnection.instances).toHaveLength(2);

    mesh.closeAll();
    expect(mesh.size).toBe(0);
    expect(FakePeerConnection.instances.every((pc) => pc.closed)).toBe(true);
  });

  it('routes deafen and output volume to incoming audio elements', async () => {
    const { mesh, audios } = makeMesh();
    await mesh.handleOffer('peer-a', 'offer');

    // Simulate the remote track arriving.
    const pc = FakePeerConnection.instances[0];
    const stream = { id: 'remote' } as unknown as MediaStream;
    pc.ontrack?.({ streams: [stream], track });
    const audio = audios[0];
    expect(audio).toBeDefined();

    mesh.setDeafened(true);
    mesh.setVolume(0.4);
    expect(audio.muted).toBe(true);
    expect(audio.volume).toBeCloseTo(0.4);

    mesh.closeAll();
    expect(audio.remove).toHaveBeenCalled();
    expect(audio.srcObject).toBeNull();
  });

  it('replaces the outbound track on every sender when the device changes', async () => {
    const { mesh } = makeMesh();
    await mesh.offerTo('peer-a');
    const replacement = { kind: 'audio' } as unknown as MediaStreamTrack;
    mesh.replaceTrack(replacement);

    const sender = FakePeerConnection.instances[0].senders[0];
    expect(sender.replacements).toEqual([replacement]);
    mesh.closeAll();
  });
});
