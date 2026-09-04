//! Deterministic fixture-server binary: loopback only, ephemeral ports.

use dezoomify_fixture_server::{AppState, RouteTable};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn usage() -> ! {
    eprintln!(
        "usage: dezoomify-fixture-server [--port N] [--write-address PATH] \
         [--scenarios-dir DIR] [--static-dir DIR] [--request-log PATH]"
    );
    std::process::exit(2);
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut port: u16 = 0;
    let mut write_address: Option<PathBuf> = None;
    let mut scenarios_dir = PathBuf::from("testdata/scenarios");
    let mut static_dir: Option<PathBuf> = None;
    let mut request_log: Option<PathBuf> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                port = args
                    .get(i)
                    .unwrap_or_else(|| usage())
                    .parse()
                    .unwrap_or_else(|_| usage());
            }
            "--write-address" => {
                i += 1;
                write_address = Some(args.get(i).unwrap_or_else(|| usage()).into());
            }
            "--scenarios-dir" => {
                i += 1;
                scenarios_dir = args.get(i).unwrap_or_else(|| usage()).into();
            }
            "--static-dir" => {
                i += 1;
                static_dir = Some(args.get(i).unwrap_or_else(|| usage()).into());
            }
            "--request-log" => {
                i += 1;
                request_log = Some(args.get(i).unwrap_or_else(|| usage()).into());
            }
            _ => usage(),
        }
        i += 1;
    }
    // Loopback only: never bind a non-loopback address.
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let routes = RouteTable::load(&scenarios_dir).unwrap_or_else(|e| {
        eprintln!("error: {e}");
        std::process::exit(1);
    });
    let state = AppState {
        routes: Arc::new(routes),
        scenarios_dir,
        static_dir,
        origin: format!("http://{addr}"),
        log: Arc::new(Mutex::new(Vec::new())),
        log_path: request_log,
    };
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("error: bind {addr}: {e}");
            std::process::exit(1);
        });
    let bound = listener.local_addr().expect("local_addr");
    // Report the loopback origin now that the port is known.
    let origin = format!("http://{bound}");
    let state = AppState { origin, ..state };
    if let Some(path) = &write_address {
        // Write exactly one parseable address, only after listening.
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).unwrap_or_else(|e| {
                    eprintln!("error: create dir {}: {e}", parent.display());
                    std::process::exit(1);
                });
            }
        }
        std::fs::write(path, format!("{bound}\n")).unwrap_or_else(|e| {
            eprintln!("error: write address {}: {e}", path.display());
            std::process::exit(1);
        });
    }
    eprintln!("fixture server listening at http://{bound}");
    axum::serve(listener, dezoomify_fixture_server::router(state))
        .await
        .expect("serve");
}
