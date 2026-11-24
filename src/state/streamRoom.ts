import { create } from 'zustand';
import type {
  ClientEvent,
  ServerEvent,
  StreamMode,
  StreamParticipantView,
  StreamPreset,
  StreamSessionView,
} from '@shared/protocol';
import { STREAM_MAX_VIEWERS } from '@shared/protocol';
import { getVoiceTransport } from '@/lib/voice/transport';
import { toIceServers } from '@/lib/voice/model';
import { useWorkspace } from '@/state/workspace';
import { useUi } from '@/state/ui';
import {
  adaptEncoding,
  describeCaptureError,
  displayCaptureConstraints,
  initialEncodeState,
  modeLabel,
  type CaptureCeiling,
  type EncodeState,
  type ReceiverStatsSummary,
  type StreamQualityReason,
} from '@/lib/stream/model';
import {
  StreamHostSession,
  StreamViewerSession,
  type VideoConnectionState,
} from '@/lib/stream/session';

/* --------------------------------------------------------------------------
   Room game streaming.

   The host captures through WebView2's getDisplayMedia (Windows Graphics
   Capture behind the scenes), then offers one video-only WebRTC connection to
   each viewer. Voice has separate peer connections in state/voiceRoom.ts, so
   starting or stopping video can never renegotiate or tear down audio.

   Capture is user-initiated and only runs while the host is in the room. A
   track that ends (window closed, user presses the browser's Stop sharing)
   clears the stream instead of showing a frozen frame.
   -------------------------------------------------------------------------- */

export type HostPhase = 'idle' | 'starting' | 'live' | 'error';
export type ViewerPhase = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error';

export interface HostRuntime {
  bitrateKbps: number;
  fps: number;
  width: number | null;
  height: number | null;
  encoder: string | null;
  codec: string | null;
  quality: StreamQualityReason;
}

export interface ViewerRuntime {
  bitrateKbps: number;
  fps: number;
  width: number | null;
  height: number | null;
  dropped: number;
  codec: string | null;
  decoder: string | null;
}

export interface StreamRoomState {
  roomId: string | null;
  session: StreamSessionView | null;
  hosting: boolean;
  watching: boolean;
  hostPhase: HostPhase;
  viewerPhase: ViewerPhase;
  mode: StreamMode;
  preset: StreamPreset;
  error: string | null;
  notice: string | null;
  previewStream: MediaStream | null;
  remoteStream: MediaStream | null;
  captureLabel: string | null;
  viewers: StreamParticipantView[];
  hostRuntime: HostRuntime | null;
  viewerRuntime: ViewerRuntime | null;
  startHosting: (input: { roomId: string; mode: StreamMode; preset: StreamPreset }) => Promise<boolean>;
  switchSource: (input: { roomId: string; mode: StreamMode; preset: StreamPreset }) => Promise<boolean>;
  stopHosting: (reason?: string) => void;
  watch: () => void;
  unwatch: () => void;
  setPreset: (preset: StreamPreset) => void;
  enterRoom: (roomId: string) => void;
  leaveRoom: () => void;
  sync: () => void;
  handleEvent: (event: ServerEvent) => void;
  onConnection: (status: 'connecting' | 'online' | 'reconnecting' | 'offline') => void;
  reset: () => void;
}

let hostSession: StreamHostSession | null = null;
let viewerSession: StreamViewerSession | null = null;
let captureStream: MediaStream | null = null;
let captureTrack: MediaStreamTrack | null = null;
let stoppingCapture = false;
let encodeState: EncodeState = initialEncodeState('auto', { maxHeight: 720, maxFps: 30 });
let hostStartTimer: ReturnType<typeof setTimeout> | null = null;
let viewerStartTimer: ReturnType<typeof setTimeout> | null = null;
let hostStatsTimer: ReturnType<typeof setInterval> | null = null;
let viewerStatsTimer: ReturnType<typeof setInterval> | null = null;
let pendingRewatch = false;
let lastViewerBytes = 0;
let lastViewerSampleAt = 0;
let trackEndedHandler: (() => void) | null = null;

