use std::fmt;

use serde::{Deserialize, Serialize};

use super::codec::{LineEnding, TextEncoding};

pub(super) type DocumentResult<T> = Result<T, DocumentError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DocumentError {
    pub(super) code: String,
    pub(super) message: String,
}

impl DocumentError {
    pub(super) fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
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
pub(super) enum DocumentKind {
    Text,
    Markdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DocumentSnapshot {
    pub(super) id: String,
    pub(super) display_name: String,
    pub(super) path: Option<String>,
    pub(super) kind: DocumentKind,
    pub(super) content: String,
    pub(super) encoding: TextEncoding,
    pub(super) line_ending: LineEnding,
    pub(super) revision: String,
    pub(super) read_only: bool,
    pub(super) normalization_warning: bool,
    pub(super) warnings: Vec<DocumentWarning>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub(super) enum DocumentWarning {
    Text(String),
    Monitoring { code: &'static str, details: String },
}

impl From<String> for DocumentWarning {
    fn from(message: String) -> Self {
        Self::Text(message)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RestoredDocument {
    pub(super) document: DocumentSnapshot,
    pub(super) dirty: bool,
    pub(super) view_mode: String,
    pub(super) cursor: usize,
    pub(super) scroll_top: f64,
    pub(super) external_change: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RestoredSession {
    pub(super) documents: Vec<RestoredDocument>,
    pub(super) active_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SaveDocumentRequest {
    pub(super) document_id: String,
    pub(super) content: String,
    pub(super) expected_revision: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DocumentKindUpdate {
    pub(super) id: String,
    pub(super) display_name: String,
    pub(super) kind: DocumentKind,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecoveryDocumentUpdate {
    pub(super) document_id: String,
    pub(super) content: String,
    #[serde(default)]
    pub(super) base_revision: Option<String>,
    pub(super) dirty: bool,
    pub(super) view_mode: String,
    pub(super) cursor: usize,
    pub(super) scroll_top: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecoveryLayoutUpdate {
    pub(super) document_ids: Vec<String>,
    pub(super) active_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExternalChange {
    pub(super) document_id: String,
    pub(super) kind: String,
    pub(super) revision: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MenuContextUpdate {
    pub(super) locale: String,
    pub(super) has_document: bool,
    pub(super) markdown: bool,
    pub(super) view_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AssetPayload {
    pub(super) mime_type: String,
    pub(super) data_url: String,
}
