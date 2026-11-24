import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import type { ServerEvent } from '../../shared/protocol';
import { SignalingService, type ServiceOptions, type SocketData } from '../src/app';

/* Game streaming signaling tests. Like the API and voice suites these use a
   real HTTP + WebSocket server and in-memory SQLite; SDP/ICE are opaque strings
   because the service only validates and relays them. Actual video negotiation
   is exercised by the native WebRTC run, not here. */

let service: SignalingService;
let server: Server<SocketData>;
let base: string;
let wsBase: string;

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
  const username = `s${counter}${Date.now().toString(36).slice(-5)}`;
  const result = await api('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'correct-horse-1', displayName }),
  });
  expect(result.status).toBe(201);
  return { token: result.data.token as string, user: result.data.user as { id: string } };
}

async function createRoom(token: string) {
  const result = await api(
    '/api/rooms',
    { method: 'POST', body: JSON.stringify({ name: 'Stream room', kind: 'game' }) },
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
  const socket: Socket = {
    ws,
    events,
    send: (event) => ws.send(JSON.stringify(event)),
    close: () => ws.close(),
  };
  await waitFor(events, (event) => event.t === 'ready');
  return socket;
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

function streamStarted(socket: Socket) {
  return waitFor(socket.events, (event) => event.t === 'stream.started');
}

function streamError(socket: Socket) {
  return waitFor(socket.events, (event) => event.t === 'stream.error');
}

async function roomWithHostAndGuest() {
  const host = await registerUser('Stream Host');
  const guest = await registerUser('Stream Guest');
  const room = await createRoom(host.token);
  await joinRoom(guest.token, room.inviteCode);
  const hostSocket = await connect(host.token);
  const guestSocket = await connect(guest.token);
  return { host, guest, room, hostSocket, guestSocket };
}

describe('stream lifecycle and authorization', () => {
  it('refuses starts from non-members, non-hosts and malformed modes', async () => {
    const owner = await registerUser('Owner');
    const stranger = await registerUser('Stranger');
    const guest = await registerUser('Guest');
    const room = await createRoom(owner.token);
    await joinRoom(guest.token, room.inviteCode);

    const strangerSocket = await connect(stranger.token);
    strangerSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'auto' });
    let error = await streamError(strangerSocket);
    expect(error.t === 'stream.error' && error.error).toContain('not a member');
    strangerSocket.close();

    const guestSocket = await connect(guest.token);
    guestSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'auto' });
    error = await streamError(guestSocket);
    expect(error.t === 'stream.error' && error.error).toContain('Only the host');
    guestSocket.close();

    const ownerSocket = await connect(owner.token);
    ownerSocket.send({ t: 'stream.start', roomId: room.id, mode: 'tab', preset: 'auto' });
    error = await streamError(ownerSocket);
    expect(error.t === 'stream.error' && error.error).toContain('Unknown capture mode');
    ownerSocket.close();
  });

  it('starts one stream per room and reports host, mode and preset to the room', async () => {
    const { host, room, hostSocket, guestSocket } = await roomWithHostAndGuest();
    hostSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'balanced' });

    const started = await streamStarted(hostSocket);
    expect(started.t).toBe('stream.started');
    if (started.t !== 'stream.started') return;
    expect(started.session.host.userId).toBe(host.user.id);
    expect(started.session.host.displayName).toBe('Stream Host');
    expect(started.session.mode).toBe('window');
    expect(started.session.preset).toBe('balanced');
    expect(started.session.viewers).toEqual([]);

    const guestView = await streamStarted(guestSocket);
    expect(guestView.t).toBe('stream.started');

    hostSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'auto' });
    const updated = await waitFor(
      guestSocket.events,
      (event) => event.t === 'stream.started' && event.session.preset === 'auto',
    );
    expect(updated.t).toBe('stream.started');

    hostSocket.close();
    guestSocket.close();
  });

  it('syncs live state and clears it when the host stops', async () => {
    const { room, hostSocket, guestSocket } = await roomWithHostAndGuest();
    guestSocket.send({ t: 'stream.sync', roomId: room.id });
    let stopped = await waitFor(guestSocket.events, (event) => event.t === 'stream.stopped');
    expect(stopped.t === 'stream.stopped' && stopped.reason).toContain('No stream');

    hostSocket.send({ t: 'stream.start', roomId: room.id, mode: 'desktop', preset: 'quality' });
    await streamStarted(hostSocket);

    guestSocket.events.length = 0;
    guestSocket.send({ t: 'stream.sync', roomId: room.id });
    const synced = await streamStarted(guestSocket);
    expect(synced.t === 'stream.started' && synced.session.mode).toBe('desktop');

    hostSocket.send({ t: 'stream.stop', roomId: room.id });
    stopped = await waitFor(guestSocket.events, (event) => event.t === 'stream.stopped');
    expect(stopped.t === 'stream.stopped' && stopped.reason).toContain('Host stopped');

    const restarted = await (async () => {
      hostSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'auto' });
      return streamStarted(hostSocket);
    })();
    expect(restarted.t).toBe('stream.started');

    hostSocket.close();
    guestSocket.close();
  });
});

