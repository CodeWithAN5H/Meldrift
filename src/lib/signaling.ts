import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './ipc';
import type { ServerMode } from './model';

/* --------------------------------------------------------------------------
   Local signaling server bridge.

   The desktop shell owns the sidecar process. This module is a thin typed
   wrapper so stores and screens never invoke raw command names. Browser preview
   has no sidecar, and says so instead of pretending a server exists.
   -------------------------------------------------------------------------- */

export type SignalingState =
  | 'starting'
  | 'ready'
  | 'failed'
  | 'stopped'
  | 'crashed'
  | 'unsupported';

export interface SignalingStatus {
  mode: ServerMode;
  state: SignalingState;
  url: string | null;
  port: number | null;
  managed: boolean;
  reused: boolean;
  error: string | null;
  logPath: string;
  restarts: number;
}

export interface SignalingDiagnostics {
  logPath: string;
  logTail: string;
}

const browserStatus: SignalingStatus = {
  mode: 'local',
  state: 'unsupported',
  url: null,
  port: null,
  managed: false,
  reused: false,
  error: 'The local signaling server runs in the desktop app, not the browser preview.',
  logPath: '',
  restarts: 0,
};

export const signalingPort = {
  status: (): Promise<SignalingStatus> =>
    isTauri() ? invoke<SignalingStatus>('signaling_status') : Promise.resolve(browserStatus),
  start: (): Promise<SignalingStatus> =>
    isTauri() ? invoke<SignalingStatus>('signaling_start') : Promise.resolve(browserStatus),
  stop: (): Promise<SignalingStatus> =>
    isTauri() ? invoke<SignalingStatus>('signaling_stop') : Promise.resolve(browserStatus),
  setMode: (mode: ServerMode): Promise<SignalingStatus> =>
    isTauri()
      ? invoke<SignalingStatus>('signaling_set_mode', { mode })
      : Promise.resolve(browserStatus),
  diagnostics: (): Promise<SignalingDiagnostics> =>
    isTauri()
      ? invoke<SignalingDiagnostics>('signaling_diagnostics')
      : Promise.resolve({ logPath: '', logTail: '' }),
};

/** True for loopback addresses, including the ones a stored session may hold. */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '::1' ||
      url.hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * A stored session may point at the old fixed port. In local mode it is rebound
 * to the sidecar's actual port; in remote mode it is left exactly as configured
 * and is never silently replaced by localhost.
 */
export function resolveSessionServer(
  storedUrl: string,
  mode: ServerMode,
  localUrl: string | null,
): string {
  if (mode === 'local' && localUrl && isLoopbackUrl(storedUrl)) return localUrl;
  return storedUrl;
}
