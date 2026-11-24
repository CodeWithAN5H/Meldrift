import type { ClientEvent, IceServerView } from '@shared/protocol';

/* --------------------------------------------------------------------------
   Signaling seam for voice.

   The socket lives in state/network.ts, which also imports the voice store to
   route incoming events. This module breaks that cycle: the network store
   installs a transport while the socket is open, and the voice store sends
   through it without importing network state.
   -------------------------------------------------------------------------- */

export interface VoiceTransport {
  selfId: string;
  /** Operator-provided STUN/TURN, fetched while signed in. */
  iceServers: IceServerView[];
  send: (event: ClientEvent) => boolean;
}

let current: VoiceTransport | null = null;

export function setVoiceTransport(transport: VoiceTransport | null): void {
  current = transport;
}

export function getVoiceTransport(): VoiceTransport | null {
  return current;
}
