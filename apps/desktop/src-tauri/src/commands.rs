//! Validation for the desktop IPC entry points.

use dezoomify::model::{DesktopSource, Error};

/// Validate the explicit source kind; encode local paths as file URIs without
/// canonicalizing them. The source retains the user's exact spelling.
/// File validation reads metadata; call from a worker rather than the UI thread.
pub fn source_input(source: &DesktopSource) -> Result<String, Error> {
    match source {
        DesktopSource::Url { url } if is_valid_input_url(url) => Ok(url.clone()),
        DesktopSource::File { path } => {
            let file = std::path::Path::new(path);
            if path.len() > 2048 || !file.is_absolute() {
                return Err(Error::InvalidInput(
                    "choose an absolute source file path up to 2048 bytes".into(),
                ));
            }
            let metadata = std::fs::metadata(file).map_err(|error| {
                Error::InvalidInput(
                    format!(
                        "cannot open source file {path}: {}",
                        dezoomify::model::chain_text(&error)
                    )
                    .into(),
                )
            })?;
            if !metadata.is_file() {
                return Err(Error::InvalidInput(
                    "choose a regular file, not a directory".into(),
                ));
            }
            url::Url::from_file_path(file)
                .map(String::from)
                .map_err(|_| {
                    Error::InvalidInput(
                        "the source path cannot be represented as a file URI".into(),
                    )
                })
        }
        DesktopSource::Url { .. } => Err(Error::InvalidInput(
            "the image address must be an http(s) URL up to 2048 bytes without userinfo".into(),
        )),
    }
}

/// True for `job:<suffix>` ids within the 128-byte bound.
pub fn is_valid_job_id(job: &str) -> bool {
    if !job.starts_with("job:") {
        return false;
    }
    let suffix = &job["job:".len()..];
    if suffix.is_empty() || job.len() > 128 {
        return false;
    }
    suffix
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// True for http(s) input urls up to 2048 bytes without userinfo.
pub fn is_valid_input_url(url: &str) -> bool {
    if url.is_empty() || url.len() > 2048 {
        return false;
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return false;
    }
    // Reject userinfo credentials embedded in the authority section.
    if let Some(after_scheme) = url.split("://").nth(1) {
        let authority = after_scheme.split('/').next().unwrap_or("");
        let authority = authority.split('?').next().unwrap_or(authority);
        if authority.contains('@') {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_validation_rejects_untrusted_authorities_and_invalid_ids() {
        assert!(is_valid_input_url("https://example.com/image"));
        for value in [
            "",
            "file:///etc/passwd",
            "https://user:password@example.com/",
        ] {
            assert!(!is_valid_input_url(value));
        }
        assert!(is_valid_job_id("job:desktop-1"));
        for value in ["", "job:", "job:a/b", "a"] {
            assert!(!is_valid_job_id(value));
        }
    }

    #[test]
    fn explicit_file_sources_preserve_spaces_and_unicode_and_reject_other_paths() {
        let directory = dezoomify_fixture_server::temp_dir("desktop-file-source");
        let path = directory.join("a painting 雪.dzi");
        std::fs::write(&path, b"metadata").unwrap();
        let raw = path.to_str().unwrap().to_owned();
        let input = source_input(&DesktopSource::File { path: raw.clone() }).unwrap();
        assert_eq!(
            url::Url::parse(&input).unwrap().to_file_path().unwrap(),
            path
        );
        for path in [
            "".to_owned(),
            "relative.dzi".into(),
            directory.to_str().unwrap().into(),
            directory.join("missing.dzi").to_str().unwrap().into(),
        ] {
            assert!(source_input(&DesktopSource::File { path }).is_err());
        }
        assert!(source_input(&DesktopSource::Url { url: raw }).is_err());
    }
}
