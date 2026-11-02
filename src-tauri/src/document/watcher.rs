use std::{
    collections::HashSet,
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

use super::{DocumentError, DocumentResult, DocumentService, EXTERNAL_CHANGE_EVENT};

const WATCH_DEBOUNCE: Duration = Duration::from_millis(150);

pub struct FileWatcher {
    watcher: RecommendedWatcher,
    watched: HashSet<PathBuf>,
}

impl FileWatcher {
    pub fn new(sender: Sender<Vec<PathBuf>>) -> DocumentResult<Self> {
        let watcher = RecommendedWatcher::new(
            move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    let _ = sender.send(event.paths);
                }
            },
            Config::default(),
        )
        .map_err(watcher_error)?;
        Ok(Self {
            watcher,
            watched: HashSet::new(),
        })
    }

    pub fn sync(&mut self, directories: &[PathBuf]) -> DocumentResult<()> {
        let requested = directories.iter().cloned().collect::<HashSet<_>>();
        let removed = self
            .watched
            .difference(&requested)
            .cloned()
            .collect::<Vec<_>>();
        let added = requested
            .difference(&self.watched)
            .cloned()
            .collect::<Vec<_>>();

        for directory in removed {
            self.watcher.unwatch(&directory).map_err(watcher_error)?;
        }
        for directory in added {
            self.watcher
                .watch(&directory, RecursiveMode::NonRecursive)
                .map_err(watcher_error)?;
        }
        self.watched = requested;
        Ok(())
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
