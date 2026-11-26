import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import type { ServerEvent } from '../../shared/protocol';
import { SignalingService, type ServiceOptions, type SocketData } from '../src/app';

/* Voice signaling tests. Like api.test.ts these run a real HTTP + WebSocket
   server against in-memory SQLite; no signaling logic is mocked. SDP and ICE
   payloads are synthetic strings because the server relays them opaquely — the
   browser's WebRTC stack is exercised separately by the native client tests. */

let service: SignalingService;
let server: Server<SocketData>;
let base: string;
let wsBase: string;

function startServer(options: ServiceOptions = {}) {
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
    wsBase: `ws://127.0.0.1:${bunServer.port}`,
    stop: () => {
      bunServer.stop(true);
      instance.close();
    },
  };
}

beforeAll(() => {
  const harness = startServer({ authBurst: 1000 });
  service = harness.service;
  server = harness.server;
  base = harness.base;
  wsBase = harness.wsBase;
});

afterAll(() => {
  server.stop(true);
  service.close();
});

async function api(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(base + path, { ...init, headers });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

let counter = 0;
async function registerUser(displayName = 'Player') {
  counter += 1;
  const username = `v${counter}${Date.now().toString(36).slice(-5)}`;
  const result = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'correct-horse-1', displayName }),
  });
  expect(result.status).toBe(201);
  return { token: result.data.token as string, user: result.data.user as { id: string } };
}

async function createRoom(token: string, name = 'Voice room') {
  const result = await api(
    '/api/rooms',
    { method: 'POST', body: JSON.stringify({ name, kind: 'voice' }) },
    token,
  );
  expect(result.status).toBe(201);
  return result.data as { id: string; inviteCode: string };
}

async function joinRoom(token: string, code: string) {
  const result = await api('/api/rooms/join', { method: 'POST', body: JSON.stringify({ code }) }, token);
  expect(result.status).toBe(200);
  return result.data as { id: string };
}

interface Socket {
  ws: WebSocket;
  events: ServerEvent[];
  send: (event: unknown) => void;
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
  return {
    ws,
    events,
    send: (event) => ws.send(JSON.stringify(event)),
    close: () => ws.close(),
  };
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

function voiceJoined(socket: Socket) {
  return waitFor(socket.events, (event) => event.t === 'voice.joined');
}

describe('voice ICE configuration', () => {
  it('requires a session and advertises only authenticated configuration', async () => {
    const unauthenticated = await api('/api/voice/ice');
    expect(unauthenticated.status).toBe(401);

    const user = await registerUser('Player One');
    const config = await api('/api/voice/ice', {}, user.token);
    expect(config.status).toBe(200);
    expect(config.data.maxParticipants).toBe(8);
    expect(config.data.iceServers[0].urls).toEqual(['stun:stun.l.google.com:19302']);
    expect(config.data.iceServers).toHaveLength(1);
  });

  it('returns configured TURN servers and drops malformed URLs', async () => {
    const harness = startServer({
      authBurst: 1000,
      voice: {
        stunUrls: ['stun:stun.example.org:3478', 'not-a-url'],
        turnUrls: ['turn:turn.example.org:3478?transport=udp', 'javascript:alert(1)'],
        turnUsername: 'meldrift',
        turnCredential: 'relay-secret',
      },
    });
    try {
      const headers = { 'content-type': 'application/json' };
      const registered = await fetch(`${harness.base}/api/auth/register`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          username: `turn${Date.now().toString(36).slice(-6)}`,
          password: 'correct-horse-1',
          displayName: 'Turn',
        }),
      });
      const auth = (await registered.json()) as { token: string };
      const response = await fetch(`${harness.base}/api/voice/ice`, {
        headers: { authorization: `Bearer ${auth.token}` },
      });
      const config = (await response.json()) as {
        iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
      };
      expect(config.iceServers).toHaveLength(2);
      expect(config.iceServers[0].urls).toEqual(['stun:stun.example.org:3478']);
      expect(config.iceServers[1]).toEqual({
        urls: ['turn:turn.example.org:3478?transport=udp'],
        username: 'meldrift',
        credential: 'relay-secret',
      });
    } finally {
      harness.stop();
    }
  });
});

