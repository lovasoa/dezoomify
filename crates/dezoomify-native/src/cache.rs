//! Atomic per-job tile cache: temp-write + rename, versioned digest keys.
//! Keys are FNV digests of the full URI (query included): distinct resources
//! never collide, and a hex digest persists no secrets, so the URL text,
//! headers, cookies, handoff payloads, and unredacted URIs are never stored.
//! Bumping `CACHE_VERSION` invalidates every prior entry.
//!
//! The pipeline stores each successfully fetched tile body under
//! `<cache_dir>/<job>/<key>` and skips the fetch when the stored bytes still
//! decode. Only response bodies are stored: request headers, user headers,
//! and cookies never touch the cache. See [`job_namespace`].

use std::path::{Path, PathBuf};

pub const CACHE_VERSION: u32 = 1;

/// FNV-1a 64-bit offset basis (standard constant, also used for protocol fingerprints).
const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;

#[must_use]
pub fn cache_key(uri: &str) -> String {
    let mut hash: u64 = FNV_OFFSET_BASIS;
    for b in uri.bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("v{CACHE_VERSION}-{hash:016x}")
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
    if job.contains(['/', '\\', '.']) {
        return None;
    }
    let dest = cache_dir.join(job).join(cache_key(uri));
    std::fs::read(dest).ok()
}

/// Stable per-job cache namespace: the versioned digest of the input URL, so
/// a repeated run of the same job reuses tiles while distinct jobs never
/// share entries. Hex and dashes only, so it always passes [`store`]
/// validation and carries no URL text, headers, or cookies.
#[must_use]
pub fn job_namespace(input_url: &str) -> String {
    format!("job-{}", cache_key(input_url))
}
