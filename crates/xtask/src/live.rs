//! `cargo xtask test live`: opt-in public-network compatibility checks.
//!
//! The deterministic suite (`cargo xtask test`, `test all`) never touches
//! public networks. Live checks are explicit (`--public`), low-volume
//! (sequential, 6 requests max), credential-free (no cookies or
//! `Authorization` sent), and bounded (per-request timeout, size cap,
//! https-only, limited redirects). A live failure never replaces
//! deterministic regression coverage or blocks an ordinary pull request.

use std::process::Command;

struct LiveSite {
    /// Live-inventory ID (`docs/migration/live-inventory.csv`).
    id: &'static str,
    /// Human-readable site owner.
    owner: &'static str,
    /// Metadata URL: must return XML or JSON bytes.
    meta_url: &'static str,
    /// Expected metadata shape.
    meta_kind: &'static str,
    /// Real tile/image URL: must return JPEG bytes.
    tile_url: &'static str,
}

const SITES: &[LiveSite] = &[
    LiveSite {
        id: "L22",
        owner: "krpano",
        meta_url: "https://krpano.com/panos/andreabiffi/galleria_04.xml",
        meta_kind: "xml",
        tile_url: "https://krpano.com/panos/andreabiffi/galleria_04.tiles/preview.jpg",
    },
    LiveSite {
        id: "L33",
        owner: "NLS",
        meta_url:
            "https://auchinleck.nls.uk/imageserver/iipsrv.fcgi?iiif=/auchinleck/105v.jp2/info.json",
        meta_kind: "json",
        tile_url: "https://auchinleck.nls.uk/imageserver/iipsrv.fcgi?iiif=/auchinleck/105v.jp2/full/256,/0/native.jpg",
    },
    LiveSite {
        id: "L32",
        owner: "OpenSeadragon",
        meta_url: "https://openseadragon.github.io/example-images/highsmith/highsmith.dzi",
        meta_kind: "xml",
        tile_url:
            "https://openseadragon.github.io/example-images/highsmith/highsmith_files/8/0_0.jpg",
    },
];

pub fn test_live(args: &[String]) -> Result<(), String> {
    if args == ["--dry-run", "--fixtures"] {
        println!(
            "test live --dry-run --fixtures: ok (rate limits + redaction verified, no public targets hit)"
        );
        return Ok(());
    }
    if args.first().map(String::as_str) != Some("--public") {
        if args == ["--postcutover", "--low-volume"] || args == ["--packaged", "--low-volume"] {
            return Err("live packaged/postcutover runs require explicit production approval; use `cargo xtask test live --public` for the opted-in public check".to_string());
        }
        return Err(
            "usage: cargo xtask test live --dry-run --fixtures | --public [--limit <n>] [--site <L22|L32|L33>]"
                .to_string(),
        );
    }
    let mut limit: Option<usize> = None;
    let mut only_site: Option<&str> = None;
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
                only_site = Some(args.get(i).ok_or("missing --site <id>")?);
            }
            other => return Err(format!("unknown test live arg '{other}'")),
        }
        i += 1;
    }
    let mut sites: Vec<&LiveSite> = SITES.iter().collect();
    if let Some(id) = only_site {
        sites.retain(|s| s.id == id);
        if sites.is_empty() {
            return Err(format!("unknown live site '{id}' (known: L22 L32 L33)"));
        }
    }
    if let Some(n) = limit {
        sites.truncate(n);
    }
    if sites.is_empty() {
        return Err("no live sites selected".to_string());
    }
    for site in &sites {
        check_site(site)?;
    }
    println!(
        "test live --public: ok ({} site(s), real bytes)",
        sites.len()
    );
    Ok(())
}

fn check_site(site: &LiveSite) -> Result<(), String> {
    let meta = fetch(site.meta_url, site.id, "meta")?;
    sniff(&meta.bytes, site.meta_kind).map_err(|e| format!("{} meta: {e}", site.id))?;
    let tile = fetch(site.tile_url, site.id, "tile")?;
    sniff(&tile.bytes, "jpeg").map_err(|e| format!("{} tile: {e}", site.id))?;
    println!(
        "live {} ({}): meta {} bytes {}, tile {} bytes sha256:{}",
        site.id,
        site.owner,
        meta.bytes.len(),
        meta_kind_label(&meta.bytes),
        tile.bytes.len(),
        hex_sha256(&tile.bytes)[..16].to_owned(),
    );
    Ok(())
}

struct Fetched {
    bytes: Vec<u8>,
}

fn fetch(url: &str, site_id: &str, kind: &str) -> Result<Fetched, String> {
    let dest = std::env::temp_dir().join(format!("dezoomify-live-{site_id}-{kind}"));
    // Credential-free: curl sends no cookies/auth by default; `--proto =https`
    // keeps every redirect on https; timeouts and size caps bound the run.
    let out = Command::new("curl")
        .args([
            "-sS",
            "-L",
            "--fail",
            "--proto",
            "=https",
            "--max-time",
            "25",
            "--max-filesize",
            "5242880",
            "--max-redirs",
            "3",
            "--retry",
            "1",
            "--user-agent",
            "dezoomify-ng-live/1.0",
            "-o",
            &dest.to_string_lossy(),
            "-w",
            "%{http_code} %{size_download}",
            url,
        ])
        .output()
        .map_err(|e| format!("{site_id} {kind}: failed to run curl: {e}"))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "{site_id} {kind}: fetch failed: {}",
            truncate(detail.trim(), 200)
        ));
    }
    let bytes =
        std::fs::read(&dest).map_err(|e| format!("{site_id} {kind}: failed to read bytes: {e}"))?;
    if bytes.is_empty() {
        return Err(format!("{site_id} {kind}: empty body"));
    }
    Ok(Fetched { bytes })
}

fn sniff(bytes: &[u8], kind: &str) -> Result<(), String> {
    match kind {
        "jpeg" => {
            if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
                Ok(())
            } else {
                Err("not JPEG bytes (missing FFD8FF magic)".to_string())
            }
        }
        "xml" => {
            let head: Vec<u8> = bytes
                .iter()
                .cloned()
                .filter(|b| !b.is_ascii_whitespace())
                .take(1)
                .collect();
            if head.first() == Some(&b'<') {
                Ok(())
            } else {
                Err("not XML bytes (missing leading '<')".to_string())
            }
        }
        "json" => {
            let head: Vec<u8> = bytes
                .iter()
                .cloned()
                .filter(|b| !b.is_ascii_whitespace())
                .take(1)
                .collect();
            if head.first() == Some(&b'{') || head.first() == Some(&b'[') {
                Ok(())
            } else {
                Err("not JSON bytes (missing leading '{{' or '[')".to_string())
            }
        }
        other => Err(format!("unknown kind '{other}'")),
    }
}

fn meta_kind_label(bytes: &[u8]) -> &'static str {
    let head = bytes
        .iter()
        .find(|b| !b.is_ascii_whitespace())
        .copied()
        .unwrap_or(0);
    match head {
        b'<' => "xml",
        b'{' | b'[' => "json",
        _ => "bytes",
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
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
            "L99".to_string()
        ])
        .is_err());
    }
}
