//! Native input, transport, and output settings.
use crate::{
    output::{validate_destination, OutputFormat},
    NativeError,
};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

/// Where the finished output goes.
#[derive(Clone, Debug)]
pub enum OutputTarget {
    /// Save to this exact file (the extension selects the encoder).
    File(PathBuf),
    /// Derive the basename from the catalog title inside this directory.
    AutoDir { dir: PathBuf, format: OutputFormat },
}

/// Validated options for one native job. Hosts map their own args/settings
/// onto this struct; validation is typed and happens before any I/O.
#[derive(Clone, Debug)]
pub struct JobOptions {
    pub input_url: String,
    pub output: OutputTarget,
    pub overwrite: bool,
    /// Algorithm format selector (`None` auto-detects; named picks one format;
    /// unknown names fail typed before any work).
    pub format: Option<String>,
    pub image_index: Option<usize>,
    pub zoom_level: Option<usize>,
    pub largest: bool,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub max_retries: u32,
    /// Base retry wait (attempt `n` waits this doubled `n-1` times);
    /// algorithm-owned backoff, default 2 s to match the CLI default.
    pub retry_base_delay: Duration,
    pub keep_partial: bool,
    pub compression: u8,
    pub headers: BTreeMap<String, String>,
    pub cache_dir: Option<PathBuf>,
    pub timeout: Duration,
    pub connect_timeout: Duration,
    pub max_idle_per_host: usize,
    pub accept_invalid_certs: bool,
    /// Max concurrent tile fetches (default 16, the reference async
    /// `buffer_unordered(parallelism)` width). Bounds one algorithm slot per
    /// tile covering the full fetch/decode/place path.
    pub max_concurrent: usize,
    /// Maximum number of planned tiles accepted by the algorithm.
    pub max_tiles: usize,
    /// Maximum bytes accepted for one metadata or tile response.
    pub max_bytes: u64,
    /// Minimum interval between tile request starts (per-tile throttle).
    /// `ZERO` disables staggering (the CLI default); bulk image pacing stays
    /// in the caller.
    pub min_interval: Duration,
    /// Bounds for native output buffering and unknown-geometry spooling.
    pub output_retain_cap: u64,
    pub output_spool_cap: u64,
}

impl Default for JobOptions {
    fn default() -> Self {
        Self {
            input_url: String::new(),
            output: OutputTarget::File(PathBuf::from("out.png")),
            overwrite: false,
            format: None,
            image_index: None,
            zoom_level: None,
            largest: false,
            max_width: None,
            max_height: None,
            max_retries: 3,
            retry_base_delay: Duration::from_secs(2),
            keep_partial: true,
            compression: 5,
            headers: BTreeMap::new(),
            cache_dir: None,
            timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(6),
            max_idle_per_host: 32,
            accept_invalid_certs: false,
            max_concurrent: crate::pipeline::MAX_CONCURRENT,
            max_tiles: 1 << 20,
            max_bytes: 64 << 20,
            min_interval: Duration::ZERO,
            output_retain_cap: 512 << 20,
            output_spool_cap: 1 << 30,
        }
    }
}

impl JobOptions {
    /// Normalize product options once before configuring the algorithm and transport.
    pub fn normalized(mut self) -> Self {
        self.max_tiles = self.max_tiles.clamp(1, 16_777_216);
        self.max_concurrent = self.max_concurrent.clamp(1, 64).min(self.max_tiles);
        self.max_retries = self.max_retries.min(1024);
        self.max_bytes = self.max_bytes.clamp(1024, 4_294_967_296);
        self.compression = self.compression.min(100);
        if self
            .format
            .as_ref()
            .is_some_and(|value| value.eq_ignore_ascii_case("auto"))
        {
            self.format = None;
        }
        self.cache_dir
            .get_or_insert_with(crate::pipeline::default_tile_cache_dir);
        self
    }

    /// Typed pre-flight validation: input shape, output-format support, and
    /// an early destination check. The commit point validates again to close
    /// races between start and publication.
    pub fn validate(&self) -> Result<(), NativeError> {
        if self.input_url.is_empty() || self.input_url.len() > 2048 {
            return Err(NativeError::new(
                "job.invalid-input",
                "input must be 1..2048 bytes",
            ));
        }
        if let Some(after_scheme) = self
            .input_url
            .split("://")
            .nth(1)
            .filter(|_| self.input_url.starts_with("http"))
        {
            let authority = after_scheme
                .split('/')
                .next()
                .unwrap_or("")
                .split('?')
                .next()
                .unwrap_or("");
            if authority.contains('@') {
                return Err(NativeError::new(
                    "job.invalid-input",
                    "input must not contain userinfo",
                ));
            }
        }
        match &self.output {
            OutputTarget::File(path) => {
                let format = OutputFormat::infer_from_path(path)?;
                validate_destination(path, &format, self.overwrite)?;
            }
            OutputTarget::AutoDir { dir: _, format: _ } => {}
        }
        Ok(())
    }
}
