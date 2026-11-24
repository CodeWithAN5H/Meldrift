import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'bun';
import type { ServerEvent } from '../../shared/protocol';
import { SignalingService, type ServiceOptions, type SocketData } from '../src/app';

/* Remote-control authority tests.

   These run against a real HTTP + WebSocket service and in-memory SQLite. They
   cover the security-sensitive half of M5: who may enable control, who may be
   granted it, queue ordering, handoff, revocation, stale grants, signalling
   direction, rate limits, and every disconnect/stream-stop cleanup path.
   The input data channel itself is peer-to-peer and is tested in the client
   suite / native run, not here. */

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
  const username = `c${counter}${Date.now().toString(36).slice(-5)}`;
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
    { method: 'POST', body: JSON.stringify({ name: 'Control room', kind: 'game' }) },
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

async function waitForState(
  socket: Socket,
  predicate: (state: Extract<ServerEvent, { t: 'control.state' }>['session']) => boolean,
) {
  return waitFor(
    socket.events,
    (event) => event.t === 'control.state' && predicate(event.session),
  );
}

async function startStream(socket: Socket, roomId: string, preset: 'auto' = 'auto') {
  socket.send({ t: 'stream.start', roomId, mode: 'window', preset });
  await waitFor(socket.events, (event) => event.t === 'stream.started');
}

async function enableControl(socket: Socket, roomId: string, label = 'Notepad · notepad.exe') {
  socket.events.length = 0;
  socket.send({ t: 'control.enable', roomId, enabled: true, targetLabel: label });
  await waitForState(socket, (state) => state.enabled && state.targetLabel === label);
}

async function roomWithStream() {
  const host = await registerUser('Control Host');
  const guest = await registerUser('Control Guest');
  const room = await createRoom(host.token);
  await joinRoom(guest.token, room.inviteCode);
  const hostSocket = await connect(host.token);
  const guestSocket = await connect(guest.token);
  await startStream(hostSocket, room.id);
  return { host, guest, room, hostSocket, guestSocket };
}

async function grantTo(hostSocket: Socket, guestSocket: Socket, guestId: string, roomId: string) {
  guestSocket.events.length = 0;
  guestSocket.send({ t: 'control.request', roomId });
  await waitForState(guestSocket, (state) => state.queue.some((player) => player.userId === guestId));
  hostSocket.events.length = 0;
  hostSocket.send({ t: 'control.approve', roomId, userId: guestId });
  return waitFor(guestSocket.events, (event) => event.t === 'control.granted');
}

describe('control enablement and host authorization', () => {
  it('requires a live stream, the room host, and a chosen target', async () => {
    const owner = await registerUser('Owner');
    const stranger = await registerUser('Stranger');
    const guest = await registerUser('Guest');
    const room = await createRoom(owner.token);
    await joinRoom(guest.token, room.inviteCode);

    const ownerSocket = await connect(owner.token);
    ownerSocket.send({ t: 'control.enable', roomId: room.id, enabled: true, targetLabel: 'Game' });
    let error = await waitFor(ownerSocket.events, (event) => event.t === 'control.error');
    expect(error.t === 'control.error' && error.error).toContain('Start sharing');

    await startStream(ownerSocket, room.id);

    const strangerSocket = await connect(stranger.token);
    strangerSocket.send({ t: 'control.enable', roomId: room.id, enabled: true, targetLabel: 'Game' });
    error = await waitFor(strangerSocket.events, (event) => event.t === 'control.error');
    expect(error.t === 'control.error' && error.error).toContain('not a member');
    strangerSocket.close();

    const guestSocket = await connect(guest.token);
    guestSocket.send({ t: 'control.enable', roomId: room.id, enabled: true, targetLabel: 'Game' });
    error = await waitFor(guestSocket.events, (event) => event.t === 'control.error');
    expect(error.t === 'control.error' && error.error).toContain('Only the room host');

    ownerSocket.events.length = 0;
    ownerSocket.send({ t: 'control.enable', roomId: room.id, enabled: true, targetLabel: '   ' });
    error = await waitFor(ownerSocket.events, (event) => event.t === 'control.error');
    expect(error.t === 'control.error' && error.error).toContain('Choose the window');

    await enableControl(ownerSocket, room.id, 'RDR2 · rdr2.exe');
    const view = await waitForState(guestSocket, (state) => state.enabled);
    expect(view.t).toBe('control.state');
    if (view.t !== 'control.state') return;
    expect(view.session.targetLabel).toBe('RDR2 · rdr2.exe');
    expect(view.session.host.userId).toBe(owner.user.id);
    expect(view.session.controller).toBeNull();

    ownerSocket.close();
    guestSocket.close();
  });

  it('reports control as off to a member who has never seen it', async () => {
    const host = await registerUser('Off Host');
    const guest = await registerUser('Off Guest');
    const room = await createRoom(host.token);
    await joinRoom(guest.token, room.inviteCode);
    const hostSocket = await connect(host.token);
    const guestSocket = await connect(guest.token);

    guestSocket.send({ t: 'control.sync', roomId: room.id });
    const state = await waitForState(guestSocket, () => true);
    expect(state.t === 'control.state' && state.session.enabled).toBe(false);
    expect(state.t === 'control.state' && state.session.controller).toBeNull();

    hostSocket.close();
    guestSocket.close();
  });
});

