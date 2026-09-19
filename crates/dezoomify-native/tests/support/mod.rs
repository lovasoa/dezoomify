#![allow(dead_code)]

use std::path::Path;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

use dezoomify_native::pipeline::{PartialPolicy, PipelineConfig};
use dezoomify_native::{
    JobOptions, JobSnapshot, NativeError, NativeRunner, OutputSummary, OutputTarget, RunningJob,
    UserCommand,
};
use dezoomify_protocol::dto::RecoveryChoice;

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(60);

/// Start the same native runner used by CLI, desktop, and Native Messaging.
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
    NativeRunner::start(options)
}

/// Run one native job while observing the actual runner snapshots. Partial
/// decisions are answered with the requested keep/fail behavior, as in CLI.
pub fn run_options_observed(
    options: JobOptions,
    mut observe: impl FnMut(&RunningJob, &JobSnapshot),
) -> Result<OutputSummary, NativeError> {
    let keep_partial = options.keep_partial;
    let job = NativeRunner::start(options)?;
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

/// Compatibility for test settings expressed in terms of the host effect
/// configuration. Execution still goes through `NativeRunner`; only settings
/// are translated into its product options.
pub fn run_with_config(
    input_url: &str,
    output: &str,
    overwrite: bool,
    config: &PipelineConfig,
    on_snapshot: &mut dyn FnMut(&dezoomify_engine::JobSnapshot),
) -> Result<OutputSummary, NativeError> {
    let options = options_from_config(input_url, output, overwrite, config);
    run_options_observed(options, |_, snapshot| on_snapshot(&snapshot.snapshot))
}

/// Run from effect settings while allowing a test to send real live commands
/// in response to snapshots (for example, `UserCommand::Cancel`).
pub fn run_with_config_observed(
    input_url: &str,
    output: &str,
    overwrite: bool,
    config: &PipelineConfig,
    observe: impl FnMut(&RunningJob, &JobSnapshot),
) -> Result<OutputSummary, NativeError> {
    run_options_observed(
        options_from_config(input_url, output, overwrite, config),
        observe,
    )
}

fn options_from_config(
    input_url: &str,
    output: &str,
    overwrite: bool,
    config: &PipelineConfig,
) -> JobOptions {
    JobOptions {
        input_url: input_url.to_string(),
        output: OutputTarget::File(output.into()),
        overwrite,
        format: config.format.clone(),
        image_index: config.image_index,
        zoom_level: config.zoom_level,
        largest: config.largest,
        max_width: config.max_width,
        max_height: config.max_height,
        max_retries: config.max_retries,
        retry_base_delay: Duration::from_millis(config.retry_base_delay_ms),
        keep_partial: config.partial_policy == PartialPolicy::Keep,
        compression: config.compression,
        headers: config.user_headers.clone(),
        cache_dir: config.cache_dir.clone(),
        timeout: config.fetch.timeout,
        connect_timeout: config.fetch.connect_timeout,
        max_idle_per_host: config.fetch.max_idle_per_host,
        accept_invalid_certs: config.fetch.tls.accept_invalid_certs,
        max_concurrent: config.max_concurrent,
        min_interval: config.min_interval,
    }
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
                // A quiet runner is cancelled through the same public command
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
