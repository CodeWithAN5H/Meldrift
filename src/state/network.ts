import { create } from 'zustand';
import type {
  BootstrapView,
  FriendRequestView,
  IceServerView,
  Presence,
  PublicUser,
  RoomMemberView,
  ServerEvent,
} from '@shared/protocol';
import { port } from '@/lib/ipc';
import { useWorkspace } from '@/state/workspace';
import { useUi } from '@/state/ui';
import { colorFor } from '@/lib/model';
import {
  ApiError,
  normalizeServerUrl,
  signalingApi,
  websocketUrl,
  type StoredSession,
} from '@/lib/net/api';
import { RealtimeConnection, type SocketStatus } from '@/lib/net/realtime';
import { toFriend, toMessage, toProfile, toRoom } from '@/lib/net/map';
import { setRemoteAdapter, type RemoteAdapter } from '@/lib/net/hub';
import { setVoiceTransport } from '@/lib/voice/transport';
import { useVoiceRoom } from '@/state/voiceRoom';
import { useStreamRoom } from '@/state/streamRoom';
import { useControlRoom } from '@/state/controlRoom';

/* --------------------------------------------------------------------------
   Connected mode.

   Signed out, the app is local-only. Signed in, this store owns credentials,
   the socket and presence, and mirrors server rooms/friends/messages into the
   same workspace store the screens already read. Local data is never deleted
   when you sign in or out; it is simply not the source of truth while online.
   -------------------------------------------------------------------------- */

export type NetworkStatus = 'signed-out' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface AuthResult {
  ok: boolean;
  error?: string;
}

interface NetworkState {
  status: NetworkStatus;
  serverUrl: string;
  user: PublicUser | null;
  error: string | null;
  busy: boolean;
  requests: FriendRequestView[];
  presence: Record<string, Presence>;
  members: Record<string, RoomMemberView[]>;
  initialize: () => Promise<void>;
  signIn: (input: { serverUrl: string; username: string; password: string }) => Promise<AuthResult>;
  signUp: (input: {
    serverUrl: string;
    username: string;
    password: string;
    displayName: string;
  }) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  retry: () => void;
  sendFriendRequest: (username: string) => Promise<AuthResult>;
  acceptRequest: (userId: string) => Promise<void>;
  declineRequest: (userId: string) => Promise<void>;
}

let socket: RealtimeConnection | null = null;
let token: string | null = null;
let initializing = false;
let activeServer = '';
let iceServers: IceServerView[] = [];
/** peerId → conversationId, so DMs keep using the friend id as their scope. */
const conversations = new Map<string, string>();
const peersByConversation = new Map<string, string>();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

function requireToken(): string {
  if (!token) throw new Error('Sign in first');
  return token;
}

