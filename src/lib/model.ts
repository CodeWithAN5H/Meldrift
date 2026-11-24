import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

/* --------------------------------------------------------------------------
   Shared model types. These cross the Rust <-> React boundary; every field is
   camelCase on both sides because the Rust structs use serde rename_all.
   -------------------------------------------------------------------------- */

export type Presence = 'online' | 'idle' | 'offline';
export type RoomKind = 'game' | 'voice';
export type ControlMode = 'single' | 'multi';

export interface Profile {
  id: string;
  displayName: string;
  handle: string;
  avatarColor: string;
  bio: string;
  createdAt: number;
}

export interface Room {
  id: string;
  name: string;
  kind: RoomKind;
  gameTitle: string | null;
  inviteCode: string;
  isOwned: boolean;
  createdAt: number;
  lastActiveAt: number;
}

export interface Friend {
  id: string;
  displayName: string;
  handle: string;
  presence: Presence;
  note: string;
  createdAt: number;
}

export type MessageScope = 'room' | 'dm';

export interface Message {
  id: string;
  scopeType: MessageScope;
  scopeId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: number;
}

export interface Game {
  id: string;
  title: string;
  exePath: string;
  accent: string;
  lastPlayedAt: number | null;
  createdAt: number;
}

export interface Settings {
  micDeviceId: string;
  speakerDeviceId: string;
  inputVolume: number;
  outputVolume: number;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  pushToTalk: boolean;
  pushToTalkKey: string;
  streamFps: number;
  streamHeight: number;
  streamBitrateKbps: number;
  controlMode: ControlMode;
  /** Optional user-supplied ICE infrastructure. Empty means "use the server's". */
  voiceStunUrl: string;
  voiceTurnUrl: string;
  voiceTurnUsername: string;
  voiceTurnCredential: string;
  reduceMotion: boolean;
  compactDensity: boolean;
  desktopNotifications: boolean;
}

export interface Bootstrap {
  profile: Profile | null;
  settings: Settings;
  rooms: Room[];
  friends: Friend[];
  games: Game[];
  messages: Message[];
}

export interface AppInfo {
  version: string;
  dataDir: string;
  runtime: 'desktop' | 'web';
}

export const MAX_MESSAGE_LENGTH = 2000;

export const AVATAR_COLORS = [
  '#7c4df2',
  '#e0607e',
  '#2f9e7a',
  '#3a7bd5',
  '#d98324',
  '#a34fd4',
  '#4c6ef5',
  '#c9486b',
] as const;

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Invite codes are 7 characters, ambiguity-free (no O/0, I/1). */
export function makeInviteCode(): string {
  let out = '';
  for (let i = 0; i < 7; i += 1) {
    out += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  }
  return out;
}

export function isValidInviteCode(code: string): boolean {
  return /^[A-HJ-NP-Z2-9]{7}$/.test(code.trim().toUpperCase());
}

export function normalizeInviteCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 7);
}

export function defaultSettings(): Settings {
  return {
    micDeviceId: 'default',
    speakerDeviceId: 'default',
    inputVolume: 100,
    outputVolume: 100,
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
    pushToTalk: false,
    pushToTalkKey: 'V',
    streamFps: 60,
    streamHeight: 1080,
    streamBitrateKbps: 12000,
    controlMode: 'single',
    voiceStunUrl: '',
    voiceTurnUrl: '',
    voiceTurnUsername: '',
    voiceTurnCredential: '',
    reduceMotion: false,
    compactDensity: false,
    desktopNotifications: true,
  };
}

/** Clamp persisted settings so a corrupt value can never break the UI. */
export function sanitizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const base = defaultSettings();
  if (!raw) return base;
  const num = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.min(max, Math.max(min, Math.round(v)))
      : fallback;
  const bool = (v: unknown, fallback: boolean) =>
    typeof v === 'boolean' ? v : fallback;
  const text = (v: unknown, max: number, fallback: string) =>
    typeof v === 'string' ? v.slice(0, max) : fallback;
  return {
    micDeviceId: typeof raw.micDeviceId === 'string' ? raw.micDeviceId : base.micDeviceId,
    speakerDeviceId:
      typeof raw.speakerDeviceId === 'string' ? raw.speakerDeviceId : base.speakerDeviceId,
    inputVolume: num(raw.inputVolume, 0, 200, base.inputVolume),
    outputVolume: num(raw.outputVolume, 0, 200, base.outputVolume),
    noiseSuppression: bool(raw.noiseSuppression, base.noiseSuppression),
    echoCancellation: bool(raw.echoCancellation, base.echoCancellation),
    autoGainControl: bool(raw.autoGainControl, base.autoGainControl),
    pushToTalk: bool(raw.pushToTalk, base.pushToTalk),
    pushToTalkKey:
      typeof raw.pushToTalkKey === 'string' && raw.pushToTalkKey.length <= 16
        ? raw.pushToTalkKey
        : base.pushToTalkKey,
    streamFps: num(raw.streamFps, 15, 144, base.streamFps),
    streamHeight: num(raw.streamHeight, 360, 2160, base.streamHeight),
    streamBitrateKbps: num(raw.streamBitrateKbps, 500, 50000, base.streamBitrateKbps),
    controlMode: raw.controlMode === 'multi' ? 'multi' : 'single',
    voiceStunUrl: text(raw.voiceStunUrl, 512, base.voiceStunUrl),
    voiceTurnUrl: text(raw.voiceTurnUrl, 512, base.voiceTurnUrl),
    voiceTurnUsername: text(raw.voiceTurnUsername, 128, base.voiceTurnUsername),
    voiceTurnCredential: text(raw.voiceTurnCredential, 256, base.voiceTurnCredential),
    reduceMotion: bool(raw.reduceMotion, base.reduceMotion),
    compactDensity: bool(raw.compactDensity, base.compactDensity),
    desktopNotifications: bool(raw.desktopNotifications, base.desktopNotifications),
  };
}

export function sanitizeMessageBody(body: string): string {
  const trimmed = body.replace(/\r\n/g, '\n').trim();
  return trimmed.slice(0, MAX_MESSAGE_LENGTH);
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Deterministic avatar colour so the same person always looks the same. */
export function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function makeProfile(displayName: string, avatarColor?: string): Profile {
  const name = displayName.trim().slice(0, 32) || 'Player';
  return {
    id: newId(),
    displayName: name,
    handle: name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'player',
    avatarColor: avatarColor ?? colorFor(name),
    bio: '',
    createdAt: Date.now(),
  };
}

/* ---- Small hooks shared by screens ------------------------------------- */

/** Subscribe to a CSS media query without re-rendering the whole tree. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query, setMatches]);
  return matches;
}

/** Closes a floating surface on outside click or Escape. */
export function useDismiss(
  open: boolean,
  onClose: () => void,
): { ref: React.RefObject<HTMLDivElement | null> } {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return { ref };
}

export type StyleVars = CSSProperties & Record<`--${string}`, string | number>;

export function vars(record: Record<string, string | number>): StyleVars {
  return record as StyleVars;
}

export type WithChildren = { children: ReactNode };
