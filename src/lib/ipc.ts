import { invoke } from '@tauri-apps/api/core';
import {
  makeInviteCode,
  makeProfile,
  normalizeInviteCode,
  sanitizeMessageBody,
  sanitizeSettings,
  type AppInfo,
  type Bootstrap,
  type Friend,
  type Game,
  type Message,
  type MessageScope,
  type Profile,
  type Room,
  type RoomKind,
  type Settings,
} from './model';
import type { StoredSession } from './net/api';
import { APP_VERSION } from './version';

/* --------------------------------------------------------------------------
   DataPort: the only way the UI touches persistence.

   Two implementations exist:
     - Tauri + SQLite (production desktop build)
     - localStorage (browser preview / UI development)

   Both implement identical semantics, so screens never branch on the runtime.
   Remote multiplayer state (peers, presence, sessions) is intentionally NOT
   part of this port yet: it belongs to the signaling service in M2/M3.
   -------------------------------------------------------------------------- */

export interface DataPort {
  readonly runtime: 'desktop' | 'web';
  bootstrap(): Promise<Bootstrap>;
  appInfo(): Promise<AppInfo>;
  loadSession(): Promise<StoredSession | null>;
  saveSession(session: StoredSession | null): Promise<void>;
  saveProfile(profile: Profile): Promise<Profile>;
  saveSettings(settings: Settings): Promise<Settings>;
  createRoom(input: { name: string; kind: RoomKind; gameTitle: string | null }): Promise<Room>;
  updateRoom(input: { id: string; name: string; gameTitle: string | null }): Promise<Room>;
  deleteRoom(id: string): Promise<void>;
  listMessages(scopeType: MessageScope, scopeId: string): Promise<Message[]>;
  sendMessage(input: {
    scopeType: MessageScope;
    scopeId: string;
    body: string;
  }): Promise<Message>;
  addFriend(input: { displayName: string; handle: string }): Promise<Friend>;
  updateFriend(input: { id: string; note?: string; presence?: Friend['presence'] }): Promise<Friend>;
  removeFriend(id: string): Promise<void>;
  addGame(input: { title: string; exePath: string }): Promise<Game>;
  removeGame(id: string): Promise<void>;
  touchGame(id: string): Promise<void>;
  clearWorkspace(): Promise<void>;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/* --------------------------------------------------------------------------
   Desktop adapter — talks to the Rust core.
   -------------------------------------------------------------------------- */

export const desktopPort: DataPort = {
  runtime: 'desktop',
  bootstrap: () => invoke<Bootstrap>('bootstrap'),
  appInfo: () => invoke<AppInfo>('app_info'),
  loadSession: () => invoke<StoredSession | null>('load_session'),
  saveSession: (session) => invoke<void>('save_session', { input: { session } }),
  saveProfile: (profile) => invoke<Profile>('save_profile', { input: { profile } }),
  saveSettings: (settings) => invoke<Settings>('save_settings', { input: { settings } }),
  createRoom: (input) => invoke<Room>('create_room', { input }),
  updateRoom: (input) => invoke<Room>('update_room', { input }),
  deleteRoom: (id) => invoke<void>('delete_room', { input: { id } }),
  listMessages: (scopeType, scopeId) =>
    invoke<Message[]>('list_messages', { input: { scopeType, scopeId } }),
  sendMessage: (input) => invoke<Message>('send_message', { input }),
  addFriend: (input) => invoke<Friend>('add_friend', { input }),
  updateFriend: (input) => invoke<Friend>('update_friend', { input }),
  removeFriend: (id) => invoke<void>('remove_friend', { input: { id } }),
  addGame: (input) => invoke<Game>('add_game', { input }),
  removeGame: (id) => invoke<void>('remove_game', { input: { id } }),
  touchGame: (id) => invoke<void>('touch_game', { input: { id } }),
  clearWorkspace: () => invoke<void>('clear_workspace'),
};

/* --------------------------------------------------------------------------
   Browser adapter — used by `bun run dev` for interface work and previews.
   Real persistence in localStorage; no simulated peers anywhere.
   -------------------------------------------------------------------------- */

const STORAGE_KEY = 'meldrift.workspace.v1';
const SESSION_KEY = 'meldrift.session.v1';

interface WebDatabase {
  profile: Profile | null;
  settings: Settings;
  rooms: Room[];
  friends: Friend[];
  games: Game[];
  messages: Message[];
}

function emptyDatabase(): WebDatabase {
  return {
    profile: null,
    settings: sanitizeSettings(null),
    rooms: [],
    friends: [],
    games: [],
    messages: [],
  };
}

function readDatabase(): WebDatabase {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyDatabase();
    const parsed = JSON.parse(raw) as Partial<WebDatabase>;
    return {
      profile: parsed.profile ?? null,
      settings: sanitizeSettings(parsed.settings),
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
      friends: Array.isArray(parsed.friends) ? parsed.friends : [],
      games: Array.isArray(parsed.games) ? parsed.games : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch {
    return emptyDatabase();
  }
}

function writeDatabase(db: WebDatabase): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function requireProfile(db: WebDatabase): Profile {
  if (!db.profile) throw new Error('Profile not set up yet');
  return db.profile;
}

function readSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.serverUrl !== 'string' ||
      typeof parsed.token !== 'string' ||
      !parsed.user ||
      typeof parsed.user.id !== 'string' ||
      typeof parsed.user.username !== 'string'
    ) {
      return null;
    }
    return {
      serverUrl: parsed.serverUrl,
      token: parsed.token,
      user: {
        id: parsed.user.id,
        username: parsed.user.username,
        displayName:
          typeof parsed.user.displayName === 'string' ? parsed.user.displayName : parsed.user.username,
        avatarColor:
          typeof parsed.user.avatarColor === 'string' ? parsed.user.avatarColor : '#7c4df2',
      },
    };
  } catch {
    return null;
  }
}

