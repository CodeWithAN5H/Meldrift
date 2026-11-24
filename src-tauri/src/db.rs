use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

/// Owns the single SQLite connection. All access is serialised through the
/// mutex because the UI is the only writer and queries are milliseconds long.
pub struct Db {
    pub conn: Mutex<Connection>,
    pub path: String,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|error| error.to_string())?;
        configure(&conn)?;
        migrate(&conn).map_err(|error| error.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: path.display().to_string(),
        })
    }

    #[cfg(test)]
    pub fn memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|error| error.to_string())?;
        configure(&conn)?;
        migrate(&conn).map_err(|error| error.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: ":memory:".to_string(),
        })
    }
}

fn configure(conn: &Connection) -> Result<(), String> {
    // WAL keeps reads from blocking on writes; NORMAL is the right durability
    // trade-off for chat history and settings.
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.pragma_update(None, "foreign_keys", "ON");
    let _ = conn.busy_timeout(std::time::Duration::from_millis(2_500));
    Ok(())
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS profile (
            id           TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            handle       TEXT NOT NULL,
            avatar_color TEXT NOT NULL,
            bio          TEXT NOT NULL DEFAULT '',
            created_at   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            id   INTEGER PRIMARY KEY CHECK (id = 1),
            json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rooms (
            id             TEXT PRIMARY KEY,
            name           TEXT NOT NULL,
            kind           TEXT NOT NULL CHECK (kind IN ('game', 'voice')),
            game_title     TEXT,
            invite_code    TEXT NOT NULL UNIQUE,
            is_owned       INTEGER NOT NULL DEFAULT 1,
            created_at     INTEGER NOT NULL,
            last_active_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS friends (
            id           TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            handle       TEXT NOT NULL,
            presence     TEXT NOT NULL DEFAULT 'offline',
            note         TEXT NOT NULL DEFAULT '',
            created_at   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS session (
            id   INTEGER PRIMARY KEY CHECK (id = 1),
            json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS games (
            id             TEXT PRIMARY KEY,
            title          TEXT NOT NULL,
            exe_path       TEXT NOT NULL DEFAULT '',
            accent         TEXT NOT NULL DEFAULT '#7c4df2',
            last_played_at INTEGER,
            created_at     INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id          TEXT PRIMARY KEY,
            scope_type  TEXT NOT NULL CHECK (scope_type IN ('room', 'dm')),
            scope_id    TEXT NOT NULL,
            author_id   TEXT NOT NULL,
            author_name TEXT NOT NULL,
            body        TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_scope
            ON messages (scope_type, scope_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_rooms_activity
            ON rooms (last_active_at DESC);
        "#,
    )
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

const INVITE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Seven characters, ambiguity-free, generated from the OS CSPRNG when
/// available so codes are not guessable from timestamps.
pub fn make_invite_code() -> String {
    let mut bytes = [0u8; 7];
    fill_random(&mut bytes);
    bytes
        .iter()
        .map(|byte| INVITE_ALPHABET[*byte as usize % INVITE_ALPHABET.len()] as char)
        .collect()
}

#[cfg(windows)]
fn fill_random(buffer: &mut [u8]) {
    use std::ffi::c_void;
    // RtlGenRandom (SystemFunction036) is available on every supported Windows
    // version without pulling in an extra crate.
    #[link(name = "advapi32")]
    extern "system" {
        fn SystemFunction036(buffer: *mut c_void, length: u32) -> u8;
    }
    let ok = unsafe { SystemFunction036(buffer.as_mut_ptr() as *mut c_void, buffer.len() as u32) };
    if ok == 0 {
        fill_pseudo_random(buffer);
    }
}

#[cfg(not(windows))]
fn fill_random(buffer: &mut [u8]) {
    fill_pseudo_random(buffer);
}

fn fill_pseudo_random(buffer: &mut [u8]) {
    let mut seed = now_ms() as u64 ^ 0x9e37_79b9_7f4a_7c15;
    for slot in buffer.iter_mut() {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        *slot = (seed & 0xff) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_idempotent() {
        let conn = Connection::open_in_memory().expect("open");
        migrate(&conn).expect("first migration");
        migrate(&conn).expect("second migration");
    }

    #[test]
    fn invite_codes_use_the_safe_alphabet() {
        for _ in 0..200 {
            let code = make_invite_code();
            assert_eq!(code.len(), 7);
            for character in code.chars() {
                assert!(INVITE_ALPHABET.contains(&(character as u8)));
                assert!(!"O0I1".contains(character));
            }
        }
    }
}
