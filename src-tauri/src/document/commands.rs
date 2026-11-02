use std::{
    fmt,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use super::{
    menu::install_menu,
    service::{open_paths_in, DocumentService, OpenedPaths},
    types::{
        AssetPayload, DocumentError, DocumentKind, DocumentKindUpdate, DocumentResult,
        DocumentSnapshot, MenuContextUpdate, RecoveryDocumentUpdate, RecoveryLayoutUpdate,
        RestoredDocument, RestoredSession, SaveDocumentRequest,
    },
    watcher::FileWatcher,
};

const DOCUMENTS_OPENED_EVENT: &str = "documents-opened";
const DOCUMENTS_OPEN_FAILED_EVENT: &str = "documents-open-failed";

pub(super) struct AppState {
    service: Arc<Mutex<DocumentService>>,
    watcher: Mutex<FileWatcher>,
    startup_paths: Mutex<Vec<PathBuf>>,
    exit_requested: AtomicBool,
    pub(super) exit_approved: AtomicBool,
}

impl AppState {
    pub(super) fn new(
        service: Arc<Mutex<DocumentService>>,
        watcher: FileWatcher,
        startup_paths: Vec<PathBuf>,
    ) -> Self {
        Self {
            service,
            watcher: Mutex::new(watcher),
            startup_paths: Mutex::new(startup_paths),
            exit_requested: AtomicBool::new(false),
            exit_approved: AtomicBool::new(false),
        }
    }
}

#[tauri::command]
pub(super) fn new_document(
    kind: DocumentKind,
    state: State<'_, AppState>,
) -> DocumentResult<DocumentSnapshot> {
    Ok(lock_service(&state)?.new_document(kind))
}

#[tauri::command]
pub(super) fn set_document_kind(
    document_id: String,
    kind: DocumentKind,
    state: State<'_, AppState>,
) -> DocumentResult<DocumentKindUpdate> {
    lock_service(&state)?.set_document_kind(&document_id, kind)
}

#[tauri::command]
pub(super) async fn pick_and_open_documents(
    app: AppHandle,
    state: State<'_, AppState>,
) -> DocumentResult<Vec<DocumentSnapshot>> {
    let selected = app
        .dialog()
        .file()
        .add_filter("Text and Markdown", &["txt", "md", "markdown"])
        .add_filter("All text files", &["*"])
        .blocking_pick_files();
    let Some(selected) = selected else {
        return Ok(Vec::new());
    };

    let paths = selected
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .collect::<Vec<_>>();
    open_paths(&state, &paths)?.into_result(&app)
}

#[tauri::command]
pub(super) async fn open_document_paths(
    app: AppHandle,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> DocumentResult<Vec<DocumentSnapshot>> {
    let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    open_paths(&state, &paths)?.into_result(&app)
}

#[tauri::command]
pub(super) async fn save_document(
    app: AppHandle,
    request: SaveDocumentRequest,
    state: State<'_, AppState>,
) -> DocumentResult<Option<DocumentSnapshot>> {
    save_with_mode(&app, &state, request, false, false)
}

#[tauri::command]
pub(super) async fn save_document_as(
    app: AppHandle,
    request: SaveDocumentRequest,
    state: State<'_, AppState>,
) -> DocumentResult<Option<DocumentSnapshot>> {
    save_with_mode(&app, &state, request, true, false)
}

#[tauri::command]
pub(super) async fn force_save_document(
    app: AppHandle,
    request: SaveDocumentRequest,
    state: State<'_, AppState>,
) -> DocumentResult<Option<DocumentSnapshot>> {
    save_with_mode(&app, &state, request, false, true)
}

#[tauri::command]
pub(super) async fn reload_document(
    document_id: String,
    state: State<'_, AppState>,
) -> DocumentResult<DocumentSnapshot> {
    let service = state.service.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        lock_service_arc(&service)?.reload_document(&document_id)
    })
    .await
    .map_err(join_error)??;
    sync_watches(&state)?;
    Ok(snapshot)
}

#[tauri::command]
pub(super) fn close_document(
    document_id: String,
    state: State<'_, AppState>,
) -> DocumentResult<()> {
    lock_service(&state)?.close_document(&document_id)?;
    sync_watches(&state)
}

