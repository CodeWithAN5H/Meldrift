import { create } from 'zustand';
import type { ClientEvent, ServerEvent, VoiceParticipantView } from '@shared/protocol';
import { describeMediaError, listAudioInputs, voiceEngine } from '@/lib/voice';
import { VoiceMesh } from '@/lib/voice/session';
import {
  deriveVoiceStatus,
  nextSpeaking,
  toIceServers,
  type VoiceConnectionState,
  type VoiceStatus,
} from '@/lib/voice/model';
import { getVoiceTransport } from '@/lib/voice/transport';
import { useWorkspace } from '@/state/workspace';
import { useVoice } from '@/state/voice';
import { useUi } from '@/state/ui';

/* --------------------------------------------------------------------------
   Room voice.

   This store owns the microphone stream, the WebRTC mesh and the signaling
   exchange. It deliberately reports three different things separately:
     - signaling: joined / not joined in a room's voice channel,
     - media: each peer's real RTCPeerConnection state,
     - capture: the actual microphone state.
   The dock only says "connected" when the media path is connected, never just
   because a socket acknowledged something.
   -------------------------------------------------------------------------- */

export interface VoicePeer extends VoiceParticipantView {
  connection: VoiceConnectionState;
  /** True when the audio we are receiving right now contains speech. */
  audible: boolean;
}

interface VoiceRoomState {
  roomId: string | null;
  roomName: string | null;
  selfId: string | null;
  status: VoiceStatus;
  joining: boolean;
  error: string | null;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  participants: Record<string, VoicePeer>;
  join: (roomId: string) => Promise<void>;
  leave: (reason?: string) => void;
  toggleMuted: () => void;
  toggleDeafened: () => void;
  /** Called by the push-to-talk binding: true means the mic may transmit. */
  applyTransmit: (live: boolean) => void;
  handleEvent: (event: ServerEvent) => void;
  onConnection: (status: 'connecting' | 'online' | 'reconnecting' | 'offline') => void;
  handleDeviceChange: () => Promise<void>;
}

let mesh: VoiceMesh | null = null;
let joined = false;
let joinTimer: ReturnType<typeof setTimeout> | null = null;
let levelUnsubscribe: (() => void) | null = null;
let localSpeaking = false;
let lastStateSent = 0;
let rejoinPending = false;

const SPEAKING_SEND_INTERVAL_MS = 250;

function clearJoinTimer(): void {
  if (joinTimer) clearTimeout(joinTimer);
  joinTimer = null;
}

function send(event: ClientEvent): boolean {
  return getVoiceTransport()?.send(event) ?? false;
}

function sendState(force = false): void {
  const state = useVoiceRoom.getState();
  if (!joined || !state.roomId) return;
  const now = Date.now();
  if (!force && now - lastStateSent < SPEAKING_SEND_INTERVAL_MS) return;
  lastStateSent = now;
  send({
    t: 'voice.state',
    roomId: state.roomId,
    muted: state.muted,
    deafened: state.deafened,
    speaking: state.speaking && !state.muted,
  });
}

function refreshStatus(): void {
  const state = useVoiceRoom.getState();
  if (!state.roomId) return;
  if (state.status === 'error') return;
  const connections = Object.values(state.participants).map((participant) => participant.connection);
  const next = deriveVoiceStatus(true, connections);
  if (next !== state.status) useVoiceRoom.setState({ status: next });
}

