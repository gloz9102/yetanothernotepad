use std::{
    fs,
    path::{Path, PathBuf},
};

use super::types::DocumentKind;

pub(super) fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| "Untitled".into())
}

pub(super) fn kind_for_path(path: &Path, fallback: DocumentKind) -> DocumentKind {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension)
            if extension.eq_ignore_ascii_case("md")
                || extension.eq_ignore_ascii_case("markdown") =>
        {
            DocumentKind::Markdown
        }
        Some(extension) if extension.eq_ignore_ascii_case("txt") => DocumentKind::Text,
        _ => fallback,
    }
}

pub(super) fn ensure_extension(mut path: PathBuf, kind: DocumentKind) -> PathBuf {
    let extension = path.extension().and_then(|extension| extension.to_str());
    let valid = match kind {
        DocumentKind::Text => {
            extension.is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
        }
        DocumentKind::Markdown => extension.is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        }),
    };
    if !valid {
        path.set_extension(match kind {
            DocumentKind::Text => "txt",
            DocumentKind::Markdown => "md",
        });
    }
    path
}

pub(super) fn paths_equivalent(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

pub(super) fn startup_paths_from_args() -> Vec<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_matching_preserves_case_and_unknown_fallbacks() {
        for (name, kind) in [
            ("note.TxT", DocumentKind::Text),
            ("note.MD", DocumentKind::Markdown),
            ("note.MarkDown", DocumentKind::Markdown),
        ] {
            let path = PathBuf::from(name);
            for fallback in [DocumentKind::Text, DocumentKind::Markdown] {
                assert_eq!(kind_for_path(&path, fallback), kind);
            }
            assert_eq!(ensure_extension(path.clone(), kind), path);
        }
        for name in ["note", "note.unknown", "note.마크다운"] {
            for fallback in [DocumentKind::Text, DocumentKind::Markdown] {
                assert_eq!(kind_for_path(Path::new(name), fallback), fallback);
            }
        }
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
}
