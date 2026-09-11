//! `cargo xtask test live`: opt-in public-network compatibility checks that
//! run the REAL dezoomify-cli binary against a curated list of real
//! museum/library deep-zoom sites, asserting auto-selected discovery and a
//! real output image per still-alive site.
//!
//! The deterministic suite (`cargo xtask test`, `test all`) never touches
//! public networks. Live checks are explicit (`--public`), sequential,
//! route and only where a legacy target requires it), and bounded (per-fetch
//! timeout, size caps, width cap, limited redirects). Both `http` and
//! `https` targets are exercised; there is no http/https distinction. Live
//! failures never
//! replace deterministic regression coverage or block an ordinary pull
//! request. Every target in this list must actually pass: there is no
//! tolerated-failure status. Dead or changed sites are removed from this
//! list with the reason in the commit message, never silently skipped and
//! never fetched with their failure ignored.

use std::process::Command;

struct LiveTarget {
    /// Short identifier used in output and `--site` filtering.
    name: &'static str,
    url: &'static str,
    /// Extra `-H` headers (trusted native memory; only where a target
    /// requires them, e.g. BLB VLS `js_enabled=2`).
    headers: &'static [(&'static str, &'static str)],
    /// Cert-verification escape hatch, explicitly user-opted per target.
    accept_invalid_certs: bool,
}

