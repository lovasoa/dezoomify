//! Golden-driven discovery/plan checks for `web/*/expected/core.json`.
//!
//! Every case is planned from its scenario's `payloads/` bytes and asserted
//! against the golden's format, image size, tile count, and first/last tile
//! URIs. Offline-impossible cases are listed in `SKIPPED`; a case that is
//! neither asserted nor listed fails the run.

use std::path::{Path, PathBuf};

use dezoomify::core::{DiscoveredEntry, ResolvedImage, default_registry};
mod support;
use support::grid;

/// Origin substituted for `{{origin}}` in payloads; goldens pin tile URIs to
/// `http://127.0.0.1:PORT` and are normalized to this origin before comparison.
const ORIGIN: &str = "http://127.0.0.1";

/// Every `web/*/expected/core.json` golden, one line each.
macro_rules! core_goldens {
    ($($name:literal),* $(,)?) => {
        &[$((
            $name,
            include_str!(concat!(
                "../../../testdata/scenarios/",
                $name,
                "/expected/core.json"
            )),
        )),*]
    };
}

const CORE_GOLDENS: &[(&str, &str)] = core_goldens![
    "web/core-discovery",
    "web/iiif-discovery",
    "web/seadragon-pages",
    "web/site-adapters",
    "web/topviewer",
    "web/zoomify-pages",
];

/// Cases deliberately not asserted offline. Every skipped case keeps its
/// reason next to it; the run fails when a golden case is in neither the
/// asserted flow nor this list.
const SKIPPED: &[(&str, &str, &str)] = &[
    // Viewer pages whose distillation stores no page payload.
    (
        "web/core-discovery",
        "https://fixtures.test/mirador?manifest=https://fixtures.test/iiif-presentation/manifest.json",
        "no payload serves the /mirador viewer page",
    ),
    (
        "web/core-discovery",
        "https://fixtures.test/uv/#?manifest=https%3A%2F%2Ffixtures.test%2Fiiif-presentation%2Fmanifest.json",
        "no payload serves the /uv viewer page",
    ),
    // The tile-info payload is stored under i.micr.io while the page and the
    // plan use iiif.micr.io: the corpus stores no bytes for the fetch.
    (
        "web/core-discovery",
        "https://fixtures.test/micrio-custom-element",
        "payloads/i.micr.io/KEimL/info.json does not answer the iiif.micr.io fetch",
    ),
    // External viewer pages with no stored payload for the input URL.
    (
        "web/iiif-discovery",
        "https://viewer.onb.ac.at/10048A37/",
        "no payload serves the viewer.onb.ac.at page (only api.onb.ac.at metadata)",
    ),
    (
        "web/seadragon-pages",
        "https://www.bl.uk/manuscripts/Viewer.aspx?ref=burney_ms_276_f031ar",
        "no payload serves the Viewer.aspx page (only the Proxy.ashx metadata)",
    ),
    (
        "web/seadragon-pages",
        "https://polona.pl/item/9388882/0/",
        "no payload serves the polona.pl viewer page (only the resources JSON)",
    ),
    (
        "web/seadragon-pages",
        "https://nla.gov.au/nla.obj-152642460/view",
        "no payload serves the /view page (only the /dzi metadata)",
    ),
    // The pnav payloads (page w=1000&h=1000, image.json 512x512) cannot
    // reproduce the pinned probe plan (w=2000&h=2000&cw=512&ch=512), and
    // pnav geometry comes from a live size probe without a declared grid.
    (
        "web/core-discovery",
        "https://fixtures.test/entity/OBJECT/1",
        "pnav probe plan cannot be reproduced from the stored payloads",
    ),
    // The viewer page pins a TopViewer JSON under images.memorix.nl/demo/...
    // with no stored payload (the corpus stores a different memorix JSON).
    (
        "web/core-discovery",
        "https://fixtures.test/topviewer/page?FIF=not-iip",
        "the page's memorix JSON is not stored",
    ),
    // External TopViewer viewer pages with no stored payloads.
    (
        "web/topviewer",
        "https://www.beeldbankgroningen.nl/beelden/detail/53479cae-899f-0ac1-8913-40276a93a4f7/media/1c7914ee-3f37-0d37-3218-48eba1c3a97f?mode=detail&view=horizontal&rows=1&page=4&fq%5B%5D=search_s_download:%22Nee%22&sort=random%7B1785398988616%7D%20asc",
        "no payload serves the beeldbankgroningen viewer page",
    ),
    (
        "web/topviewer",
        "https://historischarchief.midden-groningen.nl/collectie/beelden/beelden-view/?mode=gallery&view=horizontal&sort=random%7B1785398881908%7D%20asc",
        "no payload serves the historischarchief viewer page",
    ),
];

