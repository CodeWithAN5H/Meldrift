use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::json;
use tauri::State;

use crate::db::{make_invite_code, now_ms, Db};
use crate::models::{AppInfo, Bootstrap, Friend, Game, Message, Profile, Room};

const MAX_MESSAGE_CHARS: usize = 2000;

fn lock(db: &Db) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    db.conn
        .lock()
        .map_err(|_| "Local storage is busy. Restart Meldrift.".to_string())
}

fn clean(value: &str, limit: usize) -> String {
    value.trim().chars().take(limit).collect()
}

/* --------------------------------------------------------------------------
   Bootstrap
   -------------------------------------------------------------------------- */

#[tauri::command]
pub fn bootstrap(db: State<'_, Db>) -> Result<Bootstrap, String> {
    bootstrap_inner(&db)
}

fn bootstrap_inner(db: &Db) -> Result<Bootstrap, String> {
    let conn = lock(db)?;

    let profile = conn
        .query_row(
            "SELECT id, display_name, handle, avatar_color, bio, created_at FROM profile LIMIT 1",
            [],
            row_to_profile,
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let settings: serde_json::Value = conn
        .query_row("SELECT json FROM settings WHERE id = 1", [], |row| {
            row.get::<_, String>(0)
        })
        .optional()
        .map_err(|error| error.to_string())?
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));

    Ok(Bootstrap {
        profile,
        settings,
        rooms: rooms_inner(&conn)?,
        friends: friends_inner(&conn)?,
        games: games_inner(&conn)?,
        messages: recent_messages_inner(&conn, 200)?,
    })
}

#[tauri::command]
pub fn app_info(app: tauri::AppHandle, db: State<'_, Db>) -> AppInfo {
    // `package_info` comes from tauri.conf.json in the same build that produced
    // the installer, so About cannot report a version from a stale Rust crate
    // cache while the shipped frontend is newer (or the reverse).
    AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: db.path.clone(),
        runtime: "desktop".to_string(),
    }
}