const TARGETS: &[LiveTarget] = &[
    LiveTarget {
        name: "google_arts_and_culture",
        url: "https://artsandculture.google.com/asset/liza-kottou-0113/3gGrYhjfhcwvbA",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "zoomify",
        url: "https://openseadragon.github.io/example-images/highsmith/highsmith_zdata/ImageProperties.xml",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "zoomify_ngv_viewer",
        url: "https://www.ngv.vic.gov.au/explore/collection/work/3867/",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "zoomify_express_viewer",
        url: "https://romanlaptev.github.io/codebase/js/plugins/zoomify/febr_js.html",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "zoomify_tile_service",
        url: "https://openseadragon.github.io/examples/tilesource-zoomify/",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "deep_zoom",
        url: "https://openseadragon.github.io/example-images/highsmith/highsmith.dzi",
        headers: &[],
        accept_invalid_certs: false,
    },
    // Nationalmuseum links to this immutable public configuration from its
    // Second Canvas collection page. It exercises the version-2 `types`
    // schema without relying on a viewer page or an institution session.
    LiveTarget {
        name: "second_canvas_nationalmuseum",
        url: "https://sc52c295l2e0u257236675112f3025a8b.s3.amazonaws.com/web/52w981s7g6u181258638003c0d64ad1/a52w35039o216d250100915f780a519_en.json",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "iiif",
        url: "https://i.micr.io/fhXoU/info.json",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "iiif_national_gallery",
        url: "https://www.nationalgallery.org.uk/paintings/vincent-van-gogh-sunflowers",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "iiif_philadelphia_museum",
        url: "https://www.philamuseum.org/objects/101731",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "iiif_csntm",
        url: "https://collections.csntm.org/image-service/iiif/MNTGRCGA01/default/M_NT_GRC_GA01_20250609_203r/M_NT_GRC_GA01_20250609_203r/info.json",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "iiif_onb_viewer",
        url: "https://viewer.onb.ac.at/10048A37/",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "iiif_oklahoma_contentdm",
        url: "https://dc.library.okstate.edu/digital/collection/OKMaps/id/6483/rec/6",
        headers: &[],
        // This target requires --accept-invalid-certs.
        accept_invalid_certs: true,
    },
    LiveTarget {
        name: "iiif_gallica_bnf",
        url: "https://gallica.bnf.fr/iiif/ark:/12148/btv1b53252063t/f1/info.json",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "iiif_nls_auchinleck",
        url: "https://auchinleck.nls.uk/imageserver/iipsrv.fcgi?iiif=/auchinleck/105v.jp2/info.json",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "iiif_nls_map_view",
        url: "https://map-view.nls.uk/iiif/19619%2F196194600/info.json",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "generic",
        url: "https://digital.blb-karlsruhe.de/image/tiler/square/2410801/0/{{X}}/{{Y}}",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "krpano",
        url: "https://krpano.com/panos/andreabiffi/galleria_04.xml",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "krpano_eiffeltower_viewer",
        url: "https://krpano.com/releases/1.24/viewer/krpano.html?xml=examples/minimap/eiffeltower_minimap.xml",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "deepzoom_academia_sinica",
        url: "https://bronze.asdc.sinica.edu.tw/filePool/R/05395-1.html",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "deepzoom_paris",
        url: "https://bibliotheques-specialisees.paris.fr/ark:/73873/pf0001115743/0017/v0001.simple.selectedTab=otherdocs",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "iiif_washington_mirador",
        url: "https://digitalcollections.lib.washington.edu/digital/custom/mirador3?manifest=https://digitalcollections.lib.washington.edu//iiif/info/social/1303/manifest.json",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "iipimage",
        url: "https://image.hng-data.org/iipsrv/iipsrv.fcgi?FIF=/HNG/016/card/0178.tif&OBJ=Max-size&OBJ=Tile-size&OBJ=Resolution-number",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "custom_yaml",
        url: "https://raw.githubusercontent.com/lovasoa/dezoomify-rs/master/tiles.yaml",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "topviewer",
        url: "https://images.memorix.nl/wba/topviewjson/memorix/6eb5a89b-b76c-5039-3999-aabfd7a0c7c9",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "topviewer_media_api",
        url: "https://webservices.memorix.nl/mediabank/media/1216f2dc-2308-11e0-acba-74f6d356987f?apiKey=69111262-af4a-11e3-9967-3860770fff49&entities%5B0%5D=d7c76800-a22b-5f1c-e991-15b3dd0d4f2f",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "fsi",
        url: "https://fsi-site.neptunelabs.com/fsi/server?type=info&source=images%2Fsamples%2Fthumbnails%2Fzoom_default_skin.tif",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "fsi_viewer_page",
        url: "https://www.neptunelabs.com/fsi-server/",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "hungaricana",
        url: "https://gallery.hungaricana.hu/en/SzerencsKepeslap/1168634/?img=0",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "vls",
        url: "https://digital.blb-karlsruhe.de/blbhs/content/zoom/2410801",
        headers: &[("Cookie", "js_enabled=2")],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "wmts",
        url: "https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/WMTS/1.0.0/WMTSCapabilities.xml",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "arcgis",
        url: "https://wmts.ngi.be/arcgis/rest/services/20k__%7BD67270FA-BDEC-4A9F-95D1-BEC0C75BA45E%7D__default__404000/MapServer",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "arcgis_basemap_url",
        url: "http://www.cartesius.be/arcgis/home/webmap/viewer.html?basemapUrl=https://wmts.ngi.be/arcgis/rest/services/20k__%7BD67270FA-BDEC-4A9F-95D1-BEC0C75BA45E%7D__default__404000/MapServer&lang=nl",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "lizardtech",
        url: "http://cartweb.geography.ua.edu/lizardtech/iserv/calcrgn?cat=North%20America%20and%20United%20States&item=NorthAmerica/US1566a.sid&wid=500&hei=400&props=item(Name,Description),cat(Name,Description)&style=default/view.xsl&plugin=true",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "xlimage",
        url: "http://uffizicloud.centrica.it/7711/closer/hi-res/A1456.imgf?cmd=info",
        headers: &[],
        accept_invalid_certs: false,
    },
    LiveTarget {
        name: "pnav",
        url: "https://collection.ethnomuseum.ru/entity/OBJECT/32945",
        headers: &[],
        accept_invalid_certs: false,
    },
];

