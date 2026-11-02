mod codec;
mod commands;
mod menu;
mod paths;
mod recovery;
mod service;
mod storage;
mod types;
mod watcher;

use std::{
    fs,
    path::PathBuf,
    sync::{atomic::Ordering, mpsc, Arc, Mutex},
};

use tauri::{DragDropEvent, Emitter, Manager, RunEvent, WindowEvent};

use commands::{open_paths_and_emit, request_exit, AppState};
use menu::install_menu;
use paths::startup_paths_from_args;
use service::DocumentService;
use types::MenuContextUpdate;
use watcher::{spawn_processor, FileWatcher};

const APP_COMMAND_EVENT: &str = "app-command";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths = args
                .into_iter()
                .skip(1)
                .map(PathBuf::from)
                .filter(|path| path.is_file())
                .collect::<Vec<_>>();
            open_paths_and_emit(app, &paths);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data = app.path().app_local_data_dir()?;
            fs::create_dir_all(&app_data)?;
            let service = Arc::new(Mutex::new(DocumentService::new(
                app_data.join("session.json"),
            )));
            let (watch_sender, watch_receiver) = mpsc::channel();
            let watcher = FileWatcher::new(watch_sender)?;
            spawn_processor(app.handle().clone(), service.clone(), watch_receiver);
            app.manage(AppState::new(service, watcher, startup_paths_from_args()));
            let locale = std::env::var("LANG")
                .ok()
                .filter(|locale| locale.to_ascii_lowercase().starts_with("ko"))
                .map(|_| "ko")
                .unwrap_or("en")
                .to_string();
            install_menu(
                app.handle(),
                &MenuContextUpdate {
                    locale,
                    has_document: false,
                    markdown: false,
                    view_mode: "source".into(),
                },
            )?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "quit" {
                request_exit(app);
                return;
            }
            if matches!(
                id,
                "new-text"
                    | "new-markdown"
                    | "open"
                    | "save"
                    | "save-as"
                    | "close"
                    | "undo"
                    | "redo"
                    | "find"
                    | "replace"
                    | "view-source"
                    | "view-split"
                    | "view-preview"
                    | "settings"
            ) {
                let _ = app.emit(APP_COMMAND_EVENT, id.to_string());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::new_document,
            commands::pick_and_open_documents,
            commands::open_document_paths,
            commands::set_document_kind,
            commands::save_document,
            commands::save_document_as,
            commands::force_save_document,
            commands::reload_document,
            commands::close_document,
            commands::read_local_asset,
            commands::update_recovery_document,
            commands::update_recovery_layout,
            commands::update_menu_context,
            commands::cancel_exit,
            commands::exit_pending,
            commands::complete_exit,
            commands::restore_session,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building Yet Another Notepad");

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            if !app_handle
                .state::<AppState>()
                .exit_approved
                .load(Ordering::SeqCst)
            {
                api.prevent_close();
                request_exit(app_handle);
            }
        }
        RunEvent::ExitRequested { api, .. } => {
            if !app_handle
                .state::<AppState>()
                .exit_approved
                .load(Ordering::SeqCst)
            {
                api.prevent_exit();
                request_exit(app_handle);
            }
        }
        RunEvent::WindowEvent {
            event: WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }),
            ..
        } => open_paths_and_emit(app_handle, &paths),
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let paths = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .collect::<Vec<_>>();
            open_paths_and_emit(app_handle, &paths);
        }
        _ => {}
    });
}
