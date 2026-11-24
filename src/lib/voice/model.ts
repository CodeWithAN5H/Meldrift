import type { IceServerView, VoiceIceCandidate } from '@shared/protocol';

/* --------------------------------------------------------------------------
   Pure helpers for voice networking. Kept free of browser and store imports so
   they can be unit tested and reused by the UI.
   -------------------------------------------------------------------------- */

export interface VoiceNetworkSettings {
  stunUrl: string;
  turnUrl: string;
  turnUsername: string;
  turnCredential: string;
}

export type VoiceConnectionState = 'new' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

/** Abstraction over the analyser reading a remote stream, so it can be faked in tests. */
export interface RemoteMonitor {
  level: () => number;
  close: () => void;
}

/** Comma, semicolon or whitespace separated STUN/TURN URLs. */
export function parseIceUrlList(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => /^(stun|stuns|turn|turns):[^\s]+$/i.test(entry));
}

/**
 * Merge the operator's ICE configuration with a user override. Duplicate URLs
 * are dropped, and a user-supplied TURN entry replaces the server's credential
 * for that entry instead of producing two competing relays.
 */
export function toIceServers(
  server: IceServerView[] | null | undefined,
  settings: VoiceNetworkSettings,
): RTCIceServer[] {
  const stun = new Set<string>();
  const turns: Array<{ urls: string[]; username?: string; credential?: string }> = [];

  for (const entry of server ?? []) {
    for (const url of entry.urls) {
      if (/^stuns?:/i.test(url)) stun.add(url);
    }
    const turnUrls = entry.urls.filter((url) => /^turns?:/i.test(url));
    if (turnUrls.length > 0) {
      turns.push({
        urls: turnUrls,
        username: entry.username,
        credential: entry.credential,
      });
    }
  }

  for (const url of parseIceUrlList(settings.stunUrl)) stun.add(url);

  const userTurn = parseIceUrlList(settings.turnUrl);
  if (userTurn.length > 0) {
    turns.push({
      urls: userTurn,
      username: settings.turnUsername || undefined,
      credential: settings.turnCredential || undefined,
    });
  }

  const result: RTCIceServer[] = [];
  if (stun.size > 0) result.push({ urls: [...stun] });
  for (const entry of turns) result.push(entry);
  return result;
}

/** ICE can arrive before the remote description; it is queued until it can be added. */
export function candidateInit(candidate: VoiceIceCandidate): RTCIceCandidateInit {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? undefined,
    sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
    usernameFragment: candidate.usernameFragment ?? undefined,
  };
}

/** Rising threshold starts speaking; a lower one keeps it from flickering. */
export function nextSpeaking(level: number, wasSpeaking: boolean, threshold = 0.06): boolean {
  const gate = wasSpeaking ? threshold * 0.55 : threshold;
  return level >= gate;
}

/** dBFS-style scale for the meter, clamped to 0..1. */
export function levelFromRms(rms: number): number {
  return Math.max(0, Math.min(1, rms * 3.2));
}

export type VoiceStatus = 'idle' | 'joining' | 'connected' | 'reconnecting' | 'error';

/**
 * The dock must never claim "connected" before the media path is up. Alone in
 * a channel there are no peers, which is still a valid connected state.
 */
export function deriveVoiceStatus(
  joined: boolean,
  connections: VoiceConnectionState[],
): VoiceStatus {
  if (!joined) return 'idle';
  if (connections.length === 0) return 'connected';
  if (connections.some((state) => state === 'failed')) return 'reconnecting';
  if (connections.every((state) => state === 'connected')) return 'connected';
  return 'joining';
}

export function describeConnection(state: VoiceConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    case 'failed':
      return 'Connection failed';
    case 'new':
      return 'Waiting';
    default:
      return 'Unknown';
  }
}

/** Redacts credentials so an ICE configuration can be logged safely (if ever). */
export function describeIceConfiguration(servers: RTCIceServer[]): string {
  return servers
    .map((entry) => {
      const urls = Array.isArray(entry.urls) ? entry.urls.join(' ') : String(entry.urls);
      return `${urls}${entry.username ? ' (authenticated)' : ''}`;
    })
    .join(' | ');
}
