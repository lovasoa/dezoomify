use std::collections::HashMap;
use std::sync::{Arc, Mutex};

mod support;
use support::{http_response, scenario_payload, serve_counted, temp_dir, DZI_512};

fn setup_three_of_four() -> (String, Arc<Mutex<HashMap<String, usize>>>) {
    let shared: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::new(Mutex::new(HashMap::new()));
    let counts: Arc<Mutex<HashMap<String, usize>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let mut map = shared.lock().expect("lock");
        map.insert(
            "/pyr.dzi".to_string(),
            http_response("200 OK", "application/xml", DZI_512.as_bytes()),
        );
        for tile in ["0_0", "1_0", "0_1"] {
            let bytes = scenario_payload(&format!("tile-{tile}.png"));
            map.insert(
                format!("/pyr_files/9/{tile}.png"),
                http_response("200 OK", "image/png", &bytes),
            );
        }
        // The last tile is permanently missing.
        map.insert(
            "/pyr_files/9/1_1.png".to_string(),
            http_response("404 Not Found", "text/plain", b"tile failure"),
        );
    }
    let base = serve_counted(Arc::clone(&shared), Arc::clone(&counts));
    (base, counts)
}

#[test]
fn retries_zero_sends_no_second_request() {
    // Explicit `Fail` keeps this a retry-counting test: the missing tile
    // fails honestly with no output (default `Keep` would keep a partial).
    let (base, counts) = setup_three_of_four();
    let input = format!("{base}/pyr.dzi");
    let out_dir = temp_dir("zero");
    let output = out_dir.join("zero.png");
    let error = support::run_file(&input, &output, |options| {
        options.max_retries = 0;
        options.keep_partial = false;
    })
    .expect_err("missing tile fails");
    assert!(matches!(
        error,
        dezoomify::model::Error::PartialDiscarded { .. }
    ));
    assert!(!output.exists());
    let counts = counts.lock().expect("lock");
    // The missing tile is never refetched with retries=0.
    assert_eq!(
        counts.get("/pyr_files/9/1_1.png").copied().unwrap_or(0),
        1,
        "missing tile requested once with retries=0: {counts:?}"
    );
}