describe('control queue', () => {
  it('keeps FIFO order, deduplicates requests and lets the host skip', async () => {
    const { guest, room, hostSocket, guestSocket } = await roomWithStream();
    const second = await registerUser('Second Guest');
    await joinRoom(second.token, room.inviteCode);
    const secondSocket = await connect(second.token);

    await enableControl(hostSocket, room.id);

    guestSocket.events.length = 0;
    hostSocket.events.length = 0;
    guestSocket.send({ t: 'control.request', roomId: room.id });
    await waitForState(hostSocket, (state) => state.queue.length === 1);

    // A repeated request is idempotent, not a second queue entry.
    guestSocket.send({ t: 'control.request', roomId: room.id });
    await Bun.sleep(120);
    const queued = hostSocket.events.filter((event) => event.t === 'control.state').at(-1);
    expect(queued?.t === 'control.state' && queued.session.queue.length).toBe(1);

    secondSocket.send({ t: 'control.request', roomId: room.id });
    const ordered = await waitForState(
      hostSocket,
      (state) => state.queue.length === 2 && state.queue[1]?.userId === second.user.id,
    );
    expect(ordered.t).toBe('control.state');
    if (ordered.t !== 'control.state') return;
    expect(ordered.session.queue.map((player) => player.displayName)).toEqual([
      'Control Guest',
      'Second Guest',
    ]);

    hostSocket.events.length = 0;
    hostSocket.send({ t: 'control.reject', roomId: room.id, userId: second.user.id });
    const skipped = await waitForState(hostSocket, (state) => state.queue.length === 1);
    expect(skipped.t).toBe('control.state');

    hostSocket.events.length = 0;
    guestSocket.send({ t: 'control.cancel', roomId: room.id });
    await waitForState(hostSocket, (state) => state.queue.length === 0);

    hostSocket.close();
    guestSocket.close();
    secondSocket.close();
  });

  it('caps the queue and refuses requests while control is off', async () => {
    const host = await registerUser('Queue Host');
    const room = await createRoom(host.token);
    const hostSocket = await connect(host.token);
    await startStream(hostSocket, room.id);

    const first = await registerUser('First');
    await joinRoom(first.token, room.inviteCode);
    const firstSocket = await connect(first.token);
    firstSocket.send({ t: 'control.request', roomId: room.id });
    const off = await waitFor(firstSocket.events, (event) => event.t === 'control.error');
    expect(off.t === 'control.error' && off.error).toContain('not enabled');

    await enableControl(hostSocket, room.id);
    const guests = [];
    for (let index = 0; index < 9; index += 1) {
      const guest = await registerUser(`Queue ${index}`);
      await joinRoom(guest.token, room.inviteCode);
      guests.push({ ...guest, socket: await connect(guest.token) });
    }

    for (const guest of guests.slice(0, 8)) {
      guest.socket.send({ t: 'control.request', roomId: room.id });
      await waitForState(hostSocket, (state) => state.queue.some((player) => player.userId === guest.user.id));
    }
    guests[8].socket.send({ t: 'control.request', roomId: room.id });
    const full = await waitFor(guests[8].socket.events, (event) => event.t === 'control.error');
    expect(full.t === 'control.error' && full.error).toContain('full');

    hostSocket.close();
    firstSocket.close();
    for (const guest of guests) guest.socket.close();
  });
});

