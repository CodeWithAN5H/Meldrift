import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@/lib/ipc';
import type { ServerMode } from '@/lib/model';
import {
  signalingPort,
  type SignalingDiagnostics,
  type SignalingStatus,
} from '@/lib/signaling';
import { useWorkspace } from './workspace';

/* --------------------------------------------------------------------------
   Signaling lifecycle for the UI.

   Local mode waits for a real health check before account controls unlock.
   Remote mode stops the sidecar and never falls back to localhost.
   -------------------------------------------------------------------------- */

const idleStatus: SignalingStatus = {
  mode: 'local',
  state: 'stopped',
  url: null,
  port: null,
  managed: false,
  reused: false,
  error: null,
  logPath: '',
  restarts: 0,
};

interface SignalingStore {
  status: SignalingStatus;
  initialized: boolean;
  diagnostics: SignalingDiagnostics | null;
  init: () => Promise<void>;
  start: () => Promise<SignalingStatus>;
  retry: () => Promise<SignalingStatus>;
  stop: () => Promise<SignalingStatus>;
  setMode: (mode: ServerMode) => Promise<SignalingStatus>;
  refresh: () => Promise<SignalingStatus>;
  loadDiagnostics: () => Promise<SignalingDiagnostics | null>;
}

let subscribed = false;
let waiting: Promise<SignalingStatus> | null = null;

async function waitForReady(timeoutMs = 15_000): Promise<SignalingStatus> {
  if (waiting) return waiting;
  waiting = (async () => {
    const deadline = Date.now() + timeoutMs;
    let status = await signalingPort.status();
    while (Date.now() < deadline) {
      useSignaling.setState({ status });
      if (status.state !== 'starting') return status;
      await new Promise((resolve) => setTimeout(resolve, 250));
      status = await signalingPort.status();
    }
    return status;
  })().finally(() => {
    waiting = null;
  });
  return waiting;
}

export const useSignaling = create<SignalingStore>((set, get) => ({
  status: idleStatus,
  initialized: false,
  diagnostics: null,

  init: async () => {
    if (get().initialized) return;
    set({ initialized: true });
    if (!isTauri()) {
      set({
        status: {
          ...idleStatus,
          state: 'unsupported',
          error: 'The local signaling server runs in the desktop app, not the browser preview.',
        },
      });
      return;
    }

    if (!subscribed) {
      subscribed = true;
      try {
        await listen<SignalingStatus>('signaling-status', (event) => {
          set({ status: event.payload });
        });
      } catch {
        // Polling below still works if the event bridge is unavailable.
      }
    }

    const mode = useWorkspace.getState().settings.serverMode;
    if (mode === 'remote') {
      await get().setMode('remote');
      return;
    }
    await get().start();
  },

  start: async () => {
    try {
      const status = await signalingPort.start();
      set({ status });
      if (status.state === 'starting') return waitForReady();
      return status;
    } catch (error) {
      const status: SignalingStatus = {
        ...get().status,
        state: 'failed',
        error: error instanceof Error ? error.message : 'The local server could not start.',
      };
      set({ status });
      return status;
    }
  },

  retry: async () => {
    try {
      const status = await signalingPort.start();
      set({ status });
      return status.state === 'starting' ? waitForReady() : status;
    } catch (error) {
      const status: SignalingStatus = {
        ...get().status,
        state: 'failed',
        error: error instanceof Error ? error.message : 'The local server could not start.',
      };
      set({ status });
      return status;
    }
  },

  stop: async () => {
    const status = await signalingPort.stop();
    set({ status });
    return status;
  },

  setMode: async (mode) => {
    const workspace = useWorkspace.getState();
    if (workspace.settings.serverMode !== mode) {
      await workspace.updateSettings({ serverMode: mode });
    }
    try {
      const status = await signalingPort.setMode(mode);
      set({ status });
      if (mode === 'local' && status.state === 'starting') return waitForReady();
      return status;
    } catch (error) {
      const status: SignalingStatus = {
        ...get().status,
        mode,
        state: 'failed',
        error: error instanceof Error ? error.message : 'The server mode could not be changed.',
      };
      set({ status });
      return status;
    }
  },

  refresh: async () => {
    const status = await signalingPort.status();
    set({ status });
    return status;
  },

  loadDiagnostics: async () => {
    if (!isTauri()) return null;
    try {
      const diagnostics = await signalingPort.diagnostics();
      set({ diagnostics });
      return diagnostics;
    } catch {
      return null;
    }
  },
}));