describe('voice membership and authorization', () => {
  it('refuses to join voice for a room the user is not in', async () => {
    const owner = await registerUser('Owner');
    const stranger = await registerUser('Stranger');
    const room = await createRoom(owner.token);
    const socket = await connect(stranger.token);
    await waitFor(socket.events, (event) => event.t === 'ready');

    socket.send({ t: 'voice.join', roomId: room.id });
    const error = await waitFor(socket.events, (event) => event.t === 'voice.error');
    expect(error.t === 'voice.error' && error.error).toContain('not a member');
    socket.close();
  });

  it('rejects unknown rooms and never echoes the roster to a non-member', async () => {
    const user = await registerUser('Player One');
    const socket = await connect(user.token);
    await waitFor(socket.events, (event) => event.t === 'ready');

    socket.send({ t: 'voice.join', roomId: crypto.randomUUID() });
    const error = await waitFor(socket.events, (event) => event.t === 'voice.error');
    expect(error.t === 'voice.error' && error.error).toContain('Room not found');
    expect(socket.events.some((event) => event.t === 'voice.joined')).toBe(false);
    socket.close();
  });

  it('announces joins with real names and separate room membership', async () => {
    const host = await registerUser('Native Player');
    const guest = await registerUser('Native Rohan');
    const room = await createRoom(host.token);
    await joinRoom(guest.token, room.inviteCode);

    const hostSocket = await connect(host.token);
    const guestSocket = await connect(guest.token);
    await waitFor(hostSocket.events, (event) => event.t === 'ready');

    hostSocket.send({ t: 'voice.join', roomId: room.id });
    const hostJoined = await voiceJoined(hostSocket);
    expect(hostJoined.t === 'voice.joined' && hostJoined.participants).toEqual([]);

    guestSocket.send({ t: 'voice.join', roomId: room.id });
    const guestJoined = await voiceJoined(guestSocket);
    expect(guestJoined.t === 'voice.joined' && guestJoined.participants).toHaveLength(1);
    const peer = guestJoined.t === 'voice.joined' ? guestJoined.participants[0] : null;
    expect(peer?.displayName).toBe('Native Player');
    expect(peer?.muted).toBe(false);
    expect(peer?.speaking).toBe(false);

    const joinedEvent = await waitFor(
      hostSocket.events,
      (event) => event.t === 'voice.participant.joined',
    );
    expect(joinedEvent.t === 'voice.participant.joined' && joinedEvent.participant.displayName).toBe(
      'Native Rohan',
    );

    // Being in the room is not the same as being in voice: membership events
    // still list both people.
    const bootstrap = await api('/api/bootstrap', {}, host.token);
    expect(bootstrap.data.rooms[0].members).toHaveLength(2);

    hostSocket.close();
    guestSocket.close();
  });

  it('does not duplicate a participant who joins twice (reconnect)', async () => {
    const host = await registerUser('Host');
    const guest = await registerUser('Guest');
    const room = await createRoom(host.token);
    await joinRoom(guest.token, room.inviteCode);

    const hostSocket = await connect(host.token);
    const guestSocket = await connect(guest.token);
    await waitFor(hostSocket.events, (event) => event.t === 'ready');

    hostSocket.send({ t: 'voice.join', roomId: room.id });
    await voiceJoined(hostSocket);
    guestSocket.send({ t: 'voice.join', roomId: room.id });
    await voiceJoined(guestSocket);
    await waitFor(hostSocket.events, (event) => event.t === 'voice.participant.joined');

    const before = hostSocket.events.filter((event) => event.t === 'voice.participant.joined').length;
    guestSocket.send({ t: 'voice.join', roomId: room.id });
    const again = await voiceJoined(guestSocket);
    expect(again.t === 'voice.joined' && again.participants).toHaveLength(1);

    await Bun.sleep(100);
    const after = hostSocket.events.filter((event) => event.t === 'voice.participant.joined').length;
    expect(after).toBe(before);

    // A second join from the same socket keeps one member, not two.
    const memberCount = await api('/api/bootstrap', {}, host.token);
    expect(memberCount.data.rooms[0].members).toHaveLength(2);

    hostSocket.close();
    guestSocket.close();
  });
});

