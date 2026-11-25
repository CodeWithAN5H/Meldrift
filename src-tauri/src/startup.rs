//! Startup diagnostics.
//!
//! The main window is created hidden so the user never sees a white flash
//! before the dark interface paints. That means a launch that never reaches the
//! page-load hook leaves a running process with no visible window. These log
//! lines are written next to the database so a stuck or failed launch can be
//! diagnosed from disk instead of guessed at. Nothing sensitive is logged: no
//! tokens, profile data or session contents.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
const MAX_BYTES: u64 = 64 * 1024;

/// Points the diagnostics at the directory the app actually uses. Called once
/// the data directory is known; later calls are ignored.
pub fn init(dir: &std::path::Path) {
    let path = dir.join("meldrift-startup.log");
    if LOG_PATH.set(path.clone()).is_ok() {
        // Keep the log useful but bounded across launches.
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > MAX_BYTES {
                let _ = std::fs::remove_file(&path);
            }
        }
        log("process started");
    }
}

/// Appends one timestamped line. Never panics; diagnostics must not become a
/// new startup failure.
pub fn log(message: &str) {
    let Some(path) = LOG_PATH.get() else { return };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{stamp} {message}");
    }
}
