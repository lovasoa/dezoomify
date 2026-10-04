//! Process adapters for Node-owned HTTP servers. Rust never binds a listener.

use base64::Engine;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

#[derive(serde::Deserialize)]
pub struct RawRequest {
    pub id: u64,
    pub connection: usize,
    pub head: String,
    pub path: String,
}

pub struct RawResponse {
    pub bytes: Vec<u8>,
    pub close: bool,
}

impl From<Vec<u8>> for RawResponse {
    fn from(bytes: Vec<u8>) -> Self {
        Self { bytes, close: true }
    }
}

pub struct NodeServer {
    pub origin: String,
    child: Child,
    input: Arc<Mutex<std::process::ChildStdin>>,
    output: Option<BufReader<std::process::ChildStdout>>,
    worker: Option<JoinHandle<()>>,
}

pub fn server_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixture-server.mjs")
}

impl NodeServer {
    fn spawn(script: PathBuf, args: &[String]) -> Self {
        let mut child = Command::new("node")
            .arg(script)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect(
                "start Node fixture server (the Node version from .node-version must be on PATH)",
            );
        let input = Arc::new(Mutex::new(child.stdin.take().expect("server stdin")));
        let mut output = BufReader::new(child.stdout.take().expect("server stdout"));
        let (ready, waiting) = std::sync::mpsc::channel();
        let reader = thread::spawn(move || {
            let mut line = String::new();
            output.read_line(&mut line).expect("read server readiness");
            ready.send((line, output)).ok();
        });
        let (line, output) = waiting
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap_or_else(|error| {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Node fixture server did not become ready: {error}");
            });
        reader.join().expect("readiness worker");
        let ready: serde_json::Value =
            serde_json::from_str(&line).expect("Node server readiness JSON");
        Self {
            origin: ready["origin"].as_str().expect("server origin").to_string(),
            child,
            input,
            output: Some(output),
            worker: None,
        }
    }

    pub fn fixture(args: &[String]) -> Self {
        let mut args = args.to_vec();
        args.push("--parent-stdio".into());
        args.push("--quiet".into());
        Self::spawn(server_script(), &args)
    }

    pub fn raw(
        host: &str,
        handler: impl Fn(RawRequest) -> RawResponse + Send + Sync + 'static,
    ) -> Self {
        let script = server_script().with_file_name("raw-server.mjs");
        let mut server = Self::spawn(script, &[host.to_string()]);
        let output = server.output.take().expect("server stdout");
        let input = Arc::clone(&server.input);
        let handler = Arc::new(handler);
        server.worker = Some(thread::spawn(move || {
            let mut workers = Vec::new();
            for line in output.lines() {
                let Ok(line) = line else { break };
                let request: RawRequest = serde_json::from_str(&line).expect("Node request JSON");
                let input = Arc::clone(&input);
                let handler = Arc::clone(&handler);
                workers.push(thread::spawn(move || {
                    let id = request.id;
                    let response = handler(request);
                    let line = serde_json::json!({ "id": id, "bytes": base64::engine::general_purpose::STANDARD.encode(response.bytes), "close": response.close });
                    // A cancelled test may stop Node while a delayed reply is pending.
                    let _ = writeln!(input.lock().expect("Node stdin lock"), "{line}");
                }));
            }
            let mut failure = None;
            for worker in workers {
                if let Err(error) = worker.join() {
                    failure = Some(error);
                }
            }
            if let Some(error) = failure {
                std::panic::resume_unwind(error);
            }
        }));
        server
    }

    pub fn port(&self) -> u16 {
        self.origin
            .rsplit(':')
            .next()
            .expect("server port")
            .parse()
            .expect("port number")
    }

    /// Stops the server and propagates assertions from request callbacks.
    pub fn join(mut self) -> thread::Result<()> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.worker.take().map_or(Ok(()), JoinHandle::join)
    }
}

impl Drop for NodeServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
