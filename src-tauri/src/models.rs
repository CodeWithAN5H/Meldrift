use serde::{Deserialize, Serialize};

/// Every field is camelCase on the wire so the React layer never translates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub display_name: String,
    pub handle: String,
    pub avatar_color: String,
    pub bio: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub game_title: Option<String>,
    pub invite_code: String,
    pub is_owned: bool,
    pub created_at: i64,
    pub last_active_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Friend {
    pub id: String,
    pub display_name: String,
    pub handle: String,
    pub presence: String,
    pub note: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: String,
    pub title: String,
    pub exe_path: String,
    pub accent: String,
    pub last_played_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub scope_type: String,
    pub scope_id: String,
    pub author_id: String,
    pub author_name: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub profile: Option<Profile>,
    pub settings: serde_json::Value,
    pub rooms: Vec<Room>,
    pub friends: Vec<Friend>,
    pub games: Vec<Game>,
    pub messages: Vec<Message>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub runtime: String,
}