async function startCapture(): Promise<void> {
  const settings = useWorkspace.getState().settings;
  await voiceEngine.start({
    deviceId: settings.micDeviceId,
    noiseSuppression: settings.noiseSuppression,
    echoCancellation: settings.echoCancellation,
    autoGainControl: settings.autoGainControl,
    gain: settings.inputVolume,
  });
  const state = useVoiceRoom.getState();
  const pushToTalk = useWorkspace.getState().settings.pushToTalk;
  const held = useVoice.getState().pushToTalkHeld;
  const live = !state.muted && (!pushToTalk || held);
  voiceEngine.setMuted(!live);
  useVoice.setState({
    capturing: true,
    starting: false,
    activeInputLabel: voiceEngine.trackLabel,
    error: null,
  });
  await useVoice.getState().refreshInputs();
  voiceEngine.onTrackEnded = () => {
    if (!joined) return;
    useUi.getState().pushToast('Microphone disconnected — left voice', 'error');
    useVoiceRoom.getState().leave('The microphone was disconnected');
  };
}

function stopCapture(): void {
  voiceEngine.onTrackEnded = null;
  void useVoice.getState().stop();
}

function buildMesh(): VoiceMesh {
  const settings = useWorkspace.getState().settings;
  const transport = getVoiceTransport();
  return new VoiceMesh({
    iceServers: toIceServers(transport?.iceServers ?? [], {
      stunUrl: settings.voiceStunUrl,
      turnUrl: settings.voiceTurnUrl,
      turnUsername: settings.voiceTurnUsername,
      turnCredential: settings.voiceTurnCredential,
    }),
    localStream: () => voiceEngine.outboundStream,
    send: (event) => {
      const roomId = useVoiceRoom.getState().roomId;
      if (!roomId) return;
      send({ ...event, roomId } as ClientEvent);
    },
    onPeerState: (userId, connection) => {
      const state = useVoiceRoom.getState();
      const participant = state.participants[userId];
      if (!participant) return;
      useVoiceRoom.setState({
        participants: { ...state.participants, [userId]: { ...participant, connection } },
      });
      refreshStatus();
    },
    onRemoteLevel: (userId, level) => {
      const state = useVoiceRoom.getState();
      const participant = state.participants[userId];
      if (!participant) return;
      const audible = nextSpeaking(level, participant.audible);
      if (audible !== participant.audible) {
        useVoiceRoom.setState({
          participants: {
            ...state.participants,
            [userId]: { ...participant, audible },
          },
        });
      }
    },
    onAudioError: (message) => {
      useUi.getState().pushToast(message, 'error');
    },
  });
}

function startLocalMeter(): void {
  levelUnsubscribe?.();
  localSpeaking = false;
  levelUnsubscribe = voiceEngine.subscribe((level) => {
    const state = useVoiceRoom.getState();
    if (!state.roomId || state.muted) {
      if (state.speaking) useVoiceRoom.setState({ speaking: false });
      return;
    }
    const speaking = nextSpeaking(level, state.speaking);
    if (speaking !== state.speaking) {
      useVoiceRoom.setState({ speaking });
      localSpeaking = speaking;
      sendState();
    }
  });
}

function teardown(reason: string | null): void {
  clearJoinTimer();
  const state = useVoiceRoom.getState();
  if (state.roomId) send({ t: 'voice.leave', roomId: state.roomId });
  joined = false;
  mesh?.closeAll();
  mesh = null;
  levelUnsubscribe?.();
  levelUnsubscribe = null;
  localSpeaking = false;
  stopCapture();
  lastStateSent = 0;
  useVoiceRoom.setState({
    roomId: null,
    roomName: null,
    selfId: null,
    status: reason ? 'error' : 'idle',
    joining: false,
    error: reason,
    speaking: false,
    participants: {},
  });
}

