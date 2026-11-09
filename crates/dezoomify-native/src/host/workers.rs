//! Invocation-scoped blocking work. Dropping a wait never loses ownership of
//! its worker; settlement drains even work detached by cancellation or failure.
use super::Controls;
use dezoomify::model::Error;
use std::sync::{Arc, Mutex};
use tokio_util::task::TaskTracker;

#[derive(Clone)]
pub(super) struct BlockingTasks {
    controls: Controls,
    state: Arc<Mutex<Stats>>,
    tasks: TaskTracker,
}

#[derive(Clone, Copy, Default)]
pub(super) struct Stats {
    pub(super) input_bytes: u64,
    pub(super) peak_input_bytes: u64,
    pub(super) pixel_decodes: u64,
    pub(super) retained_bytes: u64,
}

impl BlockingTasks {
    pub(super) fn new(controls: Controls) -> Self {
        Self {
            controls,
            state: Arc::default(),
            tasks: TaskTracker::new(),
        }
    }

    /// Return promptly on cancellation or encoder failure. The closure owns
    /// its inputs until it exits, even if the calling future is dropped.
    pub(super) async fn run<T: Send + 'static>(
        &self,
        operation: &'static str,
        work: impl FnOnce() -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        self.run_with_bytes(operation, 0, work).await
    }

    /// Charge encoded input until the worker exits, including after a cancelled
    /// wait. This accounting is diagnostic; it does not impose an allocation limit.
    pub(super) async fn run_with_bytes<T: Send + 'static>(
        &self,
        operation: &'static str,
        bytes: usize,
        work: impl FnOnce() -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        self.controls
            .until_stopped(self.execute(operation, bytes, work))
            .await
    }

    /// Publication must settle its commit decision before returning, including
    /// on cancellation. The closure must check cancellation before committing.
    pub(super) async fn commit<T: Send + 'static>(
        &self,
        operation: &'static str,
        work: impl FnOnce() -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        self.execute(operation, 0, work).await
    }

    async fn execute<T: Send + 'static>(
        &self,
        operation: &'static str,
        bytes: usize,
        work: impl FnOnce() -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let state = Arc::clone(&self.state);
        {
            let mut stats = state.lock().expect("worker stats lock");
            stats.input_bytes += bytes as u64;
            stats.peak_input_bytes = stats.peak_input_bytes.max(stats.input_bytes);
        }
        let lease = Running {
            state,
            bytes: bytes as u64,
        };
        self.tasks
            .spawn_blocking(move || {
                let _lease = lease;
                work()
            })
            .await
            .map_err(|error| {
                Error::Internal(format!("{operation} worker failed: {error}").into())
            })?
    }

    /// Stop submitting work before draining; after this returns no worker can
    /// access invocation-owned staging, including workers whose waits were dropped.
    pub(super) async fn drain(&self) {
        self.tasks.close();
        self.tasks.wait().await;
    }

    pub(super) fn stats(&self) -> Stats {
        *self.state.lock().expect("worker stats lock")
    }
    pub(super) fn record_decode(&self) {
        self.state.lock().expect("worker stats lock").pixel_decodes += 1;
    }
    pub(super) fn retain(&self, bytes: u64) {
        self.state.lock().expect("worker stats lock").retained_bytes = bytes;
    }
}

struct Running {
    state: Arc<Mutex<Stats>>,
    bytes: u64,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.state.lock().expect("worker stats lock").input_bytes -= self.bytes;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_waits_for_detached_work_before_settlement() {
        let controls = Controls::default();
        let tasks = BlockingTasks::new(controls.clone());
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, finish) = std::sync::mpsc::channel();
        let (completed, done) = tokio::sync::oneshot::channel();
        let work = tasks.run_with_bytes("blocked work", 1024, move || {
            started.send(()).unwrap();
            finish.recv().unwrap();
            completed.send(()).unwrap();
            Ok(())
        });
        tokio::pin!(work);
        tokio::select! {
            biased;
            result = &mut work => panic!("worker must wait: {result:?}"),
            result = ready => result.unwrap(),
        }
        controls.cancel();
        assert_eq!(work.await, Err(Error::Cancelled));
        let settled = tasks.drain();
        tokio::pin!(settled);
        tokio::select! {
            biased;
            () = &mut settled => panic!("settlement must wait for the worker"),
            () = std::future::ready(()) => {}
        }
        release.send(()).unwrap();
        settled.await;
        done.await.unwrap();
        assert_eq!(tasks.stats().input_bytes, 0);
        assert_eq!(tasks.stats().peak_input_bytes, 1024);
    }
}