describe('voice signalling routing', () => {
  async function pair() {
    const host = await registerUser('Host');
    const guest = await registerUser('Guest');
    const room = await createRoom(host.token);
    await joinRoom(guest.token, room.inviteCode);
    const hostSocket = await connect(host.token);
    const guestSocket = await connect(guest.token);
    await waitFor(hostSocket.events, (event) => event.t === 'ready');
    hostSocket.send({ t: 'voice.join', roomId: room.id });
    await voiceJoined(hostSocket);
    guestSocket.send({ t: 'voice.join', roomId: room.id });
    await voiceJoined(guestSocket);
    await waitFor(hostSocket.events, (event) => event.t === 'voice.participant.joined');
    return { host, guest, room, hostSocket, guestSocket };
  }

  it('routes offer, answer and ICE between voice participants', async () => {
    const { room, hostSocket, guestSocket } = await pair();
    const roster = guestSocket.events.find((event) => event.t === 'voice.joined') as Extract<
      ServerEvent,
      { t: 'voice.joined' }
    >;
    const hostId = roster.participants[0].userId;

    guestSocket.send({
      t: 'voice.offer',
      roomId: room.id,
      to: hostId,
      sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n',
    });

    const offer = await waitFor(
      hostSocket.events,
      (event) => event.t === 'voice.offer' && event.sdp.includes('v=0'),
    );
    expect(offer.t === 'voice.offer' && offer.roomId).toBe(room.id);
    const from = offer.t === 'voice.offer' ? offer.from : '';

    hostSocket.send({ t: 'voice.answer', roomId: room.id, to: from, sdp: 'v=0\r\nanswer' });
    const answer = await waitFor(guestSocket.events, (event) => event.t === 'voice.answer');
    expect(answer.t === 'voice.answer' && answer.from).toBe(hostId);

    guestSocket.send({
      t: 'voice.ice',
      roomId: room.id,
      to: hostId,
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    const ice = await waitFor(hostSocket.events, (event) => event.t === 'voice.ice');
    expect(ice.t === 'voice.ice' && ice.from).toBe(from);
    expect(ice.t === 'voice.ice' && ice.candidate.candidate).toContain('typ host');

    hostSocket.close();
    guestSocket.close();
  });

  it('refuses signals to room members who are not in voice', async () => {
    const host = await registerUser('Host');
    const guest = await registerUser('Guest');
    const room = await createRoom(host.token);
    await joinRoom(guest.token, room.inviteCode);

    const hostSocket = await connect(host.token);
    const guestSocket = await connect(guest.token);
    await waitFor(hostSocket.events, (event) => event.t === 'ready');

    hostSocket.send({ t: 'voice.join', roomId: room.id });
    await voiceJoined(hostSocket);

    hostSocket.send({ t: 'voice.offer', roomId: room.id, to: guest.user.id, sdp: 'v=0' });
    const error = await waitFor(hostSocket.events, (event) => event.t === 'voice.error');
    expect(error.t === 'voice.error' && error.error).toContain('not in this voice channel');
    expect(guestSocket.events.some((event) => event.t === 'voice.offer')).toBe(false);

    hostSocket.close();
    guestSocket.close();
  });

  it('refuses signals from a user who is not in voice, and to self', async () => {
    const host = await registerUser('Host');
    const guest = await registerUser('Guest');
    const room = await createRoom(host.token);
    await joinRoom(guest.token, room.inviteCode);

    const hostSocket = await connect(host.token);
    const guestSocket = await connect(guest.token);
    await waitFor(hostSocket.events, (event) => event.t === 'ready');
    hostSocket.send({ t: 'voice.join', roomId: room.id });
    await voiceJoined(hostSocket);

    guestSocket.send({ t: 'voice.offer', roomId: room.id, to: host.user.id, sdp: 'v=0' });
    const error = await waitFor(guestSocket.events, (event) => event.t === 'voice.error');
    expect(error.t === 'voice.error' && error.error).toContain('Join voice first');

    hostSocket.send({ t: 'voice.ice', roomId: room.id, to: host.user.id, candidate: { candidate: 'x' } });
    const selfError = await waitFor(
      hostSocket.events,
      (event) => event.t === 'voice.error' && event.error.includes('Invalid voice target'),
    );
    expect(selfError.t).toBe('voice.error');

    hostSocket.close();
    guestSocket.close();
  });

  it('rejects malformed and oversized SDP/ICE payloads', async () => {
    const { room, hostSocket, guestSocket } = await pair();
    const from = guestSocket.events.find((event) => event.t === 'voice.joined') as Extract<
      ServerEvent,
      { t: 'voice.joined' }
    >;

    if (!from || from.participants.length === 0) throw new Error('missing roster');
    const hostId = from.participants[0].userId;

    guestSocket.send({ t: 'voice.offer', roomId: room.id, to: hostId, sdp: '' });
    const emptySdp = await waitFor(
      guestSocket.events,
      (event) => event.t === 'voice.error' && event.error.includes('session description'),
    );
    expect(emptySdp.t).toBe('voice.error');

    guestSocket.send({ t: 'voice.offer', roomId: room.id, to: hostId, sdp: 'x'.repeat(60_001) });
    const hugeSdp = await waitFor(
      guestSocket.events,
      (event) => event.t === 'voice.error' && event.error.includes('session description'),
    );
    expect(hugeSdp.t).toBe('voice.error');

    guestSocket.send({
      t: 'voice.ice',
      roomId: room.id,
      to: hostId,
      candidate: { candidate: 'y'.repeat(2_001) },
    });
    const hugeIce = await waitFor(
      guestSocket.events,
      (event) => event.t === 'voice.error' && event.error.includes('ICE'),
    );
    expect(hugeIce.t).toBe('voice.error');

    hostSocket.close();
    guestSocket.close();
  });

  it('rate-limits a flood of voice signalling', async () => {
    const { room, hostSocket, guestSocket } = await pair();
    const roster = guestSocket.events.find((event) => event.t === 'voice.joined') as Extract<
      ServerEvent,
      { t: 'voice.joined' }
    >;
    const hostId = roster.participants[0].userId;

    for (let i = 0; i < 245; i += 1) {
      guestSocket.send({ t: 'voice.offer', roomId: room.id, to: hostId, sdp: `v=0\r\n${i}` });
    }

    const throttled = await waitFor(
      guestSocket.events,
      (event) => event.t === 'voice.error' && event.error.includes('too fast'),
      5000,
    );
    expect(throttled.t).toBe('voice.error');

    hostSocket.close();
    guestSocket.close();
  });
});

describe('voice state, leaving and cleanup', () => {
  it('broadcasts mute/deafen/speaking state to the room', async () => {
    const host = await registerUser('Host');
    const guest = await registerUser('Guest');
    const room = await createRoom(host.token);
    await joinRoom(guest.token, room.inviteCode);
    const hostSocket = await connect(host.token);
    const guestSocket = await connect(guest.token);
    await waitFor(hostSocket.events, (event) => event.t === 'ready');
    hostSocket.send({ t: 'voice.join', roomId: room.id });
    await voiceJoined(hostSocket);
    guestSocket.send({ t: 'voice.join', roomId: room.id });
    await voiceJoined(guestSocket);

    guestSocket.send({ t: 'voice.state', roomId: room.id, muted: true, deafened: false, speaking: true });
    const state = await waitFor(hostSocket.events, (event) => event.t === 'voice.participant.state');
    expect(state.t === 'voice.participant.state' && state.muted).toBe(true);
    expect(state.t === 'voice.participant.state' && state.speaking).toBe(true);

    hostSocket.close();
    guestSocket.close();
  });

  it('broadcasts a leave and cleans up on socket close', async () => {
    const host = await registerUser('Host');
    const guest = await registerUser('Guest');
    const room = await createRoom(host.token);
    await joinRoom(guest.token, room.inviteCode);
    const hostSocket = await connect(host.token);
    const guestSocket = await connect(guest.token);
    await waitFor(hostSocket.events, (event) => event.t === 'ready');
    hostSocket.send({ t: 'voice.join', roomId: room.id });
    await voiceJoined(hostSocket);
    guestSocket.send({ t: 'voice.join', roomId: room.id });
    await voiceJoined(guestSocket);

    guestSocket.send({ t: 'voice.leave', roomId: room.id });
    const leftAck = await waitFor(guestSocket.events, (event) => event.t === 'voice.left');
    expect(leftAck.t === 'voice.left' && leftAck.roomId).toBe(room.id);

    const left = await waitFor(
      hostSocket.events,
      (event) => event.t === 'voice.participant.left' && event.userId === guest.user.id,
    );
    expect(left.t).toBe('voice.participant.left');

    // A second leave is harmless.
    guestSocket.send({ t: 'voice.leave', roomId: room.id });
    await waitFor(guestSocket.events, (event) => event.t === 'voice.left');

    // Rejoining after leaving works and produces exactly one roster entry.
    guestSocket.send({ t: 'voice.join', roomId: room.id });
    const rejoined = await voiceJoined(guestSocket);
    expect(rejoined.t === 'voice.joined' && rejoined.participants).toHaveLength(1);

    guestSocket.close();
    const ghost = await waitFor(
      hostSocket.events,
      (event) => event.t === 'voice.participant.left' && event.userId === guest.user.id,
      5000,
    );
    expect(ghost.t).toBe('voice.participant.left');

    hostSocket.close();
  });

  it('leaves the previous channel when switching rooms, without duplicate peers', async () => {
    const host = await registerUser('Host');
    const guest = await registerUser('Guest');
    const first = await createRoom(host.token, 'First');
    const second = await createRoom(host.token, 'Second');
    await joinRoom(guest.token, first.inviteCode);
    await joinRoom(guest.token, second.inviteCode);

    const hostSocket = await connect(host.token);
    const guestSocket = await connect(guest.token);
    await waitFor(hostSocket.events, (event) => event.t === 'ready');

    hostSocket.send({ t: 'voice.join', roomId: first.id });
    await voiceJoined(hostSocket);
    guestSocket.send({ t: 'voice.join', roomId: first.id });
    await voiceJoined(guestSocket);

    guestSocket.send({ t: 'voice.join', roomId: second.id });
    await voiceJoined(guestSocket);

    const leftFirst = await waitFor(
      hostSocket.events,
      (event) =>
        event.t === 'voice.participant.left' &&
        event.roomId === first.id &&
        event.userId === guest.user.id,
    );
    expect(leftFirst.t).toBe('voice.participant.left');

    // The new channel starts with an empty roster: the host is still in the
    // first room's voice, not this one.
    const moved = guestSocket.events.filter((event) => event.t === 'voice.joined');
    const latest = moved[moved.length - 1];
    expect(latest.t === 'voice.joined' && latest.participants).toHaveLength(0);

    hostSocket.close();
    guestSocket.close();
  });

  it('enforces the eight-participant mesh cap', async () => {
    const host = await registerUser('Host');
    const room = await createRoom(host.token);
    const hostSocket = await connect(host.token);
    await waitFor(hostSocket.events, (event) => event.t === 'ready');
    hostSocket.send({ t: 'voice.join', roomId: room.id });
    await voiceJoined(hostSocket);

    const sockets: Socket[] = [];
    for (let index = 0; index < 7; index += 1) {
      const user = await registerUser(`P${index}`);
      await joinRoom(user.token, room.inviteCode);
      const socket = await connect(user.token);
      await waitFor(socket.events, (event) => event.t === 'ready');
      socket.send({ t: 'voice.join', roomId: room.id });
      await voiceJoined(socket);
      sockets.push(socket);
    }

    const ninth = await registerUser('Ninth');
    await joinRoom(ninth.token, room.inviteCode);
    const ninthSocket = await connect(ninth.token);
    await waitFor(ninthSocket.events, (event) => event.t === 'ready');
    ninthSocket.send({ t: 'voice.join', roomId: room.id });
    const full = await waitFor(ninthSocket.events, (event) => event.t === 'voice.error');
    expect(full.t === 'voice.error' && full.error).toContain('hold 8');

    hostSocket.close();
    ninthSocket.close();
    for (const socket of sockets) socket.close();
  }, 20_000);
});