export const webPort: DataPort = {
  runtime: 'web',
  async loadSession() {
    return readSession();
  },
  async saveSession(session) {
    if (session) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  },
  async bootstrap() {
    const db = readDatabase();
    return {
      profile: db.profile,
      settings: db.settings,
      rooms: [...db.rooms].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
      friends: [...db.friends].sort((a, b) => a.displayName.localeCompare(b.displayName)),
      games: [...db.games].sort((a, b) => b.createdAt - a.createdAt),
      messages: db.messages
        .slice()
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-200),
    };
  },
  async appInfo() {
    return {
      version: APP_VERSION,
      dataDir: 'Browser preview (localStorage)',
      runtime: 'web',
    };
  },
  async saveProfile(profile) {
    const db = readDatabase();
    db.profile = profile;
    writeDatabase(db);
    return profile;
  },
  async saveSettings(settings) {
    const db = readDatabase();
    db.settings = sanitizeSettings(settings);
    writeDatabase(db);
    return db.settings;
  },
  async createRoom(input) {
    const db = readDatabase();
    const name = input.name.trim().slice(0, 40) || 'New room';
    const room: Room = {
      id: crypto.randomUUID(),
      name,
      kind: input.kind,
      gameTitle: input.gameTitle,
      inviteCode: makeInviteCode(),
      isOwned: true,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    db.rooms.push(room);
    writeDatabase(db);
    return room;
  },
  async updateRoom(input) {
    const db = readDatabase();
    const room = db.rooms.find((r) => r.id === input.id);
    if (!room) throw new Error('Room not found');
    room.name = input.name.trim().slice(0, 40) || room.name;
    room.gameTitle = input.gameTitle;
    writeDatabase(db);
    return room;
  },
  async deleteRoom(id) {
    const db = readDatabase();
    db.rooms = db.rooms.filter((r) => r.id !== id);
    db.messages = db.messages.filter((m) => !(m.scopeType === 'room' && m.scopeId === id));
    writeDatabase(db);
  },
  async listMessages(scopeType, scopeId) {
    const db = readDatabase();
    return db.messages
      .filter((m) => m.scopeType === scopeType && m.scopeId === scopeId)
      .sort((a, b) => a.createdAt - b.createdAt);
  },
  async sendMessage(input) {
    const db = readDatabase();
    const body = sanitizeMessageBody(input.body);
    if (!body) throw new Error('Message is empty');
    const author = requireProfile(db);
    const message: Message = {
      id: crypto.randomUUID(),
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      authorId: author.id,
      authorName: author.displayName,
      body,
      createdAt: Date.now(),
    };
    db.messages.push(message);
    const room = db.rooms.find((r) => r.id === input.scopeId);
    if (room) room.lastActiveAt = message.createdAt;
    writeDatabase(db);
    return message;
  },
  async addFriend(input) {
    const db = readDatabase();
    const displayName = input.displayName.trim().slice(0, 32);
    if (!displayName) throw new Error('Enter a name');
    const friend: Friend = {
      id: crypto.randomUUID(),
      displayName,
      handle: input.handle.trim().replace(/^@/, '').slice(0, 32) || displayName.toLowerCase(),
      presence: 'offline',
      note: '',
      createdAt: Date.now(),
    };
    db.friends.push(friend);
    writeDatabase(db);
    return friend;
  },
  async updateFriend(input) {
    const db = readDatabase();
    const friend = db.friends.find((f) => f.id === input.id);
    if (!friend) throw new Error('Friend not found');
    if (input.note !== undefined) friend.note = input.note.slice(0, 120);
    if (input.presence !== undefined) friend.presence = input.presence;
    writeDatabase(db);
    return friend;
  },
  async removeFriend(id) {
    const db = readDatabase();
    db.friends = db.friends.filter((f) => f.id !== id);
    db.messages = db.messages.filter((m) => !(m.scopeType === 'dm' && m.scopeId === id));
    writeDatabase(db);
  },
  async addGame(input) {
    const db = readDatabase();
    const title = input.title.trim().slice(0, 60);
    if (!title) throw new Error('Enter a game title');
    const game: Game = {
      id: crypto.randomUUID(),
      title,
      exePath: input.exePath.trim(),
      accent: '#7c4df2',
      lastPlayedAt: null,
      createdAt: Date.now(),
    };
    db.games.push(game);
    writeDatabase(db);
    return game;
  },
  async removeGame(id) {
    const db = readDatabase();
    db.games = db.games.filter((g) => g.id !== id);
    writeDatabase(db);
  },
  async touchGame(id) {
    const db = readDatabase();
    const game = db.games.find((g) => g.id === id);
    if (!game) return;
    game.lastPlayedAt = Date.now();
    writeDatabase(db);
  },
  async clearWorkspace() {
    localStorage.removeItem(STORAGE_KEY);
  },
};

export const port: DataPort = isTauri() ? desktopPort : webPort;

/** Utility used by the "join by code" flow until the signaling service ships. */
export function normalizeJoinCode(raw: string): string {
  return normalizeInviteCode(raw);
}

/** Convenience for the onboarding screen. */
export function createLocalProfile(name: string, color: string): Profile {
  return makeProfile(name, color);
}
