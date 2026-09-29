//! Native platform operations used directly by the shared async algorithm.
use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use crate::{
    diagnostics::Diagnostics,
    http::{FetchLimits, FetchOutcome, TlsPolicy, UserHeaders},
    imaging::{load_image_with_metadata, DecodedTile},
    options::{JobOptions, OutputTarget},
    sink::{Sink, SinkOptions},
    transport::NativeTransport,
};
use dezoomify::{host::Host, model::*, Vec2d};

/// Shared cancellation and pause controls, independent of the calling executor.
#[derive(Clone, Default)]
pub struct Controls(Arc<ControlState>);

#[derive(Default)]
struct ControlState {
    cancelled: AtomicBool,
    paused: AtomicBool,
    changed: tokio::sync::Notify,
}
/// Honest execution accounting, reported with every result.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Instrumentation {
    /// Tile/probe/metadata operations attempted.
    pub attempts: u64,
    /// Tiles acquired (decoded and placed).
    pub acquired: u64,
    /// Failures classified transient by the algorithm.
    pub failed_transient: u64,
    /// Failures classified permanent by the algorithm.
    pub failed_permanent: u64,
    /// Explicit retry timers the algorithm scheduled.
    pub retries_scheduled: u64,
    /// Total timer wait served (ms).
    pub timer_wait_ms: u64,
    /// Response body bytes fetched (metadata plus tiles).
    pub bytes_fetched: u64,
    /// Peak concurrent in-flight tasks.
    pub peak_inflight: usize,
    /// Peak retained (overlapping, unpainted) tile bytes in the sink.
    pub peak_retained_bytes: u64,
    /// Peak in-flight decode bytes: encoded bodies held by blocking decode
    /// tails (including tails detached by cancelling their parent task).
    /// Bounded by the algorithm slot budget times the fetch byte limit; counted
    /// against the retain cap alongside sink retention.
    pub peak_decode_inflight_bytes: u64,
    /// Canvas bytes (4 bytes per pixel, zero until allocated).
    pub canvas_bytes: u64,
    /// Transient encoded bytes for the committed output.
    pub encoded_bytes: u64,
    /// Peak spooled (on-disk) tile bytes.
    pub peak_spool_bytes: u64,
    /// Late paints below the painted frontier (same-tile retries).
    pub late_repaints: u64,
    /// Accounted peak: canvas plus peak retained plus encoded. This is the
    /// deterministic peak model for the shipped pipeline: canvas,
    /// outstanding decode buffers, and codec buffers.
    pub accounted_peak_bytes: u64,
}

/// Honest native publication record: what was actually written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Publication {
    pub path: PathBuf,
    pub tile_count: usize,
    pub source_format: String,
    pub output: Output,
    pub instrumentation: Instrumentation,
}

fn safe_output_stem(title: Option<&str>) -> String {
    let mut stem = String::new();
    let mut previous_separator = false;
    for character in title.unwrap_or("dezoomify").chars() {
        if character.is_alphanumeric() {
            stem.push(character);
            previous_separator = false;
        } else if !previous_separator {
            stem.push('-');
            previous_separator = true;
        }
        if stem.len() >= 120 {
            break;
        }
    }
    let stem = stem.trim_matches('-');
    let lower = stem.to_ascii_lowercase();
    let reserved_windows_name = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || (lower.len() == 4
            && (lower.starts_with("com") || lower.starts_with("lpt"))
            && lower
                .as_bytes()
                .last()
                .is_some_and(|byte| matches!(byte, b'1'..=b'9')));
    if stem.is_empty() || reserved_windows_name {
        "dezoomify".to_string()
    } else {
        stem.to_string()
    }
}

