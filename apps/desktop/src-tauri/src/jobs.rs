//! Native resources retained for a desktop invocation and its saved result.
use dezoomify::model::{DiagnosticReport, Error, RecoveryChoice};
use dezoomify_native::{diagnostics::Diagnostics, Controls};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

pub const CHANNEL_REGISTERED: &str = "dezoomify://registered";
pub const CHANNEL_PROGRESS: &str = "dezoomify://progress";
pub const CHANNEL_PARTIAL: &str = "dezoomify://partial";

pub struct Registration {
    pub controls: Controls,
    pub diagnostics: Diagnostics,
    pub completed: AtomicBool,
    pub saved_path: Mutex<Option<PathBuf>>,
    next_question: AtomicU64,
    partial: Mutex<Option<(u64, tokio::sync::oneshot::Sender<RecoveryChoice>)>>,
}

impl Registration {
    pub fn new() -> Self {
        Self {
            controls: Controls::default(),
            diagnostics: Diagnostics::new("desktop", crate::APP_VERSION),
            completed: AtomicBool::new(false),
            saved_path: Mutex::new(None),
            next_question: AtomicU64::new(0),
            partial: Mutex::new(None),
        }
    }

    pub fn request_partial(&self) -> (u64, tokio::sync::oneshot::Receiver<RecoveryChoice>) {
        let question = self.next_question.fetch_add(1, Ordering::SeqCst);
        let (send, receive) = tokio::sync::oneshot::channel();
        *self
            .partial
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some((question, send));
        (question, receive)
    }

    pub fn answer_partial(&self, question: u64, answer: RecoveryChoice) -> Result<(), Error> {
        let mut pending = self
            .partial
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !pending.as_ref().is_some_and(|(id, _)| *id == question) {
            return Err(Error::InteractionExpired);
        }
        if let Some((_, send)) = pending.take() {
            send.send(answer).map_err(|_| Error::InteractionExpired)?;
        }
        Ok(())
    }

    pub fn finish(&self, path: Option<PathBuf>) {
        *self
            .saved_path
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = path;
        self.partial
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        self.completed.store(true, Ordering::SeqCst);
    }
}

impl Default for Registration {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
pub struct JobTable {
    jobs: HashMap<String, Arc<Registration>>,
}

impl JobTable {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn insert(&mut self, id: &str) -> Result<Arc<Registration>, Error> {
        if !crate::commands::is_valid_job_id(id) {
            return Err(Error::InvalidInput(
                "job id must look like job:<suffix>".to_string().into(),
            ));
        }
        if self.jobs.contains_key(id) {
            return Err(Error::Duplicate);
        }
        let entry = Arc::new(Registration::new());
        self.jobs.insert(id.into(), Arc::clone(&entry));
        Ok(entry)
    }
    pub fn get(&self, id: &str) -> Result<Arc<Registration>, Error> {
        self.jobs.get(id).cloned().ok_or_else(|| unknown_job(id))
    }
    pub fn live(&self, id: &str) -> Result<Arc<Registration>, Error> {
        let entry = self.get(id)?;
        if entry.completed.load(Ordering::SeqCst) {
            return Err(Error::Stale);
        }
        Ok(entry)
    }
    pub fn release_job(&mut self, id: &str) {
        if let Some(entry) = self.jobs.remove(id) {
            entry.controls.cancel();
        }
    }
    pub fn diagnostic_report(&self, id: &str) -> Option<DiagnosticReport> {
        self.jobs.get(id).map(|entry| entry.diagnostics.report())
    }
    pub fn saved_output_for(&self, id: &str) -> Option<PathBuf> {
        self.jobs
            .get(id)
            .and_then(|entry| entry.saved_path.lock().ok()?.clone())
    }
}

impl Drop for JobTable {
    fn drop(&mut self) {
        for entry in self.jobs.values() {
            entry.controls.cancel();
        }
    }
}

pub fn unknown_job(id: &str) -> Error {
    Error::InvalidState(
        format!("unknown job id {id}; the invocation never existed or belongs to a closed window")
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retirement_cancels_work_and_revokes_output_access() {
        let mut table = JobTable::new();
        let registration = table.insert("job:test").unwrap();
        registration.finish(Some(PathBuf::from("saved.png")));
        assert_eq!(
            table.saved_output_for("job:test"),
            Some(PathBuf::from("saved.png"))
        );
        assert!(table.live("job:test").is_err());
        table.release_job("job:test");
        assert!(registration.controls.is_cancelled());
        assert!(table.saved_output_for("job:test").is_none());
    }
    #[test]
    fn cancellation_after_registration_prevents_native_work_and_publication() {
        use dezoomify_native::{JobOptions, NativeHost, OutputTarget};

        for release in [false, true] {
            let work = std::env::temp_dir().join(format!(
                "dezoomify-desktop-registration-{}-{release}",
                std::process::id()
            ));
            std::fs::create_dir_all(&work).unwrap();
            let output = work.join("image.png");
            let mut table = JobTable::new();
            let registration = table.insert("job:test").unwrap();
            // The frontend can now cancel or retire while the native worker
            // is still waiting to start on the blocking executor.
            if release {
                table.release_job("job:test");
            } else {
                table.live("job:test").unwrap().controls.cancel();
            }
            let mut host = NativeHost::new(JobOptions {
                input_url: work.join("image.dzi").to_string_lossy().into_owned(),
                output: OutputTarget::File(output.clone()),
                cache_dir: Some(work.join("cache")),
                ..JobOptions::default()
            })
            .unwrap();
            host.controls = registration.controls.clone();
            let error = host
                .transport
                .block_on(dezoomify::dezoomify(
                    host.inputs(),
                    host.algorithm_options(),
                    &host,
                ))
                .unwrap_err();
            assert_eq!(error, Error::Cancelled);
            assert!(host.publication().is_none());
            assert!(!output.exists());
            drop(host);
            std::fs::remove_dir_all(work).unwrap();
        }
    }
    #[test]
    fn expired_interaction_cannot_answer_a_new_question() {
        let registration = Registration::new();
        let (first, first_answer) = registration.request_partial();
        drop(first_answer);
        let (second, mut answer) = registration.request_partial();
        assert!(registration
            .answer_partial(first, RecoveryChoice::Discard)
            .is_err());
        registration
            .answer_partial(second, RecoveryChoice::Keep)
            .unwrap();
        assert_eq!(answer.try_recv().unwrap(), RecoveryChoice::Keep);
    }
}
