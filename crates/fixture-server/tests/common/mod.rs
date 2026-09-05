//! Shared test support: spawn the server in-process on an ephemeral loopback
//! port. No sleep-based readiness: the bound address implies listen readiness.

use dezoomify_fixture_server::{AppState, RouteTable};
use std::sync::{Arc, Mutex};

pub struct TestServer {
    pub base: String,
    // Only security tests read the log today; other harnesses share this
    // helper without log assertions.
    #[allow(dead_code)]
    log: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl TestServer {
    pub async fn start() -> Self {
        Self::start_inner(None).await
    }

    /// Starts the server with a real static root holding a known file, so
    /// static-serving and traversal-guard branches actually run.
    #[allow(dead_code)]
    pub async fn start_with_static_dir() -> (Self, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("dz-static-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).expect("static dir");
        std::fs::write(dir.join("index.html"), b"<html>static-index</html>").expect("index");
        std::fs::write(dir.join("secret.txt"), b"static-canary").expect("secret");
        std::fs::write(dir.join("sub").join("page.html"), b"<html>sub-page</html>").expect("sub");
        // Symlink escape: a file inside the root pointing outside it.
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hostname", dir.join("escape.txt")).expect("symlink");
        let srv = Self::start_inner(Some(dir.clone())).await;
        (srv, dir)
    }

    async fn start_inner(static_dir: Option<std::path::PathBuf>) -> Self {
        let scenarios_dir =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/scenarios");
        let routes = RouteTable::load(&scenarios_dir).expect("load routes");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let bound = listener.local_addr().expect("addr");
        let log = Arc::new(Mutex::new(Vec::new()));
        let state = AppState {
            routes: Arc::new(routes),
            scenarios_dir,
            static_dir,
            origin: format!("http://{bound}"),
            log: Arc::clone(&log),
            log_path: None,
        };
        tokio::spawn(async move {
            axum::serve(listener, dezoomify_fixture_server::router(state))
                .await
                .expect("serve");
        });
        TestServer {
            base: format!("http://{bound}"),
            log,
        }
    }

    #[allow(dead_code)]
    pub fn log_text(&self) -> String {
        self.log
            .lock()
            .expect("log lock")
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Sends one raw HTTP/1.1 GET over a socket and returns (status, body).
    /// Used for hostile paths a real client would normalize before sending.
    #[allow(dead_code)]
    pub async fn raw_get(&self, path: &str) -> (u16, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let addr = self.base.trim_start_matches("http://").to_string();
        let mut stream = tokio::net::TcpStream::connect(&addr)
            .await
            .expect("connect");
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .expect("write");
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.expect("read");
        let text = String::from_utf8_lossy(&buf).to_string();
        let status: u16 = text
            .split_whitespace()
            .nth(1)
            .and_then(|p| p.parse().ok())
            .unwrap_or(0);
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (status, body)
    }

    pub fn scenarios_path(rel: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/scenarios")
            .join(rel)
    }
}
