//! `cargo xtask test live`: opt-in public-network compatibility checks that
//! run the REAL dezoomify-cli binary against the legacy live targets
//! (`migration-sources/dezoomify-rs/tests/live_dezoomers.rs`), asserting
//! auto-selected discovery and a real output image per still-alive site.
//!
//! The deterministic suite (`cargo xtask test`, `test all`) never touches
//! public networks. Live checks are explicit (`--public`), sequential,
//! credential-free (the CLI `-H` header path is the only cookie-bearing
//! route and only where a legacy target requires it), and bounded (per-fetch
//! timeout, size caps, width cap, limited redirects). Live failures never
//! replace deterministic regression coverage or block an ordinary pull
//! request. Dead or changed sites must be recorded in
//! `docs/migration/live-inventory.csv` (`status` column), never silently
//! skipped.

use std::process::Command;

struct LiveTarget {
    /// Legacy test name from `live_dezoomers.rs`.
    name: &'static str,
    /// Live-inventory ID (`docs/migration/live-inventory.csv`), assigned when
    /// the target is ported. Empty for duplicates of existing rows.
    inventory_id: &'static str,
    url: &'static str,
    /// Extra `-H` headers (trusted native memory; only where the legacy
    /// target requires them, e.g. BLB VLS `js_enabled=2`).
    headers: &'static [(&'static str, &'static str)],
    /// Legacy parity escape hatch, explicitly user-opted per target.
    accept_invalid_certs: bool,
    /// `alive` targets must produce a real image; `dead`/`http-only` targets
    /// are documented diagnostics whose failure does not fail the run.
    status: &'static str,
}

