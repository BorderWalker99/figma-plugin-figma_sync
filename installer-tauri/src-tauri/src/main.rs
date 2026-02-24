// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_project_root,
            commands::select_project_root,
            commands::get_macos_version,
            commands::check_homebrew,
            commands::check_node,
            commands::check_imagemagick,
            commands::check_ffmpeg,
            commands::check_gifsicle,
            commands::check_icloud_space,
            commands::enable_anywhere,
            commands::install_all_dependencies,
            commands::install_dependencies,
            commands::setup_config,
            commands::start_server,
            commands::copy_to_clipboard,
            commands::setup_autostart,
            commands::setup_icloud_keep_downloaded,
            commands::get_home_dir,
            commands::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
