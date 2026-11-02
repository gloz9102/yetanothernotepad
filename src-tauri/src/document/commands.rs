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
        DocumentSnapshot, DocumentWarning, MenuContextUpdate, RecoveryDocumentUpdate,
        RecoveryLayoutUpdate, RestoredDocument, RestoredSession, SaveDocumentRequest,
    },
    watch_sync::WatchSync,
    watcher::FileWatcher,
};

const DOCUMENTS_OPENED_EVENT: &str = "documents-opened";
const DOCUMENTS_OPEN_FAILED_EVENT: &str = "documents-open-failed";

pub(super) struct AppState {
    service: Arc<Mutex<DocumentService>>,
    watch_sync: WatchSync,
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
            watch_sync: WatchSync::new(service.clone(), watcher),
            service,
            startup_paths: Mutex::new(startup_paths),
            exit_requested: AtomicBool::new(false),
            exit_approved: AtomicBool::new(false),
        }
    }

    pub(super) fn stop_watch_retries(&self) {
        self.watch_sync.stop();
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
    reload_document_in(&state, document_id).await
}

async fn reload_document_in(
    state: &AppState,
    document_id: String,
) -> DocumentResult<DocumentSnapshot> {
    let service = state.service.clone();
    let mut snapshot = tauri::async_runtime::spawn_blocking(move || {
        lock_service_arc(&service)?.reload_document(&document_id)
    })
    .await
    .map_err(join_error)??;
    if let Some(warning) = sync_watches_after_commit(state, "Reloaded") {
        snapshot.warnings.push(warning);
    }
    Ok(snapshot)
}

#[tauri::command]
pub(super) fn close_document(
    document_id: String,
    state: State<'_, AppState>,
) -> DocumentResult<()> {
    close_document_in(&state, &document_id)
}

fn close_document_in(state: &AppState, document_id: &str) -> DocumentResult<()> {
    lock_service(state)?.close_document(document_id)?;
    sync_watches_after_commit(state, "Closed");
    Ok(())
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
    approve_exit(&state)?;
    app.exit(0);
    Ok(())
}

fn approve_exit(state: &AppState) -> DocumentResult<()> {
    if !state.exit_requested.load(Ordering::SeqCst) {
        return Err(DocumentError::new(
            "INVALID_STATE",
            "No exit was requested.",
        ));
    }
    lock_service(state)?.discard_recovery()?;
    state.exit_approved.store(true, Ordering::SeqCst);
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
    restore_session_in(&state)
}

fn restore_session_in(state: &AppState) -> DocumentResult<RestoredSession> {
    let startup_paths = {
        let mut paths = state.startup_paths.lock().map_err(|_| {
            DocumentError::new("WRITE_FAILED", "The startup path registry is unavailable.")
        })?;
        std::mem::take(&mut *paths)
    };
    let mut service = lock_service(state)?;
    let mut restored = service.restore_session();
    // A startup file that cannot be opened must not discard the recovered session.
    let startup_documents = open_paths_in(&mut service, &startup_paths).documents;
    drop(service);
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
    if let Some(warning) = sync_watches_after_commit(state, "Restored") {
        for restored in &mut restored.documents {
            restored.document.warnings.push(warning.clone());
        }
    }
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
    if let Some(warning) = sync_watches_after_commit(state, "Saved") {
        saved.warnings.push(warning);
    }
    Ok(Some(saved))
}

fn lock_service<'a>(
    state: &'a AppState,
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

fn sync_watches(state: &AppState) -> DocumentResult<()> {
    state.watch_sync.sync()
}