export const useNetwork = create<NetworkState>((set, get) => ({
  status: 'signed-out',
  serverUrl: '',
  user: null,
  error: null,
  busy: false,
  requests: [],
  presence: {},
  members: {},

  initialize: async () => {
    if (initializing || get().status !== 'signed-out' || token) return;
    initializing = true;
    try {
      let stored: StoredSession | null = null;
      try {
        stored = await port.loadSession();
      } catch {
        stored = null;
      }
      if (!stored) return;

      set({ serverUrl: stored.serverUrl, user: stored.user, status: 'connecting' });
      await establish(stored.serverUrl, stored.token, stored.user);
    } finally {
      initializing = false;
    }
  },

  signIn: async (input) => {
    set({ busy: true, error: null });
    try {
      const serverUrl = normalizeServerUrl(input.serverUrl);
      const auth = await signalingApi.login(serverUrl, {
        username: input.username.trim(),
        password: input.password,
      });
      set({ serverUrl, user: auth.user });
      await establish(serverUrl, auth.token, auth.user);
      if (get().status === 'offline') {
        return { ok: false, error: get().error ?? 'Signed in, but the live channel did not open.' };
      }
      return { ok: true };
    } catch (error) {
      const message = messageOf(error);
      set({ error: message, status: 'signed-out' });
      return { ok: false, error: message };
    } finally {
      set({ busy: false });
    }
  },

  signUp: async (input) => {
    set({ busy: true, error: null });
    try {
      const serverUrl = normalizeServerUrl(input.serverUrl);
      const localProfile = useWorkspace.getState().profile;
      const auth = await signalingApi.register(serverUrl, {
        username: input.username.trim(),
        password: input.password,
        displayName: input.displayName.trim() || input.username.trim(),
        avatarColor: localProfile?.avatarColor ?? colorFor(input.username.trim()),
      });
      set({ serverUrl, user: auth.user });
      await establish(serverUrl, auth.token, auth.user);
      if (get().status === 'offline') {
        return { ok: false, error: get().error ?? 'Account created, but the live channel did not open.' };
      }
      return { ok: true };
    } catch (error) {
      const message = messageOf(error);
      set({ error: message, status: 'signed-out' });
      return { ok: false, error: message };
    } finally {
      set({ busy: false });
    }
  },

  signOut: async () => {
    const currentToken = token;
    const currentServer = activeServer;
    // Voice, screen capture and remote control must stop before the session
    // goes away. Rust also releases every held key on sign-out.
    useVoiceRoom.getState().leave();
    useStreamRoom.getState().reset();
    useControlRoom.getState().reset();
    stopSocket();
    clearInternal();
    set({
      status: 'signed-out',
      user: null,
      requests: [],
      presence: {},
      members: {},
      error: null,
      busy: false,
    });
    if (currentToken && currentServer) {
      void signalingApi.logout(currentServer, currentToken).catch(() => undefined);
    }
    try {
      await port.saveSession(null);
    } catch {
      // A failed session clear still leaves the in-memory session gone.
    }
    // Put the local workspace back on screen.
    await useWorkspace.getState().init();
  },

  retry: () => {
    if (token && activeServer) void establish(activeServer, token, get().user ?? undefined);
  },

  sendFriendRequest: async (username) => {
    if (!token) return { ok: false, error: 'Sign in to add friends online' };
    try {
      const result = await signalingApi.requestFriend(activeServer, requireToken(), username.trim());
      if (result.friend) {
        useWorkspace.getState().upsertFriend(toFriend(result.friend));
        return { ok: true };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  },

  acceptRequest: async (userId) => {
    try {
      const result = await signalingApi.acceptFriend(activeServer, requireToken(), userId);
      if (result.friend) useWorkspace.getState().upsertFriend(toFriend(result.friend));
      set((state) => ({ requests: state.requests.filter((request) => request.userId !== userId) }));
    } catch (error) {
      useUi.getState().pushToast(messageOf(error), 'error');
    }
  },

  declineRequest: async (userId) => {
    try {
      await signalingApi.removeFriend(activeServer, requireToken(), userId);
      set((state) => ({ requests: state.requests.filter((request) => request.userId !== userId) }));
    } catch (error) {
      useUi.getState().pushToast(messageOf(error), 'error');
    }
  },
}));

/* ---- Connection lifecycle ---------------------------------------------- */

function stopSocket(): void {
  if (socket) socket.stop();
  socket = null;
}

function clearInternal(): void {
  setRemoteAdapter(null);
  setVoiceTransport(null);
  token = null;
  activeServer = '';
  iceServers = [];
  conversations.clear();
  peersByConversation.clear();
}

/** Voice sends through the same socket as chat; it never opens its own. */
function installVoiceTransport(selfId: string): void {
  setVoiceTransport({
    selfId,
    iceServers,
    send: (event) => socket?.send(event) ?? false,
  });
}

async function establish(serverUrl: string, authToken: string, hintUser?: PublicUser): Promise<void> {
  token = authToken;
  activeServer = serverUrl;
  useNetwork.setState({ error: null, status: 'connecting', serverUrl, user: hintUser ?? null });

  try {
    const data = await signalingApi.bootstrap(serverUrl, authToken);
    applyBootstrap(data);
    connectSocket(serverUrl, authToken);
    setRemoteAdapter(makeAdapter(serverUrl, data.user.id));
    useNetwork.setState({ user: data.user, status: 'connecting' });
    installVoiceTransport(data.user.id);
    // ICE configuration is optional: voice still works on a LAN without STUN.
    void signalingApi
      .voiceConfig(serverUrl, authToken)
      .then((config) => {
        iceServers = config.iceServers;
        installVoiceTransport(data.user.id);
      })
      .catch(() => {
        iceServers = [];
      });
    try {
      await port.saveSession({ serverUrl, token: authToken, user: data.user });
    } catch {
      // The session still works for this run; it just will not survive a restart.
    }
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      stopSocket();
      clearInternal();
      useNetwork.setState({
        status: 'signed-out',
        user: null,
        error: 'Your session expired. Sign in again.',
        requests: [],
        presence: {},
        members: {},
      });
      try {
        await port.saveSession(null);
      } catch {
        // Nothing else to clear.
      }
      return;
    }
    useNetwork.setState({ status: 'offline', error: messageOf(error) });
  }
}

function connectSocket(serverUrl: string, authToken: string): void {
  stopSocket();
  socket = new RealtimeConnection(websocketUrl(serverUrl, authToken), {
    onStatus: (status: SocketStatus) => {
      const mapped: NetworkStatus =
        status === 'online'
          ? 'online'
          : status === 'connecting'
            ? 'connecting'
            : status === 'reconnecting'
              ? 'reconnecting'
              : 'offline';
      const current = useNetwork.getState();
      if (mapped === 'offline' && current.status === 'signed-out') return;
      useNetwork.setState({ status: mapped });
      useVoiceRoom.getState().onConnection(mapped);
      useStreamRoom.getState().onConnection(mapped);
      useControlRoom.getState().onConnection(mapped);
    },
    onEvent: handleEvent,
  });
  socket.start();
}

function handleEvent(event: ServerEvent): void {
  switch (event.t) {
    case 'ready': {
      useNetwork.setState({ status: 'online', error: null, presence: event.presence });
      useWorkspace.getState().applyPresence(event.presence);
      return;
    }
    case 'message.new': {
      const isDm = event.message.scopeType === 'dm';
      const scopeId = isDm ? peersByConversation.get(event.message.scopeId) : event.message.scopeId;
      if (!scopeId) return;
      useWorkspace.getState().appendRemoteMessage(toMessage(event.message, scopeId));
      return;
    }
    case 'presence.update': {
      useNetwork.setState((state) => ({
        presence: { ...state.presence, [event.userId]: event.presence },
      }));
      useWorkspace.getState().applyPresence({ [event.userId]: event.presence });
      return;
    }
    case 'room.members': {
      useNetwork.setState((state) => ({
        members: { ...state.members, [event.roomId]: event.members },
      }));
      return;
    }
    case 'friend.update': {
      useWorkspace.getState().upsertFriend(toFriend(event.friend));
      useNetwork.setState((state) => ({
        requests: state.requests.filter((request) => request.userId !== event.friend.userId),
        presence: { ...state.presence, [event.friend.userId]: event.friend.presence },
      }));
      return;
    }
    case 'friend.request': {
      useNetwork.setState((state) =>
        state.requests.some((request) => request.userId === event.request.userId)
          ? state
          : { requests: [...state.requests, event.request] },
      );
      useUi
        .getState()
        .pushToast(`${event.request.displayName} sent you a friend request`, 'info');
      return;
    }
    case 'error': {
      useUi.getState().pushToast(event.message, 'error');
      return;
    }
    default: {
      if (event.t.startsWith('voice.')) useVoiceRoom.getState().handleEvent(event);
      else if (event.t.startsWith('stream.')) useStreamRoom.getState().handleEvent(event);
      else if (event.t.startsWith('control.')) useControlRoom.getState().handleEvent(event);
      return;
    }
  }
}

function applyBootstrap(data: BootstrapView): void {
  conversations.clear();
  peersByConversation.clear();
  const presence: Record<string, Presence> = {};
  const members: Record<string, RoomMemberView[]> = {};

  for (const conversation of data.conversations) {
    conversations.set(conversation.peer.id, conversation.id);
    peersByConversation.set(conversation.id, conversation.peer.id);
    presence[conversation.peer.id] = conversation.peerPresence;
  }
  for (const friend of data.friends) presence[friend.userId] = friend.presence;
  for (const room of data.rooms) {
    members[room.id] = room.members;
    for (const member of room.members) presence[member.userId] = member.presence;
  }

  useNetwork.setState({
    user: data.user,
    requests: data.requests,
    presence,
    members,
    serverUrl: activeServer,
  });

  useWorkspace.getState().applyRemoteWorkspace({
    profile: toProfile(data.user),
    rooms: data.rooms.map((room) => toRoom(room, data.user.id)),
    friends: data.friends.map(toFriend),
  });
}

/* ---- Adapter used by the workspace store ------------------------------- */

function makeAdapter(serverUrl: string, userId: string): RemoteAdapter {
  return {
    serverUrl,
    userId,

    createRoom: async (input) => {
      const view = await signalingApi.createRoom(serverUrl, requireToken(), {
        name: input.name,
        kind: input.kind,
        gameTitle: input.gameTitle,
      });
      rememberMembers(view);
      return toRoom(view, userId);
    },

    joinRoom: async (code) => {
      const view = await signalingApi.joinRoom(serverUrl, requireToken(), code);
      rememberMembers(view);
      return toRoom(view, userId);
    },

    loadMessages: async (scopeType, scopeId) => {
      if (scopeType === 'dm') {
        const conversationId = await ensureConversation(scopeId);
        const list = await signalingApi.listMessages(serverUrl, requireToken(), 'dm', conversationId);
        return list.map((message) => toMessage(message, scopeId));
      }
      const list = await signalingApi.listMessages(serverUrl, requireToken(), 'room', scopeId);
      return list.map((message) => toMessage(message));
    },

    sendMessage: async (scopeType, scopeId, body) => {
      if (!socket) throw new Error('Not connected to the server');
      const conversationId = scopeType === 'dm' ? await ensureConversation(scopeId) : scopeId;
      const view = await socket.sendMessage(scopeType, conversationId, body);
      return toMessage(view, scopeId);
    },

    removeFriend: async (peerId) => {
      await signalingApi.removeFriend(serverUrl, requireToken(), peerId);
    },
  };
}

function rememberMembers(view: {
  id: string;
  members: RoomMemberView[];
}): void {
  useNetwork.setState((state) => ({ members: { ...state.members, [view.id]: view.members } }));
}

async function ensureConversation(peerId: string): Promise<string> {
  const known = conversations.get(peerId);
  if (known) return known;
  const result = await signalingApi.openConversation(activeServer, requireToken(), peerId);
  conversations.set(peerId, result.conversationId);
  peersByConversation.set(result.conversationId, peerId);
  return result.conversationId;
}
