mod commands;
mod db;
mod models;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let database = db::Db::open(&data_dir.join("meldrift.db"))?;
            app.manage(database);
            Ok(())
        })
        // The window is created hidden so the user never sees a white flash
        // before the dark interface paints.
        .on_page_load(|window, _payload| {
            let _ = window.show();
            let _ = window.set_focus();
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
        ])
        .run(tauri::generate_context!())
        .expect("Meldrift failed to start");
}