export const useVoiceRoom = create<VoiceRoomState>((set, get) => ({
  roomId: null,
  roomName: null,
  selfId: null,
  status: 'idle',
  joining: false,
  error: null,
  muted: false,
  deafened: false,
  speaking: false,
  participants: {},

  join: async (roomId) => {
    const current = get();
    if (current.roomId === roomId && (current.joining || joined)) return;
    if (current.roomId) get().leave();

    const transport = getVoiceTransport();
    const room = useWorkspace.getState().rooms.find((item) => item.id === roomId);
    if (!transport) {
      useUi.getState().pushToast('Sign in and open a server room to use voice.', 'info');
      return;
    }
    if (!room) {
      useUi.getState().pushToast('That room is not available on this server.', 'error');
      return;
    }

    set({
      roomId,
      roomName: room.name,
      selfId: transport.selfId,
      status: 'joining',
      joining: true,
      error: null,
      participants: {},
      speaking: false,
    });
    joined = false;

    try {
      await startCapture();
    } catch (error) {
      const message = describeMediaError(error);
      useUi.getState().pushToast(message, 'error');
      teardown(message);
      return;
    }

    mesh = buildMesh();
    const settings = useWorkspace.getState().settings;
    mesh.setDeafened(get().deafened);
    mesh.setVolume(settings.outputVolume / 100);
    mesh.setSinkDevice(settings.speakerDeviceId);
    startLocalMeter();

    if (!send({ t: 'voice.join', roomId })) {
      teardown('The server connection dropped before voice could start');
      return;
    }

    clearJoinTimer();
    joinTimer = setTimeout(() => {
      if (joined) return;
      teardown('The server did not answer the voice join');
      useUi.getState().pushToast('Voice join timed out', 'error');
    }, 15_000);
  },

  leave: (reason) => {
    if (!get().roomId && !mesh) {
      if (reason) set({ error: reason, status: 'error' });
      return;
    }
    teardown(reason ?? null);
  },

  toggleMuted: () => {
    const next = !get().muted;
    set({ muted: next, ...(next ? { speaking: false } : {}) });
    voiceEngine.setMuted(next);
    sendState(true);
  },

  toggleDeafened: () => {
    const next = !get().deafened;
    set({ deafened: next });
    mesh?.setDeafened(next);
    sendState(true);
  },

  applyTransmit: (live) => {
    voiceEngine.setMuted(!live);
    const wasMuted = get().muted;
    const nextMuted = !live;
    if (wasMuted !== nextMuted) {
      set({ muted: nextMuted, ...(nextMuted ? { speaking: false } : {}) });
      sendState(true);
    }
  },

  handleEvent: (event) => {
    switch (event.t) {
      case 'voice.joined': {
        if (event.roomId !== get().roomId) return;
        clearJoinTimer();
        joined = true;
        set({ joining: false, status: 'joining', error: null });

        const participants: Record<string, VoicePeer> = {};
        for (const participant of event.participants) {
          const previous = get().participants[participant.userId];
          participants[participant.userId] = {
            ...participant,
            connection: previous?.connection ?? 'new',
            audible: false,
          };
        }
        set({ participants });
        refreshStatus();
        sendState(true);

        // Every roster member is someone this client joined after, so this
        // client offers. Existing peers from a previous socket are discarded:
        // the other side saw the disconnect and closed them.
        for (const participant of event.participants) {
          if (rejoinPending) mesh?.closePeer(participant.userId);
          void mesh?.offerTo(participant.userId);
        }
        rejoinPending = false;
        return;
      }
      case 'voice.participant.joined': {
        if (event.roomId !== get().roomId) return;
        const state = get();
        if (state.participants[event.participant.userId]) return;
        set({
          participants: {
            ...state.participants,
            [event.participant.userId]: {
              ...event.participant,
              connection: 'new',
              audible: false,
            },
          },
        });
        refreshStatus();
        return;
      }
      case 'voice.participant.left': {
        if (event.roomId !== get().roomId) return;
        mesh?.closePeer(event.userId);
        const next = { ...get().participants };
        delete next[event.userId];
        set({ participants: next });
        refreshStatus();
        return;
      }
      case 'voice.participant.state': {
        if (event.roomId !== get().roomId) return;
        const state = get();
        const participant = state.participants[event.userId];
        if (!participant) return;
        set({
          participants: {
            ...state.participants,
            [event.userId]: {
              ...participant,
              muted: event.muted,
              deafened: event.deafened,
              speaking: event.speaking,
            },
          },
        });
        return;
      }
      case 'voice.offer': {
        if (event.roomId !== get().roomId) return;
        void mesh?.handleOffer(event.from, event.sdp);
        return;
      }
      case 'voice.answer': {
        if (event.roomId !== get().roomId) return;
        void mesh?.handleAnswer(event.from, event.sdp);
        return;
      }
      case 'voice.ice': {
        if (event.roomId !== get().roomId) return;
        void mesh?.handleIce(event.from, event.candidate);
        return;
      }
      case 'voice.left': {
        if (event.roomId !== get().roomId) return;
        teardown(null);
        return;
      }
      case 'voice.error': {
        if (event.roomId && event.roomId !== get().roomId) return;
        useUi.getState().pushToast(event.error, 'error');
        if (!joined) teardown(event.error);
        return;
      }
      default:
        return;
    }
  },

  onConnection: (status) => {
    const state = get();
    if (!state.roomId) return;
    if (status === 'online') {
      if (!joined) {
        // The socket came back but the server lost voice membership on close.
        rejoinPending = true;
        set({ joining: true, status: 'reconnecting' });
        if (!send({ t: 'voice.join', roomId: state.roomId })) {
          teardown('The server could not be reached to rejoin voice');
          return;
        }
        clearJoinTimer();
        joinTimer = setTimeout(() => {
          if (joined) return;
          teardown('Voice did not recover after reconnecting');
          useUi.getState().pushToast('Voice could not reconnect', 'error');
        }, 15_000);
        return;
      }
      return;
    }
    if (joined || state.joining) {
      // The socket is gone, so the server has already dropped voice membership;
      // keep the peers (media may survive briefly) and rejoin when it returns.
      joined = false;
      clearJoinTimer();
      set({ status: 'reconnecting' });
    }
  },

  handleDeviceChange: async () => {
    const voice = useVoice.getState();
    await voice.refreshInputs();
    if (!get().roomId || !voiceEngine.active) return;

    const settings = useWorkspace.getState().settings;
    const inputs = await listAudioInputs().catch(() => []);
    const selectedExists =
      settings.micDeviceId === 'default' ||
      inputs.some((device) => device.deviceId === settings.micDeviceId);

    if (selectedExists) return;

    useUi.getState().pushToast('Microphone changed — switching to the default device', 'info');
    // The settings subscription restarts capture and replaces the outbound
    // track on every peer; doing it here too would open two streams.
    await useWorkspace.getState().updateSettings({ micDeviceId: 'default' });
  },
}));