describe('grants, handoff and revocation', () => {
  it('grants to one controller and hands off explicitly to another', async () => {
    const { host, guest, room, hostSocket, guestSocket } = await roomWithStream();
    const second = await registerUser('Second Controller');
    await joinRoom(second.token, room.inviteCode);
    const secondSocket = await connect(second.token);
    await enableControl(hostSocket, room.id);

    const granted = await grantTo(hostSocket, guestSocket, guest.user.id, room.id);
    expect(granted.t).toBe('control.granted');
    if (granted.t !== 'control.granted') return;
    expect(granted.grant.controller.userId).toBe(guest.user.id);
    expect(granted.grant.hostUserId).toBe(host.user.id);
    expect(granted.grant.targetLabel).toBe('Notepad · notepad.exe');
    expect(granted.grant.token.length).toBeGreaterThan(20);

    const hostGrant = await waitFor(hostSocket.events, (event) => event.t === 'control.granted');
    expect(hostGrant.t === 'control.granted' && hostGrant.grant.grantId).toBe(granted.grant.grantId);

    const labelled = await waitForState(
      secondSocket,
      (state) => state.controller?.userId === guest.user.id,
    );
    expect(labelled.t).toBe('control.state');

    hostSocket.send({ t: 'control.active', roomId: room.id, grantId: granted.grant.grantId, active: true });
    const activeState = await waitForState(hostSocket, (state) => state.controllerActive);
    expect(activeState.t).toBe('control.state');

    hostSocket.send({ t: 'control.active', roomId: room.id, grantId: 'stale-grant', active: true });
    const staleActive = await waitFor(hostSocket.events, (event) => event.t === 'control.error');
    expect(staleActive.t === 'control.error' && staleActive.error).toContain('no longer active');

    secondSocket.events.length = 0;
    secondSocket.send({ t: 'control.request', roomId: room.id });
    await waitForState(hostSocket, (state) => state.queue.some((player) => player.userId === second.user.id));

    hostSocket.send({ t: 'control.approve', roomId: room.id, userId: second.user.id });
    const handedOff = await waitFor(secondSocket.events, (event) => event.t === 'control.granted');
    expect(handedOff.t).toBe('control.granted');
    if (handedOff.t !== 'control.granted') return;
    expect(handedOff.grant.grantId).not.toBe(granted.grant.grantId);

    const revoked = await waitFor(
      guestSocket.events,
      (event) => event.t === 'control.revoked',
    );
    expect(revoked.t === 'control.revoked' && revoked.controllerId).toBe(guest.user.id);
    expect(revoked.t === 'control.revoked' && revoked.reason).toContain('given control');

    hostSocket.close();
    guestSocket.close();
    secondSocket.close();
  });

  it('lets the controller release and refuses release by anyone else', async () => {
    const { guest, room, hostSocket, guestSocket } = await roomWithStream();
    await enableControl(hostSocket, room.id);
    await grantTo(hostSocket, guestSocket, guest.user.id, room.id);

    hostSocket.send({ t: 'control.release', roomId: room.id });
    const rejected = await waitFor(hostSocket.events, (event) => event.t === 'control.error');
    expect(rejected.t === 'control.error' && rejected.error).toContain('do not have control');

    guestSocket.events.length = 0;
    guestSocket.send({ t: 'control.release', roomId: room.id });
    const released = await waitFor(hostSocket.events, (event) => event.t === 'control.revoked');
    expect(released.t === 'control.revoked' && released.reason).toContain('released');
    const idle = await waitForState(hostSocket, (state) => state.controller === null);
    expect(idle.t).toBe('control.state');

    hostSocket.close();
    guestSocket.close();
  });

  it('revokes on controller disconnect, host disconnect and stream stop', async () => {
    const { guest, room, hostSocket, guestSocket } = await roomWithStream();
    await enableControl(hostSocket, room.id);
    await grantTo(hostSocket, guestSocket, guest.user.id, room.id);

    guestSocket.close();
    const disconnect = await waitFor(hostSocket.events, (event) => event.t === 'control.revoked');
    expect(disconnect.t === 'control.revoked' && disconnect.reason).toContain('disconnected');

    const second = await registerUser('Second');
    await joinRoom(second.token, room.inviteCode);
    const secondSocket = await connect(second.token);
    await grantTo(hostSocket, secondSocket, second.user.id, room.id);

    secondSocket.events.length = 0;
    hostSocket.send({ t: 'stream.stop', roomId: room.id });
    const stopped = await waitFor(secondSocket.events, (event) => event.t === 'control.revoked');
    expect(stopped.t === 'control.revoked' && stopped.reason).toContain('stream stopped');
    const off = await waitForState(secondSocket, () => true);
    expect(off.t === 'control.state' && off.session.enabled).toBe(false);

    hostSocket.events.length = 0;
    secondSocket.events.length = 0;
    await startStream(hostSocket, room.id);
    await enableControl(hostSocket, room.id);
    secondSocket.events.length = 0;
    hostSocket.close();
    const hostGone = await waitFor(secondSocket.events, (event) => event.t === 'stream.stopped');
    expect(hostGone.t).toBe('stream.stopped');
    secondSocket.close();
  });
});

