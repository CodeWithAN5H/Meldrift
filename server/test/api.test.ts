import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import type { ServerEvent } from '../../shared/protocol';
import { SignalingService, type ServiceOptions, type SocketData } from '../src/app';

/* These tests drive a real HTTP + WebSocket server against an in-memory
   SQLite database. Nothing is mocked: hashing, sessions, membership checks and
   fan-out all execute exactly as they do in production. */

let service: SignalingService;
let server: Server<SocketData>;
let base: string;
let wsBase: string;

function startServer(options: ServiceOptions = {}): {
  service: SignalingService;
  server: Server<SocketData>;
  base: string;
  stop: () => void;
} {
  const instance = new SignalingService(':memory:', options);
  const bunServer = Bun.serve<SocketData>({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, socketServer) {
      return (await instance.handle(request, socketServer)) ?? new Response('Not found', { status: 404 });
    },
    websocket: {
      open(socket) {
        instance.onOpen(socket);
      },
      message(socket, message) {
        instance.onMessage(socket, message as string | Buffer);
      },
      close(socket) {
        instance.onClose(socket);
      },
    },
  });
  return {
    service: instance,
    server: bunServer,
    base: `http://127.0.0.1:${bunServer.port}`,
    stop: () => {
      bunServer.stop(true);
      instance.close();
    },
  };
}

beforeAll(() => {
  // The rate limiter is exercised separately; this suite needs many accounts.
  const harness = startServer({ authBurst: 500 });
  service = harness.service;
  server = harness.server;
  base = harness.base;
  wsBase = `ws://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  service.close();
});

async function api(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<{ status: number; data: any }> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(base + path, { ...init, headers });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

let userCounter = 0;
async function registerUser(displayName = 'Player') {
  userCounter += 1;
  const username = `player${userCounter}${Date.now().toString(36).slice(-4)}`;
  const result = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'correct-horse-1', displayName }),
  });
  expect(result.status).toBe(201);
  return { token: result.data.token as string, user: result.data.user, username };
}

interface Socket {
  ws: WebSocket;
  events: ServerEvent[];
  close: () => void;
}

async function connect(token: string): Promise<Socket> {
  const ws = new WebSocket(`${wsBase}/ws?token=${token}`);
  const events: ServerEvent[] = [];
  ws.addEventListener('message', (event) => {
    events.push(JSON.parse(String(event.data)) as ServerEvent);
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('socket failed')), { once: true });
  });
  return { ws, events, close: () => ws.close() };
}

async function waitFor(
  events: ServerEvent[],
  predicate: (event: ServerEvent) => boolean,
  timeoutMs = 3000,
): Promise<ServerEvent> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out. Events seen: ${JSON.stringify(events)}`);
}

