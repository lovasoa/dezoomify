//! Shared staging utilities. Pixels live only in PixelPipe; encoded tile
//! outputs use their concrete writers.
use std::path::{Path, PathBuf};

pub(crate) fn temp_sibling(dest: &Path) -> PathBuf {
    let file_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("output");
    let tmp_name = format!("{file_name}.tmp.{}-{}", std::process::id(), unique_suffix());
    match dest.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(tmp_name),
        _ => PathBuf::from(tmp_name),
    }
}
fn unique_suffix() -> u64 {
    use std::sync::atomic::Ordering;
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    (now ^ (count.wrapping_mul(0x9E37_79B9_7F4A_7C15) as u128)) as u64
}
pub(crate) fn tile_bytes(image: &image::RgbaImage) -> u64 {
    u64::from(image.width()) * u64::from(image.height()) * 4
}
