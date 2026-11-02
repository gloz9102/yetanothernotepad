use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use uuid::Uuid;

use super::{
    codec::{
        decode_document, default_line_ending, encode_document, LineEnding, TextEncoding,
        MAX_DOCUMENT_BYTES,
    },
    paths::{ensure_extension, file_name, kind_for_path, paths_equivalent},
    recovery::{read_session, write_session, RecoveryDocument, RecoveryFile},
    storage::{self, atomic_write, map_io_error, read_limited, revision},
    types::{
        AssetPayload, DocumentError, DocumentKind, DocumentKindUpdate, DocumentResult,
        DocumentSnapshot, ExternalChange, RecoveryDocumentUpdate, RecoveryLayoutUpdate,
        RestoredDocument, RestoredSession, SaveDocumentRequest,
    },
};

const MAX_ASSET_BYTES: usize = 10 * 1024 * 1024;

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

pub(super) struct DocumentService {
    documents: HashMap<Uuid, DocumentRecord>,
    recovery_meta: HashMap<Uuid, RecoveryMeta>,
    document_order: Vec<Uuid>,
    active_id: Option<Uuid>,
    session_path: PathBuf,
    restored: bool,
}

impl DocumentService {
    pub(super) fn new(session_path: PathBuf) -> Self {
        Self {
            documents: HashMap::new(),
            recovery_meta: HashMap::new(),
            document_order: Vec::new(),
            active_id: None,
            session_path,
            restored: false,
        }
    }

    pub(super) fn new_document(&mut self, kind: DocumentKind) -> DocumentSnapshot {
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

    pub(super) fn save_context(
        &self,
        document_id: &str,
    ) -> DocumentResult<(Option<PathBuf>, String, DocumentKind)> {
        let id = parse_id(document_id)?;
        let document = self.documents.get(&id).ok_or_else(document_not_found)?;
        Ok((
            document.path.clone(),
            document.display_name.clone(),
            document.kind,
        ))
    }

    pub(super) fn save_document(
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
        let canonical = fs::canonicalize(&target_path).unwrap_or_else(|_| target_path.clone());
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

    pub(super) fn set_document_kind(
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

    pub(super) fn reload_document(
        &mut self,
        document_id: &str,
    ) -> DocumentResult<DocumentSnapshot> {
        let id = parse_id(document_id)?;
        let path = self
            .documents
            .get(&id)
            .and_then(|document| document.path.as_deref())
            .ok_or_else(document_not_found)?;
        let record = load_record(id, path)?;
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

    pub(super) fn close_document(&mut self, document_id: &str) -> DocumentResult<()> {
        let id = parse_id(document_id)?;
        self.documents.remove(&id).ok_or_else(document_not_found)?;
        self.recovery_meta.remove(&id);
        self.document_order.retain(|candidate| *candidate != id);
        if self.active_id == Some(id) {
            self.active_id = self.document_order.last().copied();
        }
        self.write_recovery()
    }

    pub(super) fn read_local_asset(
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

    pub(super) fn update_recovery_document(
        &mut self,
        request: RecoveryDocumentUpdate,
    ) -> DocumentResult<()> {
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

    pub(super) fn update_recovery_layout(
        &mut self,
        request: RecoveryLayoutUpdate,
    ) -> DocumentResult<()> {
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
                content: (meta.dirty || document.path.is_none()).then(|| document.content.clone()),
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

    pub(super) fn discard_recovery(&self) -> DocumentResult<()> {
        storage::recycle_file(&self.session_path)
    }

    pub(super) fn restore_session(&mut self) -> RestoredSession {
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

    pub(super) fn watched_directories(&self) -> Vec<PathBuf> {
        let mut directories = self
            .documents
            .values()
            .filter_map(|document| document.path.as_ref()?.parent().map(Path::to_path_buf))
            .collect::<Vec<_>>();
        directories.sort();
        directories.dedup();
        directories
    }

    pub(super) fn external_changes_in_directories(
        &self,
        directories: &[PathBuf],
    ) -> Vec<ExternalChange> {
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

/// Result of opening several paths: every readable path is opened even when
/// others fail, and the first failure is kept for reporting.
pub(super) struct OpenedPaths {
    pub(super) documents: Vec<DocumentSnapshot>,
    pub(super) error: Option<DocumentError>,
}

pub(super) fn open_paths_in(service: &mut DocumentService, paths: &[PathBuf]) -> OpenedPaths {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_content_is_kept_only_for_dirty_or_unsaved_documents() {
        let directory = tempfile::tempdir().expect("tempdir");
        let session_path = directory.path().join("session.json");
        let note = directory.path().join("note.txt");
        fs::write(&note, "disk content").expect("seed");
        let mut service = DocumentService::new(session_path.clone());
        let saved = service.open_path(&note).expect("open");
        let unsaved = service.new_document(DocumentKind::Text);
        service.write_recovery().expect("persist clean documents");

        let session = read_session(&session_path);
        assert_eq!(session.documents[0].id, saved.id);
        assert_eq!(session.documents[0].content, None);
        assert_eq!(session.documents[1].id, unsaved.id);
        assert_eq!(session.documents[1].content.as_deref(), Some(""));

        service
            .update_recovery_document(RecoveryDocumentUpdate {
                document_id: saved.id,
                content: "unsaved edit".into(),
                dirty: true,
                view_mode: "source".into(),
                cursor: 0,
                scroll_top: 0.0,
            })
            .expect("persist edit");
        let session = read_session(&session_path);
        assert_eq!(
            session.documents[0].content.as_deref(),
            Some("unsaved edit")
        );
        let mut restarted = DocumentService::new(session_path);
        let restored = restarted.restore_session();
        assert_eq!(restored.documents[0].document.content, "unsaved edit");
        assert!(restored.documents[0].dirty);
        assert_eq!(restored.documents[1].document.content, "");
        assert!(!restored.documents[1].dirty);
    }

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