fn format_id(display: &str) -> &str {
    match display {
        "Zoomify" => "zoomify",
        "Seadragon (Deep Zoom Image)" => "deepzoom",
        "IIIF" => "iiif",
        "IIPImage" => "iipimage",
        "krpano" => "krpano",
        "XLimage" => "xlimage",
        "TopViewer" => "topviewer",
        "FSI" => "fsi",
        "LizardTech ImageServer" => "lizardtech",
        "VLS" => "vls",
        "Hungaricana" => "hungaricana",
        "WMTS" => "wmts",
        "ArcGIS MapServer" => "arcgis",
        "pnav" => "pnav",
        other => panic!("golden names unknown format display {other:?}"),
    }
}

/// Goldens pin tile URIs to the harness origin recorded as `:PORT`.
fn normalize(uri: &str) -> String {
    uri.replace("http://127.0.0.1:PORT", ORIGIN)
}

fn payloads_dir(scenario: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata/scenarios")
        .join(scenario)
        .join("payloads")
}

/// Payload layout lookup (`payloads/{host}{url-path}`, query ignored),
/// with the corpus's suffix (`MapServer.json`) and index (`.../index.html`)
/// spellings resolved as documented fallbacks.
fn laid_out_payload(payloads: &Path, uri: &str) -> Option<Vec<u8>> {
    let url = url::Url::parse(uri).ok()?;
    let host = url.host_str()?;
    let path = url.path().trim_start_matches('/');
    let base = payloads.join(host).join(path);
    let candidates = if path.is_empty() || path.ends_with('/') {
        vec![base.join("index.html")]
    } else {
        let mut with_suffix: Vec<PathBuf> = [".xml", ".dzi", ".json", ".html", ".txt", ".php.xml"]
            .iter()
            .map(|ext| PathBuf::from(format!("{}{ext}", base.to_string_lossy())))
            .collect();
        with_suffix.insert(0, base.clone());
        with_suffix
    };
    for candidate in candidates {
        if let Ok(bytes) = std::fs::read(&candidate) {
            return Some(substitute(bytes, host));
        }
    }
    None
}

/// Payloads carry `{{origin}}`/`{{host}}` placeholders (the fixture server
/// substitutes them at serve time); text payloads only.
fn substitute(bytes: Vec<u8>, host: &str) -> Vec<u8> {
    if bytes.windows(2).any(|w| w == b"{{") {
        String::from_utf8(bytes)
            .map(|text| {
                text.replace("{{origin}}", ORIGIN)
                    .replace("{{host}}", host)
                    .into_bytes()
            })
            .unwrap_or_else(|text| text.into_bytes())
    } else {
        bytes
    }
}

fn discover(scenario: &str, input: &str) -> Result<ResolvedImage, String> {
    // Deferred catalog entries name their real target (e.g. an IIIF
    // Presentation manifest naming an image service): follow with a fresh
    // bounded discovery, matching the pipeline's deferred resolution.
    let mut current = input.to_string();
    for _ in 0..3 {
        match discover_once(scenario, &current)? {
            DiscoveredEntry::Ready(image) => return Ok(image),
            DiscoveredEntry::Deferred(deferred) => current = deferred.uri,
        }
    }
    Err("deferred entries exhausted the follow bound".to_string())
}