function ceiling(): CaptureCeiling {
  const settings = useWorkspace.getState().settings;
  return { maxHeight: settings.streamHeight, maxFps: settings.streamFps };
}

function send(event: ClientEvent): boolean {
  return getVoiceTransport()?.send(event) ?? false;
}

function streamEvent(event: {
  t: 'stream.stop' | 'stream.watch' | 'stream.unwatch' | 'stream.sync';
  roomId: string;
}): boolean {
  return send(event);
}

function clearTimers(): void {
  if (hostStartTimer) clearTimeout(hostStartTimer);
  if (viewerStartTimer) clearTimeout(viewerStartTimer);
  if (hostStatsTimer) clearInterval(hostStatsTimer);
  if (viewerStatsTimer) clearInterval(viewerStatsTimer);
  hostStartTimer = null;
  viewerStartTimer = null;
  hostStatsTimer = null;
  viewerStatsTimer = null;
}

function detachTrack(): void {
  if (captureTrack && trackEndedHandler) {
    captureTrack.removeEventListener('ended', trackEndedHandler);
  }
  trackEndedHandler = null;
}

function stopCaptureStream(): void {
  detachTrack();
  if (captureStream) {
    captureStream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        // Already stopped.
      }
    });
  }
  captureStream = null;
  captureTrack = null;
}

function closeViewerSession(): void {
  viewerSession?.close();
  viewerSession = null;
  if (viewerStatsTimer) clearInterval(viewerStatsTimer);
  viewerStatsTimer = null;
  if (viewerStartTimer) clearTimeout(viewerStartTimer);
  viewerStartTimer = null;
  lastViewerBytes = 0;
  lastViewerSampleAt = 0;
}

function hostFailure(message: string): void {
  clearTimers();
  hostSession?.closeAll();
  hostSession = null;
  stoppingCapture = true;
  stopCaptureStream();
  stoppingCapture = false;
  useStreamRoom.setState({
    hosting: false,
    hostPhase: 'error',
    error: message,
    previewStream: null,
    captureLabel: null,
    hostRuntime: null,
    session: null,
    viewers: [],
  });
}

function teardownHost(options: { notifyServer: boolean; reason?: string }): void {
  const state = useStreamRoom.getState();
  clearTimers();
  hostSession?.closeAll();
  hostSession = null;
  stoppingCapture = true;
  stopCaptureStream();
  stoppingCapture = false;
  if (options.notifyServer && state.roomId) {
    streamEvent({ t: 'stream.stop', roomId: state.roomId });
  }
  useStreamRoom.setState({
    hosting: false,
    hostPhase: options.reason ? 'error' : 'idle',
    error: options.reason ?? null,
    previewStream: null,
    remoteStream: null,
    captureLabel: null,
    hostRuntime: null,
    session: null,
    viewers: [],
    watching: false,
    viewerPhase: 'idle',
  });
}

function failViewer(message: string): void {
  const state = useStreamRoom.getState();
  if (state.roomId) streamEvent({ t: 'stream.unwatch', roomId: state.roomId });
  closeViewerSession();
  pendingRewatch = false;
  useStreamRoom.setState({
    watching: false,
    viewerPhase: 'error',
    viewerRuntime: null,
    remoteStream: null,
    error: message,
  });
}

async function captureDisplay(mode: StreamMode, preset: StreamPreset): Promise<MediaStream> {
  const constraints = displayCaptureConstraints(mode, preset, ceiling());
  const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  if (stream.getVideoTracks().length === 0) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('The selected source did not provide a video track.');
  }
  return stream;
}

function applyHostTrack(stream: MediaStream, mode: StreamMode, preset: StreamPreset): void {
  const track = stream.getVideoTracks()[0];
  captureStream = stream;
  captureTrack = track;
  stoppingCapture = false;
  trackEndedHandler = () => {
    if (stoppingCapture) return;
    const state = useStreamRoom.getState();
    if (!state.hosting) return;
    teardownHost({ notifyServer: true, reason: 'The shared window or display closed, so streaming stopped.' });
  };
  track.addEventListener('ended', trackEndedHandler);
  const settings = track.getSettings();
  useStreamRoom.setState({
    mode,
    preset,
    previewStream: stream,
    captureLabel: track.label || modeLabel(mode),
    hostRuntime: {
      bitrateKbps: 0,
      fps: settings.frameRate ?? 0,
      width: settings.width ?? null,
      height: settings.height ?? null,
      encoder: null,
      codec: null,
      quality: 'unknown',
    },
  });
}

