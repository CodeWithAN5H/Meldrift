import type { Database } from 'bun:sqlite';
import type { Server, ServerWebSocket } from 'bun';
import {
  MAX_MESSAGE_LENGTH,
  PROTOCOL_VERSION,
  isValidPresence,
  normalizeUsername,
  type BootstrapView,
  type ClientEvent,
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
} from '../../shared/protocol';
import { AuthError, createSession, hashPassword, revokeSession, toPublicUser, tokenFromRequest, userForToken, validateCredentials, verifyPassword } from './auth';
import { makeInviteCode, openDatabase, orderedPair, type MessageRow, type RoomRow, type UserRow } from './db';

export interface SocketData {
  userId: string;
  presence: 'online' | 'idle';
  /** Timestamps of recent messages, used for a light flood guard. */
  recent: number[];
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
}

function asUser(row: UserRow): PublicUser {
  return toPublicUser(row);
}

export class SignalingService {
  readonly db: Database;
  private sockets = new Map<string, Set<AuthedSocket>>();
  private authAttempts = new Map<string, { count: number; resetAt: number }>();

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
        data: { userId: user.id, presence: 'online', recent: [] },
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
      return this.json({ ok: true, protocol: PROTOCOL_VERSION, name: 'meldrift-signaling' }, 200, origin);
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
    if (method === 'POST' && path === '/api/rooms') {
      return this.createRoom(request, user, origin);
    }
    if (method === 'POST' && path === '/api/rooms/join') {
      return this.joinRoom(request, user, origin);
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
    const set = this.sockets.get(socket.data.userId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.sockets.delete(socket.data.userId);
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

  private broadcastToRoom(roomId: string, event: ServerEvent): void {
    for (const userId of this.roomAudience(roomId)) this.sendTo(userId, event);
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
