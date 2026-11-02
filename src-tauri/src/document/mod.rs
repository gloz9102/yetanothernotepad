mod codec;
mod recovery;
mod storage;
mod watcher;

use std::{
    collections::HashMap,
    fmt, fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use codec::{
    decode_document, default_line_ending, encode_document, LineEnding, TextEncoding,
    MAX_DOCUMENT_BYTES,
};
use recovery::{read_session, write_session, RecoveryDocument, RecoveryFile};
use serde::{Deserialize, Serialize};
use storage::{atomic_write, map_io_error, read_limited, revision};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, DragDropEvent, Emitter, Manager, RunEvent, State, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;
use watcher::{spawn_processor, FileWatcher};

const MAX_ASSET_BYTES: usize = 10 * 1024 * 1024;
const DOCUMENTS_OPENED_EVENT: &str = "documents-opened";
const DOCUMENTS_OPEN_FAILED_EVENT: &str = "documents-open-failed";
const EXTERNAL_CHANGE_EVENT: &str = "document-external-change";
const APP_COMMAND_EVENT: &str = "app-command";

pub type DocumentResult<T> = Result<T, DocumentError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentError {
    pub code: String,
    pub message: String,
}

impl DocumentError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for DocumentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for DocumentError {}

impl From<tauri::Error> for DocumentError {
    fn from(error: tauri::Error) -> Self {
        Self::new("WRITE_FAILED", error.to_string())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DocumentKind {
    Text,
    Markdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub id: String,
    pub display_name: String,
    pub path: Option<String>,
    pub kind: DocumentKind,
    pub content: String,
    pub encoding: TextEncoding,
    pub line_ending: LineEnding,
    pub revision: String,
    pub read_only: bool,
    pub normalization_warning: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredDocument {
    pub document: DocumentSnapshot,
    pub dirty: bool,
    pub view_mode: String,
    pub cursor: usize,
    pub scroll_top: f64,
    pub external_change: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredSession {
    pub documents: Vec<RestoredDocument>,
    pub active_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentRequest {
    pub document_id: String,
    pub content: String,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentKindUpdate {
    pub id: String,
    pub display_name: String,
    pub kind: DocumentKind,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDocumentUpdate {
    pub document_id: String,
    pub content: String,
    pub dirty: bool,
    pub view_mode: String,
    pub cursor: usize,
    pub scroll_top: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryLayoutUpdate {
    pub document_ids: Vec<String>,
    pub active_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalChange {
    pub document_id: String,
    pub kind: String,
    pub revision: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuContextUpdate {
    pub locale: String,
    pub has_document: bool,
    pub markdown: bool,
    pub view_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPayload {
    pub mime_type: String,
    pub data_url: String,
}

struct DocumentRecord {
    id: Uuid,
    path: Option<PathBuf>,
    display_name: String,
    kind: DocumentKind,
    content: String,
    encoding: TextEncoding,
    line_ending: LineEnding,
    preferred_line_ending: LineEnding,
    revision: String,
    read_only: bool,
}

#[derive(Debug, Clone)]
struct RecoveryMeta {
    dirty: bool,
    view_mode: String,
    cursor: usize,
    scroll_top: f64,
}

impl Default for RecoveryMeta {
    fn default() -> Self {
        Self {
            dirty: false,
            view_mode: "source".into(),
            cursor: 0,
            scroll_top: 0.0,
        }
    }
}

impl DocumentRecord {
    fn snapshot(&self) -> DocumentSnapshot {
        DocumentSnapshot {
            id: self.id.to_string(),
            display_name: self.display_name.clone(),
            path: self
                .path
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            kind: self.kind,
            content: self.content.clone(),
            encoding: self.encoding,
            line_ending: self.line_ending,
            revision: self.revision.clone(),
            read_only: self.read_only,
            normalization_warning: self.line_ending == LineEnding::Mixed,
            warnings: Vec::new(),
        }
    }
}

struct DocumentService {
    documents: HashMap<Uuid, DocumentRecord>,
    recovery_meta: HashMap<Uuid, RecoveryMeta>,
    document_order: Vec<Uuid>,
    active_id: Option<Uuid>,
    session_path: PathBuf,
    restored: bool,
}

impl DocumentService {
    fn new(session_path: PathBuf) -> Self {
        Self {
            documents: HashMap::new(),
            recovery_meta: HashMap::new(),
            document_order: Vec::new(),
            active_id: None,
            session_path,
            restored: false,
        }
    }

    fn new_document(&mut self, kind: DocumentKind) -> DocumentSnapshot {
        let display_name = self.next_untitled_name(kind, None);
        let id = Uuid::new_v4();
        let record = DocumentRecord {
            id,
            path: None,
            display_name,
            kind,
            content: String::new(),
            encoding: TextEncoding::Utf8,
            line_ending: LineEnding::None,
            preferred_line_ending: default_line_ending(),
            revision: String::new(),
            read_only: false,
        };
        let snapshot = record.snapshot();
        self.documents.insert(id, record);
        self.recovery_meta.insert(id, RecoveryMeta::default());
        self.document_order.push(id);
        self.active_id = Some(id);
        snapshot
    }

    fn open_path(&mut self, path: &Path) -> DocumentResult<DocumentSnapshot> {
        let canonical = fs::canonicalize(path).map_err(map_io_error)?;
        if let Some(document) = self
            .documents
            .values()
            .find(|document| document.path.as_ref() == Some(&canonical))
        {
            return Ok(document.snapshot());
        }

        let record = load_record(Uuid::new_v4(), &canonical)?;
        let id = record.id;
        let snapshot = record.snapshot();
        self.documents.insert(id, record);
        self.recovery_meta.insert(id, RecoveryMeta::default());
        self.document_order.push(id);
        self.active_id = Some(id);
        Ok(snapshot)
    }

    fn save_document(
        &mut self,
        request: &SaveDocumentRequest,
        target_path: PathBuf,
        force: bool,
    ) -> DocumentResult<DocumentSnapshot> {
        let id = parse_id(&request.document_id)?;
        let document = self.documents.get(&id).ok_or_else(document_not_found)?;
        let target_path = ensure_extension(target_path, document.kind);

        if self.documents.values().any(|other| {
            other.id != id
                && other
                    .path
                    .as_ref()
                    .is_some_and(|path| paths_equivalent(path, &target_path))
        }) {
            return Err(DocumentError::new(
                "EXTERNAL_CONFLICT",
                "The destination is already open in another tab.",
            ));
        }

        let same_path = document
            .path
            .as_ref()
            .is_some_and(|path| paths_equivalent(path, &target_path));
        if same_path && !force {
            match read_limited(&target_path, MAX_DOCUMENT_BYTES) {
                Ok(bytes) if revision(&bytes) != request.expected_revision => {
                    return Err(DocumentError::new(
                        "EXTERNAL_CONFLICT",
                        "The file changed on disk after it was opened.",
                    ));
                }
                Err(error)
                    if error.code == "NOT_FOUND" && !request.expected_revision.is_empty() =>
                {
                    return Err(DocumentError::new(
                        "EXTERNAL_CONFLICT",
                        "The file was deleted after it was opened.",
                    ));
                }
                Err(error) => return Err(error),
                Ok(_) => {}
            }
        }

        let bytes = encode_document(
            &request.content,
            document.encoding,
            document.preferred_line_ending,
        )?;
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err(DocumentError::new(
                "TOO_LARGE",
                "The document is larger than the 10 MiB save limit.",
            ));
        }
        atomic_write(&target_path, &bytes)?;
        let canonical = fs::canonicalize(&target_path).unwrap_or(target_path.clone());
        let readback_warning = match read_limited(&target_path, MAX_DOCUMENT_BYTES) {
            Ok(actual) if actual == bytes => None,
            Ok(_) => Some(
                "The file was written but changed before verification. Reload before saving again."
                    .to_string(),
            ),
            Err(error) => Some(format!("The file was written but readback failed: {error}")),
        };
        let new_revision = revision(&bytes);
        let display_name = file_name(&canonical);
        let kind = kind_for_path(&canonical, document.kind);

        let mut snapshot = {
            let document = self.documents.get_mut(&id).ok_or_else(document_not_found)?;
            document.path = Some(canonical);
            document.display_name = display_name;
            document.kind = kind;
            document.content = request.content.clone();
            document.revision = new_revision;
            if document.line_ending == LineEnding::Mixed
                || (document.line_ending == LineEnding::None && request.content.contains('\n'))
            {
                document.line_ending = document.preferred_line_ending;
            }
            document.read_only = false;
            document.snapshot()
        };
        self.recovery_meta.entry(id).or_default().dirty = false;
        if let Some(warning) = readback_warning {
            snapshot.warnings.push(warning);
        }
        if let Err(error) = self.write_recovery() {
            snapshot
                .warnings
                .push(format!("Saved, but recovery update failed: {error}"));
        }
        Ok(snapshot)
    }

    fn set_document_kind(
        &mut self,
        document_id: &str,
        kind: DocumentKind,
    ) -> DocumentResult<DocumentKindUpdate> {
        let id = parse_id(document_id)?;
        let document = self.documents.get(&id).ok_or_else(document_not_found)?;
        if document.path.is_some() {
            return Err(DocumentError::new(
                "INVALID_DOCUMENT_STATE",
                "Only unsaved documents can change type.",
            ));
        }
        if document.kind == kind {
            return Ok(DocumentKindUpdate {
                id: document_id.into(),
                display_name: document.display_name.clone(),
                kind,
            });
        }

        let display_name = self.next_untitled_name(kind, Some(id));
        let document = self.documents.get_mut(&id).ok_or_else(document_not_found)?;
        document.kind = kind;
        document.display_name = display_name.clone();
        let update = DocumentKindUpdate {
            id: id.to_string(),
            display_name,
            kind,
        };
        self.write_recovery()?;
        Ok(update)
    }

    fn next_untitled_name(&self, kind: DocumentKind, except: Option<Uuid>) -> String {
        let extension = match kind {
            DocumentKind::Text => "txt",
            DocumentKind::Markdown => "md",
        };
        let mut number = 1;
        loop {
            let candidate = format!("Untitled {number}.{extension}");
            let used = self.documents.values().any(|document| {
                Some(document.id) != except
                    && document.path.is_none()
                    && document.display_name == candidate
            });
            if !used {
                return candidate;
            }
            number += 1;
        }
    }

    fn reload_document(&mut self, document_id: &str) -> DocumentResult<DocumentSnapshot> {
        let id = parse_id(document_id)?;
        let path = self
            .documents
            .get(&id)
            .and_then(|document| document.path.clone())
            .ok_or_else(document_not_found)?;
        let record = load_record(id, &path)?;
        let snapshot = record.snapshot();
        self.documents.insert(id, record);
        self.recovery_meta.entry(id).or_default().dirty = false;
        self.write_recovery()?;
        Ok(snapshot)
    }

    fn check_external_change(&self, document_id: &str) -> DocumentResult<Option<ExternalChange>> {
        let id = parse_id(document_id)?;
        let document = self.documents.get(&id).ok_or_else(document_not_found)?;
        let Some(path) = &document.path else {
            return Ok(None);
        };

        let bytes = match read_limited(path, MAX_DOCUMENT_BYTES) {
            Ok(bytes) => bytes,
            Err(error) if error.code == "NOT_FOUND" => {
                return Ok(Some(ExternalChange {
                    document_id: document_id.into(),
                    kind: "deleted".into(),
                    revision: None,
                }));
            }
            Err(error) => return Err(error),
        };
        let disk_revision = revision(&bytes);
        if disk_revision == document.revision {
            Ok(None)
        } else {
            Ok(Some(ExternalChange {
                document_id: document_id.into(),
                kind: "modified".into(),
                revision: Some(disk_revision),
            }))
        }
    }

    fn close_document(&mut self, document_id: &str) -> DocumentResult<()> {
        let id = parse_id(document_id)?;
        self.documents.remove(&id).ok_or_else(document_not_found)?;
        self.recovery_meta.remove(&id);
        self.document_order.retain(|candidate| *candidate != id);
        if self.active_id == Some(id) {
            self.active_id = self.document_order.last().copied();
        }
        self.write_recovery()
    }

    fn read_local_asset(
        &self,
        document_id: &str,
        relative_path: &str,
    ) -> DocumentResult<AssetPayload> {
        let id = parse_id(document_id)?;
        let document = self.documents.get(&id).ok_or_else(document_not_found)?;
        let document_path = document.path.as_ref().ok_or_else(|| {
            DocumentError::new(
                "INVALID_ASSET_PATH",
                "Unsaved documents cannot resolve relative image paths.",
            )
        })?;
        let root = document_path.parent().ok_or_else(|| {
            DocumentError::new(
                "INVALID_ASSET_PATH",
                "The document has no parent directory.",
            )
        })?;
        let relative = Path::new(relative_path);
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(DocumentError::new(
                "INVALID_ASSET_PATH",
                "Image paths must stay inside the document directory.",
            ));
        }

        let canonical_root = fs::canonicalize(root).map_err(map_io_error)?;
        let canonical_asset = fs::canonicalize(root.join(relative)).map_err(map_io_error)?;
        if !canonical_asset.starts_with(&canonical_root) {
            return Err(DocumentError::new(
                "INVALID_ASSET_PATH",
                "Image paths must stay inside the document directory.",
            ));
        }

        let mime_type = mime_guess::from_path(&canonical_asset)
            .first_or_octet_stream()
            .to_string();
        if !mime_type.starts_with("image/") {
            return Err(DocumentError::new(
                "INVALID_ASSET_PATH",
                "Only image assets can be loaded in Markdown preview.",
            ));
        }
        let bytes = read_limited(&canonical_asset, MAX_ASSET_BYTES)?;
        let data_url = format!("data:{mime_type};base64,{}", BASE64.encode(bytes));
        Ok(AssetPayload {
            mime_type,
            data_url,
        })
    }

    fn update_recovery_document(&mut self, request: RecoveryDocumentUpdate) -> DocumentResult<()> {
        let id = parse_id(&request.document_id)?;
        let document = self.documents.get_mut(&id).ok_or_else(document_not_found)?;
        document.content = request.content;
        self.recovery_meta.insert(
            id,
            RecoveryMeta {
                dirty: request.dirty,
                view_mode: request.view_mode,
                cursor: request.cursor,
                scroll_top: request.scroll_top,
            },
        );
        self.write_recovery()
    }

    fn update_recovery_layout(&mut self, request: RecoveryLayoutUpdate) -> DocumentResult<()> {
        self.document_order = request
            .document_ids
            .iter()
            .filter_map(|document_id| parse_id(document_id).ok())
            .filter(|id| self.documents.contains_key(id))
            .collect();
        self.active_id = request
            .active_id
            .as_deref()
            .and_then(|document_id| parse_id(document_id).ok())
            .filter(|id| self.documents.contains_key(id));
        self.write_recovery()
    }

    fn write_recovery(&self) -> DocumentResult<()> {
        let mut documents = Vec::with_capacity(self.document_order.len());
        for id in &self.document_order {
            let Some(document) = self.documents.get(id) else {
                continue;
            };
            let meta = self.recovery_meta.get(id).cloned().unwrap_or_default();
            documents.push(RecoveryDocument {
                id: document.id.to_string(),
                path: document
                    .path
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                display_name: document.display_name.clone(),
                kind: document.kind,
                encoding: document.encoding,
                line_ending: document.line_ending,
                preferred_line_ending: document.preferred_line_ending,
                revision: document.revision.clone(),
                read_only: document.read_only,
                content: (meta.dirty || document.path.is_none())
                    .then_some(document.content.clone()),
                dirty: meta.dirty,
                view_mode: meta.view_mode,
                cursor: meta.cursor,
                scroll_top: meta.scroll_top,
            });
        }
        write_session(
            &self.session_path,
            &RecoveryFile {
                version: 1,
                active_id: self.active_id.map(|id| id.to_string()),
                documents,
            },
        )
    }

    fn discard_recovery(&self) -> DocumentResult<()> {
        storage::recycle_file(&self.session_path)
    }

    fn restore_session(&mut self) -> RestoredSession {
        if self.restored {
            return RestoredSession {
                documents: self
                    .documents
                    .values()
                    .map(|document| RestoredDocument {
                        document: document.snapshot(),
                        dirty: false,
                        view_mode: "source".into(),
                        cursor: 0,
                        scroll_top: 0.0,
                        external_change: false,
                    })
                    .collect(),
                active_id: None,
            };
        }
        self.restored = true;

        let session = read_session(&self.session_path);
        self.active_id = session
            .active_id
            .as_deref()
            .and_then(|document_id| Uuid::parse_str(document_id).ok());
        let mut restored_documents = Vec::new();
        for recovered in session.documents {
            let id = Uuid::parse_str(&recovered.id).unwrap_or_else(|_| Uuid::new_v4());
            let restored = restore_record(id, &recovered);
            let Some((record, external_change)) = restored else {
                continue;
            };
            let snapshot = record.snapshot();
            self.documents.insert(id, record);
            self.document_order.push(id);
            self.recovery_meta.insert(
                id,
                RecoveryMeta {
                    dirty: recovered.dirty,
                    view_mode: recovered.view_mode.clone(),
                    cursor: recovered.cursor,
                    scroll_top: recovered.scroll_top,
                },
            );
            restored_documents.push(RestoredDocument {
                document: snapshot,
                dirty: recovered.dirty,
                view_mode: recovered.view_mode,
                cursor: recovered.cursor,
                scroll_top: recovered.scroll_top,
                external_change,
            });
        }

        RestoredSession {
            documents: restored_documents,
            active_id: self.active_id.map(|id| id.to_string()),
        }
    }

    fn watched_directories(&self) -> Vec<PathBuf> {
        let mut directories = self
            .documents
            .values()
            .filter_map(|document| document.path.as_ref()?.parent().map(Path::to_path_buf))
            .collect::<Vec<_>>();
        directories.sort();
        directories.dedup();
        directories
    }

    fn external_changes_in_directories(&self, directories: &[PathBuf]) -> Vec<ExternalChange> {
        self.documents
            .values()
            .filter(|document| {
                document
                    .path
                    .as_ref()
                    .and_then(|path| path.parent())
                    .is_some_and(|parent| directories.iter().any(|directory| directory == parent))
            })
            .filter_map(|document| {
                self.check_external_change(&document.id.to_string())
                    .ok()
                    .flatten()
            })
            .collect()
    }
}

struct AppState {
    service: Arc<Mutex<DocumentService>>,
    watcher: Mutex<FileWatcher>,
    startup_paths: Mutex<Vec<PathBuf>>,
    exit_requested: AtomicBool,
    exit_approved: AtomicBool,
}

impl AppState {
    fn new(
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
fn new_document(
    kind: DocumentKind,
    state: State<'_, AppState>,
) -> DocumentResult<DocumentSnapshot> {
    Ok(lock_service(&state)?.new_document(kind))
}

#[tauri::command]
fn set_document_kind(
    document_id: String,
    kind: DocumentKind,
    state: State<'_, AppState>,
) -> DocumentResult<DocumentKindUpdate> {
    lock_service(&state)?.set_document_kind(&document_id, kind)
}

#[tauri::command]
async fn pick_and_open_documents(
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
async fn open_document_paths(
    app: AppHandle,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> DocumentResult<Vec<DocumentSnapshot>> {
    let paths = paths.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    open_paths(&state, &paths)?.into_result(&app)
}

#[tauri::command]
async fn save_document(
    app: AppHandle,
    request: SaveDocumentRequest,
    state: State<'_, AppState>,
) -> DocumentResult<Option<DocumentSnapshot>> {
    save_with_mode(&app, &state, request, false, false)
}

#[tauri::command]
async fn save_document_as(
    app: AppHandle,
    request: SaveDocumentRequest,
    state: State<'_, AppState>,
) -> DocumentResult<Option<DocumentSnapshot>> {
    save_with_mode(&app, &state, request, true, false)
}

#[tauri::command]
async fn force_save_document(
    app: AppHandle,
    request: SaveDocumentRequest,
    state: State<'_, AppState>,
) -> DocumentResult<Option<DocumentSnapshot>> {
    save_with_mode(&app, &state, request, false, true)
}

#[tauri::command]
async fn reload_document(
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
fn close_document(document_id: String, state: State<'_, AppState>) -> DocumentResult<()> {
    lock_service(&state)?.close_document(&document_id)?;
    sync_watches(&state)
}

#[tauri::command]
async fn read_local_asset(
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
async fn update_recovery_document(
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
async fn update_recovery_layout(
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
fn update_menu_context(request: MenuContextUpdate, app: AppHandle) -> DocumentResult<()> {
    install_menu(&app, &request)
}

#[tauri::command]
fn exit_pending(state: State<'_, AppState>) -> bool {
    state.exit_requested.load(Ordering::SeqCst)
}

#[tauri::command]
fn cancel_exit(state: State<'_, AppState>) {
    state.exit_requested.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn complete_exit(app: AppHandle, state: State<'_, AppState>) -> DocumentResult<()> {
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

fn request_exit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if !state.exit_requested.swap(true, Ordering::SeqCst) && app.emit("exit-requested", ()).is_err()
    {
        state.exit_requested.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
fn restore_session(state: State<'_, AppState>) -> DocumentResult<RestoredSession> {
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
    let (existing_path, display_name, kind): (Option<PathBuf>, String, DocumentKind) = {
        let service = lock_service(state)?;
        let id = parse_id(&request.document_id)?;
        let document = service.documents.get(&id).ok_or_else(document_not_found)?;
        (
            document.path.clone(),
            document.display_name.clone(),
            document.kind,
        )
    };

    let target_path = match (save_as, existing_path) {
        (false, Some(path)) => path,
        _ => {
            let filter = match kind {
                DocumentKind::Text => ("Text", vec!["txt"]),
                DocumentKind::Markdown => ("Markdown", vec!["md", "markdown"]),
            };
            let selected = app
                .dialog()
                .file()
                .set_file_name(display_name)
                .add_filter(filter.0, &filter.1)
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

fn install_menu(app: &AppHandle, context: &MenuContextUpdate) -> DocumentResult<()> {
    let korean = context.locale == "ko";
    let label = |ko: &'static str, en: &'static str| if korean { ko } else { en };
    let item = |id: &'static str,
                text: &'static str,
                accelerator: Option<&'static str>,
                enabled: bool|
     -> Result<_, tauri::Error> {
        let mut builder = MenuItemBuilder::with_id(id, text).enabled(enabled);
        if let Some(accelerator) = accelerator {
            builder = builder.accelerator(accelerator);
        }
        builder.build(app)
    };
    let check_item = |id: &'static str,
                      text: &'static str,
                      accelerator: Option<&'static str>,
                      enabled: bool,
                      checked: bool|
     -> Result<_, tauri::Error> {
        let mut builder = CheckMenuItemBuilder::with_id(id, text)
            .enabled(enabled)
            .checked(checked);
        if let Some(accelerator) = accelerator {
            builder = builder.accelerator(accelerator);
        }
        builder.build(app)
    };

    let new_text = item(
        "new-text",
        label("새 텍스트", "New Text"),
        Some("CmdOrCtrl+N"),
        true,
    )?;
    let new_markdown = item(
        "new-markdown",
        label("새 Markdown", "New Markdown"),
        Some("CmdOrCtrl+Shift+N"),
        true,
    )?;
    let open = item("open", label("열기…", "Open…"), Some("CmdOrCtrl+O"), true)?;
    let save = item(
        "save",
        label("저장", "Save"),
        Some("CmdOrCtrl+S"),
        context.has_document,
    )?;
    let save_as = item(
        "save-as",
        label("다른 이름으로 저장…", "Save As…"),
        Some("CmdOrCtrl+Shift+S"),
        context.has_document,
    )?;
    let close = item(
        "close",
        label("탭 닫기", "Close Tab"),
        Some("CmdOrCtrl+W"),
        context.has_document,
    )?;
    let file = SubmenuBuilder::new(app, label("파일", "File"))
        .items(&[&new_text, &new_markdown, &open])
        .separator()
        .items(&[&save, &save_as])
        .separator()
        .item(&close)
        .build()?;

    let undo = item(
        "undo",
        label("실행 취소", "Undo"),
        Some("CmdOrCtrl+Z"),
        context.has_document,
    )?;
    let redo = item(
        "redo",
        label("다시 실행", "Redo"),
        Some("CmdOrCtrl+Shift+Z"),
        context.has_document,
    )?;
    let find = item(
        "find",
        label("찾기", "Find"),
        Some("CmdOrCtrl+F"),
        context.has_document,
    )?;
    let replace = item(
        "replace",
        label("찾기 및 바꾸기", "Find and Replace"),
        Some("CmdOrCtrl+H"),
        context.has_document,
    )?;
    let edit = SubmenuBuilder::new(app, label("편집", "Edit"))
        .items(&[&undo, &redo])
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .items(&[&find, &replace])
        .build()?;

    let source = check_item(
        "view-source",
        label("원문", "Source"),
        Some("CmdOrCtrl+Alt+1"),
        context.has_document,
        context.view_mode == "source",
    )?;
    let split = check_item(
        "view-split",
        label("분할", "Split"),
        Some("CmdOrCtrl+Alt+2"),
        context.markdown,
        context.view_mode == "split",
    )?;
    let preview = check_item(
        "view-preview",
        label("리치뷰", "Rich View"),
        Some("CmdOrCtrl+Alt+3"),
        context.markdown,
        context.view_mode == "preview",
    )?;
    let settings = item(
        "settings",
        label("설정…", "Settings…"),
        Some("CmdOrCtrl+,"),
        true,
    )?;
    let view = SubmenuBuilder::new(app, label("보기", "View"))
        .items(&[&source, &split, &preview])
        .separator()
        .item(&settings)
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = {
        let app_menu = SubmenuBuilder::new(app, "Yet Another Notepad")
            .about(None)
            .separator()
            .item(
                &MenuItemBuilder::with_id("quit", label("종료", "Quit"))
                    .accelerator("Cmd+Q")
                    .build(app)?,
            )
            .build()?;
        MenuBuilder::new(app)
            .items(&[&app_menu, &file, &edit, &view])
            .build()?
    };
    #[cfg(not(target_os = "macos"))]
    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &view])
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

fn sync_watches(state: &State<'_, AppState>) -> DocumentResult<()> {
    let directories = lock_service(state)?.watched_directories();
    state
        .watcher
        .lock()
        .map_err(|_| DocumentError::new("WRITE_FAILED", "The file watcher is unavailable."))?
        .sync(&directories)
}

/// Result of opening several paths: every readable path is opened even when
/// others fail, and the first failure is kept for reporting.
struct OpenedPaths {
    documents: Vec<DocumentSnapshot>,
    error: Option<DocumentError>,
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

fn open_paths_in(service: &mut DocumentService, paths: &[PathBuf]) -> OpenedPaths {
    let mut opened = OpenedPaths {
        documents: Vec::new(),
        error: None,
    };
    for path in paths {
        match service.open_path(path) {
            Ok(document) => opened.documents.push(document),
            Err(error) => {
                opened.error.get_or_insert(error);
            }
        }
    }
    opened
}

fn open_paths(state: &State<'_, AppState>, paths: &[PathBuf]) -> DocumentResult<OpenedPaths> {
    let opened = open_paths_in(&mut *lock_service(state)?, paths);
    sync_watches(state)?;
    Ok(opened)
}

fn open_paths_and_emit(app: &AppHandle, paths: &[PathBuf]) {
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

fn restore_record(id: Uuid, recovered: &RecoveryDocument) -> Option<(DocumentRecord, bool)> {
    let recovered_content = recovered.content.clone();
    let Some(path_string) = &recovered.path else {
        return Some((
            DocumentRecord {
                id,
                path: None,
                display_name: recovered.display_name.clone(),
                kind: recovered.kind,
                content: recovered_content.unwrap_or_default(),
                encoding: recovered.encoding,
                line_ending: recovered.line_ending,
                preferred_line_ending: recovered.preferred_line_ending,
                revision: recovered.revision.clone(),
                read_only: false,
            },
            false,
        ));
    };

    let path = PathBuf::from(path_string);
    match fs::canonicalize(&path)
        .map_err(map_io_error)
        .and_then(|path| load_record(id, &path))
    {
        Ok(mut disk_record) => {
            let external_change = recovered.dirty && disk_record.revision != recovered.revision;
            if recovered.dirty {
                disk_record.content = recovered_content.unwrap_or_default();
                disk_record.encoding = recovered.encoding;
                disk_record.line_ending = recovered.line_ending;
                disk_record.preferred_line_ending = recovered.preferred_line_ending;
                disk_record.revision = recovered.revision.clone();
            }
            Some((disk_record, external_change))
        }
        Err(_) if recovered_content.is_some() => Some((
            DocumentRecord {
                id,
                path: Some(path),
                display_name: recovered.display_name.clone(),
                kind: recovered.kind,
                content: recovered_content.unwrap_or_default(),
                encoding: recovered.encoding,
                line_ending: recovered.line_ending,
                preferred_line_ending: recovered.preferred_line_ending,
                revision: recovered.revision.clone(),
                read_only: recovered.read_only,
            },
            true,
        )),
        Err(_) => None,
    }
}

fn load_record(id: Uuid, path: &Path) -> DocumentResult<DocumentRecord> {
    let bytes = read_limited(path, MAX_DOCUMENT_BYTES)?;
    let decoded = decode_document(&bytes)?;
    let metadata = fs::metadata(path).map_err(map_io_error)?;
    Ok(DocumentRecord {
        id,
        path: Some(path.to_path_buf()),
        display_name: file_name(path),
        kind: kind_for_path(path, DocumentKind::Text),
        content: decoded.content,
        encoding: decoded.encoding,
        line_ending: decoded.line_ending,
        preferred_line_ending: decoded.preferred_line_ending,
        revision: revision(&bytes),
        read_only: metadata.permissions().readonly(),
    })
}

fn parse_id(document_id: &str) -> DocumentResult<Uuid> {
    Uuid::parse_str(document_id)
        .map_err(|_| DocumentError::new("NOT_FOUND", "The document ID is invalid."))
}

fn document_not_found() -> DocumentError {
    DocumentError::new("NOT_FOUND", "The document is no longer open.")
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "Untitled".into())
}

fn kind_for_path(path: &Path, fallback: DocumentKind) -> DocumentKind {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("md" | "markdown") => DocumentKind::Markdown,
        Some("txt") => DocumentKind::Text,
        _ => fallback,
    }
}

fn ensure_extension(mut path: PathBuf, kind: DocumentKind) -> PathBuf {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    let valid = match kind {
        DocumentKind::Text => extension.as_deref() == Some("txt"),
        DocumentKind::Markdown => matches!(extension.as_deref(), Some("md" | "markdown")),
    };
    if !valid {
        path.set_extension(match kind {
            DocumentKind::Text => "txt",
            DocumentKind::Markdown => "md",
        });
    }
    path
}

fn paths_equivalent(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn startup_paths_from_args() -> Vec<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .collect()
}

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
            new_document,
            pick_and_open_documents,
            open_document_paths,
            set_document_kind,
            save_document,
            save_document_as,
            force_save_document,
            reload_document,
            close_document,
            read_local_asset,
            update_recovery_document,
            update_recovery_layout,
            update_menu_context,
            cancel_exit,
            exit_pending,
            complete_exit,
            restore_session,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_revision_survives_recovery_failure() {
        let directory = tempfile::tempdir().unwrap();
        let blocked_parent = directory.path().join("not-a-directory");
        fs::write(&blocked_parent, b"block").unwrap();
        let mut service = DocumentService::new(blocked_parent.join("session.json"));
        let document = service.new_document(DocumentKind::Text);
        let path = directory.path().join("한글 note.txt");
        let saved = service
            .save_document(
                &SaveDocumentRequest {
                    document_id: document.id.clone(),
                    content: "saved".into(),
                    expected_revision: String::new(),
                },
                path.clone(),
                false,
            )
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"saved");
        assert_eq!(saved.revision, revision(b"saved"));
        assert_eq!(saved.warnings.len(), 1);
        let next = service
            .save_document(
                &SaveDocumentRequest {
                    document_id: document.id,
                    content: "next".into(),
                    expected_revision: saved.revision,
                },
                path.clone(),
                false,
            )
            .unwrap();
        assert_eq!(next.revision, revision(b"next"));
    }

    #[test]
    fn recovery_updates_restore_latest_content() {
        let directory = tempfile::tempdir().unwrap();
        let session_path = directory.path().join("session.json");
        let mut service = DocumentService::new(session_path.clone());
        let document = service.new_document(DocumentKind::Text);
        for text in ["first", "latest"] {
            service
                .update_recovery_document(RecoveryDocumentUpdate {
                    document_id: document.id.clone(),
                    content: text.into(),
                    dirty: true,
                    view_mode: "source".into(),
                    cursor: 0,
                    scroll_top: 0.0,
                })
                .unwrap();
        }
        let mut restarted = DocumentService::new(session_path);
        assert_eq!(
            restarted.restore_session().documents[0].document.content,
            "latest"
        );
    }

    #[test]
    fn prevents_asset_path_traversal() {
        let directory = tempfile::tempdir().expect("tempdir");
        let notes = directory.path().join("notes");
        fs::create_dir(&notes).unwrap();
        let note = notes.join("note.md");
        fs::write(&note, "![secret](../secret.png)").expect("note");
        let secret = directory.path().join("secret.png");
        fs::write(&secret, b"secret").expect("secret");

        let mut service = DocumentService::new(directory.path().join("session.json"));
        let document = service.open_path(&note).expect("open");
        let error = service
            .read_local_asset(&document.id, "../secret.png")
            .expect_err("traversal");
        assert_eq!(error.code, "INVALID_ASSET_PATH");
    }

    #[test]
    fn detects_external_save_conflicts() {
        let directory = tempfile::tempdir().expect("tempdir");
        let note = directory.path().join("note.md");
        fs::write(&note, "original").expect("note");

        let mut service = DocumentService::new(directory.path().join("session.json"));
        let document = service.open_path(&note).expect("open");
        fs::write(&note, "external").expect("external");

        let error = service
            .save_document(
                &SaveDocumentRequest {
                    document_id: document.id.clone(),
                    content: "local".into(),
                    expected_revision: document.revision,
                },
                note,
                false,
            )
            .expect_err("conflict");
        assert_eq!(error.code, "EXTERNAL_CONFLICT");
    }

    #[test]
    fn opens_readable_paths_when_others_fail() {
        let directory = tempfile::tempdir().expect("tempdir");
        let text = directory.path().join("note.txt");
        let markdown = directory.path().join("readme.md");
        let binary = directory.path().join("image.png");
        fs::write(&text, "text").expect("text");
        fs::write(&markdown, "# title").expect("markdown");
        fs::write(&binary, b"\x89PNG\0\0\0").expect("binary");

        let mut service = DocumentService::new(directory.path().join("session.json"));
        let opened = open_paths_in(
            &mut service,
            &[text, binary, directory.path().to_path_buf(), markdown],
        );

        let names = opened
            .documents
            .iter()
            .map(|document| document.display_name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["note.txt", "readme.md"]);
        assert_eq!(opened.error.expect("error").code, "BINARY_FILE");
        assert_eq!(service.document_order.len(), 2);
    }

    #[test]
    fn rejects_saving_oversized_documents() {
        let directory = tempfile::tempdir().expect("tempdir");
        let note = directory.path().join("large.txt");
        let mut service = DocumentService::new(directory.path().join("session.json"));
        let document = service.new_document(DocumentKind::Text);

        let error = service
            .save_document(
                &SaveDocumentRequest {
                    document_id: document.id,
                    content: "a".repeat(MAX_DOCUMENT_BYTES + 1),
                    expected_revision: String::new(),
                },
                note.clone(),
                false,
            )
            .expect_err("oversized save");

        assert_eq!(error.code, "TOO_LARGE");
        assert!(!note.exists());
    }

    #[test]
    fn restores_unsaved_content() {
        let directory = tempfile::tempdir().expect("tempdir");
        let session_path = directory.path().join("session.json");
        let mut service = DocumentService::new(session_path.clone());
        let document = service.new_document(DocumentKind::Markdown);
        service
            .update_recovery_document(RecoveryDocumentUpdate {
                document_id: document.id.clone(),
                content: "# recovered".into(),
                dirty: true,
                view_mode: "preview".into(),
                cursor: 5,
                scroll_top: 10.0,
            })
            .expect("update document");
        service
            .update_recovery_layout(RecoveryLayoutUpdate {
                document_ids: vec![document.id.clone()],
                active_id: Some(document.id.clone()),
            })
            .expect("persist");

        let mut restored_service = DocumentService::new(session_path);
        let restored = restored_service.restore_session();
        assert_eq!(restored.documents.len(), 1);
        assert_eq!(restored.documents[0].document.content, "# recovered");
        assert!(restored.documents[0].dirty);
    }

    #[test]
    fn changes_only_unsaved_document_kinds() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut service = DocumentService::new(directory.path().join("session.json"));
        let document = service.new_document(DocumentKind::Text);

        let changed = service
            .set_document_kind(&document.id, DocumentKind::Markdown)
            .expect("change kind");
        assert_eq!(changed.kind, DocumentKind::Markdown);
        assert!(changed.display_name.ends_with(".md"));

        let path = directory.path().join("saved.md");
        service
            .save_document(
                &SaveDocumentRequest {
                    document_id: document.id.clone(),
                    content: "# note".into(),
                    expected_revision: String::new(),
                },
                path,
                false,
            )
            .expect("save");
        let error = service
            .set_document_kind(&document.id, DocumentKind::Text)
            .expect_err("saved documents cannot change kind");
        assert_eq!(error.code, "INVALID_DOCUMENT_STATE");
    }

    #[test]
    fn enforces_extensions_for_document_kind() {
        assert_eq!(
            ensure_extension(PathBuf::from("note.txt"), DocumentKind::Markdown),
            PathBuf::from("note.md")
        );
        assert_eq!(
            ensure_extension(PathBuf::from("note.markdown"), DocumentKind::Markdown),
            PathBuf::from("note.markdown")
        );
        assert_eq!(
            ensure_extension(PathBuf::from("note.md"), DocumentKind::Text),
            PathBuf::from("note.txt")
        );
    }

    #[test]
    fn reports_external_changes_only_when_disk_revision_differs() {
        let directory = tempfile::tempdir().expect("tempdir");
        let note = directory.path().join("note.txt");
        fs::write(&note, "initial").expect("seed");
        let mut service = DocumentService::new(directory.path().join("session.json"));
        let document = service.open_path(&note).expect("open");
        let watched = service.watched_directories();

        assert!(service.external_changes_in_directories(&watched).is_empty());
        fs::write(&note, "external").expect("external write");
        let changes = service.external_changes_in_directories(&watched);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].document_id, document.id);
        assert_eq!(changes[0].kind, "modified");

        let current_revision = changes[0].revision.clone().expect("revision");
        service
            .save_document(
                &SaveDocumentRequest {
                    document_id: document.id,
                    content: "app save".into(),
                    expected_revision: current_revision,
                },
                note.clone(),
                true,
            )
            .expect("force save");
        assert!(service.external_changes_in_directories(&watched).is_empty());

        fs::rename(&note, directory.path().join("externally-moved.txt")).expect("external move");
        let changes = service.external_changes_in_directories(&watched);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, "deleted");
    }

    #[test]
    fn assigns_unique_names_after_kind_changes() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut service = DocumentService::new(directory.path().join("session.json"));
        let markdown = service.new_document(DocumentKind::Markdown);
        let text = service.new_document(DocumentKind::Text);

        let changed = service
            .set_document_kind(&text.id, DocumentKind::Markdown)
            .expect("change");
        assert_ne!(changed.display_name, markdown.display_name);
        assert_eq!(changed.display_name, "Untitled 2.md");
    }
}
