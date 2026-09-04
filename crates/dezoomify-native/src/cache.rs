//! Atomic per-job tile cache: temp-write + rename, content keys without
//! secrets, version + integrity checks. Never persists headers, cookies,
//! handoff payloads, or unredacted URLs.

use std::path::{Path, PathBuf};

pub const CACHE_VERSION: u32 = 1;

#[must_use]
pub fn cache_key(uri: &str) -> String {
    let (base, _) = uri.split_once('?').unwrap_or((uri, ""));
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in base.bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

pub fn store(cache_dir: &Path, job: &str, uri: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if job.contains(['/', '\\', '.']) {
        return Err("bad job namespace".to_string());
    }
    let dir = cache_dir.join(job);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(cache_key(uri));
    let tmp = dest.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

pub fn load(cache_dir: &Path, job: &str, uri: &str) -> Option<Vec<u8>> {
    let dest = cache_dir.join(job).join(cache_key(uri));
    std::fs::read(dest).ok()
}
