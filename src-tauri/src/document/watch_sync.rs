use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use super::{
    service::DocumentService,
    types::{DocumentError, DocumentResult},
    watcher::FileWatcher,
};

type SyncAttempt = Arc<dyn Fn() -> DocumentResult<()> + Send + Sync>;

struct RetrySchedule {
    next: Option<Instant>,
    delay: Duration,
    initial: Duration,
    maximum: Duration,
}

impl RetrySchedule {
    fn new(initial: Duration, maximum: Duration) -> Self {
        Self {
            next: None,
            delay: initial,
            initial,
            maximum,
        }
    }

    fn record(&mut self, success: bool, retry: bool, now: Instant) {
        if success {
            self.next = None;
            self.delay = self.initial;
        } else if retry || self.next.is_none() {
            if retry {
                self.delay = self.delay.saturating_mul(2).min(self.maximum);
            }
            self.next = Some(now + self.delay);
        }
    }
}

struct RetryState {
    schedule: RetrySchedule,
}

/// One sleeping worker per app, woken only for a pending failed sync or shutdown.
/// Foreground and background attempts share the same serialization lock.
pub(super) struct WatchSync {
    attempt: SyncAttempt,
    shared: Arc<(Mutex<RetryState>, Condvar)>,
    worker: Mutex<Option<JoinHandle<()>>>,
    stopped: Arc<AtomicBool>,
}

impl WatchSync {
    pub(super) fn new(service: Arc<Mutex<DocumentService>>, watcher: FileWatcher) -> Self {
        let watcher = Mutex::new(watcher);
        Self::with_intervals(
            Arc::new(move || {
                sync_document_watches(&service, |directories| {
                    watcher
                        .lock()
                        .map_err(|_| {
                            DocumentError::new("WRITE_FAILED", "The file watcher is unavailable.")
                        })?
                        .sync(directories)
                })
            }),
            Duration::from_secs(1),
            Duration::from_secs(30),
        )
    }

    pub(super) fn with_intervals(
        attempt: SyncAttempt,
        initial: Duration,
        maximum: Duration,
    ) -> Self {
        let shared = Arc::new((
            Mutex::new(RetryState {
                schedule: RetrySchedule::new(initial, maximum),
            }),
            Condvar::new(),
        ));
        let worker_state = shared.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let worker_stopped = stopped.clone();
        let retry = attempt.clone();
        let worker = thread::spawn(move || {
            let (mutex, wake) = &*worker_state;
            let mut state = mutex.lock().unwrap_or_else(|error| error.into_inner());
            while !worker_stopped.load(Ordering::SeqCst) {
                let Some(next) = state.schedule.next else {
                    state = wake.wait(state).unwrap_or_else(|error| error.into_inner());
                    continue;
                };
                let remaining = next.saturating_duration_since(Instant::now());
                if !remaining.is_zero() {
                    state = wake
                        .wait_timeout(state, remaining)
                        .unwrap_or_else(|error| error.into_inner())
                        .0;
                    continue;
                }
                let success = run_attempt(&retry).is_ok();
                state.schedule.record(success, true, Instant::now());
            }
        });
        Self {
            attempt,
            shared,
            worker: Mutex::new(Some(worker)),
            stopped,
        }
    }

    pub(super) fn sync(&self) -> DocumentResult<()> {
        if self.stopped.load(Ordering::SeqCst) {
            return Ok(());
        }
        let (mutex, wake) = &*self.shared;
        let mut state = mutex.lock().unwrap_or_else(|error| error.into_inner());
        if self.stopped.load(Ordering::SeqCst) {
            return Ok(());
        }
        let result = run_attempt(&self.attempt);
        state.schedule.record(result.is_ok(), false, Instant::now());
        wake.notify_one();
        result
    }

    pub(super) fn stop(&self) {
        self.stop_with_timeout(Duration::from_secs(2));
    }

