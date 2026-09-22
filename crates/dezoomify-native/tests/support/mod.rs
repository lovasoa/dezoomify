#![allow(dead_code)]

use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

use dezoomify::model::RecoveryChoice;
use dezoomify_native::{
    start_job, JobOptions, JobSnapshot, NativeError, OutputSummary, OutputTarget, RunningJob,
    UserCommand,
};

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(60);

/// Start the same native job service used by the CLI and desktop app.
pub fn start_file(
    input_url: &str,
    output: &Path,
    configure: impl FnOnce(&mut JobOptions),
) -> Result<RunningJob, NativeError> {
    let mut options = JobOptions {
        input_url: input_url.to_string(),
        output: OutputTarget::File(output.to_path_buf()),
        ..JobOptions::default()
    };
    configure(&mut options);
    start_job(options)
}

/// Run one native job while observing the actual job snapshots. Partial
/// decisions are answered with the requested keep/fail behavior, as in CLI.
pub fn run_options_observed(
    options: JobOptions,
    mut observe: impl FnMut(&RunningJob, &JobSnapshot),
) -> Result<OutputSummary, NativeError> {
    let keep_partial = options.keep_partial;
    let job = start_job(options)?;
    drive_to_terminal(&job, keep_partial, &mut observe);
    job.join()
}

pub fn run_file(
    input_url: &str,
    output: &Path,
    configure: impl FnOnce(&mut JobOptions),
) -> Result<OutputSummary, NativeError> {
    let mut options = JobOptions {
        input_url: input_url.to_string(),
        output: OutputTarget::File(output.to_path_buf()),
        ..JobOptions::default()
    };
    configure(&mut options);
    run_options_observed(options, |_, _| {})
}

/// Run configured native options through the same job service used by products.
pub fn run_with_options(
    input_url: &str,
    output: &str,
    overwrite: bool,
    options: &JobOptions,
    on_snapshot: &mut dyn FnMut(&dezoomify::model::Snapshot),
) -> Result<OutputSummary, NativeError> {
    let options = options_for_target(input_url, output, overwrite, options);
    run_options_observed(options, |_, snapshot| on_snapshot(&snapshot.snapshot))
}

/// Run from effect settings while allowing a test to send real live commands
/// in response to snapshots (for example, `UserCommand::Cancel`).
pub fn run_with_options_observed(
    input_url: &str,
    output: &str,
    overwrite: bool,
    options: &JobOptions,
    observe: impl FnMut(&RunningJob, &JobSnapshot),
) -> Result<OutputSummary, NativeError> {
    run_options_observed(
        options_for_target(input_url, output, overwrite, options),
        observe,
    )
}

fn options_for_target(
    input_url: &str,
    output: &str,
    overwrite: bool,
    options: &JobOptions,
) -> JobOptions {
    let mut options = options.clone();
    options.input_url = input_url.to_string();
    options.output = OutputTarget::File(output.into());
    options.overwrite = overwrite;
    options
}

fn drive_to_terminal(
    job: &RunningJob,
    keep_partial: bool,
    observe: &mut impl FnMut(&RunningJob, &JobSnapshot),
) {
    loop {
        let snapshot = match job.snapshots().recv_timeout(SNAPSHOT_TIMEOUT) {
            Ok(snapshot) => snapshot,
            Err(RecvTimeoutError::Timeout) => {
                // A quiet job is cancelled through the same public command
                // as a user cancellation; keep draining so join owns cleanup.
                let _ = job.send(UserCommand::Cancel);
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        if let Some(decision) = snapshot.snapshot.decision.as_ref() {
            let choice = if keep_partial {
                RecoveryChoice::Keep
            } else {
                RecoveryChoice::Discard
            };
            let _ = job.send(UserCommand::AnswerPartial {
                generation: decision.generation,
                decision: choice,
            });
        }
        observe(job, &snapshot);
        if snapshot.snapshot.terminal.is_some() {
            return;
        }
    }
}