describe('service basics', () => {
  it('reports health and protocol version', async () => {
    const { status, data } = await api('/api/health');
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.protocol).toBe(1);
  });

  it('rejects unauthenticated bootstrap', async () => {
    const { status } = await api('/api/bootstrap');
    expect(status).toBe(401);
  });

  it('rate-limits repeated auth attempts', async () => {
    const limited = startServer({ authBurst: 2 });
    try {
      const attempt = () =>
        fetch(`${limited.base}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'nobody-here', password: 'wrong-password' }),
        });

      expect((await attempt()).status).toBe(401);
      expect((await attempt()).status).toBe(401);
      expect((await attempt()).status).toBe(429);
    } finally {
      limited.stop();
    }
  });
});

describe('accounts', () => {
  it('registers, rejects duplicates and validates input', async () => {
    const { username } = await registerUser('Ansh');

    const duplicate = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password: 'another-password', displayName: 'Copy' }),
    });
    expect(duplicate.status).toBe(409);

    const short = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'ab', password: 'short', displayName: 'Bad' }),
    });
    expect(short.status).toBe(400);
  });

  it('logs in with the right password only', async () => {
    const { username } = await registerUser('Rohan');

    const wrong = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password: 'not-the-password' }),
    });
    expect(wrong.status).toBe(401);

    const missing = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'ghost-user', password: 'not-the-password' }),
    });
    expect(missing.status).toBe(401);

    const ok = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password: 'correct-horse-1' }),
    });
    expect(ok.status).toBe(200);
    expect(ok.data.token).toBeString();
  });
});

describe('rooms and messaging', () => {
  it('creates a room, joins by code and fans out messages', async () => {
    const host = await registerUser('Ansh');
    const guest = await registerUser('Rohan');

    const created = await api(
      '/api/rooms',
      { method: 'POST', body: JSON.stringify({ name: 'The Boys', kind: 'game', gameTitle: 'RDR2' }) },
      host.token,
    );
    expect(created.status).toBe(201);
    expect(created.data.members).toHaveLength(1);
    expect(created.data.members[0].role).toBe('host');
    expect(created.data.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{7}$/);

    const hostSocket = await connect(host.token);
    const guestSocket = await connect(guest.token);
    await waitFor(hostSocket.events, (event) => event.t === 'ready');

    const joined = await api(
      '/api/rooms/join',
      { method: 'POST', body: JSON.stringify({ code: created.data.inviteCode }) },
      guest.token,
    );
    expect(joined.status).toBe(200);
    expect(joined.data.members).toHaveLength(2);

    // The host is told the membership changed.
    await waitFor(
      hostSocket.events,
      (event) => event.t === 'room.members' && event.members.length === 2,
    );

    guestSocket.ws.send(
      JSON.stringify({
        t: 'message.send',
        clientId: 'client-1',
        scopeType: 'room',
        scopeId: created.data.id,
        body: '  who is playing next?  ',
      }),
    );

    const ack = await waitFor(
      guestSocket.events,
      (event) => event.t === 'message.ack' && event.clientId === 'client-1',
    );
    expect(ack.t === 'message.ack' && ack.message.body).toBe('who is playing next?');

    const delivered = await waitFor(hostSocket.events, (event) => event.t === 'message.new');
    expect(delivered.t === 'message.new' && delivered.message.authorName).toBe('Rohan');

    const history = await api(
      `/api/messages?scopeType=room&scopeId=${created.data.id}`,
      {},
      host.token,
    );
    expect(history.status).toBe(200);
    expect(history.data.map((message: { body: string }) => message.body)).toEqual([
      'who is playing next?',
    ]);

    hostSocket.close();
    guestSocket.close();
  });

  it('refuses messages from a non-member', async () => {
    const owner = await registerUser('Ansh');
    const stranger = await registerUser('Aman');

    const room = await api(
      '/api/rooms',
      { method: 'POST', body: JSON.stringify({ name: 'Private', kind: 'voice' }) },
      owner.token,
    );

    const socket = await connect(stranger.token);
    socket.ws.send(
      JSON.stringify({
        t: 'message.send',
        clientId: 'intruder',
        scopeType: 'room',
        scopeId: room.data.id,
        body: 'let me in',
      }),
    );

    const error = await waitFor(
      socket.events,
      (event) => event.t === 'message.error' && event.clientId === 'intruder',
    );
    expect(error.t === 'message.error' && error.error).toContain('No access');

    const forbidden = await api(
      `/api/messages?scopeType=room&scopeId=${room.data.id}`,
      {},
      stranger.token,
    );
    expect(forbidden.status).toBe(403);

    socket.close();
  });
});

describe('friends and direct messages', () => {
  it('requires friendship, then delivers DMs both ways', async () => {
    const a = await registerUser('Ansh');
    const b = await registerUser('Siddharth');

    const request = await api(
      '/api/friends',
      { method: 'POST', body: JSON.stringify({ username: b.username }) },
      a.token,
    );
    expect(request.status).toBe(201);

    const bBootstrap = await api('/api/bootstrap', {}, b.token);
    expect(bBootstrap.data.requests).toHaveLength(1);
    expect(bBootstrap.data.requests[0].username).toBe(a.username);

    const accepted = await api(
      '/api/friends/accept',
      { method: 'POST', body: JSON.stringify({ userId: a.user.id }) },
      b.token,
    );
    expect(accepted.status).toBe(200);

    const aBootstrap = await api('/api/bootstrap', {}, a.token);
    expect(aBootstrap.data.friends).toHaveLength(1);
    expect(aBootstrap.data.friends[0].userId).toBe(b.user.id);

    const conversation = await api(`/api/dm/${b.user.id}`, {}, a.token);
    expect(conversation.status).toBe(200);
    const conversationId = conversation.data.conversationId;

    const socketA = await connect(a.token);
    const socketB = await connect(b.token);
    await waitFor(socketA.events, (event) => event.t === 'ready');

    socketA.ws.send(
      JSON.stringify({
        t: 'message.send',
        clientId: 'dm-1',
        scopeType: 'dm',
        scopeId: conversationId,
        body: 'join the room',
      }),
    );

    await waitFor(socketA.events, (event) => event.t === 'message.ack');
    const incoming = await waitFor(socketB.events, (event) => event.t === 'message.new');
    expect(incoming.t === 'message.new' && incoming.message.body).toBe('join the room');

    socketA.close();
    socketB.close();
  });

  it('blocks conversations with non-friends', async () => {
    const a = await registerUser('Ansh');
    const stranger = await registerUser('Arya');
    const result = await api(`/api/dm/${stranger.user.id}`, {}, a.token);
    expect(result.status).toBe(403);
  });
});

describe('presence', () => {
  it('broadcasts online and offline transitions to friends', async () => {
    const a = await registerUser('Ansh');
    const b = await registerUser('Aman');

    await api('/api/friends', { method: 'POST', body: JSON.stringify({ username: b.username }) }, a.token);
    const bBootstrap = await api('/api/bootstrap', {}, b.token);
    await api(
      '/api/friends/accept',
      { method: 'POST', body: JSON.stringify({ userId: bBootstrap.data.requests[0].userId }) },
      b.token,
    );

    const socketA = await connect(a.token);
    await waitFor(socketA.events, (event) => event.t === 'ready');

    const socketB = await connect(b.token);
    const online = await waitFor(
      socketA.events,
      (event) => event.t === 'presence.update' && event.userId === b.user.id && event.presence === 'online',
    );
    expect(online.t).toBe('presence.update');

    socketB.close();
    const offline = await waitFor(
      socketA.events,
      (event) => event.t === 'presence.update' && event.userId === b.user.id && event.presence === 'offline',
      5000,
    );
    expect(offline.t).toBe('presence.update');

    socketA.close();
  });
});