function startHostStats(): void {
  if (hostStatsTimer) clearInterval(hostStatsTimer);
  hostStatsTimer = setInterval(() => {
    const state = useStreamRoom.getState();
    if (!hostSession || !state.hosting) return;
    void hostSession.collectStats().then(async (stats) => {
      if (!hostSession || !useStreamRoom.getState().hosting) return;
      const analysis = adaptEncoding(
        encodeState,
        stats.sample,
        useStreamRoom.getState().preset,
        ceiling(),
      );
      encodeState = analysis.state;
      await hostSession.applyEncoding(encodeState, useStreamRoom.getState().preset);
      useStreamRoom.setState({
        hostRuntime: {
          bitrateKbps: stats.bitrateKbps,
          fps: stats.framesPerSecond ?? 0,
          width: stats.frameWidth,
          height: stats.frameHeight,
          encoder: stats.encoder,
          codec: stats.codec,
          quality: stats.quality,
        },
      });
    });
  }, 2000);
}

function startViewerStats(): void {
  if (viewerStatsTimer) clearInterval(viewerStatsTimer);
  viewerStatsTimer = setInterval(() => {
    if (!viewerSession) return;
    void viewerSession.collectStats().then((stats: ReceiverStatsSummary | null) => {
      if (!stats || !viewerSession) return;
      const now = performance.now();
      const elapsed = lastViewerSampleAt ? (now - lastViewerSampleAt) / 1000 : 2;
      const deltaBytes = Math.max(0, stats.bytesReceived - lastViewerBytes);
      lastViewerBytes = stats.bytesReceived;
      lastViewerSampleAt = now;
      useStreamRoom.setState({
        viewerRuntime: {
          bitrateKbps: elapsed > 0 ? Math.round((deltaBytes * 8) / elapsed / 1000) : 0,
          fps: stats.framesPerSecond ?? 0,
          width: stats.frameWidth,
          height: stats.frameHeight,
          dropped: stats.framesDropped,
          codec: stats.codec,
          decoder: stats.decoder,
        },
      });
    });
  }, 2000);
}

