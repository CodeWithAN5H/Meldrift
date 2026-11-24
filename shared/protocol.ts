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
  | { t: 'message.send'; clientId: string; scopeType: MessageScope; scopeId: string; body: string }
  | { t: 'voice.join'; roomId: string }
  | { t: 'voice.leave'; roomId: string }
  | { t: 'voice.state'; roomId: string; muted: boolean; deafened: boolean; speaking: boolean }
  | VoiceSignalEvent;

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
  | { t: 'error'; message: string }
  | { t: 'voice.joined'; roomId: string; selfId: string; participants: VoiceParticipantView[] }
  | { t: 'voice.left'; roomId: string }
  | { t: 'voice.participant.joined'; roomId: string; participant: VoiceParticipantView }
  | { t: 'voice.participant.left'; roomId: string; userId: string }
  | {
      t: 'voice.participant.state';
      roomId: string;
      userId: string;
      muted: boolean;
      deafened: boolean;
      speaking: boolean;
    }
  | { t: 'voice.error'; roomId?: string; error: string }
  | VoiceServerSignalEvent;

export interface ApiError {
  error: string;
  code?: string;
}

/* ---- Voice (M3) -------------------------------------------------------- */

/**
 * Room voice is a peer-to-peer mesh: every participant encodes one Opus
 * stream per other participant. Eight people is 7 upstream streams (~40 kbps
 * each), which is the point where a mesh stops being reasonable without an
 * SFU. The server enforces this cap so clients cannot exceed it.
 */
export const VOICE_MAX_PARTICIPANTS = 8;
export const VOICE_MAX_SDP_LENGTH = 60_000;
export const VOICE_MAX_CANDIDATE_LENGTH = 2_000;
/** Signaling (SDP + ICE) is chattier than chat, but still bounded. */
export const VOICE_SIGNAL_BURST = 240;
export const VOICE_SIGNAL_WINDOW_MS = 10_000;

export interface VoiceParticipantView {
  userId: string;
  displayName: string;
  avatarColor: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  joinedAt: number;
}

export interface VoiceIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface IceServerView {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Returned to signed-in clients only; TURN credentials never go public. */
export interface VoiceConfigView {
  iceServers: IceServerView[];
  maxParticipants: number;
}

export type VoiceSignalEvent =
  | { t: 'voice.offer'; roomId: string; to: string; sdp: string }
  | { t: 'voice.answer'; roomId: string; to: string; sdp: string }
  | { t: 'voice.ice'; roomId: string; to: string; candidate: VoiceIceCandidate };

export type VoiceServerSignalEvent =
  | { t: 'voice.offer'; roomId: string; from: string; sdp: string }
  | { t: 'voice.answer'; roomId: string; from: string; sdp: string }
  | { t: 'voice.ice'; roomId: string; from: string; candidate: VoiceIceCandidate };

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
