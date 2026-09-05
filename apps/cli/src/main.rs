mod arguments;
mod report;

use dezoomify_native::{JobRequest, NativeRuntime};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match arguments::parse(&args) {
        Ok(parsed) => parsed,
        Err(message) => {
            if message.starts_with("usage:") || message.starts_with("dezoomify-cli") {
                println!("{message}");
                std::process::exit(0);
            }
            eprintln!("error: {message}");
            std::process::exit(2);
        }
    };
    let runtime = NativeRuntime::new(1 << 30);
    let mut handle = match runtime.start(JobRequest {
        input_url: parsed.input,
        output_path: parsed.output.to_string_lossy().into_owned(),
        overwrite: parsed.overwrite,
    }) {
        Ok(handle) => handle,
        Err(message) => {
            eprintln!("error: {message}");
            std::process::exit(1);
        }
    };
    // Honest scaffold: the native HTTP/decode/encode pipeline is not wired
    // yet (see crates/dezoomify-native: no HTTP client or image codecs).
    // Never print fake progress/completion or a stub hash for real inputs.
    handle.emit("started");
    if parsed.json {
        println!("{}", report::machine_event("started", &handle.id, 1));
    } else {
        eprintln!("started {}", handle.id);
    }
    eprintln!("error: native download pipeline not yet implemented in this preview build");
    std::process::exit(1);
}
