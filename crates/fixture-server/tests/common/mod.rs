//! Shared support: Node owns the loopback server and signals readiness over stdio.

use dezoomify_fixture_server::NodeServer;

pub struct TestServer {
    pub base: String,
    // Other harnesses share this helper without log assertions.
    #[allow(dead_code)]
    log: std::path::PathBuf,
    _server: NodeServer,
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
        std::fs::write(dir.join("app.wasm"), b"\0asm\xff{{origin}}").expect("asset");
        // Symlink escape: a file inside the root pointing outside it.
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hostname", dir.join("escape.txt")).expect("symlink");
        let srv = Self::start_inner(Some(dir.clone())).await;
        (srv, dir)
    }

    async fn start_inner(static_dir: Option<std::path::PathBuf>) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let log =
            std::env::temp_dir().join(format!("dz-requests-{}-{id}.jsonl", std::process::id()));
        let mut args = vec!["--request-log".into(), log.to_string_lossy().into_owned()];
        if let Some(dir) = static_dir {
            args.extend(["--static-dir".into(), dir.to_string_lossy().into_owned()]);
        }
        let server = NodeServer::fixture(&args);
        TestServer {
            base: server.origin.clone(),
            log,
            _server: server,
        }
    }

    #[allow(dead_code)]
    pub fn log_text(&self) -> String {
        std::fs::read_to_string(&self.log).expect("request log")
    }

    #[allow(dead_code)]
    pub fn scenarios_path(rel: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/scenarios")
            .join(rel)
    }
}
