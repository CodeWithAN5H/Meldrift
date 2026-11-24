import { create } from 'zustand';
import { port } from '@/lib/ipc';
import { getRemoteAdapter } from '@/lib/net/hub';
import { mergeMessages } from '@/lib/net/map';
import {
  defaultSettings,
  makeProfile,
  normalizeInviteCode,
  sanitizeMessageBody,
  sanitizeSettings,
  type AppInfo,
  type Friend,
  type Game,
  type Message,
  type MessageScope,
  type Presence,
  type Profile,
  type Room,
  type RoomKind,
  type Settings,
} from '@/lib/model';
import { useUi } from './ui';

type ScopeKey = string;

export function scopeKey(scopeType: MessageScope, scopeId: string): ScopeKey {
  return `${scopeType}:${scopeId}`;
}

interface WorkspaceState {
  ready: boolean;
  bootError: string | null;
  profile: Profile | null;
  settings: Settings;
  rooms: Room[];
  friends: Friend[];
  games: Game[];
  info: AppInfo | null;
  messages: Record<ScopeKey, Message[]>;
  loadingScopes: Record<ScopeKey, boolean>;
  /** Bumped when the data source changes so open chats reload. */
  epoch: number;
  init: () => Promise<void>;
  joinRoom: (code: string) => Promise<Room | null>;
  applyRemoteWorkspace: (input: { profile: Profile; rooms: Room[]; friends: Friend[] }) => void;
  appendRemoteMessage: (message: Message) => void;
  applyPresence: (presence: Record<string, Presence>) => void;
  upsertFriend: (friend: Friend) => void;
  completeOnboarding: (name: string, color: string) => Promise<void>;
  saveProfile: (patch: Partial<Pick<Profile, 'displayName' | 'handle' | 'bio' | 'avatarColor'>>) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  createRoom: (input: { name: string; kind: RoomKind; gameTitle: string | null }) => Promise<Room | null>;
  updateRoom: (id: string, patch: { name?: string; gameTitle?: string | null }) => Promise<void>;
  deleteRoom: (id: string) => Promise<void>;
  loadMessages: (scopeType: MessageScope, scopeId: string) => Promise<void>;
  sendMessage: (scopeType: MessageScope, scopeId: string, body: string) => Promise<boolean>;
  addFriend: (input: { displayName: string; handle: string }) => Promise<Friend | null>;
  removeFriend: (id: string) => Promise<void>;
  addGame: (input: { title: string; exePath: string }) => Promise<Game | null>;
  removeGame: (id: string) => Promise<void>;
  clearWorkspace: () => Promise<void>;
}

function groupMessages(messages: Message[]): Record<ScopeKey, Message[]> {
  const grouped: Record<ScopeKey, Message[]> = {};
  for (const message of messages) {
    const key = scopeKey(message.scopeType, message.scopeId);
    (grouped[key] ??= []).push(message);
  }
  return grouped;
}

function sortRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ready: false,
  bootError: null,
  profile: null,
  settings: defaultSettings(),
  rooms: [],
  friends: [],
  games: [],
  info: null,
  messages: {},
  loadingScopes: {},
  epoch: 0,

  init: async () => {
    try {
      const [data, info] = await Promise.all([port.bootstrap(), port.appInfo()]);
      const settings = sanitizeSettings(data.settings);
      // While signed in the server is the source of truth. Loading local rooms
      // here would replace them (and did, on a hot reload).
      const remote = getRemoteAdapter();
      set({
        ready: true,
        bootError: null,
        settings,
        games: data.games,
        info,
        ...(remote
          ? {}
          : {
              profile: data.profile,
              rooms: sortRooms(data.rooms),
              friends: data.friends,
              messages: groupMessages(data.messages),
            }),
      });
      applyPreferences(settings);
    } catch (error) {
      set({
        ready: true,
        bootError: error instanceof Error ? error.message : 'Meldrift could not load local data.',
      });
    }
  },

  /* ---- Connected mode ------------------------------------------------- */

  joinRoom: async (code) => {
    const remote = getRemoteAdapter();
    if (!remote) {
      useUi.getState().pushToast('Sign in to join a room by invite code.', 'info');
      return null;
    }
    const clean = normalizeInviteCode(code);
    if (clean.length !== 7) {
      useUi.getState().pushToast('Invite codes are seven characters.', 'error');
      return null;
    }
    try {
      const room = await remote.joinRoom(clean);
      set((state) => ({
        rooms: sortRooms([room, ...state.rooms.filter((item) => item.id !== room.id)]),
      }));
      return room;
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'That room could not be joined.',
        'error',
      );
      return null;
    }
  },

  applyRemoteWorkspace: (input) => {
    set((state) => ({
      profile: input.profile,
      rooms: sortRooms(input.rooms),
      friends: [...input.friends].sort((a, b) => a.displayName.localeCompare(b.displayName)),
      messages: {},
      loadingScopes: {},
      epoch: state.epoch + 1,
    }));
  },

  appendRemoteMessage: (message) => {
    const key = scopeKey(message.scopeType, message.scopeId);
    set((state) => ({
      messages: {
        ...state.messages,
        [key]: mergeMessages(state.messages[key] ?? [], [message]),
      },
      rooms:
        message.scopeType === 'room'
          ? sortRooms(
              state.rooms.map((room) =>
                room.id === message.scopeId && message.createdAt > room.lastActiveAt
                  ? { ...room, lastActiveAt: message.createdAt }
                  : room,
              ),
            )
          : state.rooms,
    }));
  },

  applyPresence: (presence) => {
    set((state) => ({
      friends: state.friends.map((friend) =>
        presence[friend.id] ? { ...friend, presence: presence[friend.id] } : friend,
      ),
    }));
  },

  upsertFriend: (friend) => {
    set((state) => {
      const exists = state.friends.some((item) => item.id === friend.id);
      const friends = exists
        ? state.friends.map((item) => (item.id === friend.id ? { ...item, ...friend } : item))
        : [...state.friends, friend];
      return { friends: friends.sort((a, b) => a.displayName.localeCompare(b.displayName)) };
    });
  },

  completeOnboarding: async (name, color) => {
    const profile = makeProfile(name, color);
    const saved = await port.saveProfile(profile);
    set({ profile: saved });
  },

  saveProfile: async (patch) => {
    const current = get().profile;
    if (!current) return;
    if (getRemoteAdapter()) {
      useUi.getState().pushToast('Sign out of your account to edit the local profile.', 'info');
      return;
    }
    const next: Profile = {
      ...current,
      ...patch,
      displayName: (patch.displayName ?? current.displayName).trim().slice(0, 32) || current.displayName,
      handle: (patch.handle ?? current.handle).replace(/^@/, '').trim().slice(0, 32) || current.handle,
      bio: (patch.bio ?? current.bio).slice(0, 160),
    };
    set({ profile: next });
    try {
      const saved = await port.saveProfile(next);
      set({ profile: saved });
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Profile could not be saved.',
        'error',
      );
    }
  },

  updateSettings: async (patch) => {
    const next = sanitizeSettings({ ...get().settings, ...patch });
    set({ settings: next });
    applyPreferences(next);
    try {
      await port.saveSettings(next);
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Settings could not be saved.',
        'error',
      );
    }
  },

  createRoom: async (input) => {
    const remote = getRemoteAdapter();
    try {
      const room = remote ? await remote.createRoom(input) : await port.createRoom(input);
      set((state) => ({
        rooms: sortRooms([room, ...state.rooms.filter((item) => item.id !== room.id)]),
      }));
      return room;
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Room could not be created.',
        'error',
      );
      return null;
    }
  },

  updateRoom: async (id, patch) => {
    if (getRemoteAdapter()) {
      useUi.getState().pushToast('Renaming server rooms is not available in this build yet.', 'info');
      return;
    }
    const current = get().rooms.find((room) => room.id === id);
    if (!current) return;
    const merged = {
      id,
      name: patch.name ?? current.name,
      gameTitle: patch.gameTitle !== undefined ? patch.gameTitle : current.gameTitle,
    };
    try {
      const room = await port.updateRoom(merged);
      set((state) => ({ rooms: state.rooms.map((r) => (r.id === id ? room : r)) }));
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Room could not be updated.',
        'error',
      );
    }
  },

  deleteRoom: async (id) => {
    if (getRemoteAdapter()) {
      useUi.getState().pushToast('Deleting server rooms is not available in this build yet.', 'info');
      return;
    }
    try {
      await port.deleteRoom(id);
      set((state) => ({
        rooms: state.rooms.filter((room) => room.id !== id),
        messages: Object.fromEntries(
          Object.entries(state.messages).filter(([key]) => key !== scopeKey('room', id)),
        ),
      }));
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Room could not be deleted.',
        'error',
      );
    }
  },

  loadMessages: async (scopeType, scopeId) => {
    const key = scopeKey(scopeType, scopeId);
    if (get().loadingScopes[key]) return;
    set((state) => ({ loadingScopes: { ...state.loadingScopes, [key]: true } }));
    try {
      const remote = getRemoteAdapter();
      const list = remote
        ? await remote.loadMessages(scopeType, scopeId)
        : await port.listMessages(scopeType, scopeId);
      set((state) => ({
        messages: { ...state.messages, [key]: list },
        loadingScopes: { ...state.loadingScopes, [key]: false },
      }));
    } catch (error) {
      set((state) => ({ loadingScopes: { ...state.loadingScopes, [key]: false } }));
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Messages could not be loaded.',
        'error',
      );
    }
  },

  sendMessage: async (scopeType, scopeId, body) => {
    const clean = sanitizeMessageBody(body);
    if (!clean) return false;
    const key = scopeKey(scopeType, scopeId);
    try {
      const remote = getRemoteAdapter();
      const message = remote
        ? await remote.sendMessage(scopeType, scopeId, clean)
        : await port.sendMessage({ scopeType, scopeId, body: clean });
      set((state) => ({
        messages: {
          ...state.messages,
          [key]: mergeMessages(state.messages[key] ?? [], [message]),
        },
        rooms:
          scopeType === 'room'
            ? sortRooms(
                state.rooms.map((room) =>
                  room.id === scopeId ? { ...room, lastActiveAt: message.createdAt } : room,
                ),
              )
            : state.rooms,
      }));
      return true;
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Message could not be sent.',
        'error',
      );
      return false;
    }
  },

  addFriend: async (input) => {
    if (getRemoteAdapter()) {
      useUi.getState().pushToast('You are online. Add friends by username in the same dialog.', 'info');
      return null;
    }
    try {
      const friend = await port.addFriend(input);
      set((state) => ({
        friends: [...state.friends, friend].sort((a, b) =>
          a.displayName.localeCompare(b.displayName),
        ),
      }));
      return friend;
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Friend could not be added.',
        'error',
      );
      return null;
    }
  },

  removeFriend: async (id) => {
    try {
      const remote = getRemoteAdapter();
      if (remote) {
        await remote.removeFriend(id);
      } else {
        await port.removeFriend(id);
      }
      set((state) => ({ friends: state.friends.filter((friend) => friend.id !== id) }));
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Friend could not be removed.',
        'error',
      );
    }
  },

  addGame: async (input) => {
    try {
      const game = await port.addGame(input);
      set((state) => ({ games: [game, ...state.games] }));
      return game;
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Game could not be added.',
        'error',
      );
      return null;
    }
  },

  removeGame: async (id) => {
    try {
      await port.removeGame(id);
      set((state) => ({ games: state.games.filter((game) => game.id !== id) }));
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Game could not be removed.',
        'error',
      );
    }
  },

  clearWorkspace: async () => {
    if (getRemoteAdapter()) {
      useUi.getState().pushToast('Sign out before clearing local data.', 'info');
      return;
    }
    try {
      await port.clearWorkspace();
      set((state) => ({
        profile: null,
        settings: defaultSettings(),
        rooms: [],
        friends: [],
        games: [],
        messages: {},
        epoch: state.epoch + 1,
      }));
      useUi.getState().navigate({ kind: 'home' });
    } catch (error) {
      useUi.getState().pushToast(
        error instanceof Error ? error.message : 'Local data could not be cleared.',
        'error',
      );
    }
  },
}));

function applyPreferences(settings: Settings): void {
  document.documentElement.dataset.motion = settings.reduceMotion ? 'reduced' : 'full';
  document.documentElement.dataset.density = settings.compactDensity ? 'compact' : 'comfy';
}

/* ---- Selectors used by screens (kept outside components to stay stable) --- */

export const selectRooms = (state: WorkspaceState) => state.rooms;
export const selectFriends = (state: WorkspaceState) => state.friends;
export const selectSettings = (state: WorkspaceState) => state.settings;
export const selectProfile = (state: WorkspaceState) => state.profile;

export function useRoom(roomId: string | null): Room | null {
  return useWorkspace((state) =>
    roomId ? state.rooms.find((room) => room.id === roomId) ?? null : null,
  );
}

export function useScopeMessages(scopeType: MessageScope, scopeId: string): Message[] {
  return useWorkspace((state) => state.messages[scopeKey(scopeType, scopeId)] ?? EMPTY);
}

const EMPTY: Message[] = [];