    pub(super) fn stop_with_timeout(&self, timeout: Duration) {
        self.stopped.store(true, Ordering::SeqCst);
        self.shared.1.notify_all();
        // This mutex only owns the handle; the worker never locks it. Release it
        // before waiting, so simultaneous shutdown callers cannot block each other.
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(worker) = worker {
            let deadline = Instant::now() + timeout;
            while !worker.is_finished() {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    eprintln!("File watcher shutdown timed out; detaching blocked worker.");
                    return;
                }
                // Re-notify to cover a stop racing with entry into condvar.wait,
                // without ever acquiring the state mutex held during notify IO.
                self.shared.1.notify_all();
                thread::sleep(remaining.min(Duration::from_millis(10)));
            }
            if let Err(error) = worker.join() {
                eprintln!("File watcher worker join failed: {error:?}");
            }
        }
    }
}

fn run_attempt(attempt: &SyncAttempt) -> DocumentResult<()> {
    catch_unwind(AssertUnwindSafe(|| attempt())).unwrap_or_else(|_| {
        Err(DocumentError::new(
            "WRITE_FAILED",
            "File watcher synchronization panicked; retry pending.",
        ))
    })
}

impl Drop for WatchSync {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(super) fn sync_document_watches(
    service: &Mutex<DocumentService>,
    apply: impl FnOnce(&[PathBuf]) -> DocumentResult<()>,
) -> DocumentResult<()> {
    let directories = service
        .lock()
        .map_err(|_| DocumentError::new("WRITE_FAILED", "The document service is unavailable."))?
        .watched_directories();
    // WatchSync serializes capture + apply, but notify IO must never hold the
    // service guard: stalled network paths must not block recovery or exit.
    apply(&directories)
}

#[cfg(test)]
mod tests {
    use super::super::service::open_paths_in;
    use super::*;
    use std::{
        fs,
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
    };

    #[test]
    fn injected_time_proves_backoff_cap_reset_and_no_postponement() {
        let now = Instant::now();
        let mut schedule = RetrySchedule::new(Duration::from_secs(1), Duration::from_secs(30));
        assert!(schedule.next.is_none());
        schedule.record(false, false, now);
        assert_eq!(schedule.next, Some(now + Duration::from_secs(1)));
        schedule.record(false, false, now + Duration::from_millis(500));
        assert_eq!(schedule.next, Some(now + Duration::from_secs(1)));
        for seconds in [2, 4, 8, 16, 30, 30] {
            let due = schedule.next.unwrap();
            schedule.record(false, true, due);
            assert_eq!(schedule.next, Some(due + Duration::from_secs(seconds)));
        }
        schedule.record(true, true, now);
        assert!(schedule.next.is_none());
        schedule.record(false, false, now);
        assert_eq!(schedule.next, Some(now + Duration::from_secs(1)));
        schedule.record(true, false, now);
        assert!(schedule.next.is_none());
    }

    #[test]
    fn worker_retries_without_commands_then_sleeps_after_success() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let (sender, receiver) = mpsc::channel();
        let sync = WatchSync::with_intervals(
            Arc::new(move || {
                let call = count.fetch_add(1, Ordering::SeqCst) + 1;
                sender.send(call).unwrap();
                if call < 4 {
                    Err(DocumentError::new("WRITE_FAILED", "retry"))
                } else {
                    Ok(())
                }
            }),
            Duration::from_millis(1),
            Duration::from_millis(4),
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(sync.sync().is_err());
        for expected in 1..=4 {
            assert_eq!(
                receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
                expected
            );
        }
        assert!(sync.shared.0.lock().unwrap().schedule.next.is_none());
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(20)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        sync.stop();
        assert!(sync.worker.lock().unwrap().is_none());
    }