/* ---- Settings and device lifecycle ------------------------------------- */

useWorkspace.subscribe((state, previous) => {
  if (state.settings === previous.settings) return;
  const current = useVoiceRoom.getState();
  if (!current.roomId) return;

  if (state.settings.outputVolume !== previous.settings.outputVolume) {
    mesh?.setVolume(state.settings.outputVolume / 100);
  }
  if (state.settings.speakerDeviceId !== previous.settings.speakerDeviceId) {
    mesh?.setSinkDevice(state.settings.speakerDeviceId);
  }
  const captureChanged =
    state.settings.micDeviceId !== previous.settings.micDeviceId ||
    state.settings.noiseSuppression !== previous.settings.noiseSuppression ||
    state.settings.echoCancellation !== previous.settings.echoCancellation ||
    state.settings.autoGainControl !== previous.settings.autoGainControl;
  if (captureChanged) {
    void (async () => {
      try {
        await startCapture();
        const track = voiceEngine.outboundTrack;
        if (track) mesh?.replaceTrack(track);
      } catch (error) {
        const message = describeMediaError(error);
        useUi.getState().pushToast(message, 'error');
        teardown(message);
      }
    })();
  }
});

if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    void useVoiceRoom.getState().handleDeviceChange();
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (useVoiceRoom.getState().roomId) useVoiceRoom.getState().leave();
  });
}

export { localSpeaking };
