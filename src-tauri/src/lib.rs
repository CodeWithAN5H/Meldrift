mod commands;
mod control;
mod db;
mod models;

use tauri::Manager;

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            // MELDRIFT_DATA_DIR lets a second local instance keep its own
            // session while testing multi-client behaviour on one PC.
            let data_dir = match std::env::var("MELDRIFT_DATA_DIR") {
                Ok(path) if !path.trim().is_empty() => std::path::PathBuf::from(path),
                _ => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data_dir)?;
            let database = db::Db::open(&data_dir.join("meldrift.db"))?;
            app.manage(database);
            // Input injection and the Ctrl+Alt+F12 emergency stop only exist
            // while the desktop app is running.
            control::init(app.handle());
            Ok(())
        })
        // The window is created hidden so the user never sees a white flash
        // before the dark interface paints.
        .on_page_load(|window, _payload| {
            let _ = window.show();
            let _ = window.set_focus();
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
        .build(tauri::generate_context!())
        .expect("Meldrift failed to start");

    app.run(|_app, event| {
        if let tauri::RunEvent::Exit = event {
            control::shutdown();
        }
    });
}
