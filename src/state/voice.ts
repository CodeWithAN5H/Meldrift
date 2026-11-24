import { create } from 'zustand';
import { describeMediaError, listAudioInputs, voiceEngine } from '@/lib/voice';

interface VoiceState {
  capturing: boolean;
  starting: boolean;
  micEnabled: boolean;
  deafened: boolean;
  pushToTalkHeld: boolean;
  error: string | null;
  inputs: MediaDeviceInfo[];
  activeInputLabel: string | null;
  refreshInputs: () => Promise<void>;
  start: (options: {
    deviceId: string;
    noiseSuppression: boolean;
    echoCancellation: boolean;
    autoGainControl: boolean;
    inputVolume: number;
  }) => Promise<boolean>;
  stop: () => Promise<void>;
  setMicEnabled: (enabled: boolean) => void;
  setDeafened: (deafened: boolean) => void;
  setPushToTalkHeld: (held: boolean) => void;
  clearError: () => void;
}

export const useVoice = create<VoiceState>((set, get) => ({
  capturing: false,
  starting: false,
  micEnabled: true,
  deafened: false,
  pushToTalkHeld: false,
  error: null,
  inputs: [],
  activeInputLabel: null,

  refreshInputs: async () => {
    try {
      const inputs = await listAudioInputs();
      set({ inputs });
    } catch {
      set({ inputs: [] });
    }
  },

  start: async (options) => {
    if (get().starting) return false;
    set({ starting: true, error: null });
    try {
      await voiceEngine.start({
        deviceId: options.deviceId,
        noiseSuppression: options.noiseSuppression,
        echoCancellation: options.echoCancellation,
        autoGainControl: options.autoGainControl,
        gain: options.inputVolume,
      });
      if (!get().micEnabled) voiceEngine.setMuted(true);
      set({
        capturing: true,
        starting: false,
        activeInputLabel: voiceEngine.trackLabel,
      });
      await get().refreshInputs();
      return true;
    } catch (error) {
      set({
        capturing: false,
        starting: false,
        error: describeMediaError(error),
      });
      return false;
    }
  },

  stop: async () => {
    await voiceEngine.stop();
    set({ capturing: false, activeInputLabel: null });
  },

  setMicEnabled: (enabled) => {
    // Only an active capture can actually be muted; when idle the flag simply
    // records intent for the next join.
    voiceEngine.setMuted(!enabled);
    set({ micEnabled: enabled });
  },

  setDeafened: (deafened) => set({ deafened }),
  setPushToTalkHeld: (held) => set({ pushToTalkHeld: held }),
  clearError: () => set({ error: null }),
}));