fn auto_output_path(output_dir: &Path, title: Option<&str>, format: OutputFormat) -> PathBuf {
    let stem = safe_output_stem(title);
    let extension = format.extension();
    let first = output_dir.join(format!("{stem}.{extension}"));
    if !first.exists() {
        return first;
    }
    for suffix in 2..=9_999 {
        let candidate = output_dir.join(format!("{stem}-{suffix}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

impl Controls {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        self.0.changed.notify_waiters();
    }

    pub fn pause(&self) {
        self.0.paused.store(true, Ordering::SeqCst);
        self.0.changed.notify_waiters();
    }

    pub fn resume(&self) {
        self.0.paused.store(false, Ordering::SeqCst);
        self.0.changed.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    async fn wait_cancelled(&self) {
        loop {
            let changed = self.0.changed.notified();
            if self.is_cancelled() {
                return;
            }
            changed.await;
        }
    }

    #[allow(clippy::result_large_err)] // Host methods share the canonical error value.
    async fn checkpoint(&self, acquisition: bool) -> Result<(), Error> {
        loop {
            let changed = self.0.changed.notified();
            if self.is_cancelled() {
                return Err(cancelled());
            }
            if !acquisition || !self.0.paused.load(Ordering::SeqCst) {
                return Ok(());
            }
            changed.await;
        }
    }
}

type PartialAnswer<'a> = Pin<Box<dyn Future<Output = Result<RecoveryChoice, Error>> + 'a>>;
type PartialCallback<'a> = Box<dyn FnMut(MissingTiles) -> PartialAnswer<'a> + 'a>;

/// Concrete native resources and injected user interactions for one invocation.
pub struct NativeHost<'a> {
    pub options: JobOptions,
    pub controls: Controls,
    pub diagnostics: Diagnostics,
    pub transport: NativeTransport,
    fetch_limits: FetchLimits,
    user: UserHeaders,
    format: OutputFormat,
    sink: RefCell<Sink>,
    acquired: RefCell<BTreeSet<u32>>,
    instrumentation: RefCell<Instrumentation>,
    inflight: Cell<usize>,
    decode_tails: Arc<DecodeTails>,
    throttle: tokio::sync::Mutex<Option<Instant>>,
    progress: RefCell<Box<dyn FnMut(Progress) + 'a>>,
    partial: RefCell<Option<PartialCallback<'a>>>,
    published: RefCell<Option<Publication>>,
    source_format: RefCell<Option<String>>,
}

#[allow(clippy::result_large_err)] // Platform operations return the canonical Host error value.
impl<'a> NativeHost<'a> {
    pub fn new(options: JobOptions) -> Result<Self, Error> {
        Self::with_diagnostics(
            options,
            Diagnostics::new("native", env!("CARGO_PKG_VERSION")),
        )
    }

    pub fn with_diagnostics(options: JobOptions, diagnostics: Diagnostics) -> Result<Self, Error> {
        let options = options.normalized();
        options.validate()?;
        diagnostics.context(serde_json::json!({"input": options.input_url, "settings": {
            "format": options.format, "image_index": options.image_index, "zoom_level": options.zoom_level,
            "largest": options.largest, "max_width": options.max_width, "max_height": options.max_height,
            "parallelism": options.max_concurrent, "retries": options.max_retries,
            "retry_delay_ms": options.retry_base_delay.as_millis(), "keep_partial": options.keep_partial,
            "compression": options.compression, "header_names": options.headers.keys().collect::<Vec<_>>(),
            "credentials_present": !options.headers.is_empty(), "cache_enabled": true,
            "max_tiles": options.max_tiles, "max_bytes": options.max_bytes
        }}));
        let format = match &options.output {
            OutputTarget::File(path) => crate::output::infer_from_path(path)?,
            OutputTarget::AutoDir { format, .. } => *format,
        };
        let fetch_limits = FetchLimits {
            max_bytes: options.max_bytes,
            timeout: options.timeout,
            connect_timeout: options.connect_timeout,
            max_idle_per_host: options.max_idle_per_host,
            tls: TlsPolicy {
                accept_invalid_certs: options.accept_invalid_certs,
            },
            ..FetchLimits::default()
        };
        let transport = NativeTransport::new(&fetch_limits)?.with_diagnostics(diagnostics.clone());
        let user = UserHeaders::new(
            options.headers.clone(),
            url::Url::parse(&options.input_url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_string)),
        );
        let sink = Sink::new(&SinkOptions {
            compression: options.compression,
            retain_cap_bytes: options.output_retain_cap,
            spool_cap_bytes: options.output_spool_cap,
        });
        Ok(Self {
            options,
            controls: Controls::default(),
            diagnostics,
            transport,
            fetch_limits,
            user,
            format,
            sink: RefCell::new(sink),
            acquired: RefCell::default(),
            instrumentation: RefCell::default(),
            inflight: Cell::new(0),
            decode_tails: Arc::default(),
            throttle: tokio::sync::Mutex::new(None),
            progress: RefCell::new(Box::new(|_| {})),
            partial: RefCell::new(None),
            published: RefCell::new(None),
            source_format: RefCell::new(None),
        })
    }

    pub fn on_progress(&self, callback: impl FnMut(Progress) + 'a) {
        *self.progress.borrow_mut() = Box::new(callback);
    }

    pub fn on_partial(&self, callback: impl FnMut(MissingTiles) -> PartialAnswer<'a> + 'a) {
        *self.partial.borrow_mut() = Some(Box::new(callback));
    }

    pub fn publication(&self) -> Option<Publication> {
        self.published.borrow().clone()
    }

    pub fn inputs(&self) -> Vec<JobInput> {
        vec![JobInput::new(&self.options.input_url)]
    }

    pub fn algorithm_options(&self) -> Options {
        Options {
            format: self.options.format.clone(),
            output: self.format,
            selection: SelectionPolicy::Automatic {
                image_index: self.options.image_index.unwrap_or(0),
                largest: self.options.largest,
                max_width: self.options.max_width,
                max_height: self.options.max_height,
                zoom_level: self.options.zoom_level,
            },
            max_concurrent: self.options.max_concurrent as u32,
            max_tiles: self.options.max_tiles as u32,
            max_retries: self.options.max_retries,
            max_bytes: self.options.max_bytes,
            max_deferred_follows: 10,
            retry_base_delay_ms: self.options.retry_base_delay.as_millis().min(300_000) as u64,
            ..Options::default()
        }
    }

    async fn controlled<T>(
        &self,
        future: impl Future<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        tokio::select! {
            biased;
            () = self.controls.wait_cancelled() => Err(cancelled()),
            result = future => result,
        }
    }

    async fn read(&self, request: &ResourceRequest) -> Result<FetchOutcome, Error> {
        self.instrumentation.borrow_mut().attempts += 1;
        let outcome = self
            .controlled(async {
                self.transport
                    .fetch_resource(request, Some(&self.user), &self.fetch_limits)
                    .await
            })
            .await
            .map_err(|error| resource_context(error, request))?;
        self.instrumentation.borrow_mut().bytes_fetched += outcome.body.len() as u64;
        if !outcome.ok() {
            let mut error = Error::new(
                "TRANSPORT_HTTP_ERROR",
                ErrorPhase::Acquisition,
                crate::imaging::describe_http_failure(&outcome),
            );
            error.http = Some(outcome.status);
            error.request = Some(outcome.final_uri);
            error.retry_after_ms = outcome.retry_after_ms;
            error.retryable = dezoomify::retry::is_retryable(&error.code, error.http);
            return Err(resource_context(error, request));
        }
        Ok(outcome)
    }

    async fn decode(
        &self,
        bytes: Vec<u8>,
        processing: dezoomify::core::model::ProcessingRecipe,
        store: Option<(PathBuf, String, String)>,
    ) -> Result<DecodedTile, Error> {
        let permit = self.decode_tails.reserve(bytes.len());
        self.controlled(async {
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let bytes = processing.apply(bytes).map_err(|error| {
                    Error::new(
                        "tile.processing-failed",
                        ErrorPhase::Processing,
                        error.to_string(),
                    )
                })?;
                if let Some((dir, namespace, uri)) = store {
                    let _ = crate::cache::store(&dir, &namespace, &uri, &bytes);
                }
                let image = load_image_with_metadata(&bytes).map_err(|error| {
                    Error::new("TILE_DECODE_FAILED", ErrorPhase::Decode, error.to_string())
                })?;
                Ok::<_, Error>(DecodedTile {
                    image: image.image.to_rgba8(),
                    icc_profile: image.icc_profile,
                    exif_metadata: image.exif_metadata,
                })
            })
            .await
            .map_err(|_| {
                Error::new(
                    "native.internal",
                    ErrorPhase::Acquisition,
                    "tile decode task failed",
                )
            })?
        })
        .await
    }

    async fn tile(&self, tile: &Tile) -> Result<DecodedTile, Error> {
        let _flight = Flight::new(self);
        let namespace = crate::cache::job_namespace(&self.options.input_url);
        let dir = self
            .options
            .cache_dir
            .clone()
            .unwrap_or_else(crate::imaging::default_tile_cache_dir);
        if let Some(bytes) = crate::cache::load(&dir, &namespace, &tile.request.uri) {
            self.diagnostics.count("cache_reads", 1.0);
            if let Ok(decoded) = self.decode(bytes, Default::default(), None).await {
                return Ok(decoded);
            }
            self.controls.checkpoint(false).await?;
            let _ = std::fs::remove_file(
                dir.join(&namespace)
                    .join(crate::cache::cache_key(&tile.request.uri)),
            );
        }
        if !self.options.min_interval.is_zero() {
            let mut previous = self.throttle.lock().await;
            if let Some(previous) = *previous {
                let wait = (previous + self.options.min_interval)
                    .saturating_duration_since(Instant::now());
                if !wait.is_zero() {
                    self.controlled(async {
                        tokio::time::sleep(wait).await;
                        Ok(())
                    })
                    .await?;
                }
            }
            *previous = Some(Instant::now());
        }
        let response = self.read(&tile.request).await?;
        self.decode(
            response.body,
            tile.placement.processing,
            Some((dir, namespace, tile.request.uri.clone())),
        )
        .await
    }

    fn place(&self, tile: &Tile, decoded: DecodedTile) -> Result<(), Error> {
        // Separate resource slots prevent probe indices from colliding with
        // final plan indices. Finish supplies the plan order of reused probes.
        let storage_index = if tile.placement.probe_output {
            (self.options.max_tiles as u32).saturating_add(tile.index)
        } else {
            tile.index
        };
        let mut sink = self.sink.borrow_mut();
        sink.note_declared(tile.placement.canvas.as_ref().map(size));
        let retained = sink.retained_bytes();
        let inflight = self.decode_tails.bytes.load(Ordering::SeqCst);
        if decode_budget_exceeded(
            retained,
            inflight,
            crate::sink::tile_bytes(&decoded.image),
            sink.retain_cap_bytes(),
        ) {
            return Err(crate::output::canvas_memory_unavailable(
                1,
                1,
                &format!(
                    "decoded tiles beyond the retain cap ({retained} retained, {inflight} in flight)"
                ),
                "the configured output retention",
            ));
        }
        sink.place(
            storage_index,
            Vec2d {
                x: tile.placement.position.x,
                y: tile.placement.position.y,
            },
            tile.placement.expected_size.as_ref().map(size),
            decoded,
        )?;
        self.acquired.borrow_mut().insert(storage_index);
        self.instrumentation.borrow_mut().acquired = self.acquired.borrow().len() as u64;
        Ok(())
    }
}

