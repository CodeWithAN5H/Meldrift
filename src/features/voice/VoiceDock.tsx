import { useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Gamepad2,
  Headphones,
  Maximize2,
  Mic,
  MicOff,
  MonitorUp,
  Settings2,
  VolumeX,
} from 'lucide-react';
import { isTauri } from '@/lib/ipc';
import { useUi } from '@/state/ui';
import { useVoice } from '@/state/voice';
import { useWorkspace } from '@/state/workspace';
import { IconButton } from '@/components/ui';
import './voice.css';

export function VoiceDock() {
  const settings = useWorkspace((state) => state.settings);
  const capturing = useVoice((state) => state.capturing);
  const micEnabled = useVoice((state) => state.micEnabled);
  const deafened = useVoice((state) => state.deafened);
  const start = useVoice((state) => state.start);
  const setMicEnabled = useVoice((state) => state.setMicEnabled);
  const setDeafened = useVoice((state) => state.setDeafened);
  const openModal = useUi((state) => state.openModal);
  const pushToast = useUi((state) => state.pushToast);

  const toggleMic = useCallback(async () => {
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
        pushToast('Microphone live — local monitor', 'success');
      } else {
        const error = useVoice.getState().error;
        pushToast(error ?? 'Microphone could not start', 'error');
        openModal('mic-test');
      }
      return;
    }
    setMicEnabled(!micEnabled);
    pushToast(micEnabled ? 'Microphone muted' : 'Microphone unmuted');
  }, [capturing, micEnabled, openModal, pushToast, setMicEnabled, settings, start]);

  const toggleFullscreen = useCallback(() => {
    if (!isTauri()) {
      pushToast('Fullscreen is available in the desktop build');
      return;
    }
    const win = getCurrentWindow();
    void win.isFullscreen().then((full) => win.setFullscreen(!full)).catch(() => undefined);
  }, [pushToast]);

  return (
    <>
      <div className="md-dock" role="toolbar" aria-label="Voice controls">
        <div className="md-dock__group">
          <button
            type="button"
            className="md-dock__mic"
            data-live={capturing && micEnabled}
            data-muted={capturing && !micEnabled}
            aria-label={micEnabled ? 'Mute microphone' : 'Unmute microphone'}
            aria-pressed={!micEnabled}
            onClick={() => void toggleMic()}
            title={
              capturing
                ? micEnabled
                  ? 'Mute microphone (Ctrl+Shift+M)'
                  : 'Unmute microphone (Ctrl+Shift+M)'
                : 'Start microphone'
            }
          >
            {micEnabled ? <Mic size={17} /> : <MicOff size={17} />}
          </button>

          <button
            type="button"
            className="md-dock__round"
            data-active={deafened}
            aria-label={deafened ? 'Undeafen' : 'Deafen'}
            aria-pressed={deafened}
            onClick={() => setDeafened(!deafened)}
            title={deafened ? 'Undeafen (Ctrl+D)' : 'Deafen (Ctrl+D)'}
          >
            {deafened ? <VolumeX size={17} /> : <Headphones size={17} />}
          </button>
        </div>

        <span className="md-dock__divider" aria-hidden="true" />

        <div className="md-dock__group">
          <button
            type="button"
            className="md-dock__round"
            aria-label="Share screen"
            disabled
            title="Screen and game capture arrives in milestone M4"
          >
            <MonitorUp size={17} />
          </button>
          <button
            type="button"
            className="md-dock__round"
            aria-label="Game session controls"
            disabled
            title="Live game sessions arrive in milestone M4"
          >
            <Gamepad2 size={17} />
          </button>
          <span className="md-dock__status" title="No peer connection is open">
            <span className="md-dock__status-dot" data-state={capturing ? 'local' : 'idle'} />
            {capturing ? 'Local' : 'Offline'}
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