const TARGETS: &[LiveTarget] = &[
    LiveTarget {
        name: "google_arts_and_culture",
        inventory_id: "L36",
        url: "https://artsandculture.google.com/asset/liza-kottou-0113/3gGrYhjfhcwvbA",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "zoomify",
        inventory_id: "L37",
        url: "https://openseadragon.github.io/example-images/highsmith/highsmith_zdata/ImageProperties.xml",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "zoomify_ngv_viewer",
        inventory_id: "L38",
        url: "https://www.ngv.vic.gov.au/explore/collection/work/3867/",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "zoomify_express_viewer",
        inventory_id: "L39",
        url: "https://romanlaptev.github.io/codebase/js/plugins/zoomify/febr_js.html",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "zoomify_tile_service",
        inventory_id: "L40",
        url: "https://openseadragon.github.io/examples/tilesource-zoomify/",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "deep_zoom",
        inventory_id: "L32",
        url: "https://openseadragon.github.io/example-images/highsmith/highsmith.dzi",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "iiif",
        inventory_id: "L41",
        url: "https://i.micr.io/fhXoU/info.json",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "iiif_national_gallery",
        inventory_id: "L02",
        url: "https://www.nationalgallery.org.uk/paintings/vincent-van-gogh-sunflowers",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "iiif_philadelphia_museum",
        inventory_id: "L42",
        url: "https://www.philamuseum.org/objects/101731",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "iiif_csntm",
        inventory_id: "L43",
        url: "https://collections.csntm.org/image-service/iiif/MNTGRCGA01/default/M_NT_GRC_GA01_20250609_203r/M_NT_GRC_GA01_20250609_203r/info.json",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "iiif_onb_viewer",
        inventory_id: "L44",
        url: "https://viewer.onb.ac.at/10048A37/",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "iiif_oklahoma_contentdm",
        inventory_id: "L45",
        url: "https://dc.library.okstate.edu/digital/collection/OKMaps/id/6483/rec/6",
        headers: &[],
        // Legacy parity: this target always required --accept-invalid-certs.
        accept_invalid_certs: true,
        status: "alive",
    },
    LiveTarget {
        name: "iiif_liechtenstein_collections",
        inventory_id: "L46",
        url: "https://www.liechtensteincollections.at/en/collections-online/forest-landscape",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "iiif_nls_auchinleck",
        inventory_id: "L33",
        url: "https://auchinleck.nls.uk/imageserver/iipsrv.fcgi?iiif=/auchinleck/105v.jp2/info.json",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "iiif_nls_map_view",
        inventory_id: "L34",
        url: "https://map-view.nls.uk/iiif/19619%2F196194600/info.json",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "generic",
        inventory_id: "L47",
        url: "https://digital.blb-karlsruhe.de/image/tiler/square/2410801/0/{{X}}/{{Y}}",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "krpano",
        inventory_id: "L22",
        url: "https://krpano.com/panos/andreabiffi/galleria_04.xml",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "deepzoom_academia_sinica",
        inventory_id: "L48",
        url: "https://bronze.asdc.sinica.edu.tw/filePool/R/05395-1.html",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "deepzoom_paris",
        inventory_id: "L49",
        url: "https://bibliotheques-specialisees.paris.fr/ark:/73873/pf0001115743/0017/v0001.simple.selectedTab=otherdocs",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "iiif_washington_mirador",
        inventory_id: "L50",
        url: "https://digitalcollections.lib.washington.edu/digital/custom/mirador3?manifest=https://digitalcollections.lib.washington.edu//iiif/info/social/1303/manifest.json",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "iipimage",
        inventory_id: "L51",
        url: "https://image.hng-data.org/iipsrv/iipsrv.fcgi?FIF=/HNG/016/card/0178.tif&OBJ=Max-size&OBJ=Tile-size&OBJ=Resolution-number",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    // lovasoa/dezoomify#772: National Library of New Zealand. Alive for real
    // browsers but fronted by an Incapsula JS challenge, so the CLI receives
    // the challenge HTML instead of IIP metadata. Kept as a documented
    // diagnostic; failure does not fail the run.
    LiveTarget {
        name: "iipimage_natlib",
        inventory_id: "L63",
        url: "https://ndhadeliver.natlib.govt.nz/iipsrv?FIF=2013/04/19/ac_3/V1-FL16627598.jp2",
        headers: &[],
        accept_invalid_certs: false,
        status: "dead",
    },
    LiveTarget {
        name: "custom_yaml",
        inventory_id: "L52",
        url: "https://raw.githubusercontent.com/lovasoa/dezoomify-rs/master/tiles.yaml",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "topviewer",
        inventory_id: "L53",
        url: "https://images.memorix.nl/wba/topviewjson/memorix/6eb5a89b-b76c-5039-3999-aabfd7a0c7c9",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "topviewer_media_api",
        inventory_id: "L54",
        url: "https://webservices.memorix.nl/mediabank/media/1216f2dc-2308-11e0-acba-74f6d356987f?apiKey=69111262-af4a-11e3-9967-3860770fff49&entities%5B0%5D=d7c76800-a22b-5f1c-e991-15b3dd0d4f2f",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "fsi",
        inventory_id: "L55",
        url: "https://fsi-site.neptunelabs.com/fsi/server?type=info&source=images%2Fsamples%2Fthumbnails%2Fzoom_default_skin.tif",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "fsi_viewer_page",
        inventory_id: "L56",
        url: "https://www.neptunelabs.com/fsi-server/",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "hungaricana",
        inventory_id: "L57",
        url: "https://gallery.hungaricana.hu/en/SzerencsKepeslap/1168634/?img=0",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "vls",
        inventory_id: "L18",
        url: "https://digital.blb-karlsruhe.de/blbhs/content/zoom/2410801",
        headers: &[("Cookie", "js_enabled=2")],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "wmts",
        inventory_id: "L58",
        url: "https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/WMTS/1.0.0/WMTSCapabilities.xml",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "arcgis",
        inventory_id: "L59",
        url: "https://wmts.ngi.be/arcgis/rest/services/20k__%7BD67270FA-BDEC-4A9F-95D1-BEC0C75BA45E%7D__default__404000/MapServer",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
    LiveTarget {
        name: "arcgis_basemap_url",
        inventory_id: "L60",
        url: "http://www.cartesius.be/arcgis/home/webmap/viewer.html?basemapUrl=https://wmts.ngi.be/arcgis/rest/services/20k__%7BD67270FA-BDEC-4A9F-95D1-BEC0C75BA45E%7D__default__404000/MapServer&lang=nl",
        headers: &[],
        accept_invalid_certs: false,
        status: "http-only",
    },
    LiveTarget {
        name: "lizardtech",
        inventory_id: "L61",
        url: "http://cartweb.geography.ua.edu/lizardtech/iserv/calcrgn?cat=North%20America%20and%20United%20States&item=NorthAmerica/US1566a.sid&wid=500&hei=400&props=item(Name,Description),cat(Name,Description)&style=default/view.xsl&plugin=true",
        headers: &[],
        accept_invalid_certs: false,
        status: "http-only",
    },
    LiveTarget {
        name: "xlimage",
        inventory_id: "L62",
        url: "http://uffizicloud.centrica.it/7711/closer/hi-res/A1456.imgf?cmd=info",
        headers: &[],
        accept_invalid_certs: false,
        status: "http-only",
    },
    LiveTarget {
        name: "pnav",
        inventory_id: "L35",
        url: "https://collection.ethnomuseum.ru/entity/OBJECT/32945",
        headers: &[],
        accept_invalid_certs: false,
        status: "alive",
    },
];

/// Public live checks are https-bounded by policy; legacy http-only targets
/// are recorded rows, never fetched.
fn https_bounded(url: &str) -> bool {
    url.starts_with("https://")
}

pub fn test_live(args: &[String]) -> Result<(), String> {
    if args == ["--dry-run", "--fixtures"] {
        // No network: validate the target list against the inventory.
        for target in TARGETS {
            if !https_bounded(target.url) && target.status != "http-only" {
                return Err(format!(
                    "target {} is http but not marked http-only",
                    target.name
                ));
            }
            if target.status == "alive" && !https_bounded(target.url) {
                return Err(format!(
                    "target {} is alive but violates the https policy",
                    target.name
                ));
            }
        }
        println!(
            "test live --dry-run --fixtures: ok ({} targets validated, no public targets hit)",
            TARGETS.len()
        );
        return Ok(());
    }
    if args.first().map(String::as_str) != Some("--public") {
        if args == ["--postcutover", "--low-volume"] || args == ["--packaged", "--low-volume"] {
            return Err("live packaged/postcutover runs require explicit production approval; use `cargo xtask test live --public` for the opted-in public check".to_string());
        }
        if args == ["--webapp"] {
            return run_live_webapp();
        }
        return Err(
            "usage: cargo xtask test live --dry-run --fixtures | --public [--limit <n>] [--site <name>] | --webapp"
                .to_string(),
        );
    }
    let mut limit: Option<usize> = None;
    let mut only: Option<&str> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--limit" => {
                i += 1;
                limit = Some(
                    args.get(i)
                        .ok_or("missing --limit <n>")?
                        .parse::<usize>()
                        .map_err(|_| "bad --limit <n>".to_string())?,
                );
            }
            "--site" => {
                i += 1;
                only = Some(args.get(i).ok_or("missing --site <name>")?);
            }
            other => return Err(format!("unknown test live arg '{other}'")),
        }
        i += 1;
    }
    let mut targets: Vec<&LiveTarget> = TARGETS.iter().collect();
    if let Some(name) = only {
        targets.retain(|t| t.name == name || t.inventory_id == name);
        if targets.is_empty() {
            return Err(format!(
                "unknown live target '{name}' (known: {})",
                TARGETS.iter().map(|t| t.name).collect::<Vec<_>>().join(" ")
            ));
        }
    }
    if let Some(n) = limit {
        targets.truncate(n);
    }
    if targets.is_empty() {
        return Err("no live targets selected".to_string());
    }

    let cli = build_cli()?;
    let temp_dir = std::env::temp_dir().join(format!("dezoomify-live-{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("temp dir: {e}"))?;

    let mut failed_alive: Vec<String> = Vec::new();
    let mut passed = 0usize;
    let mut skipped = 0usize;
    for target in &targets {
        if target.status == "http-only" {
            println!(
                "live {} [{}] SKIP http-only target (documented policy row)",
                target.inventory_id, target.name
            );
            skipped += 1;
            continue;
        }
        let output = temp_dir.join(format!("{}-{}.png", target.inventory_id, target.name));
        let _ = std::fs::remove_file(&output);
        let mut command = Command::new(&cli);
        command
            .arg("--max-width")
            .arg("1200")
            .arg(target.url)
            .arg(&output);
        if target.accept_invalid_certs {
            command.arg("--accept-invalid-certs");
        }
        for (name, value) in target.headers {
            command.arg("-H").arg(format!("{name}: {value}"));
        }
        let result = command.output();
        match result {
            Ok(out)
                if out.status.success()
                    && output.metadata().map(|m| m.len() > 0).unwrap_or(false) =>
            {
                let size = output.metadata().map(|m| m.len()).unwrap_or(0);
                println!(
                    "live {} [{}]: PASS ({} output bytes)",
                    target.inventory_id, target.name, size
                );
                passed += 1;
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let detail = stderr.lines().last().unwrap_or("").trim().to_string();
                println!(
                    "live {} [{}]: FAIL ({})",
                    target.inventory_id,
                    target.name,
                    truncate(&detail, 220)
                );
                if target.status == "alive" {
                    failed_alive.push(format!("{} [{}]", target.inventory_id, target.name));
                }
            }
            Err(e) => {
                println!(
                    "live {} [{}]: FAIL (cli spawn: {e})",
                    target.inventory_id, target.name
                );
                if target.status == "alive" {
                    failed_alive.push(format!("{} [{}]", target.inventory_id, target.name));
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&temp_dir);
    println!(
        "test live --public: {passed} passed, {skipped} skipped (http-only), {} unexpected failure(s)",
        failed_alive.len()
    );
    if !failed_alive.is_empty() {
        return Err(format!(
            "still-alive live targets failed (document them in docs/migration/live-inventory.csv \
             with status=dead or fix the regression): {}",
            failed_alive.join(", ")
        ));
    }
    Ok(())
}

/// C6: live webapp port — opens the real webapp in Chromium against the
/// legacy dezoomify-web targets (opt-in, diagnostic).
fn run_live_webapp() -> Result<(), String> {
    let root = super::repo_root();
    let e2e_dir = root.join("crates/fixture-server/tests/webapp-e2e");
    if !e2e_dir.join("node_modules").exists() {
        let status = Command::new("npm")
            .args(["ci"])
            .current_dir(&e2e_dir)
            .status()
            .map_err(|e| format!("failed to run npm: {e}"))?;
        if !status.success() {
            return Err("npm ci (webapp-e2e) failed".to_string());
        }
    }
    let status = Command::new("npm")
        .args(["test"])
        .env("DEZOOMIFY_LIVE_WEB", "1")
        .current_dir(&e2e_dir)
        .status()
        .map_err(|e| format!("failed to run npm: {e}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "live webapp suite failed".to_string())
}

fn build_cli() -> Result<std::path::PathBuf, String> {
    let root = super::repo_root();
    let status = Command::new("cargo")
        .args(["build", "-p", "dezoomify-cli"])
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to run cargo: {e}"))?;
    if !status.success() {
        return Err("cargo build dezoomify-cli failed".to_string());
    }
    let cli = root.join("target/debug/dezoomify-cli");
    if !cli.exists() {
        return Err("cli binary missing after build".to_string());
    }
    Ok(cli)
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn public_requires_flag() {
        assert!(super::test_live(&[]).is_err());
        assert!(super::test_live(&[
            "--public".to_string(),
            "--site".to_string(),
            "nope".to_string()
        ])
        .is_err());
    }

    #[test]
    fn dry_run_validates_targets_without_network() {
        assert!(super::test_live(&["--dry-run".to_string(), "--fixtures".to_string()]).is_ok());
    }
}