impl Host for NativeHost<'_> {
    async fn fetch(
        &self,
        request: ResourceRequest,
        _interaction: Interaction,
    ) -> Result<ResourceRead, Error> {
        let response = self.read(&request).await?;
        Ok(ResourceRead::Response {
            response: ResourceResponse {
                bytes: response.body,
                final_uri: Some(response.final_uri),
            },
        })
    }

    async fn probe(&self, tile: Tile) -> Result<ProbeOutcome, Error> {
        match self.tile(&tile).await {
            Ok(decoded) => {
                let width = std::num::NonZeroU64::new(u64::from(decoded.image.width()));
                let height = std::num::NonZeroU64::new(u64::from(decoded.image.height()));
                if tile.placement.probe_output {
                    self.place(&tile, decoded)
                        .map_err(|error| resource_context(error, &tile.request))?;
                }
                match (width, height) {
                    (Some(width), Some(height)) => Ok(ProbeOutcome::Available { width, height }),
                    _ => Ok(ProbeOutcome::Missing),
                }
            }
            Err(error) if error.code == "job.cancelled" => {
                Err(resource_context(error, &tile.request))
            }
            Err(_) => Ok(ProbeOutcome::Missing),
        }
    }

    async fn acquire_tile(&self, tile: Tile) -> Result<(), Error> {
        async {
            let decoded = self.tile(&tile).await?;
            self.controls.checkpoint(false).await?;
            self.place(&tile, decoded)
        }
        .await
        .map_err(|error| resource_context(error, &tile.request))
        .inspect_err(|error| {
            let mut stats = self.instrumentation.borrow_mut();
            if error.retryable {
                stats.failed_transient += 1;
            } else {
                stats.failed_permanent += 1;
            }
            if error.code != "job.cancelled" {
                self.diagnostics
                    .record(DiagnosticLevel::Warn, "tile", serde_json::json!(error));
            }
        })
    }

    async fn finish(&self, request: FinishRequest) -> Result<Output, Error> {
        self.controls.checkpoint(false).await?;
        let destination = match &self.options.output {
            OutputTarget::File(path) => path.clone(),
            OutputTarget::AutoDir { dir, format } => {
                auto_output_path(dir, request.title.as_deref(), *format)
            }
        };
        let mut sink = self.sink.borrow_mut();
        sink.note_declared(request.canvas.as_ref().map(size));
        let acquired = self.acquired.borrow();
        let image_size = sink.assemble()?;
        let partial = !request.missing.is_empty();
        let published = sink.commit(crate::sink::CommitParams {
            dest: &destination,
            format: self.format,
            overwrite: self.options.overwrite,
            cancelled: &self.controls.0.cancelled,
            partial,
            reused_tiles: &request.reused_tiles,
        })?;
        let stats = sink.stats();
        let mut instrumentation = self.instrumentation.borrow().clone();
        instrumentation.peak_retained_bytes = stats.peak_retained_bytes;
        instrumentation.peak_decode_inflight_bytes =
            self.decode_tails.peak_bytes.load(Ordering::SeqCst);
        instrumentation.canvas_bytes = stats.canvas_bytes;
        instrumentation.encoded_bytes = stats.encoded_bytes;
        instrumentation.peak_spool_bytes = stats.peak_spool_bytes;
        instrumentation.late_repaints = stats.late_repaints;
        instrumentation.accounted_peak_bytes = stats
            .canvas_bytes
            .saturating_add(stats.peak_retained_bytes)
            .saturating_add(stats.encoded_bytes);
        let output = Output {
            canvas: Some(Size {
                width: image_size.x,
                height: image_size.y,
            }),
            format: request.format,
            complete: !partial,
            missing: request.missing,
            disposition: OutputDisposition::NativePublication,
        };
        self.diagnostics.finish(if partial { "partial-completed" } else { "completed" },
            serde_json::json!({"width": image_size.x, "height": image_size.y, "format": self.format.as_str(), "missing": output.missing.len()}));
        *self.published.borrow_mut() = Some(Publication {
            path: published,
            tile_count: acquired.len(),
            source_format: self.source_format.borrow().clone().unwrap_or_default(),
            output: output.clone(),
            instrumentation,
        });
        Ok(output)
    }

    async fn choose_image(&self, _catalog: Catalog) -> Result<u32, Error> {
        Err(Error::new(
            "discovery.no-image",
            ErrorPhase::Discovery,
            "native image selection requires a configured policy",
        ))
    }

    async fn choose_level(&self, _image: Image) -> Result<u32, Error> {
        Err(Error::new(
            "discovery.no-level",
            ErrorPhase::Discovery,
            "native level selection requires a configured policy",
        ))
    }

    async fn choose_partial(&self, missing: MissingTiles) -> Result<RecoveryChoice, Error> {
        let answer = self
            .partial
            .borrow_mut()
            .as_mut()
            .map(|callback| callback(missing));
        if let Some(answer) = answer {
            self.controlled(async {
                match tokio::time::timeout(Duration::from_secs(60), answer).await {
                    Ok(result) => result,
                    Err(_) => Ok(if self.options.keep_partial {
                        RecoveryChoice::Keep
                    } else {
                        RecoveryChoice::Discard
                    }),
                }
            })
            .await
        } else {
            Ok(if self.options.keep_partial {
                RecoveryChoice::Keep
            } else {
                RecoveryChoice::Discard
            })
        }
    }

    async fn checkpoint(&self, gate: Gate) -> Result<(), Error> {
        self.controls
            .checkpoint(matches!(gate, Gate::Acquisition))
            .await
    }

    async fn sleep(&self, delay_ms: u32) -> Result<(), Error> {
        self.instrumentation.borrow_mut().retries_scheduled += 1;
        self.instrumentation.borrow_mut().timer_wait_ms += u64::from(delay_ms);
        self.controlled(async {
            tokio::time::sleep(Duration::from_millis(u64::from(delay_ms))).await;
            Ok(())
        })
        .await
    }

    fn report(&self, progress: Progress) {
        if progress.source_format.is_some() {
            *self.source_format.borrow_mut() = progress.source_format.clone();
        }
        self.diagnostics.observe(&progress);
        (self.progress.borrow_mut())(progress);
    }

    fn warn(&self, message: String) {
        self.diagnostics.record(
            DiagnosticLevel::Warn,
            "discovery-warning",
            serde_json::json!({"message": message}),
        );
    }

    async fn settle(&self) {
        while self.decode_tails.active.load(Ordering::SeqCst) != 0 {
            let changed = self.decode_tails.changed.notified();
            if self.decode_tails.active.load(Ordering::SeqCst) != 0 {
                changed.await;
            }
        }
        if self.published.borrow().is_none() {
            self.sink.borrow_mut().rollback();
        }
        self.sink.borrow_mut().release();
    }
}

