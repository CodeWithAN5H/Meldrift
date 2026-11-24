import { useEffect, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useWorkspace } from '@/state/workspace';
import { useNetwork } from '@/state/network';
import { useUi, type View } from '@/state/ui';
import { useVoice } from '@/state/voice';
import { useVoiceRoom } from '@/state/voiceRoom';
import { isTauri } from '@/lib/ipc';
import { MeldriftMark } from '@/icons/MeldriftMark';
import { Spinner } from '@/components/ui';
import { TitleBar } from './TitleBar';
import { ToastHost } from './ToastHost';
import { NavRail } from './NavRail';
import { RoomSidebar } from '@/features/sidebar/RoomSidebar';
import { ContextPanel } from '@/features/room/ContextPanel';
import { VoiceDock } from '@/features/voice/VoiceDock';
import { HomeView } from '@/features/home/HomeView';
import { FriendsView } from '@/features/friends/FriendsView';
import { RoomsView } from '@/features/rooms/RoomsView';
import { GamesView } from '@/features/games/GamesView';
import { SettingsView } from '@/features/settings/SettingsView';
import { RoomView } from '@/features/room/RoomView';
import { Onboarding } from '@/features/onboarding/Onboarding';
import { ModalHost } from '@/features/modals/ModalHost';
import { CommandPalette } from '@/features/palette/CommandPalette';
import './App.css';

export function App() {
  const ready = useWorkspace((state) => state.ready);
  const bootError = useWorkspace((state) => state.bootError);
  const profile = useWorkspace((state) => state.profile);
  const init = useWorkspace((state) => state.init);
  const initNetwork = useNetwork((state) => state.initialize);
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    // Local data first, then the stored session: if a session exists, the
    // server must win the final write, never the local database.
    void (async () => {
      await init();
      await initNetwork();
    })();
  }, [init, initNetwork]);

  useGlobalShortcuts();
  usePushToTalk();

  if (!ready) return <Splash />;
  if (bootError) return <BootError message={bootError} onRetry={() => void init()} />;
  if (!profile) return <Onboarding />;

  return <Shell />;
}

function Shell() {
  const view = useUi((state) => state.view);
  const contextOpen = useUi((state) => state.contextOpen);

  return (
    <div className="md-shell">
      <NavRail />
      <TitleBar />
      <div className="md-body" data-context={view.kind === 'room' && contextOpen}>
        <RoomSidebar />
        <main className="md-workspace" aria-label="Workspace">
          <WorkspaceView view={view} />
        </main>
        {view.kind === 'room' && contextOpen ? <ContextPanel roomId={view.roomId} /> : null}
      </div>
      <VoiceDock />
      <ModalHost />
      <CommandPalette />
      <ToastHost />
    </div>
  );
}

function WorkspaceView({ view }: { view: View }) {
  switch (view.kind) {
    case 'home':
      return <HomeView />;
    case 'friends':
      return <FriendsView friendId={view.friendId ?? null} />;
    case 'rooms':
      return <RoomsView />;
    case 'games':
      return <GamesView />;
    case 'settings':
      return <SettingsView section={view.section} />;
    case 'room':
      return <RoomView roomId={view.roomId} />;
    default:
      return <HomeView />;
  }
}

function Splash() {
  return (
    <div className="md-splash">
      <div className="md-splash__glow" aria-hidden="true" />
      <MeldriftMark size={44} />
      <p className="md-splash__word">Meldrift</p>
      <Spinner size={14} label="Starting Meldrift" />
    </div>
  );
}

function BootError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="md-splash">
      <div className="md-splash__glow" aria-hidden="true" />
      <MeldriftMark size={40} />
      <p className="md-splash__word">Meldrift could not start</p>
      <p className="md-splash__text">{message}</p>
      <button type="button" className="md-btn md-btn--primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/* ---- Global shortcuts -------------------------------------------------- */

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const ui = useUi.getState();
      const mod = event.ctrlKey || event.metaKey;

      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        ui.setPaletteOpen(!ui.paletteOpen);
        return;
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault();
        const room = useVoiceRoom.getState();
        if (room.roomId) {
          room.toggleMuted();
          ui.pushToast(room.muted ? 'Microphone muted' : 'Microphone unmuted');
          return;
        }
        const voice = useVoice.getState();
        voice.setMicEnabled(!voice.micEnabled);
        ui.pushToast(voice.micEnabled ? 'Microphone muted' : 'Microphone unmuted');
        return;
      }
      if (mod && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        const room = useVoiceRoom.getState();
        if (room.roomId) {
          room.toggleDeafened();
          return;
        }
        const voice = useVoice.getState();
        voice.setDeafened(!voice.deafened);
        return;
      }
      if (event.key === 'F11') {
        event.preventDefault();
        if (isTauri()) {
          const win = getCurrentWindow();
          void win.isFullscreen().then((full) => win.setFullscreen(!full));
        }
        return;
      }
      if (event.key === 'Escape') {
        if (ui.modal) {
          ui.closeModal();
        } else if (ui.paletteOpen) {
          ui.setPaletteOpen(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Push-to-talk: the microphone is only live while the bound key is held. */
function usePushToTalk() {
  const pushToTalk = useWorkspace((state) => state.settings.pushToTalk);
  const pushToTalkKey = useWorkspace((state) => state.settings.pushToTalkKey);
  const micEnabled = useVoice((state) => state.micEnabled);
  const held = useVoice((state) => state.pushToTalkHeld);
  const setHeld = useVoice((state) => state.setPushToTalkHeld);

  useEffect(() => {
    if (!pushToTalk) {
      setHeld(false);
      return;
    }
    const matches = (event: KeyboardEvent) =>
      event.key.length === 1 && event.key.toUpperCase() === pushToTalkKey.toUpperCase();
    const onDown = (event: KeyboardEvent) => {
      if (matches(event) && !event.repeat) setHeld(true);
    };
    const onUp = (event: KeyboardEvent) => {
      if (matches(event)) setHeld(false);
    };
    const onBlur = () => setHeld(false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [pushToTalk, pushToTalkKey, setHeld]);

  useEffect(() => {
    const live = micEnabled && (!pushToTalk || held);
    // Routes through the voice store so peers and the server learn about the
    // change, not just the local audio graph.
    useVoiceRoom.getState().applyTransmit(live);
  }, [micEnabled, held, pushToTalk]);
}
