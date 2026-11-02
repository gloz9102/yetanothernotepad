use std::{
    collections::HashSet,
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    sync::{
        mpsc::{Receiver, RecvTimeoutError, Sender},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use super::{
    service::DocumentService,
    types::{DocumentError, DocumentResult},
};

const EXTERNAL_CHANGE_EVENT: &str = "document-external-change";

const WATCH_DEBOUNCE: Duration = Duration::from_millis(150);

pub struct FileWatcher {
    watcher: Option<RecommendedWatcher>,
    sender: Sender<Vec<PathBuf>>,
    watched: HashSet<PathBuf>,
}

impl FileWatcher {
    pub fn new(sender: Sender<Vec<PathBuf>>) -> DocumentResult<Self> {
        let watcher = Self::create_watcher(sender.clone())?;
        Ok(Self {
            watcher: Some(watcher),
            sender,
            watched: HashSet::new(),
        })
    }

    fn create_watcher(sender: Sender<Vec<PathBuf>>) -> DocumentResult<RecommendedWatcher> {
        let watcher = RecommendedWatcher::new(
            move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    let _ = sender.send(event.paths);
                }
            },
            Config::default(),
        )
        .map_err(watcher_error)?;
        Ok(watcher)
    }

    pub fn sync(&mut self, directories: &[PathBuf]) -> DocumentResult<()> {
        self.with_panic_recovery(|watcher| watcher.sync_inner(directories))
    }

    fn with_panic_recovery(
        &mut self,
        apply: impl FnOnce(&mut Self) -> DocumentResult<()>,
    ) -> DocumentResult<()> {
        match catch_unwind(AssertUnwindSafe(|| apply(self))) {
            Ok(result) => result,
            Err(_) => {
                // Catch inside the caller's watcher guard so it is not poisoned.
                self.watched.clear();
                let failed = self.watcher.take();
                let _ = catch_unwind(AssertUnwindSafe(|| drop(failed)));
                if let Ok(Ok(watcher)) = catch_unwind(AssertUnwindSafe(|| {
                    Self::create_watcher(self.sender.clone())
                })) {
                    self.watcher = Some(watcher);
                }
                Err(DocumentError::new(
                    "WRITE_FAILED",
                    "File watcher panicked; watcher reset and retry pending.",
                ))
            }
        }
    }

    fn sync_inner(&mut self, directories: &[PathBuf]) -> DocumentResult<()> {
        if self.watcher.is_none() {
            self.watcher = Some(Self::create_watcher(self.sender.clone())?);
        }
        let watcher = self.watcher.as_mut().expect("watcher initialized");
        let requested = directories.iter().cloned().collect::<HashSet<_>>();
        // Known limitation: a watched directory deleted and recreated at the
        // same path is not re-registered here. That lifecycle is separate work.
        let mut removed = self
            .watched
            .difference(&requested)
            .cloned()
            .collect::<Vec<_>>();
        let mut added = requested
            .difference(&self.watched)
            .cloned()
            .collect::<Vec<_>>();
        removed.sort();
        added.sort();
        let mut errors = Vec::new();

        for directory in removed {
            match watcher.unwatch(&directory) {
                Ok(()) => {}
                // The OS may already have removed a watch for a deleted directory.
                Err(error) if matches!(error.kind, notify::ErrorKind::WatchNotFound) => {}
                Err(error) => {
                    errors.push(format!("{}: {error}", directory.display()));
                    continue;
                }
            }
            self.watched.remove(&directory);
        }
        for directory in added {
            match watcher.watch(&directory, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    self.watched.insert(directory);
                }
                Err(error) => errors.push(format!("{}: {error}", directory.display())),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(DocumentError::new(
                "WRITE_FAILED",
                format!("File watcher errors: {}", errors.join("; ")),
            ))
        }
    }
}