fn resource_context(mut error: Error, request: &ResourceRequest) -> Error {
    let kind = match request.purpose {
        RequestPurpose::Metadata => {
            if error.phase == ErrorPhase::Acquisition {
                error.phase = ErrorPhase::Discovery;
            }
            ResourceKind::Metadata
        }
        RequestPurpose::Tile => ResourceKind::Tile,
        RequestPurpose::Probe => ResourceKind::Probe,
    };
    error.request.get_or_insert_with(|| request.uri.clone());
    error.resource_kind.get_or_insert(kind);
    error.transport.get_or_insert(ErrorTransport::Native);
    error
}

fn size(size: &Size) -> Vec2d {
    Vec2d {
        x: size.width,
        y: size.height,
    }
}
fn cancelled() -> Error {
    Error::new(
        "job.cancelled",
        ErrorPhase::Cleanup,
        "job cancelled before completion",
    )
}

#[derive(Default)]
struct DecodeTails {
    active: AtomicUsize,
    bytes: AtomicU64,
    peak_bytes: AtomicU64,
    changed: tokio::sync::Notify,
}

impl DecodeTails {
    fn reserve(self: &Arc<Self>, bytes: usize) -> DecodePermit {
        self.active.fetch_add(1, Ordering::SeqCst);
        let current = self
            .bytes
            .fetch_add(bytes as u64, Ordering::SeqCst)
            .saturating_add(bytes as u64);
        self.peak_bytes.fetch_max(current, Ordering::SeqCst);
        DecodePermit {
            tails: Arc::clone(self),
            bytes: bytes as u64,
        }
    }
}

