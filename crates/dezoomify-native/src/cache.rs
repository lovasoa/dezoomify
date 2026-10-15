//! Atomic per-job tile cache: temp-write + rename, versioned digest keys.
//! Keys are truncated SHA256 digests of the full URI and requested byte range:
//! distinct resources have distinct keys. Only response bodies are stored. Bumping `CACHE_VERSION` invalidates every prior entry.
//!
//! The pipeline stores each successfully fetched tile body under
//! `<cache_dir>/<job>/<key>` and skips the fetch when the stored bytes still
//! decode. Only response bodies are stored: URIs and range values are digested;
//! other request headers, user headers, and cookies never touch the cache.
//! See [`job_namespace`].

use dezoomify::model::ResourceRequest;
use std::path::{Path, PathBuf};

pub const CACHE_VERSION: u32 = 3;

/// A container's tiles share one URI but occupy distinct byte intervals.
#[must_use]
pub fn cache_key(request: &ResourceRequest) -> String {
    let range = request
        .headers
        .iter()
        .rev()
        .find(|header| header.name.eq_ignore_ascii_case("range"));
    digest_key(&request.uri, range.map(|header| header.value.as_str()))
}

fn digest_key(uri: &str, range: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update((uri.len() as u64).to_le_bytes());
    digest.update(uri.as_bytes());
    if let Some(range) = range {
        digest.update(range.as_bytes());
    }
    let hash = digest.finalize();
    let hex: String = hash[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("v{CACHE_VERSION}-{hex}")
}

pub fn store(
    cache_dir: &Path,
    job: &str,
    request: &ResourceRequest,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    if job.contains(['/', '\\', '.']) {
        return Err("bad job namespace".to_string());
    }
    let dir = cache_dir.join(job);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(cache_key(request));
    let tmp = dest.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(dest)
}

pub fn load(cache_dir: &Path, job: &str, request: &ResourceRequest) -> Option<Vec<u8>> {
    if job.contains(['/', '\\', '.']) {
        return None;
    }
    let dest = cache_dir.join(job).join(cache_key(request));
    std::fs::read(dest).ok()
}

/// Stable per-job cache namespace: the versioned digest of the input URL, so
/// a repeated run of the same job reuses tiles while distinct jobs never
/// share entries. Hex and dashes only, so it always passes [`store`]
/// validation and carries no URL text, headers, or cookies.
#[must_use]
pub fn job_namespace(input_url: &str) -> String {
    format!("job-{}", digest_key(input_url, None))
}
