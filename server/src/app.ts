import type { Database } from 'bun:sqlite';
import type { Server, ServerWebSocket } from 'bun';
import {
  CONTROL_GRANT_TTL_MS,
  CONTROL_MAX_CANDIDATE_LENGTH,
  CONTROL_MAX_QUEUE,
  CONTROL_MAX_SDP_LENGTH,
  CONTROL_MAX_TARGET_LABEL,
  CONTROL_SIGNAL_BURST,
  CONTROL_SIGNAL_WINDOW_MS,
  MAX_MESSAGE_LENGTH,
  PROTOCOL_VERSION,
  STREAM_MAX_CANDIDATE_LENGTH,
  STREAM_MAX_SDP_LENGTH,
  STREAM_MAX_VIEWERS,
  STREAM_SIGNAL_BURST,
  STREAM_SIGNAL_WINDOW_MS,
  VOICE_MAX_CANDIDATE_LENGTH,
  VOICE_MAX_PARTICIPANTS,
  VOICE_MAX_SDP_LENGTH,
  VOICE_SIGNAL_BURST,
  VOICE_SIGNAL_WINDOW_MS,
  isValidPresence,
  normalizeUsername,
  type BootstrapView,
  type ClientEvent,
  type ControlGrantView,
  type ControlSessionView,
  type ConversationView,
  type CreateRoomBody,
  type FriendRequestView,
  type FriendView,
  type LoginBody,
  type MessageScope,
  type MessageView,
  type Presence,
  type PublicUser,
  type RegisterBody,
  type RoomMemberView,
  type RoomView,
  type ServerEvent,
  type StreamMode,
  type StreamParticipantView,
  type StreamPreset,
  type StreamSessionView,
  type VoiceConfigView,
  type VoiceIceCandidate,
  type VoiceParticipantView,
} from '../../shared/protocol';
import { AuthError, createSession, hashPassword, revokeSession, toPublicUser, tokenFromRequest, userForToken, validateCredentials, verifyPassword } from './auth';
import { makeInviteCode, openDatabase, orderedPair, type MessageRow, type RoomRow, type UserRow } from './db';

export interface SocketData {
  userId: string;
  presence: 'online' | 'idle';
  /** Identifies this connection, so a stale socket cannot tear down a newer one. */
  socketId: number;
  /** Timestamps of recent messages, used for a light flood guard. */
  recent: number[];
  /** Timestamps of recent voice signals (SDP/ICE). */
  voiceRecent: number[];
  /** Timestamps of recent stream signals (SDP/ICE). */
  streamRecent: number[];
  /** Timestamps of recent remote-control signals (SDP/ICE). */
  controlRecent: number[];
}

export interface VoiceOptions {
  /** stun:/stuns: URLs advertised to clients. */
  stunUrls?: string[];
  /** turn:/turns: URLs; credentials are only sent to signed-in clients. */
  turnUrls?: string[];
  turnUsername?: string;
  turnCredential?: string;
}

interface VoiceMember {
  participant: VoiceParticipantView;
  /** The socket that joined; a reconnect replaces it rather than duplicating. */
  socketId: number;
}

interface StreamSession {
  roomId: string;
  hostUserId: string;
  /** The socket hosting; a stale socket can never control a newer stream. */
  hostSocketId: number;
  mode: StreamMode;
  preset: StreamPreset;
  startedAt: number;
  viewers: Map<string, { socketId: number }>;
}

/**
 * Remote-control authority for a room. Created only when the stream host
 * explicitly enables control, and destroyed with the stream. The grant id and
 * input token are secrets: they go to the host and controller only.
 */
interface ControlSession {
  roomId: string;
  hostUserId: string;
  hostSocketId: number;
  enabled: boolean;
  targetLabel: string | null;
  /** FIFO: the host still approves every grant, even the first in line. */
  queue: string[];
  controllerId: string | null;
  grantId: string | null;
  token: string | null;
  grantExpiresAt: number | null;
  controllerActive: boolean;
  since: number;
  /** Recently revoked grant ids, so a replayed grant cannot regain control. */
  revoked: string[];
}

const STREAM_PRESETS: readonly StreamPreset[] = ['auto', 'smooth', 'balanced', 'quality'];

/** 192 bits of CSPRNG output; the input channel checks this before injecting. */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

const DEFAULT_STUN_URLS = ['stun:stun.l.google.com:19302'];

/** Only STUN/TURN schemes are meaningful, and a bad URL must not break calling. */
function validIceUrls(values: string[] | undefined): string[] {
  if (!values) return [];
  return values
    .map((value) => value.trim())
    .filter((value) => /^(stun|stuns|turn|turns):[^\s]+$/i.test(value));
}

interface AuthedSocket extends ServerWebSocket<SocketData> {}

const MESSAGE_BURST = 12;
const MESSAGE_WINDOW_MS = 5_000;

/** Hashed once so a missing user costs the same as a wrong password. */
const DUMMY_HASH = Bun.password.hash('meldrift-dummy-password', {
  algorithm: 'argon2id',
  memoryCost: 19456,
  timeCost: 2,
});
const AUTH_BURST = 12;
const AUTH_WINDOW_MS = 60_000;

export interface ServiceOptions {
  /** Failed/all auth attempts allowed per client per window. */
  authBurst?: number;
  authWindowMs?: number;
  /** Only enable behind a reverse proxy you control: trusts X-Forwarded-For. */
  trustProxy?: boolean;
  /** STUN/TURN configuration advertised through GET /api/voice/ice. */
  voice?: VoiceOptions;
}

function asUser(row: UserRow): PublicUser {
  return toPublicUser(row);
}

export class SignalingService {
  readonly db: Database;
  private sockets = new Map<string, Set<AuthedSocket>>();
  private authAttempts = new Map<string, { count: number; resetAt: number }>();
  /** roomId → userId → voice membership. Voice is live state, never persisted. */
  private voiceRooms = new Map<string, Map<string, VoiceMember>>();
  /** roomId → live video session. Never persisted; one host per room. */
  private streams = new Map<string, StreamSession>();
  /** roomId → remote-control authority. Never persisted; dies with the stream. */
  private controlSessions = new Map<string, ControlSession>();
  private nextSocketId = 1;