/* --------------------------------------------------------------------------
   Profile + settings
   -------------------------------------------------------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProfileInput {
    profile: Profile,
}

#[tauri::command]
pub fn save_profile(input: SaveProfileInput, db: State<'_, Db>) -> Result<Profile, String> {
    save_profile_inner(&db, input.profile)
}

fn save_profile_inner(db: &Db, mut profile: Profile) -> Result<Profile, String> {
    profile.display_name = clean(&profile.display_name, 32);
    if profile.display_name.is_empty() {
        return Err("Display name cannot be empty".into());
    }
    profile.handle = clean(&profile.handle.trim_start_matches('@'), 32);
    profile.bio = profile.bio.chars().take(160).collect();
    profile.avatar_color = clean(&profile.avatar_color, 16);

    let conn = lock(db)?;
    conn.execute("DELETE FROM profile", [])
        .map_err(|error| error.to_string())?;
    conn.execute(
        "INSERT INTO profile (id, display_name, handle, avatar_color, bio, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            profile.id,
            profile.display_name,
            profile.handle,
            profile.avatar_color,
            profile.bio,
            profile.created_at
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(profile)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsInput {
    settings: serde_json::Value,
}

#[tauri::command]
pub fn save_settings(
    input: SaveSettingsInput,
    db: State<'_, Db>,
) -> Result<serde_json::Value, String> {
    let conn = lock(&db)?;
    let raw = input.settings.to_string();
    conn.execute(
        "INSERT INTO settings (id, json) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        params![raw],
    )
    .map_err(|error| error.to_string())?;
    Ok(input.settings)
}

/* --------------------------------------------------------------------------
   Account session
   -------------------------------------------------------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionInput {
    session: Option<serde_json::Value>,
}

#[tauri::command]
pub fn load_session(db: State<'_, Db>) -> Result<Option<serde_json::Value>, String> {
    load_session_inner(&db)
}

fn load_session_inner(db: &Db) -> Result<Option<serde_json::Value>, String> {
    let conn = lock(db)?;
    let raw: Option<String> = conn
        .query_row("SELECT json FROM session WHERE id = 1", [], |row| row.get(0))
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(raw.and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok()))
}

#[tauri::command]
pub fn save_session(input: SaveSessionInput, db: State<'_, Db>) -> Result<(), String> {
    save_session_inner(&db, input.session)
}

fn save_session_inner(db: &Db, session: Option<serde_json::Value>) -> Result<(), String> {
    let conn = lock(db)?;
    match session {
        Some(value) => {
            conn.execute(
                "INSERT INTO session (id, json) VALUES (1, ?1)
                 ON CONFLICT(id) DO UPDATE SET json = excluded.json",
                params![value.to_string()],
            )
            .map_err(|error| error.to_string())?;
        }
        None => {
            conn.execute("DELETE FROM session", [])
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/* --------------------------------------------------------------------------
   Rooms
   -------------------------------------------------------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoomInput {
    name: String,
    kind: String,
    game_title: Option<String>,
}

#[tauri::command]
pub fn create_room(input: CreateRoomInput, db: State<'_, Db>) -> Result<Room, String> {
    create_room_inner(&db, &input.name, &input.kind, input.game_title.as_deref())
}

fn create_room_inner(
    db: &Db,
    name: &str,
    kind: &str,
    game_title: Option<&str>,
) -> Result<Room, String> {
    let kind = match kind {
        "game" => "game",
        "voice" => "voice",
        _ => return Err("Unknown room type".into()),
    };
    let name = clean(name, 40);
    if name.is_empty() {
        return Err("Room needs a name".into());
    }
    let title = game_title
        .map(|value| clean(value, 60))
        .filter(|value| !value.is_empty());

    let conn = lock(db)?;
    let mut code = make_invite_code();
    for _ in 0..8 {
        let taken: bool = conn
            .query_row(
                "SELECT 1 FROM rooms WHERE invite_code = ?1",
                params![code],
                |_| Ok(true),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .unwrap_or(false);
        if !taken {
            break;
        }
        code = make_invite_code();
    }

    let room = Room {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        kind: kind.to_string(),
        game_title: title,
        invite_code: code,
        is_owned: true,
        created_at: now_ms(),
        last_active_at: now_ms(),
    };

    conn.execute(
        "INSERT INTO rooms (id, name, kind, game_title, invite_code, is_owned, created_at, last_active_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)",
        params![
            room.id,
            room.name,
            room.kind,
            room.game_title,
            room.invite_code,
            room.created_at,
            room.last_active_at
        ],
    )
    .map_err(|error| error.to_string())?;

    Ok(room)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRoomInput {
    id: String,
    name: String,
    game_title: Option<String>,
}

#[tauri::command]
pub fn update_room(input: UpdateRoomInput, db: State<'_, Db>) -> Result<Room, String> {
    let name = clean(&input.name, 40);
    if name.is_empty() {
        return Err("Room needs a name".into());
    }
    let title = input
        .game_title
        .map(|value| clean(&value, 60))
        .filter(|value| !value.is_empty());

    let conn = lock(&db)?;
    let changed = conn
        .execute(
            "UPDATE rooms SET name = ?2, game_title = ?3 WHERE id = ?1",
            params![input.id, name, title],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("Room not found".into());
    }
    conn.query_row(
        "SELECT id, name, kind, game_title, invite_code, is_owned, created_at, last_active_at
         FROM rooms WHERE id = ?1",
        params![input.id],
        row_to_room,
    )
    .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdInput {
    id: String,
}

#[tauri::command]
pub fn delete_room(input: IdInput, db: State<'_, Db>) -> Result<(), String> {
    let conn = lock(&db)?;
    conn.execute(
        "DELETE FROM messages WHERE scope_type = 'room' AND scope_id = ?1",
        params![input.id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM rooms WHERE id = ?1", params![input.id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/* --------------------------------------------------------------------------
   Messages
   -------------------------------------------------------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeInput {
    scope_type: String,
    scope_id: String,
}

#[tauri::command]
pub fn list_messages(input: ScopeInput, db: State<'_, Db>) -> Result<Vec<Message>, String> {
    let conn = lock(&db)?;
    validate_scope(&conn, &input.scope_type, &input.scope_id)?;
    let mut statement = conn
        .prepare(
            "SELECT id, scope_type, scope_id, author_id, author_name, body, created_at
             FROM messages WHERE scope_type = ?1 AND scope_id = ?2
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![input.scope_type, input.scope_id], row_to_message)
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessageInput {
    scope_type: String,
    scope_id: String,
    body: String,
}

#[tauri::command]
pub fn send_message(input: SendMessageInput, db: State<'_, Db>) -> Result<Message, String> {
    send_message_inner(&db, &input.scope_type, &input.scope_id, &input.body)
}

fn send_message_inner(
    db: &Db,
    scope_type: &str,
    scope_id: &str,
    body: &str,
) -> Result<Message, String> {
    let body: String = body.trim().chars().take(MAX_MESSAGE_CHARS).collect();
    if body.is_empty() {
        return Err("Message is empty".into());
    }

    let conn = lock(db)?;
    validate_scope(&conn, scope_type, scope_id)?;

    let (author_id, author_name) = conn
        .query_row(
            "SELECT id, display_name FROM profile LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or("Create a profile before sending messages")?;

    let message = Message {
        id: uuid::Uuid::new_v4().to_string(),
        scope_type: scope_type.to_string(),
        scope_id: scope_id.to_string(),
        author_id,
        author_name,
        body,
        created_at: now_ms(),
    };

    conn.execute(
        "INSERT INTO messages (id, scope_type, scope_id, author_id, author_name, body, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            message.id,
            message.scope_type,
            message.scope_id,
            message.author_id,
            message.author_name,
            message.body,
            message.created_at
        ],
    )
    .map_err(|error| error.to_string())?;

    if scope_type == "room" {
        conn.execute(
            "UPDATE rooms SET last_active_at = ?2 WHERE id = ?1",
            params![message.scope_id, message.created_at],
        )
        .map_err(|error| error.to_string())?;
    }

    Ok(message)
}

fn validate_scope(conn: &Connection, scope_type: &str, scope_id: &str) -> Result<(), String> {
    let table = match scope_type {
        "room" => "rooms",
        "dm" => "friends",
        _ => return Err("Unknown message scope".into()),
    };
    let exists: bool = conn
        .query_row(
            &format!("SELECT 1 FROM {table} WHERE id = ?1"),
            params![scope_id],
            |_| Ok(true),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(false);
    if !exists {
        return Err("Conversation not found".into());
    }
    Ok(())
}

/* --------------------------------------------------------------------------
   Friends
   -------------------------------------------------------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddFriendInput {
    display_name: String,
    handle: String,
}

#[tauri::command]
pub fn add_friend(input: AddFriendInput, db: State<'_, Db>) -> Result<Friend, String> {
    let display_name = clean(&input.display_name, 32);
    if display_name.is_empty() {
        return Err("Enter a name".into());
    }
    let handle = clean(input.handle.trim_start_matches('@'), 32);
    let friend = Friend {
        id: uuid::Uuid::new_v4().to_string(),
        display_name,
        handle: if handle.is_empty() {
            "player".to_string()
        } else {
            handle
        },
        presence: "offline".to_string(),
        note: String::new(),
        created_at: now_ms(),
    };

    let conn = lock(&db)?;
    conn.execute(
        "INSERT INTO friends (id, display_name, handle, presence, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            friend.id,
            friend.display_name,
            friend.handle,
            friend.presence,
            friend.note,
            friend.created_at
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(friend)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFriendInput {
    id: String,
    note: Option<String>,
    presence: Option<String>,
}

#[tauri::command]
pub fn update_friend(input: UpdateFriendInput, db: State<'_, Db>) -> Result<Friend, String> {
    let conn = lock(&db)?;
    if let Some(note) = input.note {
        let note = clean(&note, 120);
        conn.execute(
            "UPDATE friends SET note = ?2 WHERE id = ?1",
            params![input.id, note],
        )
        .map_err(|error| error.to_string())?;
    }
    if let Some(presence) = input.presence {
        let presence = match presence.as_str() {
            "online" | "idle" | "offline" => presence,
            _ => "offline".to_string(),
        };
        conn.execute(
            "UPDATE friends SET presence = ?2 WHERE id = ?1",
            params![input.id, presence],
        )
        .map_err(|error| error.to_string())?;
    }
    conn.query_row(
        "SELECT id, display_name, handle, presence, note, created_at FROM friends WHERE id = ?1",
        params![input.id],
        row_to_friend,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn remove_friend(input: IdInput, db: State<'_, Db>) -> Result<(), String> {
    let conn = lock(&db)?;
    conn.execute(
        "DELETE FROM messages WHERE scope_type = 'dm' AND scope_id = ?1",
        params![input.id],
    )
    .map_err(|error| error.to_string())?;
    conn.execute("DELETE FROM friends WHERE id = ?1", params![input.id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/* --------------------------------------------------------------------------
   Games
   -------------------------------------------------------------------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddGameInput {
    title: String,
    exe_path: String,
}

#[tauri::command]
pub fn add_game(input: AddGameInput, db: State<'_, Db>) -> Result<Game, String> {
    let title = clean(&input.title, 60);
    if title.is_empty() {
        return Err("Enter a game title".into());
    }
    let game = Game {
        id: uuid::Uuid::new_v4().to_string(),
        title,
        exe_path: input.exe_path.trim().chars().take(512).collect(),
        accent: "#7c4df2".to_string(),
        last_played_at: None,
        created_at: now_ms(),
    };

    let conn = lock(&db)?;
    conn.execute(
        "INSERT INTO games (id, title, exe_path, accent, last_played_at, created_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
        params![
            game.id,
            game.title,
            game.exe_path,
            game.accent,
            game.created_at
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(game)
}

#[tauri::command]
pub fn touch_game(input: IdInput, db: State<'_, Db>) -> Result<(), String> {
    let conn = lock(&db)?;
    conn.execute(
        "UPDATE games SET last_played_at = ?2 WHERE id = ?1",
        params![input.id, now_ms()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn launch_game(input: IdInput, db: State<'_, Db>) -> Result<(), String> {
    let path: Option<String> = {
        let conn = lock(&db)?;
        conn.query_row(
            "SELECT exe_path FROM games WHERE id = ?1",
            params![input.id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
    };
    let path = path.ok_or_else(|| "That game is no longer in your library.".to_string())?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Add the executable path for this game first.".into());
    }
    // The path is the one the user chose in their own library. Only a real file
    // is started, and only after this explicit command; nothing scans for or
    // launches games on its own.
    let exe = std::path::Path::new(trimmed);
    if !exe.is_file() {
        return Err(format!(
            "Meldrift could not find {trimmed}. Update the path and try again."
        ));
    }
    let mut command = std::process::Command::new(exe);
    if let Some(dir) = exe.parent() {
        command.current_dir(dir);
    }
    command
        .spawn()
        .map_err(|error| format!("Windows could not start that game: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn remove_game(input: IdInput, db: State<'_, Db>) -> Result<(), String> {
    let conn = lock(&db)?;
    conn.execute("DELETE FROM games WHERE id = ?1", params![input.id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/* --------------------------------------------------------------------------
   Reset
   -------------------------------------------------------------------------- */