describe('stream viewers and routing', () => {
  it('notifies the host when a viewer opts in and out', async () => {
    const { guest, room, hostSocket, guestSocket } = await roomWithHostAndGuest();
    hostSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'auto' });
    await streamStarted(hostSocket);
    hostSocket.events.length = 0;
    guestSocket.events.length = 0;

    guestSocket.send({ t: 'stream.watch', roomId: room.id });
    const snapshot = await streamStarted(guestSocket);
    expect(snapshot.t === 'stream.started' && snapshot.session.viewers.map((v) => v.userId)).toEqual([
      guest.user.id,
    ]);
    const joined = await waitFor(hostSocket.events, (event) => event.t === 'stream.viewer.joined');
    expect(joined.t === 'stream.viewer.joined' && joined.viewer.userId).toBe(guest.user.id);

    const viewers = await waitFor(hostSocket.events, (event) => event.t === 'stream.viewers');
    expect(viewers.t === 'stream.viewers' && viewers.viewers).toHaveLength(1);

    // Retrying on the same socket keeps the slot but asks the host for a fresh offer.
    const joinedBefore = hostSocket.events.filter((event) => event.t === 'stream.viewer.joined').length;
    guestSocket.send({ t: 'stream.watch', roomId: room.id });
    const deadline = Date.now() + 3000;
    while (
      hostSocket.events.filter((event) => event.t === 'stream.viewer.joined').length <= joinedBefore &&
      Date.now() < deadline
    ) {
      await Bun.sleep(10);
    }
    const joins = hostSocket.events.filter((event) => event.t === 'stream.viewer.joined');
    expect(joins).toHaveLength(joinedBefore + 1);
    const lastJoin = joins.at(-1);
    expect(lastJoin?.t).toBe('stream.viewer.joined');
    if (lastJoin?.t === 'stream.viewer.joined') {
      expect(lastJoin.viewer.userId).toBe(guest.user.id);
    }

    guestSocket.send({ t: 'stream.unwatch', roomId: room.id });
    const left = await waitFor(hostSocket.events, (event) => event.t === 'stream.viewer.left');
    expect(left.t === 'stream.viewer.left' && left.userId).toBe(guest.user.id);

    hostSocket.send({ t: 'stream.stop', roomId: room.id });
    guestSocket.events.length = 0;
    guestSocket.send({ t: 'stream.watch', roomId: room.id });
    const error = await streamError(guestSocket);
    expect(error.t === 'stream.error' && error.error).toContain('No stream');

    hostSocket.close();
    guestSocket.close();
  });

  it('enforces the four-viewer cap and rejects the host watching its own stream', async () => {
    const host = await registerUser('Cap Host');
    const room = await createRoom(host.token);
    const guests = [];
    for (let index = 0; index < 5; index += 1) {
      const guest = await registerUser(`Viewer ${index + 1}`);
      await joinRoom(guest.token, room.inviteCode);
      guests.push({ ...guest, socket: await connect(guest.token) });
    }
    const hostSocket = await connect(host.token);
    hostSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'auto' });
    await streamStarted(hostSocket);

    hostSocket.send({ t: 'stream.watch', roomId: room.id });
    const selfError = await streamError(hostSocket);
    expect(selfError.t === 'stream.error' && selfError.error).toContain('hosting');

    for (const guest of guests.slice(0, 4)) {
      guest.socket.events.length = 0;
      guest.socket.send({ t: 'stream.watch', roomId: room.id });
      await streamStarted(guest.socket);
    }
    guests[4].socket.events.length = 0;
    guests[4].socket.send({ t: 'stream.watch', roomId: room.id });
    const error = await streamError(guests[4].socket);
    expect(error.t === 'stream.error' && error.error).toContain('full');

    hostSocket.close();
    for (const guest of guests) guest.socket.close();
  });

  it('relays offer, answer and ICE only between the host and its viewers', async () => {
    const { host, guest, room, hostSocket, guestSocket } = await roomWithHostAndGuest();
    hostSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'auto' });
    await streamStarted(hostSocket);
    guestSocket.send({ t: 'stream.watch', roomId: room.id });
    await waitFor(
      guestSocket.events,
      (event) => event.t === 'stream.started' && event.session.viewers.length === 1,
    );

    hostSocket.send({ t: 'stream.offer', roomId: room.id, to: guest.user.id, sdp: 'v=0 host-offer' });
    const offer = await waitFor(guestSocket.events, (event) => event.t === 'stream.offer');
    expect(offer.t === 'stream.offer' && offer.from).toBe(host.user.id);
    expect(offer.t === 'stream.offer' && offer.sdp).toBe('v=0 host-offer');

    guestSocket.send({ t: 'stream.answer', roomId: room.id, to: host.user.id, sdp: 'v=0 viewer-answer' });
    const answer = await waitFor(hostSocket.events, (event) => event.t === 'stream.answer');
    expect(answer.t === 'stream.answer' && answer.from).toBe(guest.user.id);

    guestSocket.send({
      t: 'stream.ice',
      roomId: room.id,
      to: host.user.id,
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    const ice = await waitFor(hostSocket.events, (event) => event.t === 'stream.ice');
    expect(ice.t === 'stream.ice' && ice.from).toBe(guest.user.id);

    // Direction and target checks.
    guestSocket.send({ t: 'stream.offer', roomId: room.id, to: host.user.id, sdp: 'v=0 nope' });
    let error = await waitFor(
      guestSocket.events,
      (event) => event.t === 'stream.error' && event.error.includes('Only the host'),
    );
    expect(error.t).toBe('stream.error');

    hostSocket.send({ t: 'stream.answer', roomId: room.id, to: guest.user.id, sdp: 'v=0 nope' });
    error = await waitFor(
      hostSocket.events,
      (event) => event.t === 'stream.error' && event.error.includes('does not answer'),
    );
    expect(error.t).toBe('stream.error');

    hostSocket.send({ t: 'stream.offer', roomId: room.id, to: crypto.randomUUID(), sdp: 'v=0 nope' });
    error = await waitFor(
      hostSocket.events,
      (event) => event.t === 'stream.error' && event.error.includes('not watching'),
    );
    expect(error.t).toBe('stream.error');

    guestSocket.send({ t: 'stream.answer', roomId: room.id, to: guest.user.id, sdp: 'v=0 self' });
    error = await waitFor(
      guestSocket.events,
      (event) => event.t === 'stream.error' && event.error.includes('Invalid stream target'),
    );
    expect(error.t).toBe('stream.error');

    hostSocket.close();
    guestSocket.close();
  });

  it('rejects malformed and oversized SDP/ICE and rate-limits a flood', async () => {
    const { host, guest, room, hostSocket, guestSocket } = await roomWithHostAndGuest();
    hostSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'auto' });
    await streamStarted(hostSocket);
    guestSocket.send({ t: 'stream.watch', roomId: room.id });
    await waitFor(
      guestSocket.events,
      (event) => event.t === 'stream.started' && event.session.viewers.length === 1,
    );

    hostSocket.send({ t: 'stream.offer', roomId: room.id, to: guest.user.id, sdp: 'x'.repeat(60_001) });
    let error = await streamError(hostSocket);
    expect(error.t === 'stream.error' && error.error).toContain('Invalid session description');

    guestSocket.send({
      t: 'stream.ice',
      roomId: room.id,
      to: host.user.id,
      candidate: { candidate: 'x'.repeat(2_001) },
    });
    error = await streamError(guestSocket);
    expect(error.t === 'stream.error' && error.error).toContain('Invalid ICE candidate');

    for (let index = 0; index < 301; index += 1) {
      hostSocket.send({ t: 'stream.offer', roomId: room.id, to: guest.user.id, sdp: 'v=0 flood' });
    }
    error = await waitFor(
      hostSocket.events,
      (event) => event.t === 'stream.error' && event.error.includes('too fast'),
      5000,
    );
    expect(error.t).toBe('stream.error');

    hostSocket.close();
    guestSocket.close();
  });
});

