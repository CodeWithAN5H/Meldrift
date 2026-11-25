mod commands;
mod control;
mod db;
mod models;
mod startup;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::Manager;

/// Set as soon as the webview reports any page. The watchdog uses it to tell a
/// slow first paint from a launch that will never produce a page.
static PAGE_LOADED: AtomicBool = AtomicBool::new(false);

/// How long a launch may go without any page load before the window is shown
/// anyway. A normal launch loads in well under a second.
const FALLBACK_REVEAL_AFTER: Duration = Duration::from_secs(5);

/// Reveals the real OS window that hosts a webview.
///
/// `Webview::show` only makes the embedded WebView2 controller visible; the
/// top-level window keeps its `visible: false` flag, gets no taskbar entry and
/// stays off the desktop. This deliberately takes a `Window`, not a `Webview`,
/// so the wrong call cannot compile back in.
fn reveal<R: tauri::Runtime>(window: &tauri::Window<R>) {
    // Clears the failure title the watchdog may have set before a late load.
    let _ = window.set_title("Meldrift");
    if let Err(error) = window.show() {
        startup::log(&format!("FAILED showing window: {error}"));
    }
    if let Err(error) = window.set_focus() {
        startup::log(&format!("FAILED focusing window: {error}"));
    }
    startup::log(&format!(
        "window visible after reveal: {:?}",
        window.is_visible().unwrap_or(false)
    ));
}

/// The hidden-until-paint design must never leave an invisible process behind.
fn should_reveal_anyway(page_loaded: bool, waited: Duration) -> bool {
    !page_loaded && waited >= FALLBACK_REVEAL_AFTER
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            // MELDRIFT_DATA_DIR lets a second local instance keep its own
            // session while testing multi-client behaviour on one PC.
            let data_dir = match std::env::var("MELDRIFT_DATA_DIR") {
                Ok(path) if !path.trim().is_empty() => std::path::PathBuf::from(path),
                _ => app.path().app_data_dir()?,
            };
            startup::init(&data_dir);
            startup::log(&format!("data dir: {}", data_dir.display()));
            if let Err(error) = std::fs::create_dir_all(&data_dir) {
                startup::log(&format!("FAILED creating data dir: {error}"));
                return Err(error.into());
            }
            let database = match db::Db::open(&data_dir.join("meldrift.db")) {
                Ok(database) => database,
                Err(error) => {
                    startup::log(&format!("FAILED opening database: {error}"));
                    return Err(error.into());
                }
            };
            app.manage(database);
            startup::log("database ready");
            // Input injection and the Ctrl+Alt+F12 emergency stop only exist
            // while the desktop app is running.
            control::init(app.handle());
            startup::log("control hooks ready");
            if let Some(window) = app.get_webview_window("main") {
                startup::log(&format!(
                    "main window created hidden, visible={:?}",
                    window.is_visible().unwrap_or(false)
                ));
            } else {
                startup::log("FAILED: main window missing after setup");
            }
            // Safety net: a page that never loads (broken WebView2 runtime,
            // failed asset load) must not leave a running process with no
            // visible window. This does not delay a normal launch, which
            // reveals the window from the page-load hook in milliseconds.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(FALLBACK_REVEAL_AFTER);
                if !should_reveal_anyway(PAGE_LOADED.load(Ordering::Relaxed), FALLBACK_REVEAL_AFTER) {
                    return;
                }
                startup::log("no page load after 5s; revealing window anyway");
                let inner = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Some(window) = inner.get_webview_window("main") {
                        // The window frame is visible even if the page is not,
                        // so say what went wrong instead of showing a blank
                        // frame that looks like a hang.
                        let _ = window.set_title("Meldrift — failed to load interface (see startup log)");
                        reveal(&window.as_ref().window());
                    }
                });
            });
            Ok(())
        })
        // The window is created hidden so the user never sees a white flash
        // before the dark interface paints.
        .on_page_load(|webview, payload| {
            startup::log(&format!(
                "page load {:?}: {}",
                payload.event(),
                payload.url()
            ));
            PAGE_LOADED.store(true, Ordering::Relaxed);
            reveal(&webview.window());
        })
        // A closing window must never leave a remotely held key down.
        .on_window_event(|_window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                control::shutdown();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::app_info,
            commands::load_session,
            commands::save_session,
            commands::save_profile,
            commands::save_settings,
            commands::create_room,
            commands::update_room,
            commands::delete_room,
            commands::list_messages,
            commands::send_message,
            commands::add_friend,
            commands::update_friend,
            commands::remove_friend,
            commands::add_game,
            commands::touch_game,
            commands::remove_game,
            commands::clear_workspace,
            control::control_targets,
            control::control_arm,
            control::control_end,
            control::control_inject,
            control::control_armed,
            control::control_resume,
        ])
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            startup::log(&format!("FATAL: failed to build the app: {error}"));
            panic!("Meldrift failed to start: {error}");
        }
    };

    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            control::shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watchdog_leaves_a_loaded_window_alone() {
        assert!(!should_reveal_anyway(true, FALLBACK_REVEAL_AFTER));
        assert!(!should_reveal_anyway(true, Duration::from_secs(60)));
    }

    #[test]
    fn watchdog_waits_for_the_timeout_before_revealing() {
        assert!(!should_reveal_anyway(false, Duration::from_millis(4999)));
        assert!(should_reveal_anyway(false, FALLBACK_REVEAL_AFTER));
    }
}