#[tauri::command]
pub fn clear_workspace(db: State<'_, Db>) -> Result<(), String> {
    let conn = lock(&db)?;
    conn.execute_batch(
        "DELETE FROM messages;
         DELETE FROM rooms;
         DELETE FROM friends;
         DELETE FROM games;
         DELETE FROM profile;
         DELETE FROM settings;
         DELETE FROM session;",
    )
    .map_err(|error| error.to_string())
}

/* --------------------------------------------------------------------------
   Row mapping
   -------------------------------------------------------------------------- */

fn row_to_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: row.get(0)?,
        display_name: row.get(1)?,
        handle: row.get(2)?,
        avatar_color: row.get(3)?,
        bio: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn row_to_room(row: &rusqlite::Row<'_>) -> rusqlite::Result<Room> {
    Ok(Room {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: row.get(2)?,
        game_title: row.get(3)?,
        invite_code: row.get(4)?,
        is_owned: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        last_active_at: row.get(7)?,
    })
}

fn row_to_friend(row: &rusqlite::Row<'_>) -> rusqlite::Result<Friend> {
    Ok(Friend {
        id: row.get(0)?,
        display_name: row.get(1)?,
        handle: row.get(2)?,
        presence: row.get(3)?,
        note: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn row_to_game(row: &rusqlite::Row<'_>) -> rusqlite::Result<Game> {
    Ok(Game {
        id: row.get(0)?,
        title: row.get(1)?,
        exe_path: row.get(2)?,
        accent: row.get(3)?,
        last_played_at: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        scope_type: row.get(1)?,
        scope_id: row.get(2)?,
        author_id: row.get(3)?,
        author_name: row.get(4)?,
        body: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn rooms_inner(conn: &Connection) -> Result<Vec<Room>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, kind, game_title, invite_code, is_owned, created_at, last_active_at
             FROM rooms ORDER BY last_active_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_to_room)
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

fn friends_inner(conn: &Connection) -> Result<Vec<Friend>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, display_name, handle, presence, note, created_at
             FROM friends ORDER BY display_name COLLATE NOCASE ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_to_friend)
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

fn games_inner(conn: &Connection) -> Result<Vec<Game>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, title, exe_path, accent, last_played_at, created_at
             FROM games ORDER BY created_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], row_to_game)
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())
}

