//! Native resources retained for a desktop invocation and its saved result.
use crate::commands::CommandError;
use dezoomify::model::{DiagnosticReport, RecoveryChoice};
use dezoomify_native::{diagnostics::Diagnostics, Controls};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

pub const CHANNEL_PROGRESS: &str = "dezoomify://progress";
pub const CHANNEL_PARTIAL: &str = "dezoomify://partial";
pub const CHANNEL_DEEP_LINK: &str = "dezoomify://deep-link-pending";

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

    pub fn answer_partial(
        &self,
        question: u64,
        answer: RecoveryChoice,
    ) -> Result<(), CommandError> {
        let mut pending = self
            .partial
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !pending.as_ref().is_some_and(|(id, _)| *id == question) {
            return Err(CommandError::new(
                "interaction.expired",
                "The question is no longer open.",
            ));
        }
        if let Some((_, send)) = pending.take() {
            send.send(answer).map_err(|_| {
                CommandError::new("interaction.expired", "The question is no longer open.")
            })?;
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
    pub fn insert(&mut self, id: &str) -> Result<Arc<Registration>, CommandError> {
        if !crate::commands::is_valid_job_id(id) {
            return Err(CommandError::invalid_input(
                "job id must look like job:<suffix>",
            ));
        }
        if self.jobs.contains_key(id) {
            return Err(CommandError::new(
                "job.duplicate",
                "An invocation with this identity already exists.",
            ));
        }
        let entry = Arc::new(Registration::new());
        self.jobs.insert(id.into(), Arc::clone(&entry));
        Ok(entry)
    }
    pub fn get(&self, id: &str) -> Result<Arc<Registration>, CommandError> {
        self.jobs
            .get(id)
            .cloned()
            .ok_or_else(|| CommandError::unknown_job(id))
    }
    pub fn live(&self, id: &str) -> Result<Arc<Registration>, CommandError> {
        let entry = self.get(id)?;
        if entry.completed.load(Ordering::SeqCst) {
            return Err(CommandError::stale_job(id));
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
