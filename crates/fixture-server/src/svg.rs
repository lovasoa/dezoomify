//! Deterministic tile-image generators mirroring legacy fixture behavior.
//!
//! Pixel semantics (not byte identity) match the legacy server: solid-color
//! SVGs with exact dimensions and availability shapes; decoded pixels are what
//! scenarios assert.

fn query_value(query: Option<&str>, key: &str) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

fn solid_svg(width: u32, height: u32) -> Vec<u8> {
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\">\
         <rect width=\"100%\" height=\"100%\" fill=\"#888888\"/></svg>"
    )
    .into_bytes()
}

/// Legacy `/fixtures/generic/*.svg` availability shapes. Returns `None` for
/// missing tiles (caller maps to 404).
pub fn generic_tile(shape: &str, query: Option<&str>) -> Option<Vec<u8>> {
    let x: i64 = query_value(query, "x")?.parse().ok()?;
    let y: i64 = query_value(query, "y")?.parse().ok()?;
    let (avail, w, h) = match shape {
        "padded" => ((0..2).contains(&x) && (0..2).contains(&y), 256, 256),
        "large" => ((0..2).contains(&x) && y == 0, 512, 512),
        "edge" => {
            if !((0..2).contains(&x) && (0..2).contains(&y)) {
                return None;
            }
            let w = if x == 1 { 1 } else { 256 };
            let h = if y == 1 { 14 } else { 256 };
            (true, w, h)
        }
        "boundary" => ((0..1000).contains(&x) && y == 0, 256, 256),
        "one" => ((0..3).contains(&x) && y == 0, 256, 256),
        "missing-origin" => (
            (0..2).contains(&x) && (0..2).contains(&y) && (x, y) != (0, 0),
            256,
            256,
        ),
        // Legacy placeholder: in-area probes get a full tile, everything else
        // gets HTTP 200 with a 1x1 body (treated as missing by clients).
        "placeholder" => {
            return Some(if (0..2).contains(&x) && (0..2).contains(&y) {
                solid_svg(256, 256)
            } else {
                solid_svg(1, 1)
            });
        }
        _ => return None,
    };
    avail.then(|| solid_svg(w, h))
}

/// Legacy `/fixtures/generic/tile.jpg`: real bytes only inside the 2x2 probe
/// area, 404 elsewhere.
pub fn generic_jpg(image: &[u8], query: Option<&str>) -> Option<Vec<u8>> {
    let x: i64 = query_value(query, "x")?.parse().ok()?;
    let y: i64 = query_value(query, "y")?.parse().ok()?;
    ((0..2).contains(&x) && (0..2).contains(&y)).then(|| image.to_vec())
}
pub fn assembly_tile(query: Option<&str>) -> Option<Vec<u8>> {
    let w: u32 = query_value(query, "w")?.parse().ok()?;
    let h: u32 = query_value(query, "h")?.parse().ok()?;
    let color = query_value(query, "color")?;
    if w == 0 || h == 0 || color.len() != 6 || !color.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h}\">\
             <rect width=\"{w}\" height=\"{h}\" fill=\"#{color}\"/></svg>"
        )
        .into_bytes(),
    )
}