#[tauri::command]
pub(super) async fn read_local_asset(
    document_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> DocumentResult<AssetPayload> {
    let service = state.service.clone();
    tauri::async_runtime::spawn_blocking(move || {
        lock_service_arc(&service)?.read_local_asset(&document_id, &relative_path)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub(super) async fn update_recovery_document(
    request: RecoveryDocumentUpdate,
    state: State<'_, AppState>,
) -> DocumentResult<()> {
    let service = state.service.clone();
    tauri::async_runtime::spawn_blocking(move || {
        lock_service_arc(&service)?.update_recovery_document(request)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub(super) async fn update_recovery_layout(
    request: RecoveryLayoutUpdate,
    state: State<'_, AppState>,
) -> DocumentResult<()> {
    let service = state.service.clone();
    tauri::async_runtime::spawn_blocking(move || {
        lock_service_arc(&service)?.update_recovery_layout(request)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub(super) fn update_menu_context(
    request: MenuContextUpdate,
    app: AppHandle,
) -> DocumentResult<()> {
    install_menu(&app, &request)
}

#[tauri::command]
pub(super) fn exit_pending(state: State<'_, AppState>) -> bool {
    state.exit_requested.load(Ordering::SeqCst)
}

#[tauri::command]
pub(super) fn cancel_exit(state: State<'_, AppState>) {
    state.exit_requested.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub(super) fn complete_exit(app: AppHandle, state: State<'_, AppState>) -> DocumentResult<()> {
    if !state.exit_requested.load(Ordering::SeqCst) {
        return Err(DocumentError::new(
            "INVALID_STATE",
            "No exit was requested.",
        ));
    }
    lock_service(&state)?.discard_recovery()?;
    state.exit_approved.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

pub(super) fn request_exit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.exit_requested.swap(true, Ordering::SeqCst) && app.emit("exit-requested", ()).is_err()
    {
        state.exit_requested.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub(super) fn restore_session(state: State<'_, AppState>) -> DocumentResult<RestoredSession> {
    let mut restored = lock_service(&state)?.restore_session();
    let startup_paths = {
        let mut paths = state.startup_paths.lock().map_err(|_| {
            DocumentError::new("WRITE_FAILED", "The startup path registry is unavailable.")
        })?;
        std::mem::take(&mut *paths)
    };
    // A startup file that cannot be opened must not discard the recovered session.
    let startup_documents = open_paths(&state, &startup_paths)?.documents;
    for document in startup_documents {
        if !restored
            .documents
            .iter()
            .any(|restored| restored.document.id == document.id)
        {
            if restored.active_id.is_none() {
                restored.active_id = Some(document.id.clone());
            }
            restored.documents.push(RestoredDocument {
                document,
                dirty: false,
                view_mode: "source".into(),
                cursor: 0,
                scroll_top: 0.0,
                external_change: false,
            });
        }
    }
    sync_watches(&state)?;
    Ok(restored)
}

fn save_with_mode(
    app: &AppHandle,
    state: &State<'_, AppState>,
    request: SaveDocumentRequest,
    save_as: bool,
    force: bool,
) -> DocumentResult<Option<DocumentSnapshot>> {
    let (existing_path, display_name, kind) =
        lock_service(state)?.save_context(&request.document_id)?;

    let target_path = match (save_as, existing_path) {
        (false, Some(path)) => path,
        _ => {
            let filter: (&str, &[&str]) = match kind {
                DocumentKind::Text => ("Text", &["txt"]),
                DocumentKind::Markdown => ("Markdown", &["md", "markdown"]),
            };
            let selected = app
                .dialog()
                .file()
                .set_file_name(display_name)
                .add_filter(filter.0, filter.1)
                .blocking_save_file();
            let Some(selected) = selected else {
                return Ok(None);
            };
            selected.into_path().map_err(|error| {
                DocumentError::new("WRITE_FAILED", format!("Invalid save path: {error}"))
            })?
        }
    };

    let saved = lock_service(state)?.save_document(&request, target_path, force)?;
    let mut saved = saved;
    if let Err(error) = sync_watches(state) {
        saved
            .warnings
            .push(format!("Saved, but file monitoring failed: {error}"));
    }
    Ok(Some(saved))
}

fn lock_service<'a>(
    state: &'a State<'_, AppState>,
) -> DocumentResult<std::sync::MutexGuard<'a, DocumentService>> {
    state
        .service
        .lock()
        .map_err(|_| DocumentError::new("WRITE_FAILED", "The document service is unavailable."))
}

fn lock_service_arc<'a>(
    service: &'a Arc<Mutex<DocumentService>>,
) -> DocumentResult<std::sync::MutexGuard<'a, DocumentService>> {
    service
        .lock()
        .map_err(|_| DocumentError::new("WRITE_FAILED", "The document service is unavailable."))
}

fn join_error(error: impl fmt::Display) -> DocumentError {
    DocumentError::new(
        "WRITE_FAILED",
        format!("Background document operation failed: {error}"),
    )
}

fn sync_watches(state: &State<'_, AppState>) -> DocumentResult<()> {
    let directories = lock_service(state)?.watched_directories();
    state
        .watcher
        .lock()
        .map_err(|_| DocumentError::new("WRITE_FAILED", "The file watcher is unavailable."))?
        .sync(&directories)
}

impl OpenedPaths {
    /// Fails only when nothing was opened; partial failures are emitted instead.
    fn into_result(self, app: &AppHandle) -> DocumentResult<Vec<DocumentSnapshot>> {
        match self.error {
            Some(error) if self.documents.is_empty() => Err(error),
            Some(error) => {
                let _ = app.emit(DOCUMENTS_OPEN_FAILED_EVENT, error);
                Ok(self.documents)
            }
            None => Ok(self.documents),
        }
    }
}

fn open_paths(state: &State<'_, AppState>, paths: &[PathBuf]) -> DocumentResult<OpenedPaths> {
    let opened = open_paths_in(&mut *lock_service(state)?, paths);
    sync_watches(state)?;
    Ok(opened)
}

pub(super) fn open_paths_and_emit(app: &AppHandle, paths: &[PathBuf]) {
    if app
        .state::<AppState>()
        .exit_requested
        .load(Ordering::SeqCst)
    {
        return;
    }
    let state = app.state::<AppState>();
    match open_paths(&state, paths) {
        Ok(opened) => {
            if !opened.documents.is_empty() {
                let _ = app.emit(DOCUMENTS_OPENED_EVENT, opened.documents);
            }
            if let Some(error) = opened.error {
                let _ = app.emit(DOCUMENTS_OPEN_FAILED_EVENT, error);
            }
        }
        Err(error) => {
            let _ = app.emit(DOCUMENTS_OPEN_FAILED_EVENT, error);
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