  constructor(
    readonly dbPath: string,
    private readonly options: ServiceOptions = {},
  ) {
    this.db = openDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  /* ---- HTTP ----------------------------------------------------------- */

  private cors(origin: string | null): Record<string, string> {
    return {
      'access-control-allow-origin': origin ?? '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-max-age': '86400',
      vary: 'Origin',
    };
  }

  private json(data: unknown, status = 200, origin: string | null = null): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...this.cors(origin), 'content-type': 'application/json; charset=utf-8' },
    });
  }

  private fail(message: string, status = 400, origin: string | null = null): Response {
    return this.json({ error: message }, status, origin);
  }

  private readonly startedAt = Date.now();

  async handle(request: Request, server: Server<SocketData>): Promise<Response | undefined> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: this.cors(origin) });
    }

    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token');
      const user = userForToken(this.db, token);
      if (!user) return this.fail('Sign in required', 401, origin);
      const upgraded = server.upgrade(request, {
        data: {
          userId: user.id,
          presence: 'online',
          socketId: this.nextSocketId++,
          recent: [],
          voiceRecent: [],
          streamRecent: [],
          controlRecent: [],
        },
      });
      return upgraded ? undefined : this.fail('WebSocket upgrade failed', 400, origin);
    }

    try {
      const response = await this.route(request, server, url, origin);
      return response ?? this.fail('Not found', 404, origin);
    } catch (error) {
      if (error instanceof AuthError) return this.fail(error.message, error.status, origin);
      console.error('[meldrift] request failed', error);
      return this.fail('Server error', 500, origin);
    }
  }

  private async route(
    request: Request,
    server: Server<SocketData>,
    url: URL,
    origin: string | null,
  ): Promise<Response | null> {
    const method = request.method;
    const path = url.pathname;

    if (method === 'GET' && path === '/api/health') {
      return this.json(
        {
          ok: true,
          protocol: PROTOCOL_VERSION,
          name: 'meldrift-signaling',
          version: process.env.MELDRIFT_VERSION ?? 'dev',
          uptimeMs: Date.now() - this.startedAt,
        },
        200,
        origin,
      );
    }

    if (method === 'POST' && path === '/api/auth/register') {
      return this.register(request, server, origin);
    }
    if (method === 'POST' && path === '/api/auth/login') {
      return this.login(request, server, origin);
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      const token = tokenFromRequest(request);
      const user = userForToken(this.db, token);
      if (!user || !token) return this.fail('Sign in required', 401, origin);
      revokeSession(this.db, token);
      return this.json({ ok: true }, 200, origin);
    }

    const user = userForToken(this.db, tokenFromRequest(request));
    if (!user) return this.fail('Sign in required', 401, origin);

    if (method === 'GET' && path === '/api/bootstrap') {
      return this.json(this.bootstrap(user), 200, origin);
    }
    if (method === 'GET' && path === '/api/voice/ice') {
      return this.json(this.voiceConfig(), 200, origin);
    }
    if (method === 'POST' && path === '/api/rooms') {
      return this.createRoom(request, user, origin);
    }
    if (method === 'POST' && path === '/api/rooms/join') {
      return this.joinRoom(request, user, origin);
    }
    if (method === 'DELETE' && path.startsWith('/api/rooms/')) {
      return this.deleteRoom(path.slice('/api/rooms/'.length), user, origin);
    }
    if (method === 'GET' && path === '/api/messages') {
      return this.listMessages(url, user, origin);
    }
    if (method === 'POST' && path === '/api/friends') {
      return this.requestFriend(request, user, origin);
    }
    if (method === 'POST' && path === '/api/friends/accept') {
      return this.acceptFriend(request, user, origin);
    }
    if (method === 'DELETE' && path.startsWith('/api/friends/')) {
      return this.removeFriend(path.split('/').pop() ?? '', user, origin);
    }
    if (method === 'GET' && path.startsWith('/api/dm/')) {
      return this.openConversation(path.split('/').pop() ?? '', user, origin);
    }

    return null;
  }

  /* ---- Auth endpoints -------------------------------------------------- */

  /**
   * Height only: a per-client counter, not a distributed limiter. Behind a
   * proxy every client shares one address unless trustProxy is enabled.
   */
  private rateLimited(key: string): boolean {
    const now = Date.now();
    const burst = this.options.authBurst ?? AUTH_BURST;
    const windowMs = this.options.authWindowMs ?? AUTH_WINDOW_MS;
    const entry = this.authAttempts.get(key);
    if (!entry || entry.resetAt < now) {
      this.authAttempts.set(key, { count: 1, resetAt: now + windowMs });
      // Opportunistic cleanup so the map cannot grow without bound.
      if (this.authAttempts.size > 5_000) {
        for (const [id, value] of this.authAttempts) {
          if (value.resetAt < now) this.authAttempts.delete(id);
        }
      }
      return false;
    }
    entry.count += 1;
    return entry.count > burst;
  }

  private clientKey(request: Request, server: Server<SocketData>, kind: string): string {
    const forwarded = this.options.trustProxy
      ? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      : null;
    const ip = forwarded || server.requestIP(request)?.address || 'local';
    return `${kind}:${ip}`;
  }

  private async register(
    request: Request,
    server: Server<SocketData>,
    origin: string | null,
  ): Promise<Response> {
    if (this.rateLimited(this.clientKey(request, server, 'register'))) {
      return this.fail('Too many attempts, try again shortly.', 429, origin);
    }

    const body = (await request.json().catch(() => null)) as RegisterBody | null;
    if (!body) return this.fail('Invalid JSON body', 400, origin);

    const username = normalizeUsername(body.username ?? '');
    const password = String(body.password ?? '');
    const displayName = String(body.displayName ?? '').trim().slice(0, 32) || username;
    const avatarColor = String(body.avatarColor ?? '#7c4df2').slice(0, 16);

    validateCredentials(username, password);
    if (!displayName) return this.fail('Display name is required', 400, origin);

    const existing = this.db.query('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return this.fail('That username is taken', 409, origin);

    const user: UserRow = {
      id: crypto.randomUUID(),
      username,
      display_name: displayName,
      avatar_color: avatarColor,
      password_hash: await hashPassword(password),
      created_at: Date.now(),
    };
    this.db
      .query(
        'INSERT INTO users (id, username, display_name, avatar_color, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(user.id, user.username, user.display_name, user.avatar_color, user.password_hash, user.created_at);

    const token = createSession(this.db, user.id);
    return this.json({ token, user: asUser(user) }, 201, origin);
  }

  private async login(
    request: Request,
    server: Server<SocketData>,
    origin: string | null,
  ): Promise<Response> {
    if (this.rateLimited(this.clientKey(request, server, 'login'))) {
      return this.fail('Too many attempts, try again shortly.', 429, origin);
    }

    const body = (await request.json().catch(() => null)) as LoginBody | null;
    if (!body) return this.fail('Invalid JSON body', 400, origin);

    const username = normalizeUsername(body.username ?? '');
    const row = this.db.query('SELECT * FROM users WHERE username = ?').get(username) as UserRow | null;
    const password = String(body.password ?? '');

    // Always run a hash comparison so a missing user and a wrong password take
    // comparable time.
    const hash = row ? row.password_hash : await DUMMY_HASH;
    const valid = await verifyPassword(password, hash);
    if (!row || !valid) return this.fail('Wrong username or password', 401, origin);

    const token = createSession(this.db, row.id);
    return this.json({ token, user: asUser(row) }, 200, origin);
  }

  /* ---- Bootstrap ------------------------------------------------------- */

  bootstrap(user: PublicUser): BootstrapView {
    return {
      protocol: PROTOCOL_VERSION,
      user,
      rooms: this.roomsFor(user.id),
      friends: this.friendsFor(user.id),
      requests: this.requestsFor(user.id),
      conversations: this.conversationsFor(user.id),
    };
  }

  private roomsFor(userId: string): RoomView[] {
    const rows = this.db
      .query(
        `SELECT rooms.* FROM rooms
         JOIN room_members ON room_members.room_id = rooms.id
         WHERE room_members.user_id = ?
         ORDER BY rooms.last_active_at DESC`,
      )
      .all(userId) as RoomRow[];
    return rows.map((row) => this.roomView(row));
  }

  private roomView(row: RoomRow): RoomView {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind === 'voice' ? 'voice' : 'game',
      gameTitle: row.game_title,
      inviteCode: row.invite_code,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      members: this.membersOf(row.id),
    };
  }

  membersOf(roomId: string): RoomMemberView[] {
    const rows = this.db
      .query(
        `SELECT room_members.user_id, room_members.role, room_members.joined_at,
                users.display_name, users.avatar_color
         FROM room_members
         JOIN users ON users.id = room_members.user_id
         WHERE room_members.room_id = ?
         ORDER BY room_members.joined_at ASC`,
      )
      .all(roomId) as Array<{
      user_id: string;
      role: string;
      joined_at: number;
      display_name: string;
      avatar_color: string;
    }>;
    return rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      avatarColor: row.avatar_color,
      role: row.role === 'host' ? 'host' : 'member',
      presence: this.presenceOf(row.user_id),
      joinedAt: row.joined_at,
    }));
  }

  private friendsFor(userId: string): FriendView[] {
    const rows = this.db
      .query(
        `SELECT users.id, users.username, users.display_name, users.avatar_color, friend_links.created_at
         FROM friend_links
         JOIN users ON users.id = CASE WHEN friend_links.user_a = ? THEN friend_links.user_b ELSE friend_links.user_a END
         WHERE (friend_links.user_a = ? OR friend_links.user_b = ?) AND friend_links.status = 'accepted'
         ORDER BY users.display_name COLLATE NOCASE ASC`,
      )
      .all(userId, userId, userId) as Array<{
      id: string;
      username: string;
      display_name: string;
      avatar_color: string;
      created_at: number;
    }>;
    return rows.map((row) => this.friendView(row));
  }

  private friendView(row: {
    id: string;
    username: string;
    display_name: string;
    avatar_color: string;
    created_at: number;
  }): FriendView {
    return {
      userId: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarColor: row.avatar_color,
      presence: this.presenceOf(row.id),
      since: row.created_at,
    };
  }

  private friendViewFor(userId: string, friendId: string): FriendView | null {
    const row = this.db
      .query(
        `SELECT users.id, users.username, users.display_name, users.avatar_color, friend_links.created_at
         FROM friend_links
         JOIN users ON users.id = ?
         WHERE ((friend_links.user_a = ? AND friend_links.user_b = ?) OR (friend_links.user_a = ? AND friend_links.user_b = ?))
           AND friend_links.status = 'accepted'`,
      )
      .get(friendId, userId, friendId, friendId, userId) as
      | {
          id: string;
          username: string;
          display_name: string;
          avatar_color: string;
          created_at: number;
        }
      | null;
    return row ? this.friendView(row) : null;
  }

  private requestsFor(userId: string): FriendRequestView[] {
    const rows = this.db
      .query(
        `SELECT users.id, users.username, users.display_name, users.avatar_color, friend_links.created_at
         FROM friend_links
         JOIN users ON users.id = friend_links.requested_by
         WHERE (friend_links.user_a = ? OR friend_links.user_b = ?)
           AND friend_links.status = 'pending'
           AND friend_links.requested_by != ?
         ORDER BY friend_links.created_at ASC`,
      )
      .all(userId, userId, userId) as Array<{
      id: string;
      username: string;
      display_name: string;
      avatar_color: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      userId: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarColor: row.avatar_color,
      createdAt: row.created_at,
    }));
  }

  private conversationsFor(userId: string): ConversationView[] {
    const rows = this.db
      .query(
        `SELECT dm_conversations.id, dm_conversations.member_a, dm_conversations.member_b,
                (SELECT MAX(created_at) FROM messages WHERE scope_type = 'dm' AND scope_id = dm_conversations.id) AS last_message_at
         FROM dm_conversations
         WHERE dm_conversations.member_a = ? OR dm_conversations.member_b = ?`,
      )
      .all(userId, userId) as Array<{
      id: string;
      member_a: string;
      member_b: string;
      last_message_at: number | null;
    }>;

    return rows.map((row) => {
      const peerId = row.member_a === userId ? row.member_b : row.member_a;
      const peer = this.db.query('SELECT * FROM users WHERE id = ?').get(peerId) as UserRow;
      return {
        id: row.id,
        peer: asUser(peer),
        peerPresence: this.presenceOf(peerId),
        lastMessageAt: row.last_message_at,
      };
    });
  }

  /* ---- Rooms ----------------------------------------------------------- */

  private async createRoom(request: Request, user: PublicUser, origin: string | null): Promise<Response> {
    const body = (await request.json().catch(() => null)) as CreateRoomBody | null;
    if (!body) return this.fail('Invalid JSON body', 400, origin);

    const name = String(body.name ?? '').trim().slice(0, 40);
    const kind = body.kind === 'voice' ? 'voice' : 'game';
    if (!name) return this.fail('Room needs a name', 400, origin);
    const gameTitle = kind === 'game' ? (String(body.gameTitle ?? '').trim().slice(0, 60) || null) : null;

    let inviteCode = makeInviteCode();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const taken = this.db.query('SELECT 1 FROM rooms WHERE invite_code = ?').get(inviteCode);
      if (!taken) break;
      inviteCode = makeInviteCode();
    }

    const now = Date.now();
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO rooms (id, name, kind, game_title, invite_code, owner_id, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, kind, gameTitle, inviteCode, user.id, now, now);
    this.db
      .query('INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(id, user.id, 'host', now);

    const row = this.db.query('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow;
    return this.json(this.roomView(row), 201, origin);
  }

  private async joinRoom(request: Request, user: PublicUser, origin: string | null): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { code?: string } | null;
    const code = String(body?.code ?? '').trim().toUpperCase();
    if (!code) return this.fail('Enter an invite code', 400, origin);

    const row = this.db.query('SELECT * FROM rooms WHERE invite_code = ?').get(code) as RoomRow | null;
    if (!row) return this.fail('No room matches that code', 404, origin);

    const membership = this.db
      .query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?')
      .get(row.id, user.id);
    if (!membership) {
      this.db
        .query('INSERT INTO room_members (room_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
        .run(row.id, user.id, 'member', Date.now());
    }

    const members = this.membersOf(row.id);
    this.broadcastToRoom(row.id, { t: 'room.members', roomId: row.id, members });
    return this.json(this.roomView(row), 200, origin);
  }

  /**
   * Only the room owner may delete it. The delete is permanent on the server:
   * the row (and its unique invite code) is removed, so an old code can never
   * be used to rejoin, and the room is gone for every member after a restart.
   *
   * Deletion is acknowledged with 200 only after both writes committed. Members
   * are told after the writes, so a client cannot show the room as deleted while
   * the server still holds it.
   */
  private deleteRoom(roomId: string, user: PublicUser, origin: string | null): Response {
    let id: string;
    try {
      id = decodeURIComponent(roomId);
    } catch {
      return this.fail('Unknown room', 400, origin);
    }
    if (!id || id.length > 64) return this.fail('Unknown room', 400, origin);

    const row = this.db.query('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | null;
    if (!row) return this.fail('This room has already been deleted', 404, origin);
    if (row.owner_id !== user.id) {
      return this.fail('Only the room host can delete this room', 403, origin);
    }

    // Live voice/stream/control state is in memory and keyed by room id. End it
    // before the rows disappear so participants get an explicit stop event.
    const members = this.roomAudience(id);
    this.voiceRooms.delete(id);
    this.endStream(id, 'The room was deleted.');
    this.endControl(id, 'The room was deleted.');
    this.streams.delete(id);

    this.db.query("DELETE FROM messages WHERE scope_type = 'room' AND scope_id = ?").run(id);
    this.db.query('DELETE FROM rooms WHERE id = ?').run(id);

    const event: ServerEvent = {
      t: 'room.deleted',
      roomId: id,
      name: row.name,
      actorId: user.id,
    };
    for (const memberId of members) this.sendTo(memberId, event);

    return this.json({ ok: true }, 200, origin);
  }

  /* ---- Messages -------------------------------------------------------- */

  private listMessages(url: URL, user: PublicUser, origin: string | null): Response {
    const scopeType = url.searchParams.get('scopeType') as MessageScope | null;
    const scopeId = url.searchParams.get('scopeId') ?? '';
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
    if (scopeType !== 'room' && scopeType !== 'dm') return this.fail('Unknown message scope', 400, origin);
    if (!this.canRead(user.id, scopeType, scopeId)) return this.fail('No access to this conversation', 403, origin);

    const rows = this.db
      .query(
        `SELECT messages.*, users.display_name, users.avatar_color
         FROM messages JOIN users ON users.id = messages.author_id
         WHERE scope_type = ? AND scope_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(scopeType, scopeId, limit) as Array<MessageRow & { display_name: string; avatar_color: string }>;

    return this.json(
      rows
        .map((row) => ({
          id: row.id,
          scopeType,
          scopeId,
          authorId: row.author_id,
          authorName: row.display_name,
          authorAvatarColor: row.avatar_color,
          body: row.body,
          createdAt: row.created_at,
        }))
        .reverse(),
      200,
      origin,
    );
  }

  private isRoomMember(userId: string, roomId: string): boolean {
    return Boolean(
      this.db.query('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId),
    );
  }

  private isConversationMember(userId: string, conversationId: string): boolean {
    return Boolean(
      this.db
        .query('SELECT 1 FROM dm_conversations WHERE id = ? AND (member_a = ? OR member_b = ?)')
        .get(conversationId, userId, userId),
    );
  }

  private canRead(userId: string, scopeType: MessageScope, scopeId: string): boolean {
    return scopeType === 'room' ? this.isRoomMember(userId, scopeId) : this.isConversationMember(userId, scopeId);
  }

  /* ---- Friends --------------------------------------------------------- */

  private async requestFriend(request: Request, user: PublicUser, origin: string | null): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { username?: string } | null;
    const username = normalizeUsername(String(body?.username ?? ''));
    if (!username) return this.fail('Enter a username', 400, origin);
    if (username === user.username) return this.fail('That is your own username', 400, origin);

    const target = this.db.query('SELECT * FROM users WHERE username = ?').get(username) as UserRow | null;
    if (!target) return this.fail('No player with that username', 404, origin);

    const [a, b] = orderedPair(user.id, target.id);
    const existing = this.db.query('SELECT * FROM friend_links WHERE user_a = ? AND user_b = ?').get(a, b) as
      | { status: string; requested_by: string }
      | null;

    if (existing?.status === 'accepted') return this.fail('You are already friends', 409, origin);
    if (existing?.status === 'pending') {
      if (existing.requested_by === user.id) return this.fail('Request already sent', 409, origin);
      // The target had already asked us: accepting immediately is the friendly
      // interpretation of a mutual request.
      this.acceptPair(a, b, user.id, target.id);
      return this.json({ friend: this.friendViewFor(user.id, target.id) }, 200, origin);
    }

    this.db
      .query('INSERT INTO friend_links (user_a, user_b, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(a, b, 'pending', user.id, Date.now());

    this.sendTo(target.id, {
      t: 'friend.request',
      request: {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarColor: user.avatarColor,
        createdAt: Date.now(),
      },
    });

    return this.json({ pending: true }, 201, origin);
  }

  private acceptPair(a: string, b: string, requesterId: string, targetId: string): void {
    this.db
      .query(`UPDATE friend_links SET status = 'accepted' WHERE user_a = ? AND user_b = ?`)
      .run(a, b);
    const forRequester = this.friendViewFor(requesterId, targetId);
    const forTarget = this.friendViewFor(targetId, requesterId);
    if (forRequester) this.sendTo(requesterId, { t: 'friend.update', friend: forRequester });
    if (forTarget) this.sendTo(targetId, { t: 'friend.update', friend: forTarget });
  }

  private async acceptFriend(request: Request, user: PublicUser, origin: string | null): Promise<Response> {
    const body = (await request.json().catch(() => null)) as { userId?: string } | null;
    const requesterId = String(body?.userId ?? '');
    if (!requesterId) return this.fail('Missing user', 400, origin);

    const [a, b] = orderedPair(user.id, requesterId);
    const link = this.db.query('SELECT * FROM friend_links WHERE user_a = ? AND user_b = ?').get(a, b) as
      | { status: string; requested_by: string }
      | null;
    if (!link || link.status !== 'pending') return this.fail('No pending request from that player', 404, origin);

    this.acceptPair(a, b, requesterId, user.id);
    return this.json({ friend: this.friendViewFor(user.id, requesterId) }, 200, origin);
  }

  private removeFriend(friendId: string, user: PublicUser, origin: string | null): Response {
    const [a, b] = orderedPair(user.id, friendId);
    this.db.query('DELETE FROM friend_links WHERE user_a = ? AND user_b = ?').run(a, b);
    return this.json({ ok: true }, 200, origin);
  }

  private openConversation(peerId: string, user: PublicUser, origin: string | null): Response {
    if (!this.friendViewFor(user.id, peerId)) return this.fail('You are not friends with that player', 403, origin);

    const [a, b] = orderedPair(user.id, peerId);
    let row = this.db
      .query('SELECT * FROM dm_conversations WHERE member_a = ? AND member_b = ?')
      .get(a, b) as { id: string } | null;
    if (!row) {
      const id = crypto.randomUUID();
      this.db
        .query('INSERT INTO dm_conversations (id, member_a, member_b, created_at) VALUES (?, ?, ?, ?)')
        .run(id, a, b, Date.now());
      row = { id };
    }
    return this.json({ conversationId: row.id }, 200, origin);
  }

  /* ---- Voice ----------------------------------------------------------- */

  /**
   * Advertised ICE servers. Signed-in clients only: a TURN credential is a
   * relay credential, so it is never served without authentication. Self-hosters
   * can rotate it by restarting the service with new environment variables.
   */
  voiceConfig(): VoiceConfigView {
    const stun = validIceUrls(this.options.voice?.stunUrls);
    const turn = validIceUrls(this.options.voice?.turnUrls);
    const iceServers: VoiceConfigView['iceServers'] = [];
    iceServers.push({ urls: stun.length > 0 ? stun : DEFAULT_STUN_URLS });
    if (turn.length > 0) {
      iceServers.push({
        urls: turn,
        ...(this.options.voice?.turnUsername ? { username: this.options.voice.turnUsername } : {}),
        ...(this.options.voice?.turnCredential
          ? { credential: this.options.voice.turnCredential }
          : {}),
      });
    }
    return { iceServers, maxParticipants: VOICE_MAX_PARTICIPANTS };
  }

  /**
   * Joining is idempotent. Re-joining after a socket reconnect replaces the
   * membership instead of creating a second one, and joining a different room
   * leaves the previous voice channel first.
   */
  private handleVoiceJoin(socket: AuthedSocket, roomId: string): void {
    const userId = socket.data.userId;
    if (!roomId || roomId.length > 64) {
      this.send(socket, { t: 'voice.error', error: 'Unknown room' });
      return;
    }
    const room = this.db.query('SELECT id FROM rooms WHERE id = ?').get(roomId);
    if (!room) {
      this.send(socket, { t: 'voice.error', roomId, error: 'Room not found' });
      return;
    }
    if (!this.isRoomMember(userId, roomId)) {
      this.send(socket, { t: 'voice.error', roomId, error: 'You are not a member of this room' });
      return;
    }

    for (const [otherRoom, members] of this.voiceRooms) {
      if (otherRoom === roomId) continue;
      const member = members.get(userId);
      if (member && member.socketId === socket.data.socketId) {
        this.removeVoiceMember(otherRoom, userId);
      }
    }

    let members = this.voiceRooms.get(roomId);
    if (!members) {
      members = new Map<string, VoiceMember>();
      this.voiceRooms.set(roomId, members);
    }

    const existing = members.get(userId);
    const user = this.db.query('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
    if (!existing && members.size >= VOICE_MAX_PARTICIPANTS) {
      this.send(socket, {
        t: 'voice.error',
        roomId,
        error: `Voice channels hold ${VOICE_MAX_PARTICIPANTS} people in this build`,
      });
      return;
    }

    const participant: VoiceParticipantView = existing
      ? { ...existing.participant, joinedAt: existing.participant.joinedAt }
      : {
          userId,
          displayName: user.display_name,
          avatarColor: user.avatar_color,
          muted: false,
          deafened: false,
          speaking: false,
          joinedAt: Date.now(),
        };
    members.set(userId, { participant, socketId: socket.data.socketId });

    const roster = [...members.values()]
      .map((member) => member.participant)
      .filter((item) => item.userId !== userId);
    this.send(socket, { t: 'voice.joined', roomId, selfId: userId, participants: roster });

    if (!existing) {
      this.broadcastToRoom(
        roomId,
        { t: 'voice.participant.joined', roomId, participant },
        userId,
      );
    }
  }

  private handleVoiceLeave(socket: AuthedSocket, roomId: string): void {
    const removed = this.removeVoiceMember(roomId, socket.data.userId, socket);
    if (!removed) this.send(socket, { t: 'voice.left', roomId });
  }

  private removeVoiceMember(
    roomId: string,
    userId: string,
    origin?: AuthedSocket,
  ): VoiceParticipantView | null {
    const members = this.voiceRooms.get(roomId);
    const member = members?.get(userId);
    if (!members || !member) return null;
    members.delete(userId);
    if (members.size === 0) this.voiceRooms.delete(roomId);
    if (origin) this.send(origin, { t: 'voice.left', roomId });
    this.broadcastToRoom(roomId, { t: 'voice.participant.left', roomId, userId }, userId);
    return member.participant;
  }

  private handleVoiceState(
    socket: AuthedSocket,
    event: Extract<ClientEvent, { t: 'voice.state' }>,
  ): void {
    const roomId = String(event.roomId ?? '');
    const members = this.voiceRooms.get(roomId);
    const member = members?.get(socket.data.userId);
    if (!members || !member || member.socketId !== socket.data.socketId) {
      this.send(socket, { t: 'voice.error', roomId, error: 'Join voice first' });
      return;
    }
    const participant: VoiceParticipantView = {
      ...member.participant,
      muted: event.muted === true,
      deafened: event.deafened === true,
      speaking: event.speaking === true,
    };
    member.participant = participant;
    this.broadcastToRoom(
      roomId,
      {
        t: 'voice.participant.state',
        roomId,
        userId: participant.userId,
        muted: participant.muted,
        deafened: participant.deafened,
        speaking: participant.speaking,
      },
      participant.userId,
    );
  }

  /**
   * SDP and ICE are only relayed between two people who are currently in the
   * same voice channel. Membership alone is not enough: a room member who never
   * joined voice cannot be signalled, and a stranger cannot signal anyone.
   */
  private handleVoiceSignal(
    socket: AuthedSocket,
    event: Extract<ClientEvent, { t: 'voice.offer' | 'voice.answer' | 'voice.ice' }>,
  ): void {
    const now = Date.now();
    socket.data.voiceRecent = socket.data.voiceRecent.filter(
      (stamp) => now - stamp < VOICE_SIGNAL_WINDOW_MS,
    );
    if (socket.data.voiceRecent.length >= VOICE_SIGNAL_BURST) {
      this.send(socket, {
        t: 'voice.error',
        roomId: String(event.roomId ?? '') || undefined,
        error: 'Voice signalling is too fast; slow down',
      });
      return;
    }

    const roomId = String(event.roomId ?? '');
    const to = String(event.to ?? '');
    if (!roomId || roomId.length > 64 || !to || to.length > 64 || to === socket.data.userId) {
      this.send(socket, { t: 'voice.error', roomId: roomId || undefined, error: 'Invalid voice target' });
      return;
    }

    const members = this.voiceRooms.get(roomId);
    const self = members?.get(socket.data.userId);
    const target = members?.get(to);
    if (!self || self.socketId !== socket.data.socketId) {
      this.send(socket, { t: 'voice.error', roomId, error: 'Join voice first' });
      return;
    }
    if (!target) {
      this.send(socket, { t: 'voice.error', roomId, error: 'That player is not in this voice channel' });
      return;
    }

    if (event.t === 'voice.ice') {
      const candidate = event.candidate as VoiceIceCandidate | undefined;
      if (
        !candidate ||
        typeof candidate.candidate !== 'string' ||
        candidate.candidate.length > VOICE_MAX_CANDIDATE_LENGTH ||
        (candidate.sdpMid != null && typeof candidate.sdpMid !== 'string') ||
        (candidate.sdpMLineIndex != null && typeof candidate.sdpMLineIndex !== 'number')
      ) {
        this.send(socket, { t: 'voice.error', roomId, error: 'Invalid ICE candidate' });
        return;
      }
      socket.data.voiceRecent.push(now);
      this.sendTo(to, {
        t: 'voice.ice',
        roomId,
        from: socket.data.userId,
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          usernameFragment: candidate.usernameFragment ?? null,
        },
      });
      return;
    }

    const sdp = event.sdp;
    if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > VOICE_MAX_SDP_LENGTH) {
      this.send(socket, { t: 'voice.error', roomId, error: 'Invalid session description' });
      return;
    }
    socket.data.voiceRecent.push(now);
    this.sendTo(to, {
      t: event.t,
      roomId,
      from: socket.data.userId,
      sdp,
    });
  }

  /* ---- Game streaming -------------------------------------------------- */

  private streamParticipant(userId: string): StreamParticipantView {
    const row = this.db.query('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | null;
    return {
      userId,
      displayName: row?.display_name ?? 'Player',
      avatarColor: row?.avatar_color ?? '#7c4df2',
    };
  }

  private streamView(session: StreamSession): StreamSessionView {
    return {
      roomId: session.roomId,
      host: this.streamParticipant(session.hostUserId),
      mode: session.mode,
      preset: session.preset,
      startedAt: session.startedAt,
      viewers: [...session.viewers.keys()].map((userId) => this.streamParticipant(userId)),
    };
  }

  private broadcastStreamSession(session: StreamSession): void {
    this.broadcastToRoom(session.roomId, { t: 'stream.started', session: this.streamView(session) });
  }

  private broadcastStreamViewers(session: StreamSession): void {
    this.broadcastToRoom(session.roomId, {
      t: 'stream.viewers',
      roomId: session.roomId,
      viewers: [...session.viewers.keys()].map((userId) => this.streamParticipant(userId)),
    });
  }

  private endStream(roomId: string, reason: string): void {
    const session = this.streams.get(roomId);
    if (!session) return;
    this.streams.delete(roomId);
    // Control never outlives the stream it was granted for.
    this.endControl(roomId, 'The stream stopped, so remote control ended.');
    this.broadcastToRoom(roomId, { t: 'stream.stopped', roomId, reason });
  }

  /**
   * Only the room owner may broadcast. Repeating `stream.start` on the same
   * socket reconfigures an active stream (source or preset change) without
   * dropping viewers; a different socket can never take over someone's stream.
   */
  private handleStreamStart(
    socket: AuthedSocket,
    event: Extract<ClientEvent, { t: 'stream.start' }>,
  ): void {
    const roomId = String(event.roomId ?? '');
    if (!roomId || roomId.length > 64) {
      this.send(socket, { t: 'stream.error', error: 'Unknown room' });
      return;
    }
    const room = this.db.query('SELECT * FROM rooms WHERE id = ?').get(roomId) as RoomRow | null;
    if (!room) {
      this.send(socket, { t: 'stream.error', roomId, error: 'Room not found' });
      return;
    }
    if (!this.isRoomMember(socket.data.userId, roomId)) {
      this.send(socket, { t: 'stream.error', roomId, error: 'You are not a member of this room' });
      return;
    }
    if (room.owner_id !== socket.data.userId) {
      this.send(socket, { t: 'stream.error', roomId, error: 'Only the host of this room can share a screen' });
      return;
    }
    if (event.mode !== 'window' && event.mode !== 'desktop') {
      this.send(socket, { t: 'stream.error', roomId, error: 'Unknown capture mode' });
      return;
    }
    if (!STREAM_PRESETS.includes(event.preset)) {
      this.send(socket, { t: 'stream.error', roomId, error: 'Unknown quality preset' });
      return;
    }

    const existing = this.streams.get(roomId);
    if (existing) {
      if (existing.hostUserId !== socket.data.userId || existing.hostSocketId !== socket.data.socketId) {
        this.send(socket, { t: 'stream.error', roomId, error: 'This room is already streaming' });
        return;
      }
      existing.mode = event.mode;
      existing.preset = event.preset;
      this.broadcastStreamSession(existing);
      return;
    }

    const session: StreamSession = {
      roomId,
      hostUserId: socket.data.userId,
      hostSocketId: socket.data.socketId,
      mode: event.mode,
      preset: event.preset,
      startedAt: Date.now(),
      viewers: new Map(),
    };
    this.streams.set(roomId, session);
    this.broadcastStreamSession(session);
  }

  private handleStreamStop(socket: AuthedSocket, roomId: string): void {
    const session = this.streams.get(roomId);
    if (!session) {
      this.send(socket, { t: 'stream.error', roomId, error: 'No stream is running in this room' });
      return;
    }
    if (
      session.hostUserId !== socket.data.userId ||
      session.hostSocketId !== socket.data.socketId
    ) {
      this.send(socket, { t: 'stream.error', roomId, error: 'Only the streaming host can stop this stream' });
      return;
    }
    this.endStream(roomId, 'Host stopped the stream');
  }

  /** Viewers opt in explicitly: watching consumes the host's upload bandwidth. */
  private handleStreamWatch(socket: AuthedSocket, roomId: string): void {
    const session = this.streams.get(roomId);
    if (!session) {
      this.send(socket, { t: 'stream.error', roomId, error: 'No stream is running in this room' });
      return;
    }
    if (session.hostUserId === socket.data.userId) {
      this.send(socket, { t: 'stream.error', roomId, error: 'You are hosting this stream' });
      return;
    }
    if (!this.isRoomMember(socket.data.userId, roomId)) {
      this.send(socket, { t: 'stream.error', roomId, error: 'You are not a member of this room' });
      return;
    }

    const existing = session.viewers.get(socket.data.userId);
    if (existing && existing.socketId === socket.data.socketId) {
      // A retry on the same socket keeps the viewer slot but needs a fresh
      // offer: tell the host to replace that viewer's failed peer connection.
      this.send(socket, { t: 'stream.started', session: this.streamView(session) });
      this.sendTo(session.hostUserId, {
        t: 'stream.viewer.joined',
        roomId,
        viewer: this.streamParticipant(socket.data.userId),
      });
      return;
    }
    if (!existing && session.viewers.size >= STREAM_MAX_VIEWERS) {
      this.send(socket, {
        t: 'stream.error',
        roomId,
        error: `This stream is full (${STREAM_MAX_VIEWERS} viewers)`,
      });
      return;
    }

    session.viewers.set(socket.data.userId, { socketId: socket.data.socketId });
    this.send(socket, { t: 'stream.started', session: this.streamView(session) });
    this.broadcastStreamViewers(session);
    this.sendTo(session.hostUserId, {
      t: 'stream.viewer.joined',
      roomId,
      viewer: this.streamParticipant(socket.data.userId),
    });
  }

  private handleStreamUnwatch(socket: AuthedSocket, roomId: string): void {
    const session = this.streams.get(roomId);
    if (!session) return;
    const viewer = session.viewers.get(socket.data.userId);
    if (!viewer || viewer.socketId !== socket.data.socketId) return;
    session.viewers.delete(socket.data.userId);
    this.broadcastStreamViewers(session);
    this.sendTo(session.hostUserId, {
      t: 'stream.viewer.left',
      roomId,
      userId: socket.data.userId,
    });
  }

  private handleStreamPreset(
    socket: AuthedSocket,
    roomId: string,
    preset: StreamPreset,
  ): void {
    const session = this.streams.get(roomId);
    if (!session) {
      this.send(socket, { t: 'stream.error', roomId, error: 'No stream is running in this room' });
      return;
    }
    if (
      session.hostUserId !== socket.data.userId ||
      session.hostSocketId !== socket.data.socketId
    ) {
      this.send(socket, { t: 'stream.error', roomId, error: 'Only the streaming host can change quality' });
      return;
    }
    if (!STREAM_PRESETS.includes(preset)) {
      this.send(socket, { t: 'stream.error', roomId, error: 'Unknown quality preset' });
      return;
    }
    session.preset = preset;
    this.broadcastStreamSession(session);
  }

  private handleStreamSync(socket: AuthedSocket, roomId: string): void {
    if (!roomId || !this.isRoomMember(socket.data.userId, roomId)) {
      this.send(socket, { t: 'stream.error', roomId, error: 'You are not a member of this room' });
      return;
    }
    const session = this.streams.get(roomId);
    if (session) {
      this.send(socket, { t: 'stream.started', session: this.streamView(session) });
    } else {
      this.send(socket, { t: 'stream.stopped', roomId, reason: 'No stream is running' });
    }
  }

  /**
   * Video SDP/ICE is relayed only between the current host and current viewers
   * of the same session; the media itself never passes through the service.
   */
  private handleStreamSignal(
    socket: AuthedSocket,
    event: Extract<ClientEvent, { t: 'stream.offer' | 'stream.answer' | 'stream.ice' }>,
  ): void {
    const now = Date.now();
    socket.data.streamRecent = socket.data.streamRecent.filter(
      (stamp) => now - stamp < STREAM_SIGNAL_WINDOW_MS,
    );
    if (socket.data.streamRecent.length >= STREAM_SIGNAL_BURST) {
      this.send(socket, {
        t: 'stream.error',
        roomId: String(event.roomId ?? '') || undefined,
        error: 'Stream signalling is too fast; slow down',
      });
      return;
    }

    const roomId = String(event.roomId ?? '');
    const to = String(event.to ?? '');
    if (!roomId || roomId.length > 64 || !to || to.length > 64 || to === socket.data.userId) {
      this.send(socket, { t: 'stream.error', roomId: roomId || undefined, error: 'Invalid stream target' });
      return;
    }

    const session = this.streams.get(roomId);
    if (!session) {
      this.send(socket, { t: 'stream.error', roomId, error: 'No stream is running in this room' });
      return;
    }
    const isHost =
      session.hostUserId === socket.data.userId &&
      session.hostSocketId === socket.data.socketId;
    const viewer = session.viewers.get(socket.data.userId);
    const isViewer = viewer?.socketId === socket.data.socketId;
    if (!isHost && !isViewer) {
      this.send(socket, { t: 'stream.error', roomId, error: 'You are not part of this stream' });
      return;
    }
    if (isHost) {
      if (!session.viewers.has(to)) {
        this.send(socket, { t: 'stream.error', roomId, error: 'That player is not watching this stream' });
        return;
      }
      if (event.t === 'stream.answer') {
        this.send(socket, { t: 'stream.error', roomId, error: 'A host does not answer its own stream' });
        return;
      }
    } else {
      if (to !== session.hostUserId) {
        this.send(socket, { t: 'stream.error', roomId, error: 'Stream signalling must go to the host' });
        return;
      }
      if (event.t === 'stream.offer') {
        this.send(socket, { t: 'stream.error', roomId, error: 'Only the host can offer a stream' });
        return;
      }
    }

    if (event.t === 'stream.ice') {
      const candidate = event.candidate as VoiceIceCandidate | undefined;
      if (
        !candidate ||
        typeof candidate.candidate !== 'string' ||
        candidate.candidate.length > STREAM_MAX_CANDIDATE_LENGTH ||
        (candidate.sdpMid != null && typeof candidate.sdpMid !== 'string') ||
        (candidate.sdpMLineIndex != null && typeof candidate.sdpMLineIndex !== 'number')
      ) {
        this.send(socket, { t: 'stream.error', roomId, error: 'Invalid ICE candidate' });
        return;
      }
      socket.data.streamRecent.push(now);
      this.sendTo(to, {
        t: 'stream.ice',
        roomId,
        from: socket.data.userId,
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          usernameFragment: candidate.usernameFragment ?? null,
        },
      });
      return;
    }

    const sdp = event.sdp;
    if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > STREAM_MAX_SDP_LENGTH) {
      this.send(socket, { t: 'stream.error', roomId, error: 'Invalid session description' });
      return;
    }
    socket.data.streamRecent.push(now);
    this.sendTo(to, { t: event.t, roomId, from: socket.data.userId, sdp });
  }

  /* ---- Remote control -------------------------------------------------- */

  private controlView(roomId: string): ControlSessionView {
    const room = this.db.query('SELECT * FROM rooms WHERE id = ?').get(roomId) as RoomRow | null;
    const session = this.controlSessions.get(roomId);
    return {
      roomId,
      host: this.streamParticipant(room?.owner_id ?? ''),
      enabled: session?.enabled ?? false,
      targetLabel: session?.targetLabel ?? null,
      queue: (session?.queue ?? []).map((userId) => this.streamParticipant(userId)),
      controller: session?.controllerId ? this.streamParticipant(session.controllerId) : null,
      controllerActive: session?.controllerActive ?? false,
      since: session?.since ?? 0,
    };
  }

  private broadcastControl(session: ControlSession): void {
    this.broadcastToRoom(session.roomId, {
      t: 'control.state',
      session: this.controlView(session.roomId),
    });
  }

  private controlError(socket: AuthedSocket, roomId: string | undefined, error: string): void {
    this.send(socket, { t: 'control.error', roomId: roomId || undefined, error });
  }

  /** Only the socket hosting the live stream may change control settings. */
  private controlHost(
    socket: AuthedSocket,
    roomId: string,
  ): ControlSession | null {
    if (!roomId || roomId.length > 64) {
      this.controlError(socket, undefined, 'Unknown room');
      return null;
    }
    const session = this.controlSessions.get(roomId);
    if (!session) {
      this.controlError(socket, roomId, 'Remote control is not enabled in this room');
      return null;
    }
    if (
      session.hostUserId !== socket.data.userId ||
      session.hostSocketId !== socket.data.socketId
    ) {
      this.controlError(socket, roomId, 'Only the streaming host can manage remote control');
      return null;
    }
    return session;
  }

  /** Removes a grant everywhere. The host stays the owner; control goes to nobody. */
  private dropGrant(session: ControlSession, reason: string): void {
    const previous = session.controllerId;
    if (previous) {
      this.broadcastToRoom(session.roomId, {
        t: 'control.revoked',
        roomId: session.roomId,
        controllerId: previous,
        reason,
      });
    }
    if (session.grantId) {
      session.revoked.push(session.grantId);
      if (session.revoked.length > 32) session.revoked.shift();
    }
    session.controllerId = null;
    session.grantId = null;
    session.token = null;
    session.grantExpiresAt = null;
    session.controllerActive = false;
    this.broadcastControl(session);
  }

  /** Ends control completely, including the enabled flag and queue. */
  private endControl(roomId: string, reason: string): void {
    const session = this.controlSessions.get(roomId);
    if (!session) return;
    this.controlSessions.delete(roomId);
    if (session.controllerId) {
      this.broadcastToRoom(roomId, {
        t: 'control.revoked',
        roomId,
        controllerId: session.controllerId,
        reason,
      });
    }
    this.broadcastToRoom(roomId, { t: 'control.state', session: this.controlView(roomId) });
  }

  private handleControlEnable(
    socket: AuthedSocket,
    event: Extract<ClientEvent, { t: 'control.enable' }>,
  ): void {
    const roomId = String(event.roomId ?? '');
    if (!roomId || roomId.length > 64) {
      this.controlError(socket, undefined, 'Unknown room');
      return;
    }
    const room = this.db.query('SELECT * FROM rooms WHERE id = ?').get(roomId) as RoomRow | null;
    if (!room) {
      this.controlError(socket, roomId, 'Room not found');
      return;
    }
    if (!this.isRoomMember(socket.data.userId, roomId)) {
      this.controlError(socket, roomId, 'You are not a member of this room');
      return;
    }
    if (room.owner_id !== socket.data.userId) {
      this.controlError(socket, roomId, 'Only the room host can enable remote control');
      return;
    }
    const stream = this.streams.get(roomId);
    if (
      !stream ||
      stream.hostUserId !== socket.data.userId ||
      stream.hostSocketId !== socket.data.socketId
    ) {
      this.controlError(socket, roomId, 'Start sharing your game before enabling remote control');
      return;
    }

    if (event.enabled !== true) {
      this.endControl(roomId, 'The host turned remote control off.');
      this.send(socket, { t: 'control.state', session: this.controlView(roomId) });
      return;
    }

    const targetLabel = String(event.targetLabel ?? '')
      .trim()
      .slice(0, CONTROL_MAX_TARGET_LABEL);
    if (!targetLabel) {
      this.controlError(socket, roomId, 'Choose the window you are granting control of');
      return;
    }

    let session = this.controlSessions.get(roomId);
    if (!session) {
      session = {
        roomId,
        hostUserId: socket.data.userId,
        hostSocketId: socket.data.socketId,
        enabled: true,
        targetLabel,
        queue: [],
        controllerId: null,
        grantId: null,
        token: null,
        grantExpiresAt: null,
        controllerActive: false,
        since: Date.now(),
        revoked: [],
      };
      this.controlSessions.set(roomId, session);
    } else {
      session.enabled = true;
      if (session.targetLabel !== targetLabel && session.controllerId) {
        // Moving the consent boundary to another window must not silently
        // extend the current controller's reach.
        this.dropGrant(session, 'The host changed the controlled window.');
      }
      session.targetLabel = targetLabel;
    }
    this.broadcastControl(session);
  }

  private handleControlRequest(socket: AuthedSocket, roomId: string): void {
    if (!roomId || !this.isRoomMember(socket.data.userId, roomId)) {
      this.controlError(socket, roomId, 'You are not a member of this room');
      return;
    }
    const session = this.controlSessions.get(roomId);
    if (!session || !session.enabled) {
      this.controlError(socket, roomId, 'The host has not enabled remote control');
      return;
    }
    if (session.hostUserId === socket.data.userId) {
      this.controlError(socket, roomId, 'The host already has local control');
      return;
    }
    if (session.controllerId === socket.data.userId) {
      this.controlError(socket, roomId, 'You already have control');
      return;
    }
    if (session.queue.includes(socket.data.userId)) {
      this.send(socket, { t: 'control.state', session: this.controlView(roomId) });
      return;
    }
    if (session.queue.length >= CONTROL_MAX_QUEUE) {
      this.controlError(socket, roomId, `The control queue is full (${CONTROL_MAX_QUEUE})`);
      return;
    }
    session.queue.push(socket.data.userId);
    this.broadcastControl(session);
  }

  private handleControlCancel(socket: AuthedSocket, roomId: string): void {
    const session = this.controlSessions.get(roomId);
    if (!session) return;
    const index = session.queue.indexOf(socket.data.userId);
    if (index === -1) return;
    session.queue.splice(index, 1);
    this.broadcastControl(session);
  }

  private handleControlReject(
    socket: AuthedSocket,
    event: Extract<ClientEvent, { t: 'control.reject' }>,
  ): void {
    const session = this.controlHost(socket, String(event.roomId ?? ''));
    if (!session) return;
    const targetId = String(event.userId ?? '');
    const index = session.queue.indexOf(targetId);
    if (index === -1) {
      this.controlError(socket, session.roomId, 'That request is no longer in the queue');
      return;
    }
    session.queue.splice(index, 1);
    this.broadcastControl(session);
  }

  private handleControlApprove(
    socket: AuthedSocket,
    event: Extract<ClientEvent, { t: 'control.approve' }>,
  ): void {
    const session = this.controlHost(socket, String(event.roomId ?? ''));
    if (!session) return;
    const targetId = String(event.userId ?? '');
    if (!targetId || targetId.length > 64 || targetId === session.hostUserId) {
      this.controlError(socket, session.roomId, 'Choose another player to control the game');
      return;
    }
    if (!this.isRoomMember(targetId, session.roomId)) {
      this.controlError(socket, session.roomId, 'That player is not in this room');
      return;
    }
    if (!this.sockets.get(targetId)?.size) {
      this.controlError(socket, session.roomId, 'That player is offline');
      return;
    }

    const target = this.streamParticipant(targetId);
    // Handoff is explicit: an existing grant is revoked before the next one.
    if (session.controllerId && session.controllerId !== targetId) {
      this.dropGrant(session, `${target.displayName} was given control by the host.`);
    }
    session.queue = session.queue.filter((userId) => userId !== targetId);

    const grant: ControlGrantView = {
      roomId: session.roomId,
      grantId: crypto.randomUUID(),
      token: randomToken(),
      hostUserId: session.hostUserId,
      controller: target,
      targetLabel: session.targetLabel ?? 'The shared window',
      expiresAt: Date.now() + CONTROL_GRANT_TTL_MS,
    };
    session.controllerId = targetId;
    session.grantId = grant.grantId;
    session.token = grant.token;
    session.grantExpiresAt = grant.expiresAt;
    session.controllerActive = false;
    session.since = Date.now();

    this.send(socket, { t: 'control.granted', grant });
    this.sendTo(targetId, { t: 'control.granted', grant });
    this.broadcastControl(session);
  }

  private handleControlRevoke(socket: AuthedSocket, roomId: string): void {
    const session = this.controlHost(socket, roomId);
    if (!session) return;
    if (!session.controllerId) {
      this.controlError(socket, roomId, 'Nobody is controlling the game right now');
      return;
    }
    this.dropGrant(session, 'The host revoked control.');
  }

  private handleControlRelease(socket: AuthedSocket, roomId: string): void {
    if (!roomId || roomId.length > 64) {
      this.controlError(socket, undefined, 'Unknown room');
      return;
    }
    const session = this.controlSessions.get(roomId);
    if (!session || session.controllerId !== socket.data.userId) {
      this.controlError(socket, roomId, 'You do not have control');
      return;
    }
    this.dropGrant(session, 'The controller released control.');
  }

  private handleControlActive(
    socket: AuthedSocket,
    event: Extract<ClientEvent, { t: 'control.active' }>,
  ): void {
    const session = this.controlHost(socket, String(event.roomId ?? ''));
    if (!session) return;
    if (!session.grantId || !session.controllerId) return;
    if (String(event.grantId ?? '') !== session.grantId) {
      this.controlError(socket, session.roomId, 'That control grant is no longer active');
      return;
    }
    session.controllerActive = event.active === true;
    this.broadcastControl(session);
  }

  private handleControlSync(socket: AuthedSocket, roomId: string): void {
    if (!roomId || !this.isRoomMember(socket.data.userId, roomId)) {
      this.controlError(socket, roomId, 'You are not a member of this room');
      return;
    }
    this.send(socket, { t: 'control.state', session: this.controlView(roomId) });
  }

  /**
   * Control SDP/ICE is relayed only between the host and the controller named by
   * the current, unexpired grant. The input itself never touches this service.
   */
  private handleControlSignal(
    socket: AuthedSocket,
    event: Extract<
      ClientEvent,
      { t: 'control.offer' | 'control.answer' | 'control.ice' }
    >,
  ): void {
    const now = Date.now();
    socket.data.controlRecent = socket.data.controlRecent.filter(
      (stamp) => now - stamp < CONTROL_SIGNAL_WINDOW_MS,
    );
    if (socket.data.controlRecent.length >= CONTROL_SIGNAL_BURST) {
      this.controlError(
        socket,
        String(event.roomId ?? ''),
        'Control signalling is too fast; slow down',
      );
      return;
    }

    const roomId = String(event.roomId ?? '');
    const to = String(event.to ?? '');
    const grantId = String(event.grantId ?? '');
    if (
      !roomId ||
      roomId.length > 64 ||
      !to ||
      to.length > 64 ||
      to === socket.data.userId ||
      !grantId ||
      grantId.length > 64
    ) {
      this.controlError(socket, roomId || undefined, 'Invalid control target');
      return;
    }

    const session = this.controlSessions.get(roomId);
    if (!session || !session.controllerId || !session.grantId) {
      this.controlError(socket, roomId, 'No control session is active');
      return;
    }
    if (session.revoked.includes(grantId) || grantId !== session.grantId) {
      this.controlError(socket, roomId, 'That control grant is stale');
      return;
    }
    if (session.grantExpiresAt !== null && session.grantExpiresAt < now) {
      this.dropGrant(session, 'The control grant expired.');
      return;
    }

    const isHost =
      session.hostUserId === socket.data.userId &&
      session.hostSocketId === socket.data.socketId;
    const isController = session.controllerId === socket.data.userId;
    if (!isHost && !isController) {
      this.controlError(socket, roomId, 'You are not part of this control session');
      return;
    }
    if (isHost) {
      if (to !== session.controllerId) {
        this.controlError(socket, roomId, 'Signalling must go to the current controller');
        return;
      }
      if (event.t === 'control.offer') {
        this.controlError(socket, roomId, 'The controller offers the input channel');
        return;
      }
    } else {
      if (to !== session.hostUserId) {
        this.controlError(socket, roomId, 'Signalling must go to the host');
        return;
      }
      if (event.t === 'control.answer') {
        this.controlError(socket, roomId, 'The host answers the input channel');
        return;
      }
    }

    if (event.t === 'control.ice') {
      const candidate = event.candidate as VoiceIceCandidate | undefined;
      if (
        !candidate ||
        typeof candidate.candidate !== 'string' ||
        candidate.candidate.length > CONTROL_MAX_CANDIDATE_LENGTH ||
        (candidate.sdpMid != null && typeof candidate.sdpMid !== 'string') ||
        (candidate.sdpMLineIndex != null && typeof candidate.sdpMLineIndex !== 'number')
      ) {
        this.controlError(socket, roomId, 'Invalid ICE candidate');
        return;
      }
      socket.data.controlRecent.push(now);
      this.sendTo(to, {
        t: 'control.ice',
        roomId,
        from: socket.data.userId,
        grantId,
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          usernameFragment: candidate.usernameFragment ?? null,
        },
      });
      return;
    }

    const sdp = event.sdp;
    if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > CONTROL_MAX_SDP_LENGTH) {
      this.controlError(socket, roomId, 'Invalid session description');
      return;
    }
    socket.data.controlRecent.push(now);
    this.sendTo(to, { t: event.t, roomId, from: socket.data.userId, grantId, sdp });
  }

  /* ---- Presence -------------------------------------------------------- */

  presenceOf(userId: string): Presence {
    const sockets = this.sockets.get(userId);
    if (!sockets || sockets.size === 0) return 'offline';
    for (const socket of sockets) {
      if (socket.data.presence === 'online') return 'online';
    }
    return 'idle';
  }

  presenceMapFor(userId: string): Record<string, Presence> {
    const map: Record<string, Presence> = {};
    for (const id of this.audienceFor(userId)) map[id] = this.presenceOf(id);
    return map;
  }

  /** Friends plus everyone sharing a room: the only people a client may see. */
  private audienceFor(userId: string): Set<string> {
    const ids = new Set<string>([userId]);
    const friends = this.db
      .query(
        `SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id
         FROM friend_links WHERE user_a = ? OR user_b = ?`,
      )
      .all(userId, userId, userId) as Array<{ id: string }>;
    for (const row of friends) ids.add(row.id);

    const mates = this.db
      .query(
        `SELECT DISTINCT other.user_id AS id
         FROM room_members mine
         JOIN room_members other ON other.room_id = mine.room_id
         WHERE mine.user_id = ?`,
      )
      .all(userId) as Array<{ id: string }>;
    for (const row of mates) ids.add(row.id);
    return ids;
  }

  /* ---- Sockets --------------------------------------------------------- */

  onOpen(socket: AuthedSocket): void {
    const existing = this.sockets.get(socket.data.userId) ?? new Set<AuthedSocket>();
    existing.add(socket);
    this.sockets.set(socket.data.userId, existing);

    const row = this.db.query('SELECT * FROM users WHERE id = ?').get(socket.data.userId) as UserRow;
    this.send(socket, {
      t: 'ready',
      user: asUser(row),
      presence: this.presenceMapFor(socket.data.userId),
    });
    this.broadcastPresence(socket.data.userId);
  }

  onClose(socket: AuthedSocket): void {
    // Video is live state too: a dead host ends the stream for every viewer,
    // and a dead viewer must not keep consuming the host's upload.
    for (const [roomId, session] of [...this.streams]) {
      if (
        session.hostUserId === socket.data.userId &&
        session.hostSocketId === socket.data.socketId
      ) {
        this.endStream(roomId, 'The host disconnected');
        continue;
      }
      const viewer = session.viewers.get(socket.data.userId);
      if (viewer && viewer.socketId === socket.data.socketId) {
        session.viewers.delete(socket.data.userId);
        this.broadcastStreamViewers(session);
        this.sendTo(session.hostUserId, {
          t: 'stream.viewer.left',
          roomId,
          userId: socket.data.userId,
        });
      }
    }

    // Voice is live state: a closed socket must never leave a ghost participant.
    for (const [roomId, members] of [...this.voiceRooms]) {
      const member = members.get(socket.data.userId);
      if (member && member.socketId === socket.data.socketId) {
        this.removeVoiceMember(roomId, socket.data.userId);
      }
    }

    const set = this.sockets.get(socket.data.userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.sockets.delete(socket.data.userId);

    // A controller who is fully gone cannot keep a grant, and an offline
    // request cannot be approved meaningfully.
    const stillConnected = (this.sockets.get(socket.data.userId)?.size ?? 0) > 0;
    if (!stillConnected) {
      for (const session of [...this.controlSessions.values()]) {
        if (session.controllerId === socket.data.userId) {
          this.dropGrant(session, 'The controller disconnected.');
        }
        const index = session.queue.indexOf(socket.data.userId);
        if (index !== -1) {
          session.queue.splice(index, 1);
          this.broadcastControl(session);
        }
      }
    }

    this.broadcastPresence(socket.data.userId);
  }

  onMessage(socket: AuthedSocket, raw: string | Buffer): void {
    let event: ClientEvent;
    try {
      event = JSON.parse(String(raw)) as ClientEvent;
    } catch {
      this.send(socket, { t: 'error', message: 'Malformed event' });
      return;
    }

    switch (event.t) {
      case 'ping':
        this.send(socket, { t: 'pong', ts: event.ts });
        return;
      case 'presence.set': {
        if (!isValidPresence(event.presence)) {
          this.send(socket, { t: 'error', message: 'Unsupported presence value' });
          return;
        }
        socket.data.presence = event.presence;
        this.broadcastPresence(socket.data.userId);
        return;
      }
      case 'message.send':
        this.handleSend(socket, event);
        return;
      case 'voice.join':
        this.handleVoiceJoin(socket, String(event.roomId ?? ''));
        return;
      case 'voice.leave':
        this.handleVoiceLeave(socket, String(event.roomId ?? ''));
        return;
      case 'voice.state':
        this.handleVoiceState(socket, event);
        return;
      case 'voice.offer':
      case 'voice.answer':
      case 'voice.ice':
        this.handleVoiceSignal(socket, event);
        return;
      case 'stream.start':
        this.handleStreamStart(socket, event);
        return;
      case 'stream.stop':
        this.handleStreamStop(socket, String(event.roomId ?? ''));
        return;
      case 'stream.watch':
        this.handleStreamWatch(socket, String(event.roomId ?? ''));
        return;
      case 'stream.unwatch':
        this.handleStreamUnwatch(socket, String(event.roomId ?? ''));
        return;
      case 'stream.preset':
        this.handleStreamPreset(socket, String(event.roomId ?? ''), event.preset);
        return;
      case 'stream.sync':
        this.handleStreamSync(socket, String(event.roomId ?? ''));
        return;
      case 'stream.offer':
      case 'stream.answer':
      case 'stream.ice':
        this.handleStreamSignal(socket, event);
        return;
      case 'control.enable':
        this.handleControlEnable(socket, event);
        return;
      case 'control.request':
        this.handleControlRequest(socket, String(event.roomId ?? ''));
        return;
      case 'control.cancel':
        this.handleControlCancel(socket, String(event.roomId ?? ''));
        return;
      case 'control.approve':
        this.handleControlApprove(socket, event);
        return;
      case 'control.reject':
        this.handleControlReject(socket, event);
        return;
      case 'control.revoke':
        this.handleControlRevoke(socket, String(event.roomId ?? ''));
        return;
      case 'control.release':
        this.handleControlRelease(socket, String(event.roomId ?? ''));
        return;
      case 'control.active':
        this.handleControlActive(socket, event);
        return;
      case 'control.sync':
        this.handleControlSync(socket, String(event.roomId ?? ''));
        return;
      case 'control.offer':
      case 'control.answer':
      case 'control.ice':
        this.handleControlSignal(socket, event);
        return;
      default:
        this.send(socket, { t: 'error', message: 'Unknown event' });
    }
  }

  private handleSend(
    socket: AuthedSocket,
    event: Extract<ClientEvent, { t: 'message.send' }>,
  ): void {
    const now = Date.now();
    socket.data.recent = socket.data.recent.filter((stamp) => now - stamp < MESSAGE_WINDOW_MS);
    if (socket.data.recent.length >= MESSAGE_BURST) {
      this.send(socket, { t: 'message.error', clientId: event.clientId, error: 'Slow down a moment' });
      return;
    }

    const body = String(event.body ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!body) {
      this.send(socket, { t: 'message.error', clientId: event.clientId, error: 'Message is empty' });
      return;
    }
    if (event.scopeType !== 'room' && event.scopeType !== 'dm') {
      this.send(socket, { t: 'message.error', clientId: event.clientId, error: 'Unknown scope' });
      return;
    }
    if (!this.canRead(socket.data.userId, event.scopeType, event.scopeId)) {
      this.send(socket, { t: 'message.error', clientId: event.clientId, error: 'No access to this conversation' });
      return;
    }

    const author = this.db.query('SELECT * FROM users WHERE id = ?').get(socket.data.userId) as UserRow;
    const message: MessageRow = {
      id: crypto.randomUUID(),
      scope_type: event.scopeType,
      scope_id: event.scopeId,
      author_id: author.id,
      body,
      created_at: now,
    };
    this.db
      .query('INSERT INTO messages (id, scope_type, scope_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(message.id, message.scope_type, message.scope_id, message.author_id, message.body, message.created_at);
    socket.data.recent.push(now);

    if (event.scopeType === 'room') {
      this.db.query('UPDATE rooms SET last_active_at = ? WHERE id = ?').run(now, event.scopeId);
    }

    const view: MessageView = {
      id: message.id,
      scopeType: event.scopeType,
      scopeId: event.scopeId,
      authorId: message.author_id,
      authorName: author.display_name,
      authorAvatarColor: author.avatar_color,
      body: message.body,
      createdAt: message.created_at,
    };

    this.send(socket, { t: 'message.ack', clientId: event.clientId, message: view });

    const audience =
      event.scopeType === 'room' ? this.roomAudience(event.scopeId) : this.conversationAudience(event.scopeId);
    for (const userId of audience) {
      if (userId === socket.data.userId) continue;
      this.sendTo(userId, { t: 'message.new', message: view });
    }
  }

  private roomAudience(roomId: string): string[] {
    return (
      this.db.query('SELECT user_id FROM room_members WHERE room_id = ?').all(roomId) as Array<{
        user_id: string;
      }>
    ).map((row) => row.user_id);
  }

  private conversationAudience(conversationId: string): string[] {
    const row = this.db
      .query('SELECT member_a, member_b FROM dm_conversations WHERE id = ?')
      .get(conversationId) as { member_a: string; member_b: string } | null;
    return row ? [row.member_a, row.member_b] : [];
  }

  private broadcastPresence(userId: string): void {
    const event: ServerEvent = {
      t: 'presence.update',
      userId,
      presence: this.presenceOf(userId),
    };
    for (const id of this.audienceFor(userId)) this.sendTo(id, event);
  }

  private broadcastToRoom(roomId: string, event: ServerEvent, excludeUserId?: string): void {
    for (const userId of this.roomAudience(roomId)) {
      if (userId === excludeUserId) continue;
      this.sendTo(userId, event);
    }
  }

  private sendTo(userId: string, event: ServerEvent): void {
    const sockets = this.sockets.get(userId);
    if (!sockets) return;
    for (const socket of sockets) this.send(socket, event);
  }

  private send(socket: AuthedSocket, event: ServerEvent): void {
    try {
      socket.send(JSON.stringify(event));
    } catch {
      // A socket that died between heartbeat and send is cleaned up on close.
    }
  }
}

export { SignalingService as MeldriftService };
export { normalizeUsername };
