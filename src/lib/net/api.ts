import type {
  AuthResponse,
  BootstrapView,
  FriendRequestView,
  FriendView,
  LoginBody,
  MessageScope,
  MessageView,
  PublicUser,
  RegisterBody,
  RoomView,
} from '@shared/protocol';

/* --------------------------------------------------------------------------
   Typed HTTP client for the Meldrift signaling service.

   Nothing here touches app state: the network store owns credentials and
   decides what to do with the results. Every failure surfaces as an ApiError
   with a status of 0 for transport problems, so screens can distinguish
   "server said no" from "server could not be reached".
   -------------------------------------------------------------------------- */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

export interface StoredSession {
  serverUrl: string;
  token: string;
  user: PublicUser;
}

/** Accepts "host:port", "http://host", trailing slashes and paths. */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ApiError('Enter your server address', 0);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ApiError('That does not look like a server address', 0);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError('Use an http:// or https:// address', 0);
  }
  if (!url.hostname) throw new ApiError('Enter your server address', 0);
  url.search = '';
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

export function websocketUrl(serverUrl: string, token: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`;
  url.searchParams.set('token', token);
  return url.toString();
}

async function request<T>(
  serverUrl: string,
  path: string,
  init: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.token) headers.authorization = `Bearer ${init.token}`;

    const response = await fetch(`${serverUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });

    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const message =
        data && typeof data === 'object' && 'error' in data
          ? String((data as { error: unknown }).error)
          : `The server answered ${response.status}`;
      throw new ApiError(message, response.status);
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('The server took too long to answer', 0);
    }
    throw new ApiError(
      `Cannot reach ${serverUrl}. Check the address and that the service is running.`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

export const signalingApi = {
  health: (serverUrl: string) =>
    request<{ ok: boolean; protocol: number; name: string }>(serverUrl, '/api/health'),

  register: (serverUrl: string, body: RegisterBody) =>
    request<AuthResponse>(serverUrl, '/api/auth/register', { method: 'POST', body }),

  login: (serverUrl: string, body: LoginBody) =>
    request<AuthResponse>(serverUrl, '/api/auth/login', { method: 'POST', body }),

  logout: (serverUrl: string, token: string) =>
    request<{ ok: boolean }>(serverUrl, '/api/auth/logout', { method: 'POST', token }),

  bootstrap: (serverUrl: string, token: string) =>
    request<BootstrapView>(serverUrl, '/api/bootstrap', { token }),

  createRoom: (
    serverUrl: string,
    token: string,
    body: { name: string; kind: 'game' | 'voice'; gameTitle?: string | null },
  ) => request<RoomView>(serverUrl, '/api/rooms', { method: 'POST', token, body }),

  joinRoom: (serverUrl: string, token: string, code: string) =>
    request<RoomView>(serverUrl, '/api/rooms/join', { method: 'POST', token, body: { code } }),

  listMessages: (
    serverUrl: string,
    token: string,
    scopeType: MessageScope,
    scopeId: string,
    limit = 100,
  ) =>
    request<MessageView[]>(
      serverUrl,
      `/api/messages?scopeType=${scopeType}&scopeId=${encodeURIComponent(scopeId)}&limit=${limit}`,
      { token },
    ),

  requestFriend: (serverUrl: string, token: string, username: string) =>
    request<{ pending?: boolean; friend?: FriendView }>(serverUrl, '/api/friends', {
      method: 'POST',
      token,
      body: { username },
    }),

  acceptFriend: (serverUrl: string, token: string, userId: string) =>
    request<{ friend: FriendView | null }>(serverUrl, '/api/friends/accept', {
      method: 'POST',
      token,
      body: { userId },
    }),

  removeFriend: (serverUrl: string, token: string, userId: string) =>
    request<{ ok: boolean }>(serverUrl, `/api/friends/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      token,
    }),

  openConversation: (serverUrl: string, token: string, peerId: string) =>
    request<{ conversationId: string }>(serverUrl, `/api/dm/${encodeURIComponent(peerId)}`, {
      token,
    }),
};

export type PendingRequest = FriendRequestView;
