import { useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Gamepad2,
  Headphones,
  Maximize2,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Settings2,
  VolumeX,
} from 'lucide-react';
import { isTauri } from '@/lib/ipc';
import { useUi } from '@/state/ui';
import { useVoice } from '@/state/voice';
import { useVoiceRoom } from '@/state/voiceRoom';
import { useWorkspace } from '@/state/workspace';
import { useStreamRoom } from '@/state/streamRoom';
import { useControlRoom } from '@/state/controlRoom';
import { IconButton } from '@/components/ui';
import './voice.css';

const VOICE_STATUS_LABEL: Record<string, string> = {
  joining: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Voice failed',
};

export function VoiceDock() {
  const settings = useWorkspace((state) => state.settings);
  const capturing = useVoice((state) => state.capturing);
  const micEnabled = useVoice((state) => state.micEnabled);
  const localDeafened = useVoice((state) => state.deafened);
  const start = useVoice((state) => state.start);
  const setMicEnabled = useVoice((state) => state.setMicEnabled);
  const setLocalDeafened = useVoice((state) => state.setDeafened);
  const openModal = useUi((state) => state.openModal);
  const pushToast = useUi((state) => state.pushToast);

  const inVoice = useVoiceRoom((state) => Boolean(state.roomId));
  const voiceStatus = useVoiceRoom((state) => state.status);
  const voiceRoomName = useVoiceRoom((state) => state.roomName);
  const voiceMuted = useVoiceRoom((state) => state.muted);
  const voiceDeafened = useVoiceRoom((state) => state.deafened);
  const voiceError = useVoiceRoom((state) => state.error);
  const peers = useVoiceRoom((state) => Object.keys(state.participants).length);
  const toggleVoiceMuted = useVoiceRoom((state) => state.toggleMuted);
  const toggleVoiceDeafened = useVoiceRoom((state) => state.toggleDeafened);
  const leaveVoice = useVoiceRoom((state) => state.leave);

  const view = useUi((state) => state.view);
  const rooms = useWorkspace((state) => state.rooms);
  const currentRoom = view.kind === 'room' ? rooms.find((room) => room.id === view.roomId) : null;
  const streamSession = useStreamRoom((state) => state.session);
  const streamHosting = useStreamRoom((state) => state.hosting);
  const streamWatching = useStreamRoom((state) => state.watching);
  const watchStream = useStreamRoom((state) => state.watch);
  const unwatchStream = useStreamRoom((state) => state.unwatch);
  const stopStream = useStreamRoom((state) => state.stopHosting);
  const controlSession = useControlRoom((state) => state.session);
  const controlLocal = useControlRoom((state) => state.local);
  const requestControl = useControlRoom((state) => state.request);
  const cancelControl = useControlRoom((state) => state.cancel);
  const releaseControl = useControlRoom((state) => state.release);
  const startControlling = useControlRoom((state) => state.startControlling);
  const controlRoomId = useControlRoom((state) => state.roomId);
  const controlAvailable = Boolean(
    currentRoom &&
      currentRoom.id === controlRoomId &&
      controlSession?.enabled &&
      currentRoom.isOwned === false,
  );
  const controlling = controlLocal === 'active' || controlLocal === 'connecting';
  const controlLabel = controlling
    ? 'Release control'
    : controlLocal === 'granted'
      ? 'Start controlling'
      : controlLocal === 'requesting'
        ? 'Cancel control request'
        : 'Request remote control';
  const shareDisabled =
    !streamHosting && !streamWatching && !streamSession && !currentRoom?.isOwned;

  const toggleStream = () => {
    if (streamHosting) {
      stopStream();
      return;
    }
    if (streamWatching) {
      unwatchStream();
      return;
    }
    if (streamSession) {
      watchStream();
      return;
    }
    if (currentRoom) openModal('stream', { roomId: currentRoom.id, mode: 'window' });
  };

  const streamLabel = streamHosting
    ? 'Stop sharing'
    : streamWatching
      ? 'Leave stream'
      : streamSession
        ? 'Watch stream'
        : 'Share screen';
  const streamTitle = streamHosting
    ? 'Stop sharing your screen with this room'
    : streamWatching
      ? 'Stop watching the stream; voice and room membership stay connected'
      : streamSession
        ? `Watch ${streamSession.host.displayName}'s stream`
        : shareDisabled
          ? 'Only the room host can start a stream'
          : 'Share a game window or display with this room';

  const micLive = inVoice ? !voiceMuted : capturing && micEnabled;
  const micMuted = inVoice ? voiceMuted : capturing && !micEnabled;
  const deafened = inVoice ? voiceDeafened : localDeafened;

  const toggleMic = useCallback(async () => {
    if (inVoice) {
      toggleVoiceMuted();
      return;
    }
    if (!capturing) {
      const ok = await start({
        deviceId: settings.micDeviceId,
        noiseSuppression: settings.noiseSuppression,
        echoCancellation: settings.echoCancellation,
        autoGainControl: settings.autoGainControl,
        inputVolume: settings.inputVolume,
      });
      if (ok) {
        setMicEnabled(true);
        pushToast('Microphone live — local monitor only', 'success');
      } else {
        const error = useVoice.getState().error;
        pushToast(error ?? 'Microphone could not start', 'error');
        openModal('mic-test');
      }
      return;
    }
    setMicEnabled(!micEnabled);
    pushToast(micEnabled ? 'Microphone muted' : 'Microphone unmuted');
  }, [capturing, inVoice, micEnabled, openModal, pushToast, setMicEnabled, settings, start, toggleVoiceMuted]);

  const toggleDeafen = useCallback(() => {
    if (inVoice) {
      toggleVoiceDeafened();
      return;
    }
    setLocalDeafened(!localDeafened);
  }, [inVoice, localDeafened, setLocalDeafened, toggleVoiceDeafened]);

  const toggleFullscreen = useCallback(() => {
    if (!isTauri()) {
      pushToast('Fullscreen is available in the desktop build');
      return;
    }
    const win = getCurrentWindow();
    void win.isFullscreen().then((full) => win.setFullscreen(!full)).catch(() => undefined);
  }, [pushToast]);

  const baseStatus = inVoice
    ? voiceStatus === 'connected'
      ? `${voiceRoomName ?? 'Voice'} · ${peers + 1}`
      : VOICE_STATUS_LABEL[voiceStatus] ?? 'In voice'
    : capturing
      ? 'Mic check'
      : 'Not in voice';
  const statusText =
    baseStatus +
    (streamHosting ? ' · Sharing' : streamWatching ? ' · Watching' : '') +
    (controlling ? ' · Controlling' : controlLocal === 'requesting' ? ' · Queued' : '');
  const dotState = inVoice
    ? voiceStatus === 'connected'
      ? 'live'
      : voiceStatus === 'error'
        ? 'error'
        : 'warn'
    : capturing
      ? 'local'
      : 'idle';

  return (
    <>
      <div className="md-dock" role="toolbar" aria-label="Voice controls">
        <div className="md-dock__group">
          <button
            type="button"
            className="md-dock__mic"
            data-live={micLive}
            data-muted={micMuted}
            aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
            aria-pressed={micMuted}
            onClick={() => void toggleMic()}
            title={
              inVoice
                ? micMuted
                  ? 'Unmute microphone (Ctrl+Shift+M)'
                  : 'Mute microphone (Ctrl+Shift+M)'
                : capturing
                  ? micMuted
                    ? 'Unmute microphone (Ctrl+Shift+M)'
                    : 'Mute microphone (Ctrl+Shift+M)'
                  : 'Start a local mic check'
            }
          >
            {micMuted ? <MicOff size={17} /> : <Mic size={17} />}
          </button>

          <button
            type="button"
            className="md-dock__round"
            data-active={deafened}
            aria-label={deafened ? 'Undeafen' : 'Deafen'}
            aria-pressed={deafened}
            onClick={toggleDeafen}
            title={
              deafened
                ? 'Undeafen (Ctrl+D)'
                : inVoice
                  ? 'Deafen — stop hearing everyone in voice (Ctrl+D)'
                  : 'Deafen (Ctrl+D)'
            }
          >
            {deafened ? <VolumeX size={17} /> : <Headphones size={17} />}
          </button>

          {inVoice ? (
            <button
              type="button"
              className="md-dock__round"
              data-active={false}
              aria-label="Leave voice"
              onClick={() => leaveVoice()}
              title="Leave voice"
            >
              <PhoneOff size={17} />
            </button>
          ) : null}
        </div>

        <span className="md-dock__divider" aria-hidden="true" />

        <div className="md-dock__group">
          <button
            type="button"
            className="md-dock__round"
            data-active={streamHosting || streamWatching}
            data-stream-host={streamHosting}
            aria-label={streamLabel}
            aria-pressed={streamHosting || streamWatching}
            disabled={shareDisabled}
            title={streamTitle}
            onClick={toggleStream}
          >
            <MonitorUp size={17} />
          </button>
          <button
            type="button"
            className="md-dock__round"
            aria-label={controlLabel}
            aria-pressed={controlling}
            data-active={controlling}
            disabled={!controlAvailable}
            title={
              controlAvailable
                ? controlLabel
                : currentRoom?.isOwned
                  ? 'You are the host — grant control from the room panel'
                  : controlSession?.enabled
                    ? 'Open the room to request control'
                    : 'The host has not enabled remote control'
            }
            onClick={() => {
              if (controlling) releaseControl();
              else if (controlLocal === 'granted') void startControlling();
              else if (controlLocal === 'requesting') cancelControl();
              else requestControl();
            }}
          >
            <Gamepad2 size={17} />
          </button>
          <span
            className="md-dock__status"
            title={
              voiceError
                ? voiceError
                : inVoice
                  ? `Voice channel: ${voiceRoomName ?? 'room'}`
                  : capturing
                    ? 'Microphone is only being monitored on this PC'
                    : 'You are not in a voice channel'
            }
          >
            <span className="md-dock__status-dot" data-state={dotState} />
            {statusText}
          </span>
        </div>
      </div>

      <div className="md-dock-aside">
        <IconButton
          round
          label="Microphone and audio settings"
          onClick={() => openModal('mic-test')}
        >
          <Settings2 size={16} />
        </IconButton>
        <IconButton round label="Toggle fullscreen (F11)" onClick={toggleFullscreen}>
          <Maximize2 size={16} />
        </IconButton>
      </div>
    </>
  );
}

/** Small helper kept here for future window-mode controls. */
export function restoreWindow() {
  if (!isTauri()) return;
  void getCurrentWindow().unmaximize().catch(() => undefined);
}
