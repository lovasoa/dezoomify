// Single source of truth for every command exposed by the desktop shell.
//
// This file is included by the library, the Tauri build script, and the
// real-window handler registration. Keep the callback shape: each consumer
// decides whether it needs identifiers or their string names.
macro_rules! desktop_commands {
    ($callback:ident) => {
        $callback!(
            dezoomify,
            cancel_job,
            pause_job,
            resume_job,
            answer_partial,
            open_saved_output,
            release_job,
            get_job_diagnostics
        )
    };
}
