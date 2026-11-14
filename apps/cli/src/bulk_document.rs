//! Ordered multi-image document saving and honest publication reporting.
use super::{
    arguments::Args, interrupt::Interrupt, job_options_for, report, run_native_with_page, Throttler,
};
use dezoomify::model::Error;
use dezoomify_native::{Controls, OutputDocument, OutputTarget};
use std::path::Path;

pub(crate) fn run(parsed: &Args, entries: &[(String, Option<String>)], destination: &Path) -> i32 {
    match save(parsed, entries, destination) {
        Ok(status) => status,
        Err(error) => {
            if parsed.json {
                println!(
                    "{}",
                    serde_json::json!({"kind":"bulk-completed", "total":entries.len(), "succeeded":0, "failed":1, "error":error})
                );
            }
            eprintln!("error: {error} ({})", error.cause().kind());
            1
        }
    }
}

fn save(
    parsed: &Args,
    entries: &[(String, Option<String>)],
    destination: &Path,
) -> Result<i32, Error> {
    let options = job_options_for(parsed, &entries[0].0, destination);
    let mut document = OutputDocument::new(
        OutputTarget::File(destination.into()),
        parsed.overwrite,
        options.output_retain_cap,
    )?;
    let controls = Controls::default();
    let interrupt = Interrupt::watch(controls.clone())?;
    let mut throttler = Throttler::new(parsed.min_interval);
    let mut completed = Vec::new();
    let mut failure = None;
    for (index, (url, _title)) in entries.iter().enumerate() {
        if controls.is_cancelled() || !throttler.wait_interruptible(&interrupt) {
            failure = Some(Error::Cancelled);
            break;
        }
        let page = match document.page() {
            Ok(page) => page,
            Err(error) => {
                failure = Some(error);
                break;
            }
        };
        match run_native_with_page(
            parsed,
            url,
            destination,
            None,
            Some(page),
            Some(controls.clone()),
        ) {
            Ok(result) => completed.push((index, url, result.output)),
            Err(error) => {
                failure = Some(error);
                break;
            }
        }
    }
    let publication = document.finish().inspect_err(|_| {
        if let Some(error) = &failure {
            eprintln!(
                "download stopped before document finalization: {error} ({})",
                error.cause().kind()
            );
        }
    })?;
    let succeeded = publication
        .as_ref()
        .map_or(0, |publication| publication.pages);
    if let Some(publication) = &publication {
        for (page, (index, url, _output)) in completed.iter().enumerate() {
            if parsed.json {
                let mut item =
                    report::BulkItem::ok(*index, url, &publication.path.to_string_lossy());
                item.page = Some(page + 1);
                println!("{}", report::machine_bulk_item(&item));
            }
        }
        if !parsed.json && report::show_success(&parsed.logging) {
            eprintln!(
                "saved {} pages to {}",
                succeeded,
                publication.path.display()
            );
        }
    }
    if let Some(error) = &failure {
        let index = completed.len();
        let url = entries.get(index).map_or("", |entry| entry.0.as_str());
        if parsed.json {
            println!(
                "{}",
                report::machine_bulk_item(&report::BulkItem::failed(
                    index,
                    url,
                    &destination.to_string_lossy(),
                    error
                ))
            );
        }
        eprintln!(
            "stopped after {succeeded} complete pages: {error} ({})",
            error.cause().kind()
        );
    }
    if parsed.json {
        let mut summary = serde_json::json!({"kind":"bulk-completed", "total":entries.len(), "succeeded":succeeded, "failed":usize::from(failure.is_some()), "skipped":entries.len().saturating_sub(completed.len() + usize::from(failure.is_some()))});
        if let Some(publication) = &publication {
            summary["output"] = publication.path.to_string_lossy().as_ref().into();
            summary["pages"] = publication.pages.into();
        }
        if let Some(error) = &failure {
            summary["error"] = serde_json::to_value(error)
                .map_err(|error| Error::Internal(error.to_string().into()))?;
        }
        println!("{summary}");
    }
    Ok(i32::from(failure.is_some()))
}