export const useStreamRoom = create<StreamRoomState>((set, get) => ({
  roomId: null,
  session: null,
  hosting: false,
  watching: false,
  hostPhase: 'idle',
  viewerPhase: 'idle',
  mode: 'window',
  preset: 'auto',
  error: null,
  notice: null,
  previewStream: null,
  remoteStream: null,
  captureLabel: null,
  viewers: [],
  hostRuntime: null,
  viewerRuntime: null,

  startHosting: async ({ roomId, mode, preset }) => {
    const current = get();
    if (current.hosting) return false;
    const transport = getVoiceTransport();
    if (!transport) {
      useUi.getState().pushToast('Sign in to share a screen with a room', 'error');
      return false;
    }
    const room = useWorkspace.getState().rooms.find((item) => item.id === roomId);
    if (!room || !room.isOwned) {
      useUi.getState().pushToast('Only the room host can start a stream', 'error');
      return false;
    }

    clearTimers();
    set({
      roomId,
      hosting: true,
      hostPhase: 'starting',
      watching: false,
      viewerPhase: 'idle',
      mode,
      preset,
      error: null,
      notice: null,
      session: null,
      viewers: [],
      hostRuntime: null,
      previewStream: null,
      remoteStream: null,
    });
    encodeState = initialEncodeState(preset, ceiling());

    let stream: MediaStream;
    try {
      stream = await captureDisplay(mode, preset);
    } catch (error) {
      const message = describeCaptureError(error);
      set({ hosting: false, hostPhase: 'error', error: message });
      useUi.getState().pushToast(message, 'error');
      return false;
    }

    applyHostTrack(stream, mode, preset);
    hostSession = new StreamHostSession({
      iceServers: toIceServers(transport.iceServers, {
        stunUrl: useWorkspace.getState().settings.voiceStunUrl,
        turnUrl: useWorkspace.getState().settings.voiceTurnUrl,
        turnUsername: useWorkspace.getState().settings.voiceTurnUsername,
        turnCredential: useWorkspace.getState().settings.voiceTurnCredential,
      }),
      stream: () => captureStream,
      send: (event) => {
        const activeRoom = get().roomId;
        if (!activeRoom) return;
        send({ ...event, roomId: activeRoom } as ClientEvent);
      },
      // Per-viewer transport state is surfaced through the host's stats and
      // the viewer's own overlay; no roster mutation is needed on every ICE tick.
      onViewerState: () => undefined,
      onError: (message) => useUi.getState().pushToast(message, 'error'),
    });
    await hostSession.applyEncoding(encodeState, preset);
    startHostStats();

    if (!send({ t: 'stream.start', roomId, mode, preset })) {
      hostFailure('The server connection dropped before streaming could start.');
      return false;
    }

    hostStartTimer = setTimeout(() => {
      if (get().hostPhase === 'starting') {
        hostFailure('The server did not confirm the stream. Check the connection and try again.');
      }
    }, 12_000);
    return true;
  },

  switchSource: async ({ roomId, mode, preset }) => {
    const current = get();
    if (!current.hosting || !hostSession) {
      return get().startHosting({ roomId, mode, preset });
    }
    if (current.hostPhase !== 'live') return false;

    let stream: MediaStream;
    try {
      // The picker opens while the old stream keeps running; cancelling it
      // leaves the existing stream untouched.
      stream = await captureDisplay(mode, preset);
    } catch (error) {
      useUi.getState().pushToast(describeCaptureError(error), 'info');
      return false;
    }

    const oldStream = captureStream;
    detachTrack();
    applyHostTrack(stream, mode, preset);
    const track = stream.getVideoTracks()[0];
    await hostSession.replaceTrack(track);
    encodeState = initialEncodeState(preset, ceiling());
    await hostSession.applyEncoding(encodeState, preset);
    send({ t: 'stream.start', roomId, mode, preset });
    if (oldStream && oldStream !== stream) {
      stoppingCapture = true;
      oldStream.getTracks().forEach((item) => {
        try {
          item.stop();
        } catch {
          // Already stopped.
        }
      });
      stoppingCapture = false;
    }
    useUi.getState().pushToast(`Sharing ${modeLabel(mode).toLowerCase()}`, 'success');
    return true;
  },

  stopHosting: (reason) => {
    const wasHosting = get().hosting;
    teardownHost({ notifyServer: wasHosting, reason: reason || undefined });
    if (wasHosting) useUi.getState().pushToast('Stream stopped');
  },

  watch: () => {
    const state = get();
    const session = state.session;
    const transport = getVoiceTransport();
    if (!session || !transport || session.host.userId === transport.selfId) return;
    if (
      state.watching &&
      state.viewerPhase !== 'reconnecting' &&
      state.viewerPhase !== 'error'
    ) {
      return;
    }

    closeViewerSession();
    pendingRewatch = false;
    set({
      watching: true,
      viewerPhase: 'connecting',
      viewerRuntime: null,
      remoteStream: null,
      error: null,
      notice: null,
    });
    if (!streamEvent({ t: 'stream.watch', roomId: session.roomId })) {
      failViewer('The server connection dropped before the stream could start.');
      return;
    }
    viewerStartTimer = setTimeout(() => {
      if (get().viewerPhase === 'connecting') {
        failViewer('The stream did not connect. The host may be offline or the network may be blocking it.');
      }
    }, 20_000);
  },

  unwatch: () => {
    const roomId = get().roomId;
    if (roomId) streamEvent({ t: 'stream.unwatch', roomId });
    closeViewerSession();
    pendingRewatch = false;
    set({
      watching: false,
      viewerPhase: 'idle',
      viewerRuntime: null,
      remoteStream: null,
      notice: null,
      error: null,
    });
  },

  setPreset: (preset) => {
    if (!get().hosting) {
      set({ preset });
      return;
    }
    const roomId = get().roomId;
    encodeState = initialEncodeState(preset, ceiling());
    set({ preset });
    if (roomId) send({ t: 'stream.preset', roomId, preset });
    if (hostSession) void hostSession.applyEncoding(encodeState, preset);
  },

  enterRoom: (roomId) => {
    const state = get();
    if (state.roomId === roomId) {
      get().sync();
      return;
    }
    if (state.hosting) get().stopHosting();
    if (state.watching) get().unwatch();
    clearTimers();
    hostFailureCleanup();
    set({
      roomId,
      session: null,
      hosting: false,
      watching: false,
      hostPhase: 'idle',
      viewerPhase: 'idle',
      error: null,
      notice: null,
      previewStream: null,
      remoteStream: null,
      captureLabel: null,
      viewers: [],
      hostRuntime: null,
      viewerRuntime: null,
    });
    get().sync();
  },

  leaveRoom: () => {
    const state = get();
    if (state.hosting) get().stopHosting();
    if (state.watching) get().unwatch();
    clearTimers();
    hostFailureCleanup();
    pendingRewatch = false;
    set({
      roomId: null,
      session: null,
      hosting: false,
      watching: false,
      hostPhase: 'idle',
      viewerPhase: 'idle',
      error: null,
      notice: null,
      previewStream: null,
      remoteStream: null,
      captureLabel: null,
      viewers: [],
      hostRuntime: null,
      viewerRuntime: null,
    });
  },

  sync: () => {
    const roomId = get().roomId;
    if (!roomId) return;
    streamEvent({ t: 'stream.sync', roomId });
  },

  handleEvent: (event) => {
    switch (event.t) {
      case 'stream.started': {
        const state = get();
        if (event.session.roomId !== state.roomId) return;
        const selfId = getVoiceTransport()?.selfId;
        const isHost = event.session.host.userId === selfId;
        set({
          session: event.session,
          viewers: event.session.viewers,
          mode: event.session.mode,
          preset: event.session.preset,
        });
        if (isHost && state.hosting) {
          if (hostStartTimer) clearTimeout(hostStartTimer);
          hostStartTimer = null;
          set({ hostPhase: 'live', error: null });
        } else if (state.watching) {
          if (viewerStartTimer) clearTimeout(viewerStartTimer);
          viewerStartTimer = null;
          if (pendingRewatch) {
            // The previous socket lost its viewer membership; re-join it and
            // let the host offer again rather than keeping a dead connection.
            pendingRewatch = false;
            get().watch();
          } else {
            set({ viewerPhase: state.viewerPhase === 'live' ? 'live' : 'connecting' });
          }
        }
        return;
      }
      case 'stream.stopped': {
        const state = get();
        if (state.roomId && event.roomId !== state.roomId) return;
        const reason = event.reason ?? 'The stream ended.';
        if (state.hosting) {
          // The server already considers the stream over (host socket loss or
          // a restart); release the capture immediately and say why.
          teardownHost({ notifyServer: false, reason });
        } else if (state.watching) {
          closeViewerSession();
          pendingRewatch = false;
          set({
            watching: false,
            viewerPhase: 'idle',
            remoteStream: null,
            viewerRuntime: null,
            session: null,
            notice: reason,
            error: null,
          });
        } else {
          pendingRewatch = false;
          set({ session: null, viewers: [] });
        }
        return;
      }
      case 'stream.viewers': {
        if (event.roomId !== get().roomId) return;
        set({ viewers: event.viewers });
        return;
      }
      case 'stream.viewer.joined': {
        const state = get();
        if (!state.hosting || !hostSession || event.roomId !== state.roomId) return;
        set({
          viewers: state.viewers.some((viewer) => viewer.userId === event.viewer.userId)
            ? state.viewers
            : [...state.viewers, event.viewer],
        });
        void hostSession.addViewer(event.viewer.userId);
        return;
      }
      case 'stream.viewer.left': {
        const state = get();
        if (!state.hosting) return;
        hostSession?.closePeer(event.userId);
        set({ viewers: state.viewers.filter((viewer) => viewer.userId !== event.userId) });
        return;
      }
      case 'stream.offer': {
        const state = get();
        if (!state.watching || event.roomId !== state.roomId) return;
        if (!viewerSession) {
          const transport = getVoiceTransport();
          if (!transport) return;
          viewerSession = new StreamViewerSession({
            iceServers: toIceServers(transport.iceServers, {
              stunUrl: useWorkspace.getState().settings.voiceStunUrl,
              turnUrl: useWorkspace.getState().settings.voiceTurnUrl,
              turnUsername: useWorkspace.getState().settings.voiceTurnUsername,
              turnCredential: useWorkspace.getState().settings.voiceTurnCredential,
            }),
            send: (signal) => {
              const roomId = get().roomId;
              if (roomId) send({ ...signal, roomId } as ClientEvent);
            },
            onTrack: (remote) => {
              lastViewerBytes = 0;
              lastViewerSampleAt = 0;
              set({ remoteStream: remote, viewerPhase: 'connecting' });
              startViewerStats();
            },
            onState: (connection: VideoConnectionState) => {
              if (connection === 'connected') {
                if (viewerStartTimer) clearTimeout(viewerStartTimer);
                viewerStartTimer = null;
                set({ viewerPhase: 'live', error: null });
              } else if (connection === 'reconnecting') {
                set({ viewerPhase: 'reconnecting' });
              } else if (connection === 'failed') {
                set({ viewerPhase: 'error', error: 'The stream connection failed.' });
              }
            },
            onError: (message) => useUi.getState().pushToast(message, 'error'),
          });
        }
        void viewerSession.handleOffer(event.from, event.sdp);
        return;
      }
      case 'stream.answer': {
        if (event.roomId !== get().roomId || !hostSession) return;
        void hostSession.handleAnswer(event.from, event.sdp);
        return;
      }
      case 'stream.ice': {
        if (event.roomId !== get().roomId) return;
        if (get().hosting) void hostSession?.handleIce(event.from, event.candidate);
        else void viewerSession?.handleIce(event.from, event.candidate);
        return;
      }
      case 'stream.error': {
        if (event.roomId && event.roomId !== get().roomId) return;
        const state = get();
        if (state.hostPhase === 'starting') {
          hostFailure(event.error);
        } else if (state.viewerPhase === 'connecting') {
          failViewer(event.error);
        } else {
          useUi.getState().pushToast(event.error, 'error');
        }
        return;
      }
      default:
        return;
    }
  },

  onConnection: (status) => {
    const state = get();
    if (!state.roomId) return;
    if (status !== 'online') {
      if (state.hosting) {
        teardownHost({
          notifyServer: false,
          reason: 'Your connection dropped, so sharing stopped. Start a new stream when you reconnect.',
        });
      }
      if (state.watching) {
        closeViewerSession();
        pendingRewatch = true;
        set({
          viewerPhase: 'reconnecting',
          remoteStream: null,
          viewerRuntime: null,
        });
      }
      return;
    }
    get().sync();
  },

  reset: () => {
    const state = get();
    if (state.hosting) teardownHost({ notifyServer: true });
    closeViewerSession();
    pendingRewatch = false;
    clearTimers();
    hostFailureCleanup();
    set({
      roomId: null,
      session: null,
      hosting: false,
      watching: false,
      hostPhase: 'idle',
      viewerPhase: 'idle',
      error: null,
      notice: null,
      previewStream: null,
      remoteStream: null,
      captureLabel: null,
      viewers: [],
      hostRuntime: null,
      viewerRuntime: null,
    });
  },
}));

/** Stops any capture that survived a state transition, without touching voice. */
function hostFailureCleanup(): void {
  hostSession?.closeAll();
  hostSession = null;
  stoppingCapture = true;
  stopCaptureStream();
  stoppingCapture = false;
}

export const STREAM_VIEWER_LIMIT = STREAM_MAX_VIEWERS;