pub fn spawn_processor(
    app: AppHandle,
    service: Arc<Mutex<DocumentService>>,
    receiver: Receiver<Vec<PathBuf>>,
) {
    thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut paths = first;
            loop {
                match receiver.recv_timeout(WATCH_DEBOUNCE) {
                    Ok(mut next) => paths.append(&mut next),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }

            let mut directories = paths
                .iter()
                .filter_map(|path| {
                    if path.is_dir() {
                        Some(path.clone())
                    } else {
                        path.parent().map(PathBuf::from)
                    }
                })
                .collect::<Vec<_>>();
            directories.sort();
            directories.dedup();

            let changes = match service.lock() {
                Ok(service) => service.external_changes_in_directories(&directories),
                Err(_) => continue,
            };
            for change in changes {
                let _ = app.emit(EXTERNAL_CHANGE_EVENT, change);
            }
        }
    });
}

fn watcher_error(error: notify::Error) -> DocumentError {
    DocumentError::new("WRITE_FAILED", format!("File watcher error: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::mpsc};

    #[test]
    fn notify_panic_recreates_watcher_without_poisoning_its_lock() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().to_path_buf();
        let (sender, _receiver) = mpsc::channel();
        let watcher = Mutex::new(FileWatcher::new(sender).unwrap());
        watcher
            .lock()
            .unwrap()
            .sync(std::slice::from_ref(&path))
            .unwrap();
        let error = watcher
            .lock()
            .unwrap()
            .with_panic_recovery(|_| panic!("injected notify panic"))
            .unwrap_err();
        assert_eq!(error.code, "WRITE_FAILED");
        assert!(!watcher.is_poisoned());
        let mut watcher = watcher.lock().unwrap();
        assert!(watcher.watcher.is_some());
        assert!(watcher.watched.is_empty());
        watcher.sync(std::slice::from_ref(&path)).unwrap();
        assert!(watcher.watched.contains(&path));
    }

    #[test]
    fn failed_directories_do_not_block_later_additions_and_errors_are_aggregated() {
        let directory = tempfile::tempdir().unwrap();
        let missing_a = directory.path().join("a-missing");
        let missing_b = directory.path().join("b-missing");
        let valid = directory.path().join("z-valid");
        fs::create_dir(&valid).unwrap();
        let (sender, _receiver) = mpsc::channel();
        let mut watcher = FileWatcher::new(sender).unwrap();
        let requested = [missing_a.clone(), missing_b.clone(), valid.clone()];
        let error = watcher.sync(&requested).unwrap_err();
        assert!(error.message.contains(missing_a.to_str().unwrap()));
        assert!(error.message.contains(missing_b.to_str().unwrap()));
        assert_eq!(watcher.watched, HashSet::from([valid]));
        fs::create_dir(missing_a).unwrap();
        fs::create_dir(missing_b).unwrap();
        watcher.sync(&requested).unwrap();
        assert_eq!(watcher.watched, HashSet::from(requested));
    }

    #[test]
    fn failed_add_keeps_successful_removals_so_the_next_sync_can_retry() {
        let directory = tempfile::tempdir().unwrap();
        let old = directory.path().join("old");
        let added = directory.path().join("added");
        fs::create_dir(&old).unwrap();
        let (sender, _receiver) = mpsc::channel();
        let mut watcher = FileWatcher::new(sender).unwrap();
        watcher.sync(std::slice::from_ref(&old)).unwrap();
        assert!(watcher.sync(std::slice::from_ref(&added)).is_err());
        assert!(watcher.watched.is_empty());
        fs::create_dir(&added).unwrap();
        watcher.sync(std::slice::from_ref(&added)).unwrap();
        assert_eq!(watcher.watched, HashSet::from([added]));
        watcher.sync(&[]).unwrap();
        assert!(watcher.watched.is_empty());
    }

    #[test]
    fn already_removed_watch_does_not_block_resynchronization() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().to_path_buf();
        let (sender, _receiver) = mpsc::channel();
        let mut watcher = FileWatcher::new(sender).unwrap();
        watcher.sync(std::slice::from_ref(&path)).unwrap();
        watcher.watcher.as_mut().unwrap().unwatch(&path).unwrap();
        watcher.sync(&[]).unwrap();
        assert!(watcher.watched.is_empty());
        watcher.sync(std::slice::from_ref(&path)).unwrap();
        assert!(watcher.watched.contains(&path));
    }
}
