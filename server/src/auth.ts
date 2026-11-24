import type { Database } from 'bun:sqlite';
import { MIN_PASSWORD_LENGTH, normalizeUsername, isValidUsername } from '../../shared/protocol';
import type { PublicUser } from '../../shared/protocol';
import { makeToken, type UserRow } from './db';

/* --------------------------------------------------------------------------
   Identity: argon2id password hashes (Bun's built-in), opaque 256-bit session
   tokens stored hashed-at-rest? — tokens are stored as-is so they can be
   looked up, but they never leave the server except to the owning client.

   Tokens are bearer credentials: serve the service behind HTTPS when it is
   reachable beyond localhost.
   -------------------------------------------------------------------------- */

export interface AuthedUser extends PublicUser {}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
  };
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

export function validateCredentials(username: string, password: string): void {
  if (!isValidUsername(username)) {
    throw new AuthError('Username must be 3-24 letters, numbers or underscores.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 200) {
    throw new AuthError('Password is too long.');
  }
}

export function createSession(db: Database, userId: string): string {
  const token = makeToken();
  const now = Date.now();
  db.query('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    now,
    now,
  );
  return token;
}

export function userForToken(db: Database, token: string | null): AuthedUser | null {
  if (!token) return null;
  const row = db
    .query(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token = ?`,
    )
    .get(token) as UserRow | null;
  if (!row) return null;
  db.query('UPDATE sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token);
  return toPublicUser(row);
}

export function tokenFromRequest(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null;
  }
  const url = new URL(request.url);
  return url.searchParams.get('token');
}

export function revokeSession(db: Database, token: string): void {
  db.query('DELETE FROM sessions WHERE token = ?').run(token);
}

export function normalizeHandle(value: string): string {
  return normalizeUsername(value);
}
