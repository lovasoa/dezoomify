use crate::arguments::Args;
use dezoomify::model::DiagnosticLevel;
use dezoomify_native::diagnostics::Diagnostics;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::sync::{Mutex, OnceLock};

static FILE: OnceLock<Mutex<File>> = OnceLock::new();

pub fn prepare(args: &Args) -> Result<(), String> {
    if let Some(path) = &args.diagnostics {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .map_err(|e| format!("cannot create diagnostic report: {e}"))?;
        if args.output.as_ref().is_some_and(|output| {
            output
                .canonicalize()
                .ok()
                .zip(path.canonicalize().ok())
                .is_some_and(|(a, b)| a == b)
        }) {
            return Err("the image and diagnostic report need different paths".into());
        }
        let _ = FILE.set(Mutex::new(file));
    }
    Ok(())
}

pub fn start(args: &Args) -> Diagnostics {
    let diagnostics = Diagnostics::new("cli", crate::arguments::APP_VERSION);
    let level = args.logging.clone();
    diagnostics.set_sink(move |record| {
        let show = match record.level {
            DiagnosticLevel::Trace => level == "trace",
            DiagnosticLevel::Debug => level == "trace" || level == "debug",
            DiagnosticLevel::Info => !matches!(level.as_str(), "error" | "warn"),
            DiagnosticLevel::Warn => level != "error",
            DiagnosticLevel::Error => true,
        };
        // Existing human progress and final output own these milestones.
        if !show
            || matches!(
                record.event.as_str(),
                "start"
                    | "phase"
                    | "completed"
                    | "partial-completed"
                    | "failed"
                    | "runtime-failed"
                    | "validation-failed"
            )
        {
            return;
        }
        eprintln!(
            "+{:.3}s {} {}",
            record.elapsed_ms / 1000.0,
            record.event,
            serde_json::to_string(&record.fields).unwrap_or_default()
        );
    });
    diagnostics
}

pub fn save(diagnostics: &Diagnostics) {
    let Some(file) = FILE.get() else {
        return;
    };
    let result = (|| {
        let mut file = file
            .lock()
            .map_err(|_| std::io::Error::other("report writer unavailable"))?;
        serde_json::to_writer(&mut *file, &diagnostics.report())?;
        file.write_all(b"\n")?;
        file.flush()
    })();
    if let Err(error) = result {
        eprintln!("warning: could not write diagnostic report: {error}");
    }
}
