#![allow(dead_code)]
use dezoomify::model::Progress;
use dezoomify_native::{
    Controls, JobOptions, NativeError, NativeHost, OutputSummary, OutputTarget,
};
use std::path::Path;

pub fn run_options_observed(
    options: JobOptions,
    mut observe: impl FnMut(&Controls, &Progress),
) -> Result<OutputSummary, NativeError> {
    let host = NativeHost::new(options)?;
    let controls = host.controls.clone();
    host.on_progress(move |progress| observe(&controls, &progress));
    run_host(&host)
}

pub fn run_host(host: &NativeHost<'_>) -> Result<OutputSummary, NativeError> {
    let result = host.transport.block_on(dezoomify::dezoomify(
        host.inputs(),
        host.algorithm_options(),
        host,
    ));
    if let Err(error) = &result {
        host.diagnostics.finish(
            if error.code == "job.cancelled" {
                "cancelled"
            } else {
                "failed"
            },
            serde_json::json!({"code": error.code, "message": error.message}),
        );
    }
    result.map_err(NativeError::from)?;
    host.publication()
        .ok_or_else(|| NativeError::new("native.internal", "output was not published"))
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

pub fn run_with_options(
    input_url: &str,
    output: &str,
    overwrite: bool,
    options: &JobOptions,
    on_progress: &mut dyn FnMut(&Progress),
) -> Result<OutputSummary, NativeError> {
    run_options_observed(
        options_for_target(input_url, output, overwrite, options),
        |_, progress| on_progress(progress),
    )
}

pub fn run_with_options_observed(
    input_url: &str,
    output: &str,
    overwrite: bool,
    options: &JobOptions,
    observe: impl FnMut(&Controls, &Progress),
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
