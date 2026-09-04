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
    handle.emit("started");
    let result = handle.finish("hash-stub".into());
    if parsed.json {
        println!("{}", report::machine_event("completed", &handle.id, 2));
    } else {
        eprintln!("{}", report::human_progress(1, 1));
        eprintln!("done {} ({})", handle.id, result.output_hash);
    }
}