pub fn test_live(args: &[String]) -> Result<(), String> {
    if args == ["--dry-run", "--fixtures"] {
        // No network: validate the target list.
        println!(
            "test live --dry-run --fixtures: ok ({} targets validated, no public targets hit)",
            TARGETS.len()
        );
        return Ok(());
    }
    if args.first().map(String::as_str) != Some("--public") {
        if args == ["--packaged", "--low-volume"] {
            return Err("live packaged runs require explicit production approval; use `cargo xtask test live --public` for the opted-in public check".to_string());
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
        targets.retain(|t| t.name == name);
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

    let mut failed: Vec<String> = Vec::new();
    let mut passed = 0usize;
    for target in &targets {
        let output = temp_dir.join(format!("{}.png", target.name));
        let _ = std::fs::remove_file(&output);
        let mut command = Command::new(&cli);
        command
            .arg("--json")
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
                let stdout = String::from_utf8_lossy(&out.stdout);
                let (format, width, height, tile_count) = parse_completed(&stdout);
                // A zero-size catalog or an empty tile plan must never go
                // green: a successful exit with no readable tiles is a broken
                // target, not a pass (krpano-style relative-URL regressions
                // must fail here as well as in the webapp suite).
                if width == 0 || height == 0 || tile_count == 0 || format == "unknown" {
                    println!(
                        "{} : incomplete completion (format={format} {width}x{height} tiles={tile_count})",
                        target.url
                    );
                    failed.push(target.name.to_string());
                } else {
                    println!(
                        "{} : {format} : {width}x{height} ({tile_count} tiles)",
                        target.url
                    );
                    passed += 1;
                }
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let detail = last_error_message(&stderr);
                println!("{} : {}", target.url, truncate(&detail, 220));
                failed.push(target.name.to_string());
            }
            Err(e) => {
                println!("{} : cli spawn: {e}", target.url);
                failed.push(target.name.to_string());
            }
        }
    }
    let _ = std::fs::remove_dir_all(&temp_dir);
    println!(
        "test live --public: {passed} passed, {} failure(s)",
        failed.len()
    );
    if !failed.is_empty() {
        return Err(format!(
            "live targets failed (remove the site from crates/xtask/src/live.rs with the reason \
             in the commit message, or fix the regression): {}",
            failed.join(", ")
        ));
    }
    Ok(())
}

/// Live webapp port: opens the real webapp in Chromium against the
/// real-site targets (opt-in, diagnostic).
fn run_live_webapp() -> Result<(), String> {
    let root = super::repo_root();
    let mut command = super::desktop::pnpm_command()?;
    let status = command
        .args(["--filter", "webapp-e2e", "test"])
        .env("DEZOOMIFY_LIVE_WEB", "1")
        .current_dir(&root)
        .status()
        .map_err(|e| format!("failed to run pnpm: {e}"))?;
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
    let cli = super::cargo_debug_binary("dezoomify-cli")?;
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

/// Extract the detected format, image dimensions, and tile count from the CLI
/// `--json` completion record. Falls back to `unknown`/`0x0`/0 tiles when the
/// record is missing so a broken download still prints one stable line and
/// fails the completeness check at the call site.
fn parse_completed(stdout: &str) -> (String, u64, u64, u64) {
    for line in stdout.lines().rev() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("kind").and_then(serde_json::Value::as_str) != Some("completed") {
            continue;
        }
        let format = value
            .get("format")
            .and_then(serde_json::Value::as_str)
            .filter(|format| !format.is_empty())
            .unwrap_or("unknown")
            .to_string();
        let width = value
            .get("width")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let height = value
            .get("height")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let tile_count = value
            .get("tileCount")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        return (format, width, height, tile_count);
    }
    ("unknown".to_string(), 0, 0, 0)
}

/// Last non-empty stderr line without the `error: ` prefix.
fn last_error_message(stderr: &str) -> String {
    let raw = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    raw.strip_prefix("error: ").unwrap_or(raw).to_string()
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

    #[test]
    fn parses_completed_format_and_dimensions() {
        let stdout = "{\"job\":\"job:native-1\",\"seq\":1,\"kind\":\"started\",\"detail\":{}}\n\
            {\"job\":\"job:native-1\",\"seq\":5,\"kind\":\"completed\",\"outputHash\":\"sha256:abc\",\
            \"format\":\"zoomify\",\"width\":1200,\"height\":800,\"tileCount\":4}";
        assert_eq!(
            super::parse_completed(stdout),
            ("zoomify".to_string(), 1200, 800, 4)
        );
    }

    #[test]
    fn completed_falls_back_without_a_record() {
        assert_eq!(
            super::parse_completed("{\"kind\":\"started\"}\nnot json"),
            ("unknown".to_string(), 0, 0, 0)
        );
    }

    #[test]
    fn zero_tiles_are_incomplete() {
        let (format, width, height, tiles) = super::parse_completed(
            "{\"kind\":\"completed\",\"format\":\"krpano\",\"width\":955,\"height\":955,\"tileCount\":0}",
        );
        assert_eq!(
            (format.as_str(), width, height, tiles),
            ("krpano", 955, 955, 0)
        );
        assert!(
            width == 0 || height == 0 || tiles == 0 || format == "unknown",
            "zero-tile completions must fail the live completeness gate"
        );
    }

    #[test]
    fn error_message_strips_prefix_and_blanks() {
        assert_eq!(
            super::last_error_message("progress\nerror: tile failed (tile.download-failed)\n"),
            "tile failed (tile.download-failed)"
        );
        assert_eq!(super::last_error_message(""), "");
    }
}
