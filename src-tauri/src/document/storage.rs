use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use uuid::Uuid;

use super::types::{DocumentError, DocumentResult};

pub fn read_limited(path: &Path, max_bytes: usize) -> DocumentResult<Vec<u8>> {
    let metadata = fs::metadata(path).map_err(map_io_error)?;
    if metadata.len() > max_bytes as u64 {
        return Err(DocumentError::new(
            "TOO_LARGE",
            format!("{} is larger than the supported size.", path.display()),
        ));
    }
    fs::read(path).map_err(map_io_error)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> DocumentResult<()> {
    let parent = path.parent().ok_or_else(|| {
        DocumentError::new("WRITE_FAILED", "The destination has no parent directory.")
    })?;
    fs::create_dir_all(parent).map_err(map_io_error)?;

    let temp_path = temporary_path(path, "tmp");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options.open(&temp_path).map_err(map_io_error)?;

    let result = (|| {
        match fs::metadata(path) {
            Ok(metadata) => {
                file.set_permissions(metadata.permissions())
                    .map_err(map_io_error)?;
                copy_access_permissions(path, &temp_path)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(map_io_error(error)),
        }
        write_and_sync(&mut file, bytes).map_err(map_io_error)
    })();
    drop(file);
    let result = result.and_then(|()| replace_file(&temp_path, path));
    if let Err(mut error) = result {
        if let Err(cleanup) = recycle_file(&temp_path) {
            error.message.push_str(&format!(
                " Temporary file retained at {}: {}",
                temp_path.display(),
                cleanup
            ));
        }
        return Err(error);
    }

    sync_parent(parent);
    Ok(())
}

pub fn revision(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn write_and_sync(file: &mut File, bytes: &[u8]) -> std::io::Result<()> {
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()
}

#[cfg(not(windows))]
fn replace_file(temp_path: &Path, path: &Path) -> DocumentResult<()> {
    fs::rename(temp_path, path).map_err(map_io_error)
}

#[cfg(windows)]
fn replace_file(temp_path: &Path, path: &Path) -> DocumentResult<()> {
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from = wide_path(temp_path);
    let to = wide_path(path);
    // Both files are on the same volume. Never fall back to copy/delete.
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(map_io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

pub fn recycle_file(path: &Path) -> DocumentResult<()> {
    if !path.try_exists().map_err(map_io_error)? {
        return Ok(());
    }
    let context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    let context = {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = context;
        context.set_delete_method(DeleteMethod::NsFileManager);
        context
    };
    context.delete(path).map_err(|error| {
        DocumentError::new(
            "WRITE_FAILED",
            format!("Cannot move {} to Trash: {error}", path.display()),
        )
    })
}

#[cfg(not(windows))]
fn copy_access_permissions(_source: &Path, _destination: &Path) -> DocumentResult<()> {
    Ok(())
}

#[cfg(windows)]
fn wide_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn copy_access_permissions(source: &Path, destination: &Path) -> DocumentResult<()> {
    use windows_sys::Win32::Security::{
        GetFileSecurityW, GetSecurityDescriptorControl, SetFileSecurityW,
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SE_DACL_PROTECTED,
        UNPROTECTED_DACL_SECURITY_INFORMATION,
    };
    let source = wide_path(source);
    let destination = wide_path(destination);
    let mut size = 0;
    unsafe {
        GetFileSecurityW(
            source.as_ptr(),
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut size,
        );
    }
    if size == 0 {
        return Err(map_io_error(std::io::Error::last_os_error()));
    }
    // Use aligned storage for the Windows security descriptor.
    let mut descriptor = vec![0u32; (size as usize).div_ceil(4)];
    let pointer = descriptor.as_mut_ptr().cast();
    if unsafe {
        GetFileSecurityW(
            source.as_ptr(),
            DACL_SECURITY_INFORMATION,
            pointer,
            size,
            &mut size,
        )
    } == 0
    {
        return Err(map_io_error(std::io::Error::last_os_error()));
    }
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(pointer, &mut control, &mut revision) } == 0 {
        return Err(map_io_error(std::io::Error::last_os_error()));
    }
    let protection = if control & SE_DACL_PROTECTED != 0 {
        PROTECTED_DACL_SECURITY_INFORMATION
    } else {
        UNPROTECTED_DACL_SECURITY_INFORMATION
    };
    if unsafe {
        SetFileSecurityW(
            destination.as_ptr(),
            DACL_SECURITY_INFORMATION | protection,
            pointer,
        )
    } == 0
    {
        return Err(map_io_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

fn temporary_path(path: &Path, suffix: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document");
    path.with_file_name(format!(".{file_name}.{}.{}", Uuid::new_v4(), suffix))
}

#[cfg(unix)]
fn sync_parent(parent: &Path) {
    if let Ok(directory) = File::open(parent) {
        let _ = directory.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) {}

pub fn map_io_error(error: std::io::Error) -> DocumentError {
    use std::io::ErrorKind;

    let code = match error.kind() {
        ErrorKind::NotFound => "NOT_FOUND",
        ErrorKind::PermissionDenied => "PERMISSION_DENIED",
        _ => "WRITE_FAILED",
    };
    DocumentError::new(code, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_content() {
        let directory = tempfile::tempdir().expect("tempdir");
        let path = directory.path().join("note.md");
        fs::write(&path, b"old").expect("seed");

        atomic_write(&path, b"new content").expect("write");

        assert_eq!(fs::read(&path).expect("read"), b"new content");
        let leftovers = fs::read_dir(directory.path())
            .expect("list")
            .filter_map(Result::ok)
            .count();
        assert_eq!(leftovers, 1);
    }

    #[test]
    fn failed_replace_keeps_original_at_its_path() {
        let directory = tempfile::tempdir().expect("tempdir");
        let target = directory.path().join("한글 note.txt");
        fs::write(&target, b"original").unwrap();
        let missing = directory.path().join("missing.tmp");
        assert!(replace_file(&missing, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
    }

    #[cfg(windows)]
    #[test]
    fn sharing_violation_keeps_original_and_replacement() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("locked.txt");
        let temp = directory.path().join("new.tmp");
        fs::write(&target, b"original").unwrap();
        fs::write(&temp, b"replacement").unwrap();
        let handle = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&target)
            .unwrap();
        assert!(replace_file(&temp, &target).is_err());
        drop(handle);
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert_eq!(fs::read(&temp).unwrap(), b"replacement");
    }

    #[test]
    fn revision_changes_with_content() {
        assert_ne!(revision(b"a"), revision(b"b"));
        assert_eq!(revision(b"same"), revision(b"same"));
    }
}