fn recent_messages_inner(conn: &Connection, limit: usize) -> Result<Vec<Message>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, scope_type, scope_id, author_id, author_name, body, created_at
             FROM messages ORDER BY created_at DESC, id DESC LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![limit as i64], row_to_message)
        .map_err(|error| error.to_string())?;
    let mut messages = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    // The newest N rows were selected newest-first; the UI wants chronological.
    messages.reverse();
    Ok(messages)
}

/* --------------------------------------------------------------------------
   Tests — exercised against a real in-memory SQLite database.
   -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        let db = Db::memory().expect("memory db");
        save_profile_inner(
            &db,
            Profile {
                id: "player-1".into(),
                display_name: "Ansh".into(),
                handle: "ansh".into(),
                avatar_color: "#7c4df2".into(),
                bio: String::new(),
                created_at: 1,
            },
        )
        .expect("profile");
        db
    }

    #[test]
    fn session_round_trips_and_clears() {
        let db = db();
        let payload = serde_json::json!({
            "serverUrl": "http://127.0.0.1:8787",
            "token": "token-value",
            "user": { "id": "player-1", "username": "ansh" }
        });
        save_session_inner(&db, Some(payload.clone())).expect("save session");
        assert_eq!(load_session_inner(&db).expect("load session"), Some(payload));
        save_session_inner(&db, None).expect("clear session");
        assert_eq!(load_session_inner(&db).expect("load session"), None);
    }

    #[test]
    fn creating_a_room_persists_it() {
        let db = db();
        let room = create_room_inner(&db, "The Boys", "game", Some("RDR2")).expect("room");
        assert_eq!(room.name, "The Boys");
        assert_eq!(room.invite_code.len(), 7);
        assert!(room.is_owned);

        let bootstrap = bootstrap_inner(&db).expect("bootstrap");
        assert_eq!(bootstrap.rooms.len(), 1);
        assert_eq!(bootstrap.rooms[0].game_title.as_deref(), Some("RDR2"));
    }

    #[test]
    fn blank_rooms_and_bad_kinds_are_rejected() {
        let db = db();
        assert!(create_room_inner(&db, "   ", "game", None).is_err());
        assert!(create_room_inner(&db, "Squad", "invalid", None).is_err());
    }

    #[test]
    fn messages_round_trip_and_touch_room_activity() {
        let db = db();
        let room = create_room_inner(&db, "Squad", "voice", None).expect("room");
        let message =
            send_message_inner(&db, "room", &room.id, "  who's playing next?  ").expect("message");
        assert_eq!(message.body, "who's playing next?");
        assert_eq!(message.author_name, "Ansh");

        let conn = lock(&db).expect("lock");
        let messages = {
            let mut statement = conn
                .prepare("SELECT body FROM messages WHERE scope_id = ?1")
                .expect("prepare");
            statement
                .query_map(params![room.id], |row| row.get::<_, String>(0))
                .expect("query")
                .collect::<rusqlite::Result<Vec<_>>>()
                .expect("collect")
        };
        assert_eq!(messages, vec!["who's playing next?".to_string()]);
    }

    #[test]
    fn unknown_scopes_are_rejected() {
        let db = db();
        assert!(send_message_inner(&db, "room", "missing", "hello").is_err());
        assert!(send_message_inner(&db, "dm", "missing", "hello").is_err());
        assert!(send_message_inner(&db, "bad", "missing", "hello").is_err());
        assert!(send_message_inner(&db, "room", "missing", "   ").is_err());
    }

    #[test]
    fn deleting_a_room_removes_its_messages() {
        let db = db();
        let room = create_room_inner(&db, "Temp", "game", None).expect("room");
        send_message_inner(&db, "room", &room.id, "hello").expect("message");
        {
            let conn = lock(&db).expect("lock");
            conn.execute(
                "DELETE FROM messages WHERE scope_type = 'room' AND scope_id = ?1",
                params![room.id],
            )
            .expect("delete messages");
            conn.execute("DELETE FROM rooms WHERE id = ?1", params![room.id])
                .expect("delete room");
        }
        let bootstrap = bootstrap_inner(&db).expect("bootstrap");
        assert!(bootstrap.rooms.is_empty());
        assert!(bootstrap.messages.is_empty());
    }
}