    #[test]
    fn shutdown_interrupts_pending_backoff_and_joins_the_worker() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let sync = WatchSync::with_intervals(
            Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                Err(DocumentError::new("WRITE_FAILED", "retry"))
            }),
            Duration::from_secs(3600),
            Duration::from_secs(3600),
        );
        assert!(sync.sync().is_err());
        sync.stop();
        assert!(sync.worker.lock().unwrap().is_none());
        assert!(sync.stopped.load(Ordering::SeqCst));
        sync.sync().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        drop(sync);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn directory_reappearance_is_registered_without_another_document_command() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("watched");
        fs::create_dir(&parent).unwrap();
        let path = parent.join("note.txt");
        fs::write(&path, "note").unwrap();
        let service = Mutex::new(DocumentService::new(directory.path().join("session.json")));
        open_paths_in(&mut service.lock().unwrap(), std::slice::from_ref(&path));
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&parent).unwrap();
        let (events, _receiver) = mpsc::channel();
        let watcher = Mutex::new(FileWatcher::new(events).unwrap());
        let (sender, attempts) = mpsc::channel();
        let sync = WatchSync::with_intervals(
            Arc::new(move || {
                let result =
                    sync_document_watches(&service, |paths| watcher.lock().unwrap().sync(paths));
                sender.send(result.is_ok()).unwrap();
                result
            }),
            Duration::from_millis(1),
            Duration::from_millis(4),
        );
        assert!(sync.sync().is_err());
        assert!(!attempts.recv().unwrap());
        fs::create_dir(parent).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !attempts
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap()
        {}
        assert!(sync.shared.0.lock().unwrap().schedule.next.is_none());
    }

    #[test]
    fn sync_attempts_stay_ordered_without_blocking_document_service() {
        let directory = tempfile::tempdir().unwrap();
        let old = directory.path().join("old");
        let new = directory.path().join("new");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&new).unwrap();
        let old_path = old.join("note.txt");
        let new_path = new.join("note.txt");
        fs::write(&old_path, "old").unwrap();
        fs::write(&new_path, "new").unwrap();
        let service = Arc::new(Mutex::new(DocumentService::new(
            directory.path().join("session.json"),
        )));
        let id = open_paths_in(&mut service.lock().unwrap(), &[old_path]).documents[0]
            .id
            .clone();
        let (captured, ready) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let resume = Mutex::new(resume);
        let applied = Arc::new(Mutex::new(Vec::new()));
        let callback_service = service.clone();
        let callback_applied = applied.clone();
        let calls = AtomicUsize::new(0);
        let sync = WatchSync::with_intervals(
            Arc::new(move || {
                sync_document_watches(&callback_service, |paths| {
                    if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        captured.send(()).unwrap();
                        resume
                            .lock()
                            .unwrap()
                            .recv_timeout(Duration::from_secs(5))
                            .unwrap();
                    }
                    callback_applied.lock().unwrap().push(paths.to_vec());
                    Ok(())
                })
            }),
            Duration::from_secs(1),
            Duration::from_secs(30),
        );
        thread::scope(|scope| {
            scope.spawn(|| sync.sync().unwrap());
            ready.recv_timeout(Duration::from_secs(5)).unwrap();
            {
                let mut service = service
                    .try_lock()
                    .expect("notify IO must not hold service guard");
                service.close_document(&id).unwrap();
                open_paths_in(&mut service, &[new_path]);
            }
            scope.spawn(|| sync.sync().unwrap());
            release.send(()).unwrap();
        });
        assert_eq!(*applied.lock().unwrap(), vec![vec![old], vec![new]]);
    }

    #[test]
    fn background_panic_does_not_poison_service_or_kill_retries() {
        let directory = tempfile::tempdir().unwrap();
        let service = Arc::new(Mutex::new(DocumentService::new(
            directory.path().join("session.json"),
        )));
        let callback_service = service.clone();
        let (sender, receiver) = mpsc::channel();
        let calls = AtomicUsize::new(0);
        let sync = WatchSync::with_intervals(
            Arc::new(move || {
                sync_document_watches(&callback_service, |_| {
                    let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
                    sender.send(call).unwrap();
                    match call {
                        1 => Err(DocumentError::new("WRITE_FAILED", "retry")),
                        2 => panic!("injected notify panic"),
                        _ => Ok(()),
                    }
                })
            }),
            Duration::from_millis(1),
            Duration::from_millis(4),
        );
        assert!(sync.sync().is_err());
        for expected in 1..=3 {
            assert_eq!(
                receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
                expected
            );
        }
        assert!(sync.shared.0.lock().unwrap().schedule.next.is_none());
        assert!(!service.is_poisoned());
        assert!(!sync.shared.0.is_poisoned());
        service
            .lock()
            .unwrap()
            .new_document(super::super::types::DocumentKind::Text);
    }
}