describe('stream cleanup and preset control', () => {
  it('only the host may change quality and the room sees the update', async () => {
    const { room, hostSocket, guestSocket } = await roomWithHostAndGuest();
    hostSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'auto' });
    await streamStarted(hostSocket);

    guestSocket.send({ t: 'stream.preset', roomId: room.id, preset: 'quality' });
    const error = await streamError(guestSocket);
    expect(error.t === 'stream.error' && error.error).toContain('Only the streaming host');

    hostSocket.send({ t: 'stream.preset', roomId: room.id, preset: 'smooth' });
    const updated = await waitFor(
      guestSocket.events,
      (event) => event.t === 'stream.started' && event.session.preset === 'smooth',
    );
    expect(updated.t).toBe('stream.started');

    hostSocket.close();
    guestSocket.close();
  });

  it('ends the stream when the host socket closes', async () => {
    const { room, hostSocket, guestSocket } = await roomWithHostAndGuest();
    hostSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'auto' });
    await streamStarted(hostSocket);

    hostSocket.close();
    const stopped = await waitFor(guestSocket.events, (event) => event.t === 'stream.stopped');
    expect(stopped.t === 'stream.stopped' && stopped.reason).toContain('host disconnected');
    guestSocket.close();
  });

  it('removes a disconnected viewer without touching the stream', async () => {
    const { guest, room, hostSocket, guestSocket } = await roomWithHostAndGuest();
    hostSocket.send({ t: 'stream.start', roomId: room.id, mode: 'window', preset: 'auto' });
    await streamStarted(hostSocket);
    guestSocket.send({ t: 'stream.watch', roomId: room.id });
    await streamStarted(guestSocket);
    hostSocket.events.length = 0;

    guestSocket.close();
    const left = await waitFor(hostSocket.events, (event) => event.t === 'stream.viewer.left');
    expect(left.t === 'stream.viewer.left' && left.userId).toBe(guest.user.id);
    expect(hostSocket.events.some((event) => event.t === 'stream.stopped')).toBe(false);

    hostSocket.send({ t: 'stream.sync', roomId: room.id });
    const synced = await waitFor(
      hostSocket.events,
      (event) => event.t === 'stream.started' && event.session.viewers.length === 0,
    );
    expect(synced.t).toBe('stream.started');
    hostSocket.close();
  });
});
