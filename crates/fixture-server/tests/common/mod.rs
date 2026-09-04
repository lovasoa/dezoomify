//! Shared test support: spawn the server in-process on an ephemeral loopback
//! port. No sleep-based readiness: the bound address implies listen readiness.

use dezoomify_fixture_server::{AppState, RouteTable};
use std::sync::{Arc, Mutex};

pub struct TestServer {
    pub base: String,
}

impl TestServer {
    pub async fn start() -> Self {
        let scenarios_dir =
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata/scenarios");
        let routes = RouteTable::load(&scenarios_dir).expect("load routes");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let bound = listener.local_addr().expect("addr");
        let state = AppState {
            routes: Arc::new(routes),
            scenarios_dir,
            static_dir: None,
            origin: format!("http://{bound}"),
            log: Arc::new(Mutex::new(Vec::new())),
            log_path: None,
        };
        tokio::spawn(async move {
            axum::serve(listener, dezoomify_fixture_server::router(state))
                .await
                .expect("serve");
        });
        TestServer {
            base: format!("http://{bound}"),
        }
    }

    pub fn scenarios_path(rel: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../testdata/scenarios")
            .join(rel)
    }
}