describe('control signalling', () => {
  it('relays only between the host and the current controller', async () => {
    const { host, guest, room, hostSocket, guestSocket } = await roomWithStream();
    const outsider = await registerUser('Outsider');
    await joinRoom(outsider.token, room.inviteCode);
    const outsiderSocket = await connect(outsider.token);
    const second = await registerUser('Watching Guest');
    await joinRoom(second.token, room.inviteCode);
    const secondSocket = await connect(second.token);
    await enableControl(hostSocket, room.id);
    const granted = await grantTo(hostSocket, guestSocket, guest.user.id, room.id);
    if (granted.t !== 'control.granted') throw new Error('grant missing');

    guestSocket.events.length = 0;
    guestSocket.send({
      t: 'control.offer',
      roomId: room.id,
      to: host.user.id,
      grantId: granted.grant.grantId,
      sdp: 'v=0 input-offer',
    });
    const offer = await waitFor(hostSocket.events, (event) => event.t === 'control.offer');
    expect(offer.t === 'control.offer' && offer.from).toBe(guest.user.id);
    expect(offer.t === 'control.offer' && offer.sdp).toBe('v=0 input-offer');

    hostSocket.send({
      t: 'control.answer',
      roomId: room.id,
      to: guest.user.id,
      grantId: granted.grant.grantId,
      sdp: 'v=0 input-answer',
    });
    const answer = await waitFor(guestSocket.events, (event) => event.t === 'control.answer');
    expect(answer.t === 'control.answer' && answer.from).toBe(host.user.id);

    guestSocket.send({
      t: 'control.ice',
      roomId: room.id,
      to: host.user.id,
      grantId: granted.grant.grantId,
      candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });
    const ice = await waitFor(hostSocket.events, (event) => event.t === 'control.ice');
    expect(ice.t === 'control.ice' && ice.from).toBe(guest.user.id);

    // The controller cannot answer its own channel, and the host cannot offer.
    guestSocket.send({
      t: 'control.answer',
      roomId: room.id,
      to: host.user.id,
      grantId: granted.grant.grantId,
      sdp: 'v=0 nope',
    });
    let error = await waitFor(
      guestSocket.events,
      (event) => event.t === 'control.error' && event.error.includes('host answers'),
    );
    expect(error.t).toBe('control.error');

    hostSocket.send({
      t: 'control.offer',
      roomId: room.id,
      to: guest.user.id,
      grantId: granted.grant.grantId,
      sdp: 'v=0 nope',
    });
    error = await waitFor(
      hostSocket.events,
      (event) => event.t === 'control.error' && event.error.includes('controller offers'),
    );
    expect(error.t).toBe('control.error');

    // Nobody without the current grant may signal.
    outsiderSocket.send({
      t: 'control.offer',
      roomId: room.id,
      to: host.user.id,
      grantId: granted.grant.grantId,
      sdp: 'v=0 outsider',
    });
    error = await waitFor(outsiderSocket.events, (event) => event.t === 'control.error');
    expect(error.t === 'control.error' && error.error).toContain('not part of this control session');

    secondSocket.send({
      t: 'control.offer',
      roomId: room.id,
      to: host.user.id,
      grantId: granted.grant.grantId,
      sdp: 'v=0 second',
    });
    error = await waitFor(secondSocket.events, (event) => event.t === 'control.error');
    expect(error.t === 'control.error');

    hostSocket.close();
    guestSocket.close();
    secondSocket.close();
    outsiderSocket.close();
  });

  it('rejects stale, oversized and flooded control signalling', async () => {
    const { guest, room, hostSocket, guestSocket } = await roomWithStream();
    await enableControl(hostSocket, room.id);
    const granted = await grantTo(hostSocket, guestSocket, guest.user.id, room.id);
    if (granted.t !== 'control.granted') throw new Error('grant missing');

    guestSocket.send({
      t: 'control.offer',
      roomId: room.id,
      to: guest.user.id,
      grantId: granted.grant.grantId,
      sdp: 'v=0 self',
    });
    let error = await waitFor(guestSocket.events, (event) => event.t === 'control.error');
    expect(error.t === 'control.error' && error.error).toContain('Invalid control target');

    guestSocket.events.length = 0;
    guestSocket.send({
      t: 'control.offer',
      roomId: room.id,
      to: granted.grant.hostUserId,
      grantId: 'x'.repeat(65),
      sdp: 'v=0 stale',
    });
    error = await waitFor(
      guestSocket.events,
      (event) => event.t === 'control.error' && event.error.includes('Invalid control target'),
    );
    expect(error.t).toBe('control.error');

    guestSocket.events.length = 0;
    guestSocket.send({
      t: 'control.offer',
      roomId: room.id,
      to: granted.grant.hostUserId,
      grantId: granted.grant.grantId,
      sdp: 'x'.repeat(60_001),
    });
    error = await waitFor(
      guestSocket.events,
      (event) => event.t === 'control.error' && event.error.includes('Invalid session description'),
    );
    expect(error.t).toBe('control.error');

    for (let index = 0; index < 161; index += 1) {
      guestSocket.send({
        t: 'control.offer',
        roomId: room.id,
        to: granted.grant.hostUserId,
        grantId: granted.grant.grantId,
        sdp: 'v=0 flood',
      });
    }
    error = await waitFor(
      guestSocket.events,
      (event) => event.t === 'control.error' && event.error.includes('too fast'),
      5000,
    );
    expect(error.t).toBe('control.error');

    hostSocket.close();
    guestSocket.close();
  });

  it('rejects a grant id replayed after a handoff', async () => {
    const { guest, room, hostSocket, guestSocket } = await roomWithStream();
    const second = await registerUser('Next Player');
    await joinRoom(second.token, room.inviteCode);
    const secondSocket = await connect(second.token);
    await enableControl(hostSocket, room.id);
    const first = await grantTo(hostSocket, guestSocket, guest.user.id, room.id);
    if (first.t !== 'control.granted') throw new Error('grant missing');

    secondSocket.send({ t: 'control.request', roomId: room.id });
    await waitForState(hostSocket, (state) => state.queue.length === 1);
    hostSocket.send({ t: 'control.approve', roomId: room.id, userId: second.user.id });
    await waitFor(secondSocket.events, (event) => event.t === 'control.granted');

    guestSocket.events.length = 0;
    guestSocket.send({
      t: 'control.offer',
      roomId: room.id,
      to: first.grant.hostUserId,
      grantId: first.grant.grantId,
      sdp: 'v=0 replay',
    });
    const error = await waitFor(
      guestSocket.events,
      (event) => event.t === 'control.error' && event.error.includes('stale'),
    );
    expect(error.t).toBe('control.error');

    hostSocket.close();
    guestSocket.close();
    secondSocket.close();
  });
});