struct DecodePermit {
    tails: Arc<DecodeTails>,
    bytes: u64,
}
impl Drop for DecodePermit {
    fn drop(&mut self) {
        self.tails.bytes.fetch_sub(self.bytes, Ordering::SeqCst);
        self.tails.active.fetch_sub(1, Ordering::SeqCst);
        self.tails.changed.notify_waiters();
    }
}

struct Flight<'a, 'b>(&'a NativeHost<'b>);
impl<'a, 'b> Flight<'a, 'b> {
    fn new(host: &'a NativeHost<'b>) -> Self {
        host.inflight.set(host.inflight.get() + 1);
        let mut stats = host.instrumentation.borrow_mut();
        stats.peak_inflight = stats.peak_inflight.max(host.inflight.get());
        Self(host)
    }
}
impl Drop for Flight<'_, '_> {
    fn drop(&mut self) {
        self.0.inflight.set(self.0.inflight.get().saturating_sub(1));
    }
}

fn decode_budget_exceeded(retained: u64, inflight: u64, tile: u64, cap: u64) -> bool {
    retained.saturating_add(inflight).saturating_add(tile) > cap
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pause_suspends_acquisition_and_cancel_releases_the_wait() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let controls = Controls::default();
            controls.pause();
            controls.checkpoint(false).await.unwrap();
            let acquisition = controls.checkpoint(true);
            tokio::pin!(acquisition);
            tokio::select! {
                biased;
                _ = &mut acquisition => panic!("acquisition must wait while paused"),
                () = std::future::ready(()) => {}
            }
            controls.cancel();
            assert_eq!(acquisition.await.unwrap_err().code, "job.cancelled");
        });
    }

    #[test]
    fn blocking_decode_permit_survives_cancellation_until_work_exits() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let tails = Arc::new(DecodeTails::default());
            let permit = tails.reserve(1024);
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, finish) = std::sync::mpsc::channel();
            let parent = tokio::spawn(async move {
                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    started.send(()).unwrap();
                    finish.recv().unwrap();
                })
                .await
            });
            ready.await.unwrap();
            parent.abort();
            let _ = parent.await;
            assert_eq!(tails.active.load(Ordering::SeqCst), 1);
            assert_eq!(tails.bytes.load(Ordering::SeqCst), 1024);
            release.send(()).unwrap();
            while tails.active.load(Ordering::SeqCst) != 0 {
                let changed = tails.changed.notified();
                if tails.active.load(Ordering::SeqCst) != 0 {
                    changed.await;
                }
            }
            assert_eq!(tails.bytes.load(Ordering::SeqCst), 0);
            assert_eq!(tails.peak_bytes.load(Ordering::SeqCst), 1024);
        });
    }

    #[test]
    fn decode_budget_counts_retained_pixels_and_unfinished_work() {
        assert!(!decode_budget_exceeded(400, 100, 12, 512));
        assert!(decode_budget_exceeded(400, 100, 13, 512));
        assert!(decode_budget_exceeded(u64::MAX, u64::MAX, 1, u64::MAX - 1));
    }
}
