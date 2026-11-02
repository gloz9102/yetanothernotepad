use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

use super::{
    codec::{LineEnding, TextEncoding},
    storage::atomic_write,
    types::{DocumentError, DocumentKind, DocumentResult},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryFile {
    pub version: u32,
    pub active_id: Option<String>,
    pub documents: Vec<RecoveryDocument>,
}

impl Default for RecoveryFile {
    fn default() -> Self {
        Self {
            version: 1,
            active_id: None,
            documents: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDocument {
    pub id: String,
    pub path: Option<String>,
    pub display_name: String,
    pub kind: DocumentKind,
    pub encoding: TextEncoding,
    pub line_ending: LineEnding,
    pub preferred_line_ending: LineEnding,
    pub revision: String,
    pub read_only: bool,
    pub content: Option<String>,
    pub dirty: bool,
    pub view_mode: String,
    pub cursor: usize,
    pub scroll_top: f64,
}

pub fn read_session(path: &Path) -> RecoveryFile {
    let Ok(bytes) = fs::read(path) else {
        return RecoveryFile::default();
    };

    match serde_json::from_slice::<RecoveryFile>(&bytes) {
        Ok(session) if session.version == 1 => session,
        _ => RecoveryFile::default(),
    }
}

pub fn write_session(path: &Path, session: &RecoveryFile) -> DocumentResult<()> {
    let bytes = serde_json::to_vec(session).map_err(|error| {
        DocumentError::new(
            "WRITE_FAILED",
            format!("Failed to encode recovery: {error}"),
        )
    })?;
    atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_session_is_ignored() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("session.json");
        fs::write(&path, b"not json").expect("write");

        let session = read_session(&path);
        assert!(session.documents.is_empty());
    }
}
