import { Database } from 'bun:sqlite';

/* --------------------------------------------------------------------------
   Server persistence. One SQLite file, WAL enabled, prepared statements cached
   by bun:sqlite. All timestamps are Unix milliseconds.
   -------------------------------------------------------------------------- */

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  password_hash: string;
  created_at: number;
}

export interface RoomRow {
  id: string;
  name: string;
  kind: string;
  game_title: string | null;
  invite_code: string;
  owner_id: string;
  created_at: number;
  last_active_at: number;
}

export interface MessageRow {
  id: string;
  scope_type: string;
  scope_id: string;
  author_id: string;
  body: string;
  created_at: number;
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeInviteCode(): string {
  const bytes = new Uint8Array(7);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  return out;
}

export function makeToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 3000;');
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name  TEXT NOT NULL,
      avatar_color  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      kind           TEXT NOT NULL CHECK (kind IN ('game','voice')),
      game_title     TEXT,
      invite_code    TEXT NOT NULL UNIQUE,
      owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at     INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role      TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('room','dm')),
      scope_id   TEXT NOT NULL,
      author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_scope
      ON messages (scope_type, scope_id, created_at);

    CREATE TABLE IF NOT EXISTS dm_conversations (
      id         TEXT PRIMARY KEY,
      member_a   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      member_b   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE (member_a, member_b)
    );

    CREATE TABLE IF NOT EXISTS friend_links (
      user_a       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status       TEXT NOT NULL CHECK (status IN ('pending','accepted')),
      requested_by TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (user_a, user_b)
    );
  `);
}

/** Friend links are stored once per pair, ordered, so both directions agree. */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