// Document state has already committed. Monitoring errors must never turn that
// success into an IPC failure. Snapshots carry warnings; void commands log them.
fn sync_watches_after_commit(state: &AppState, operation: &str) -> Option<DocumentWarning> {
    sync_watches(state).err().map(|error| {
        eprintln!("{operation}: FILE_MONITORING_FAILED: {error}");
        DocumentWarning::Monitoring {
            code: "FILE_MONITORING_FAILED",
            details: error.to_string(),
        }
    })
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

fn open_paths(state: &AppState, paths: &[PathBuf]) -> DocumentResult<OpenedPaths> {
    let mut opened = open_paths_in(&mut *lock_service(state)?, paths);
    if let Some(warning) = sync_watches_after_commit(state, "Opened") {
        for document in &mut opened.documents {
            document.warnings.push(warning.clone());
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::mpsc};

    fn assert_monitoring_warning(warning: &DocumentWarning) {
        let encoded = serde_json::to_value(warning).unwrap();
        assert_eq!(encoded["code"], "FILE_MONITORING_FAILED");
        assert!(encoded["details"]
            .as_str()
            .unwrap()
            .contains("WRITE_FAILED"));
    }

    fn state_with_missing_watch(
        directory: &std::path::Path,
    ) -> (AppState, DocumentSnapshot, PathBuf) {
        let parent = directory.join("missing-watch");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("note.txt");
        fs::write(&path, "base").unwrap();
        let mut service = DocumentService::new(directory.join("session.json"));
        let document = open_paths_in(&mut service, std::slice::from_ref(&path))
            .documents
            .remove(0);
        service
            .update_recovery_document(RecoveryDocumentUpdate {
                document_id: document.id.clone(),
                content: "draft".into(),
                base_revision: Some(document.revision.clone()),
                dirty: true,
                view_mode: "source".into(),
                cursor: 2,
                scroll_top: 3.0,
            })
            .unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(&parent).unwrap();
        let (sender, _receiver) = mpsc::channel();
        let state = AppState::new(
            Arc::new(Mutex::new(service)),
            FileWatcher::new(sender).unwrap(),
            Vec::new(),
        );
        assert!(sync_watches(&state).is_err());
        (state, document, parent)
    }

    #[test]
    fn stalled_watcher_cannot_block_recycling_exit_approval_or_bounded_shutdown() {
        use super::super::watch_sync::sync_document_watches;
        use std::{
            sync::atomic::AtomicUsize,
            time::{Duration, Instant},
        };
        let directory = tempfile::tempdir().unwrap();
        let (mut state, _, _) = state_with_missing_watch(directory.path());
        let service = state.service.clone();
        let calls = AtomicUsize::new(0);
        let (started, entered) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let resume = Mutex::new(resume);
        let (finished, done) = mpsc::channel();
        state.watch_sync = WatchSync::with_intervals(
            Arc::new(move || {
                sync_document_watches(&service, |_| {
                    if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        return Err(DocumentError::new("WRITE_FAILED", "retry"));
                    }
                    started.send(()).unwrap();
                    resume
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                    finished.send(()).unwrap();
                    Ok(())
                })
            }),
            Duration::from_millis(1),
            Duration::from_millis(4),
        );
        assert!(sync_watches(&state).is_err());
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(state.service.try_lock().is_ok());
        state.exit_requested.store(true, Ordering::SeqCst);
        let began = Instant::now();
        approve_exit(&state).unwrap();
        assert!(state.exit_approved.load(Ordering::SeqCst));
        assert!(!directory.path().join("session.json").exists());
        state
            .watch_sync
            .stop_with_timeout(Duration::from_millis(20));
        assert!(began.elapsed() < Duration::from_secs(1));
        release.send(()).unwrap();
        done.recv_timeout(Duration::from_secs(5)).unwrap();
    }

    #[test]
    fn committed_close_succeeds_when_monitoring_fails_and_later_sync_retries() {
        let directory = tempfile::tempdir().unwrap();
        let (state, remaining, missing) = state_with_missing_watch(directory.path());
        let closing = lock_service(&state)
            .unwrap()
            .new_document(DocumentKind::Text);
        close_document_in(&state, &closing.id).unwrap();
        assert!(lock_service(&state)
            .unwrap()
            .save_context(&closing.id)
            .is_err());
        assert!(lock_service(&state)
            .unwrap()
            .save_context(&remaining.id)
            .is_ok());
        assert!(sync_watches(&state).is_err());
        fs::create_dir(missing).unwrap();
        sync_watches(&state).unwrap();
        let restored =
            DocumentService::new(directory.path().join("session.json")).restore_session();
        assert_eq!(restored.documents.len(), 1);
        assert_eq!(restored.documents[0].document.id, remaining.id);
    }

    #[test]
    fn close_still_propagates_recovery_failure_and_keeps_the_document() {
        let directory = tempfile::tempdir().unwrap();
        let (state, document, _) = state_with_missing_watch(directory.path());
        let session = directory.path().join("session.json");
        fs::remove_file(&session).unwrap();
        fs::create_dir(&session).unwrap();
        assert!(close_document_in(&state, &document.id).is_err());
        assert!(lock_service(&state)
            .unwrap()
            .save_context(&document.id)
            .is_ok());
    }

    #[test]
    fn open_keeps_snapshots_and_read_errors_when_monitoring_fails() {
        let directory = tempfile::tempdir().unwrap();
        let (state, _, _) = state_with_missing_watch(directory.path());
        let path = directory.path().join("opened.txt");
        fs::write(&path, "opened").unwrap();
        let opened = open_paths(&state, &[path, directory.path().join("absent.txt")]).unwrap();
        assert_eq!(opened.documents.len(), 1);
        assert_eq!(opened.documents[0].content, "opened");
        assert_monitoring_warning(&opened.documents[0].warnings[0]);
        assert_eq!(opened.error.unwrap().code, "NOT_FOUND");
    }

    #[test]
    fn reload_returns_the_committed_snapshot_with_a_monitoring_warning() {
        let directory = tempfile::tempdir().unwrap();
        let (state, _, _) = state_with_missing_watch(directory.path());
        let path = directory.path().join("reload.txt");
        fs::write(&path, "before").unwrap();
        let opened = open_paths(&state, std::slice::from_ref(&path)).unwrap();
        let id = opened.documents[0].id.clone();
        fs::write(path, "after").unwrap();
        let reloaded = tauri::async_runtime::block_on(reload_document_in(&state, id)).unwrap();
        assert_eq!(reloaded.content, "after");
        assert_monitoring_warning(&reloaded.warnings[0]);
    }

    #[test]
    fn restore_keeps_recovery_and_startup_documents_when_monitoring_fails() {
        let directory = tempfile::tempdir().unwrap();
        let (previous, recovered, _) = state_with_missing_watch(directory.path());
        drop(previous);
        let startup = directory.path().join("startup.txt");
        fs::write(&startup, "startup").unwrap();
        let (sender, _receiver) = mpsc::channel();
        let state = AppState::new(
            Arc::new(Mutex::new(DocumentService::new(
                directory.path().join("session.json"),
            ))),
            FileWatcher::new(sender).unwrap(),
            vec![startup],
        );
        let restored = restore_session_in(&state).unwrap();
        assert_eq!(restored.documents.len(), 2);
        assert_eq!(restored.documents[0].document.id, recovered.id);
        assert_eq!(restored.documents[0].document.content, "draft");
        assert!(restored.documents[0].dirty);
        assert_eq!(restored.documents[1].document.content, "startup");
        for restored in restored.documents {
            assert_monitoring_warning(&restored.document.warnings[0]);
        }
    }
}
