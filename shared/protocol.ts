/* --------------------------------------------------------------------------
   Wire protocol shared by the Meldrift desktop client and the signaling
   service. Both sides import this file, so a protocol change is a compile
   error on whichever side was not updated.
   -------------------------------------------------------------------------- */

export const PROTOCOL_VERSION = 1;

export type Presence = 'online' | 'idle' | 'offline';
export type RoomKind = 'game' | 'voice';
export type MessageScope = 'room' | 'dm';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
}

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

export interface RoomMemberView {
  userId: string;
  displayName: string;
  avatarColor: string;
  role: 'host' | 'member';
  presence: Presence;
  joinedAt: number;
}

export interface RoomView {
  id: string;
  name: string;
  kind: RoomKind;
  gameTitle: string | null;
  inviteCode: string;
  ownerId: string;
  createdAt: number;
  lastActiveAt: number;
  members: RoomMemberView[];
}

export interface FriendView {
  userId: string;
  username: string;
  displayName: string;
  avatarColor: string;
  presence: Presence;
  since: number;
}

export interface FriendRequestView {
  userId: string;
  username: string;
  displayName: string;
  avatarColor: string;
  createdAt: number;
}

export interface ConversationView {
  id: string;
  peer: PublicUser;
  peerPresence: Presence;
  lastMessageAt: number | null;
}

export interface MessageView {
  id: string;
  scopeType: MessageScope;
  scopeId: string;
  authorId: string;
  authorName: string;
  authorAvatarColor: string;
  body: string;
  createdAt: number;
}

export interface BootstrapView {
  protocol: number;
  user: PublicUser;
  rooms: RoomView[];
  friends: FriendView[];
  requests: FriendRequestView[];
  conversations: ConversationView[];
}

export interface RegisterBody {
  username: string;
  password: string;
  displayName: string;
  avatarColor?: string;
}

export interface LoginBody {
  username: string;
  password: string;
}

export interface CreateRoomBody {
  name: string;
  kind: RoomKind;
  gameTitle?: string | null;
}

export type ClientEvent =
  | { t: 'ping'; ts: number }
  | { t: 'presence.set'; presence: 'online' | 'idle' }
  | { t: 'message.send'; clientId: string; scopeType: MessageScope; scopeId: string; body: string };

export type ServerEvent =
  | { t: 'ready'; user: PublicUser; presence: Record<string, Presence> }
  | { t: 'message.new'; message: MessageView }
  | { t: 'message.ack'; clientId: string; message: MessageView }
  | { t: 'message.error'; clientId: string; error: string }
  | { t: 'presence.update'; userId: string; presence: Presence }
  | { t: 'room.members'; roomId: string; members: RoomMemberView[] }
  | { t: 'friend.update'; friend: FriendView }
  | { t: 'friend.request'; request: FriendRequestView }
  | { t: 'pong'; ts: number }
  | { t: 'error'; message: string };

export interface ApiError {
  error: string;
  code?: string;
}

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,24}$/;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_MESSAGE_LENGTH = 2000;
export const INVITE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{7}$/;

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value);
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidPresence(value: unknown): value is Presence {
  return value === 'online' || value === 'idle' || value === 'offline';
}
