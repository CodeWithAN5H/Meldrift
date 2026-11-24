import type { Message, MessageScope, Room } from '@/lib/model';

/* --------------------------------------------------------------------------
   The seam between the workspace store and the network store.

   workspace.ts needs to know whether it is online without importing the
   network store (which imports workspace), so the network store installs a
   small adapter here while connected and removes it on sign-out.
   -------------------------------------------------------------------------- */

export interface RemoteAdapter {
  serverUrl: string;
  userId: string;
  createRoom(input: { name: string; kind: 'game' | 'voice'; gameTitle: string | null }): Promise<Room>;
  loadMessages(scopeType: MessageScope, scopeId: string): Promise<Message[]>;
  sendMessage(scopeType: MessageScope, scopeId: string, body: string): Promise<Message>;
  joinRoom(code: string): Promise<Room>;
  removeFriend(userId: string): Promise<void>;
}

let adapter: RemoteAdapter | null = null;

export function setRemoteAdapter(next: RemoteAdapter | null): void {
  adapter = next;
}

export function getRemoteAdapter(): RemoteAdapter | null {
  return adapter;
}