fn discover_once(scenario: &str, input: &str) -> Result<DiscoveredEntry, String> {
    let payloads = payloads_dir(scenario);
    support::discover_with(default_registry(), input, |uri| {
        laid_out_payload(&payloads, uri)
    })
    .map_err(|error| format!("discovery failed: {error:?}"))?
    .into_entries()
    .into_iter()
    .next()
    .ok_or_else(|| "no image discovered".to_string())
}

fn plan_case(scenario: &str, case: &serde_json::Value) -> Result<(), String> {
    let input = case["input"].as_str().expect("case input");
    let image = discover(scenario, input)?;
    let expected_format = format_id(case["format"].as_str().expect("case format"));
    if image.format != expected_format {
        return Err(format!(
            "format {:?} != golden {expected_format:?}",
            image.format
        ));
    }
    let width = case["width"].as_u64().expect("case width");
    let height = case["height"].as_u64().expect("case height");
    let level = image
        .levels
        .iter()
        .find(|level| {
            grid(level).is_ok_and(|grid| {
                let size = grid.image_size();
                u64::from(size.x) == width && u64::from(size.y) == height
            })
        })
        .ok_or_else(|| {
            let sizes: Vec<_> = image
                .levels
                .iter()
                .map(|level| match grid(level) {
                    Ok(grid) => format!("{:?}", grid.image_size()),
                    Err(reason) => reason,
                })
                .collect();
            format!("no level at golden size {width}x{height}; levels: {sizes:?}")
        })?;
    let tiles: Vec<String> =
        support::tile_urls(level).map_err(|reason| format!("level at golden size: {reason}"))?;
    let count = case["tileCount"].as_u64().expect("case tileCount");
    if tiles.len() as u64 != count {
        return Err(format!("tile count {} != golden {count}", tiles.len()));
    }
    let first = normalize(case["firstTile"].as_str().expect("case firstTile"));
    let last = normalize(case["lastTile"].as_str().expect("case lastTile"));
    if tiles.first().map(String::as_str) != Some(first.as_str()) {
        return Err(format!(
            "first tile {:?} != golden {first:?}",
            tiles.first()
        ));
    }
    if tiles.last().map(String::as_str) != Some(last.as_str()) {
        return Err(format!("last tile {:?} != golden {last:?}", tiles.last()));
    }
    Ok(())
}

#[test]
fn web_core_goldens_match_discovery_and_planning() {
    let mut failures = Vec::new();
    let mut asserted = 0usize;
    for (scenario, raw) in CORE_GOLDENS {
        let golden: serde_json::Value = serde_json::from_str(raw).expect("golden parses");
        for case in golden["cases"].as_array().expect("golden cases") {
            let input = case["input"].as_str().expect("case input").to_string();
            if SKIPPED
                .iter()
                .any(|(s, i, _)| *s == *scenario && *i == input)
            {
                continue;
            }
            match plan_case(scenario, case) {
                Ok(()) => asserted += 1,
                Err(reason) => failures.push(format!("{scenario} {input}: {reason}")),
            }
        }
    }
    assert!(
        failures.is_empty(),
        "core golden mismatches:\n{}",
        failures.join("\n")
    );
    assert!(asserted >= 25, "too few asserted cases: {asserted}");

    // Every skip entry must still exist in a golden, and every skipped case
    // must match exactly: stale or misspelled skips fail here instead of
    // silently covering nothing.
    for (scenario, input, reason) in SKIPPED {
        let golden: serde_json::Value = CORE_GOLDENS
            .iter()
            .find(|(s, _)| s == scenario)
            .map(|(_, raw)| serde_json::from_str(raw).expect("golden parses"))
            .unwrap_or_else(|| panic!("skip names unknown scenario {scenario}"));
        let found = golden["cases"]
            .as_array()
            .expect("golden cases")
            .iter()
            .any(|case| case["input"].as_str() == Some(*input));
        assert!(
            found,
            "skip entry {scenario} {input} ({reason}) matches no golden case"
        );
    }
}
