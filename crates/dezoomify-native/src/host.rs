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
    imaging::{load_image_with_limit, DecodedTile},
    options::{JobOptions, OutputTarget},
    pixel_pipe::{MemoryBudget, PixelPipe, Reservation},
    raster::EncoderTask,
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
    reader: std::sync::Mutex<Option<std::sync::Weak<PixelPipe>>>,
}
/// Honest execution accounting, reported with every result.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Instrumentation {
    /// Tile/probe/metadata operations attempted.
    pub attempts: u64,
    /// Tiles acquired and placed, including encoded tile reuse.
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
    /// Peak raster RAM reservations, or retained encoded tiles and metadata.
    pub peak_retained_bytes: u64,
    /// Peak in-flight decode bytes: encoded bodies held by blocking decode
    /// tails (including tails detached by cancelling their parent task).
    /// Bounded by the acquisition slots times the response byte limit;
    /// tracked separately from raster RAM reservations.
    pub peak_decode_inflight_bytes: u64,
    /// Total bytes in the committed output, not resident memory.
    pub encoded_bytes: u64,
    /// Pixel decoder calls; header inspection and tile reuse do not count.
    pub pixel_decodes: u64,
    /// Incoming strip contributions discarded after ownership handoff.
    pub late_repaints: u64,
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

fn automatic_image_format(size: Vec2d, transparent: bool) -> OutputFormat {
    if !transparent
        && size.x <= crate::imaging::JPEG_MAX_SIDE
        && size.y <= crate::imaging::JPEG_MAX_SIDE
    {
        OutputFormat::Jpeg
    } else {
        OutputFormat::Png
    }
}

#[test]
fn automatic_format_checks_both_sides_at_the_jpeg_boundary() {
    for (x, y, expected) in [
        (65_535, 1, OutputFormat::Jpeg),
        (1, 65_535, OutputFormat::Jpeg),
        (65_536, 1, OutputFormat::Png),
        (1, 65_536, OutputFormat::Png),
    ] {
        assert_eq!(automatic_image_format(Vec2d { x, y }, false), expected);
    }
    assert_eq!(
        automatic_image_format(Vec2d { x: 1, y: 1 }, true),
        OutputFormat::Png
    );
}

fn auto_output_path(
    output_dir: &Path,
    title: Option<&str>,
    format: OutputFormat,
    partial: bool,
) -> PathBuf {
    let stem = safe_output_stem(title);
    let extension = format.extension();
    let first = output_dir.join(format!("{stem}.{extension}"));
    let exists = |path: &Path| {
        if partial {
            crate::output::partial_path_for(path).exists()
        } else {
            path.exists()
        }
    };
    if !exists(&first) {
        return first;
    }
    for suffix in 2..=9_999 {
        let candidate = output_dir.join(format!("{stem}-{suffix}.{extension}"));
        if !exists(&candidate) {
            return candidate;
        }
    }
    first
}

impl Controls {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::SeqCst);
        self.0.changed.notify_waiters();
        if let Some(reader) = self
            .0
            .reader
            .lock()
            .expect("control reader lock")
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
        {
            reader.fail(cancelled());
        }
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
    pub(crate) fn watch(&self, pipe: &Arc<PixelPipe>) {
        *self.0.reader.lock().expect("control reader lock") = Some(Arc::downgrade(pipe));
        if self.is_cancelled() {
            pipe.fail(cancelled());
        }
    }
    pub(crate) fn cancel_flag(&self) -> &AtomicBool {
        &self.0.cancelled
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

struct ReceivedPixels {
    decoded: DecodedTile,
    reservation: Reservation,
}
struct PendingPixels {
    id: u32,
    placement: TilePlacement,
    pixels: ReceivedPixels,
}

/// Concrete native resources and injected user interactions for one invocation.
pub struct NativeHost<'a> {
    pub options: JobOptions,
    pub controls: Controls,
    pub diagnostics: Diagnostics,
    pub transport: NativeTransport,
    fetch_limits: FetchLimits,
    user: UserHeaders,
    format: OutputFormat,
    raster: RefCell<Option<EncoderTask>>,
    pixels: Arc<MemoryBudget>,
    pending_pixels: RefCell<Vec<PendingPixels>>,
    acquired: RefCell<BTreeSet<u32>>,
    instrumentation: RefCell<Instrumentation>,
    inflight: Cell<usize>,
    decode_tails: Arc<DecodeTails>,
    throttle: tokio::sync::Mutex<Option<Instant>>,
    progress: RefCell<Box<dyn FnMut(Progress) + 'a>>,
    last_progress: RefCell<Progress>,
    partial: RefCell<Option<PartialCallback<'a>>>,
    published: RefCell<Option<Publication>>,
    source_format: RefCell<Option<String>>,
    output_plan: RefCell<Option<OutputPlan>>,
    tiled: RefCell<Option<Arc<std::sync::Mutex<crate::tile_output::TileWriter>>>>,
    encoded_probes: RefCell<Vec<crate::tile_output::EncodedTile>>,
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
        let mut options = options.normalized();
        options.output_retain_cap = options
            .output_retain_cap
            .min(crate::imaging::available_memory_bytes() / 5 * 4);
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
            OutputTarget::AutoImageDir { .. } => OutputFormat::Png,
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
        let pixels = MemoryBudget::new(options.output_retain_cap);
        Ok(Self {
            options,
            controls: Controls::default(),
            diagnostics,
            transport,
            fetch_limits,
            user,
            format,
            raster: RefCell::new(None),
            pixels,
            pending_pixels: RefCell::new(Vec::new()),
            acquired: RefCell::default(),
            instrumentation: RefCell::default(),
            inflight: Cell::new(0),
            decode_tails: Arc::default(),
            throttle: tokio::sync::Mutex::new(None),
            progress: RefCell::new(Box::new(|_| {})),
            last_progress: RefCell::new(Progress::default()),
            partial: RefCell::new(None),
            published: RefCell::new(None),
            source_format: RefCell::new(None),
            output_plan: RefCell::new(None),
            tiled: RefCell::new(None),
            encoded_probes: RefCell::new(Vec::new()),
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
        let pipe = self
            .raster
            .borrow()
            .as_ref()
            .map(|task| Arc::clone(&task.pipe));
        let failure = async {
            match pipe {
                Some(pipe) => pipe.wait_failed().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            () = self.controls.wait_cancelled() => Err(cancelled()),
            error = failure => Err(error),
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
            let error = Error::HttpError {
                status: outcome.status,
                retry_after_ms: outcome.retry_after_ms,
                preview: None,
                transport: ErrorTransport::Native,
                failure: Failure {
                    request: Some(dezoomify::model::bounded_uri(outcome.final_uri.clone())),
                    detail: None,
                },
            };
            return Err(resource_context(error, request));
        }
        Ok(outcome)
    }

    async fn decode(
        &self,
        bytes: Vec<u8>,
        processing: dezoomify::core::model::ProcessingRecipe,
        store: Option<(PathBuf, String, String)>,
    ) -> Result<ReceivedPixels, Error> {
        let permit = self.decode_tails.reserve(bytes.len());
        let decode_tails = Arc::clone(&self.decode_tails);
        let budget = Arc::clone(&self.pixels);
        self.controlled(async {
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                // Decryption can hold input, an encrypted chunk and output.
                let mut processing_memory = budget.reserve(
                    bytes.len() as u64
                        * match processing {
                            dezoomify::core::model::ProcessingRecipe::None => 1,
                            dezoomify::core::model::ProcessingRecipe::GoogleArtsDecrypt => 3,
                        },
                )?;
                let bytes = processing
                    .apply(bytes)
                    .map_err(|error| Error::ProcessingFailed(error.to_string().into()))?;
                processing_memory.shrink(bytes.len() as u64);
                if let Some((dir, namespace, uri)) = &store {
                    let _ = crate::cache::store(dir, namespace, uri, &bytes);
                }
                let (dimensions, _) = crate::tile_output::inspect(&bytes)?;
                // Charge before the pixel decoder can allocate. The temporary
                // allowance covers conversion and decoder workspace; only the
                // actual RGBA allocation remains charged until placement.
                let pixels = u64::from(dimensions.width) * u64::from(dimensions.height);
                let mut reservation = budget.reserve(pixels.saturating_mul(16))?;
                decode_tails.pixel_decodes.fetch_add(1, Ordering::SeqCst);
                let decoded = load_image_with_limit(
                    &bytes,
                    Some(pixels.saturating_mul(16).saturating_add(bytes.len() as u64)),
                )
                .map_err(|error| Error::DecodeFailed(error.to_string().into()))?;
                drop(bytes);
                drop(processing_memory);
                reservation.shrink(decoded.image.as_raw().len() as u64);
                Ok::<_, Error>(ReceivedPixels {
                    decoded,
                    reservation,
                })
            })
            .await
            .map_err(|_| Error::Internal("tile decode task failed".to_string().into()))?
        })
        .await
    }

    async fn tile(&self, tile: &Tile) -> Result<ReceivedPixels, Error> {
        let _flight = Flight::new(self);
        let namespace = crate::cache::job_namespace(&self.options.input_url);
        let dir = self
            .options
            .cache_dir
            .clone()
            .unwrap_or_else(crate::imaging::default_tile_cache_dir);
        if let Some(bytes) = crate::cache::load(&dir, &namespace, &tile.request.uri) {
            self.diagnostics.count("cache_reads", 1.0);
            match self.decode(bytes, Default::default(), None).await {
                Ok(decoded) => return Ok(decoded),
                Err(error) if error.is_terminal() || error.is_output() => return Err(error),
                Err(_) => {}
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

    async fn inspect_encoded(
        &self,
        mut bytes: Vec<u8>,
    ) -> Result<(Vec<u8>, Size, image::ImageFormat), Error> {
        let permit = self.decode_tails.reserve(bytes.len());
        self.check_encoded_inflight()?;
        let budget = self
            .options
            .output_retain_cap
            .saturating_sub(self.decode_tails.bytes.load(Ordering::SeqCst));
        self.controlled(async {
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                crate::tile_output::normalize_orientation(&mut bytes);
                let (size, format) = crate::tile_output::inspect(&bytes, budget)?;
                Ok((bytes, size, format))
            })
            .await
            .map_err(|_| Error::Internal("tile inspection task failed".into()))?
        })
        .await
    }

    async fn encoded_tile(&self, tile: &Tile) -> Result<crate::tile_output::EncodedTile, Error> {
        let _flight = Flight::new(self);
        let namespace = crate::cache::job_namespace(&self.options.input_url);
        let dir = self
            .options
            .cache_dir
            .clone()
            .unwrap_or_else(crate::imaging::default_tile_cache_dir);
        if let Some(bytes) = crate::cache::load(&dir, &namespace, &tile.request.uri) {
            match self.inspect_encoded(bytes).await {
                Ok((bytes, size, format)) => {
                    self.diagnostics.count("cache_reads", 1.0);
                    return Ok(crate::tile_output::EncodedTile {
                        request: Some(tile.request.clone()),
                        id: self.storage_index(tile),
                        placement: tile.placement.clone(),
                        bytes,
                        size,
                        format,
                    });
                }
                Err(Error::DecodeFailed(_)) => {}
                Err(error) => return Err(error),
            }
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
                self.controlled(async {
                    tokio::time::sleep(wait).await;
                    Ok(())
                })
                .await?;
            }
            *previous = Some(Instant::now());
        }
        let response = self.read(&tile.request).await?;
        let processing = tile.placement.processing;
        let permit = self.decode_tails.reserve(response.body.len());
        self.check_encoded_inflight()?;
        let uri = tile.request.uri.clone();
        let budget = self
            .options
            .output_retain_cap
            .saturating_sub(self.decode_tails.bytes.load(Ordering::SeqCst));
        let (bytes, size, format) = self
            .controlled(async {
                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    let mut bytes = processing
                        .apply(response.body)
                        .map_err(|e| Error::ProcessingFailed(e.to_string().into()))?;
                    crate::tile_output::normalize_orientation(&mut bytes);
                    let (size, format) = crate::tile_output::inspect(&bytes, budget)?;
                    let _ = crate::cache::store(&dir, &namespace, &uri, &bytes);
                    Ok((bytes, size, format))
                })
                .await
                .map_err(|_| Error::Internal("tile processing task failed".into()))?
            })
            .await?;
        Ok(crate::tile_output::EncodedTile {
            request: Some(tile.request.clone()),
            id: self.storage_index(tile),
            placement: tile.placement.clone(),
            bytes,
            size,
            format,
        })
    }

    fn storage_index(&self, tile: &Tile) -> u32 {
        if tile.placement.role.probe {
            (self.options.max_tiles as u32).saturating_add(tile.index)
        } else {
            tile.index
        }
    }

    fn check_encoded_inflight(&self) -> Result<(), Error> {
        let probes: u64 = self
            .encoded_probes
            .borrow()
            .iter()
            .map(|tile| tile.bytes.len() as u64)
            .sum();
        crate::tile_output::memory_check(
            probes
                .saturating_add(self.decode_tails.bytes.load(Ordering::SeqCst))
                .saturating_add(self.decode_tails.encoded_retained.load(Ordering::SeqCst)),
            self.options.output_retain_cap,
        )
    }

    fn evict_failed_tile<T>(&self, tile: &Tile, result: &Result<T, Error>) {
        if matches!(self.format, OutputFormat::IiifDir | OutputFormat::Zif)
            && result
                .as_ref()
                .is_err_and(|e| matches!(e.cause(), Error::DecodeFailed(_)))
        {
            let dir = self
                .options
                .cache_dir
                .clone()
                .unwrap_or_else(crate::imaging::default_tile_cache_dir);
            let _ = std::fs::remove_file(
                dir.join(crate::cache::job_namespace(&self.options.input_url))
                    .join(crate::cache::cache_key(&tile.request.uri)),
            );
        }
    }

    async fn place_encoded(&self, tile: crate::tile_output::EncodedTile) -> Result<(), Error> {
        let id = tile.id;
        let writer = self.tiled.borrow().as_ref().cloned();
        if let Some(writer) = writer {
            let permit = self.decode_tails.reserve(tile.bytes.len());
            self.check_encoded_inflight()?;
            let controls = self.controls.clone();
            let peak = self
                .controlled(async {
                    tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        let result = (|| {
                            let mut writer = writer
                                .lock()
                                .map_err(|_| Error::Internal("tile writer poisoned".into()))?;
                            let queued = _permit
                                .tails
                                .bytes
                                .load(Ordering::SeqCst)
                                .saturating_sub(_permit.bytes);
                            writer.hold_queued_bytes(queued)?;
                            let result = writer.place(tile, &controls.0.cancelled);
                            writer.release_probe_bytes(queued);
                            _permit
                                .tails
                                .encoded_retained
                                .store(writer.retained_bytes(), Ordering::SeqCst);
                            result?;
                            Ok(writer.peak_retained())
                        })();
                        drop(writer);
                        result
                    })
                    .await
                    .map_err(|_| Error::Internal("tile placement task failed".into()))?
                })
                .await?;
            let mut stats = self.instrumentation.borrow_mut();
            stats.peak_retained_bytes = stats.peak_retained_bytes.max(peak);
        } else {
            let mut probes = self.encoded_probes.borrow_mut();
            let retained = probes
                .iter()
                .map(|tile| tile.bytes.len() as u64)
                .sum::<u64>()
                + tile.bytes.len() as u64;
            crate::tile_output::memory_check(retained, self.options.output_retain_cap)?;
            let mut stats = self.instrumentation.borrow_mut();
            stats.peak_encoded_bytes = stats.peak_encoded_bytes.max(retained);
            probes.push(tile);
        }
        self.acquired.borrow_mut().insert(id);
        self.instrumentation.borrow_mut().acquired = self.acquired.borrow().len() as u64;
        Ok(())
    }

    async fn place(&self, tile: &Tile, pixels: ReceivedPixels) -> Result<(), Error> {
        // Separate resource slots prevent probe indices from colliding with
        // final plan indices. Finish supplies the plan order of reused probes.
        let storage_index = self.storage_index(tile);
        let pipe = self
            .raster
            .borrow()
            .as_ref()
            .map(|task| Arc::clone(&task.pipe));
        if let Some(pipe) = pipe {
            self.place_pixels(pipe, storage_index, tile.placement.clone(), pixels)
                .await?;
        } else {
            self.pending_pixels.borrow_mut().push(PendingPixels {
                id: storage_index,
                placement: tile.placement.clone(),
                pixels,
            });
        }
        self.acquired.borrow_mut().insert(storage_index);
        self.instrumentation.borrow_mut().acquired = self.acquired.borrow().len() as u64;
        Ok(())
    }

    async fn place_pixels(
        &self,
        pipe: Arc<PixelPipe>,
        id: u32,
        placement: TilePlacement,
        pixels: ReceivedPixels,
    ) -> Result<(), Error> {
        // Copy/composition belongs on a worker; placement never waits for queue
        // capacity. The tail tracker owns cancelled placement work too.
        let permit = self.decode_tails.reserve(0);
        self.controlled(async {
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                pipe.place(id, &placement, pixels.decoded, pixels.reservation)
            })
            .await
            .map_err(|_| Error::Internal("pixel producer task failed".into()))?
        })
        .await
    }

    async fn start_raster(&self, dimensions: Size, title: Option<&str>) -> Result<(), Error> {
        let destination = match &self.options.output {
            OutputTarget::File(path) => path.clone(),
            OutputTarget::AutoDir { dir, format } => auto_output_path(dir, title, *format),
        };
        let task = EncoderTask::start(
            &destination,
            dimensions,
            self.format,
            self.options.compression,
            Arc::clone(&self.pixels),
            self.controls.clone(),
        )?;
        let pipe = Arc::clone(&task.pipe);
        *self.raster.borrow_mut() = Some(task);
        let pending = std::mem::take(&mut *self.pending_pixels.borrow_mut());
        for pending in pending {
            self.place_pixels(
                Arc::clone(&pipe),
                pending.id,
                pending.placement,
                pending.pixels,
            )
            .await?;
        }
        Ok(())
    }

    fn next_auto_destination(&self, title: Option<&str>, partial: bool) -> PathBuf {
        let OutputTarget::AutoDir { dir, format } = &self.options.output else {
            unreachable!("automatic destination")
        };
        let stem = safe_output_stem(title);
        for suffix in 1..=9_999 {
            let name = if suffix == 1 {
                stem.clone()
            } else {
                format!("{stem}-{suffix}")
            };
            let path = dir.join(format!("{name}.{}", format.extension()));
            let path = if partial {
                crate::output::partial_path_for(&path)
            } else {
                path
            };
            if !path.exists() {
                return path;
            }
        }
        dir.join(format!("{stem}.{}", format.extension()))
    }
    fn report_preparation(&self, pipe: &PixelPipe) {
        let mut progress = self.last_progress.borrow().clone();
        progress.preparation = Some(OutputPreparation {
            completed_pixels: pipe.consumed(),
            total_pixels: u64::from(pipe.size.width) * u64::from(pipe.size.height),
        });
        self.report(progress);
    }
}

impl Host for NativeHost<'_> {
    async fn parse_html(
        &self,
        query: dezoomify::model::HtmlQuery,
    ) -> Result<dezoomify::model::HtmlDocument, Error> {
        crate::html::parse_html(query).await
    }
    async fn begin_output(&self, plan: OutputPlan) -> Result<(), Error> {
        self.controls.checkpoint(false).await?;
        if plan.format != self.format || self.output_plan.borrow().is_some() {
            return Err(Error::InvalidState(
                "output preflight does not match invocation".into(),
            ));
        }
        if let OutputTarget::File(path) = &self.options.output {
            crate::output::validate_destination(path, &self.format, self.options.overwrite)?;
        }
        if matches!(self.format, OutputFormat::IiifDir | OutputFormat::Zif) {
            let destination = match &self.options.output {
                OutputTarget::File(path) => path.clone(),
                OutputTarget::AutoDir { dir, format } => {
                    auto_output_path(dir, plan.title.as_deref(), *format, false)
                }
                OutputTarget::AutoImageDir { dir } => {
                    auto_output_path(dir, plan.title.as_deref(), self.format, false)
                }
            };
            let probes = std::mem::take(&mut *self.encoded_probes.borrow_mut());
            let pending: u64 = probes.iter().map(|tile| tile.bytes.len() as u64).sum();
            let mut writer = crate::tile_output::TileWriter::new(
                &destination,
                &plan,
                self.options.output_retain_cap.saturating_sub(pending),
                self.options.compression,
                self.options.max_tiles as u32,
            )?;
            let controls = self.controls.clone();
            let permit = self.decode_tails.reserve(0);
            let writer = self
                .controlled(async {
                    tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        for tile in probes {
                            writer.release_probe_bytes(tile.bytes.len() as u64);
                            let request = tile.request.clone();
                            writer.place(tile, &controls.0.cancelled).map_err(
                                |e| match request {
                                    Some(ref request) => resource_context(e, request),
                                    None => e,
                                },
                            )?;
                        }
                        Ok(writer)
                    })
                    .await
                    .map_err(|_| Error::Internal("tile preflight task failed".into()))?
                })
                .await?;
            let mut stats = self.instrumentation.borrow_mut();
            stats.peak_retained_bytes = stats.peak_retained_bytes.max(writer.peak_retained());
            self.decode_tails
                .encoded_retained
                .store(writer.retained_bytes(), Ordering::SeqCst);
            *self.tiled.borrow_mut() = Some(Arc::new(std::sync::Mutex::new(writer)));
        } else if let Some(dimensions) = &plan.canvas {
            self.start_raster(dimensions.clone(), plan.title.as_deref())
                .await?;
        }
        *self.output_plan.borrow_mut() = Some(plan);
        Ok(())
    }
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
        if matches!(self.format, OutputFormat::IiifDir | OutputFormat::Zif) {
            let result = async {
                let mut encoded = self.encoded_tile(&tile).await?;
                let width = std::num::NonZeroU64::new(u64::from(encoded.size.width));
                let height = std::num::NonZeroU64::new(u64::from(encoded.size.height));
                if tile.placement.role.output {
                    let extent = tile
                        .placement
                        .expected_size
                        .as_ref()
                        .unwrap_or(&encoded.size);
                    let size = Size {
                        width: extent.width.min(encoded.size.width),
                        height: extent.height.min(encoded.size.height),
                    };
                    if size != encoded.size
                        || (self.format == OutputFormat::Zif
                            && !crate::zif_output::can_reuse(&encoded.bytes))
                        || !matches!(
                            encoded.format,
                            image::ImageFormat::Png | image::ImageFormat::Jpeg
                        )
                    {
                        let permit = self.decode_tails.reserve(encoded.bytes.len());
                        self.check_encoded_inflight()?;
                        let budget = self.options.output_retain_cap.saturating_sub(
                            self.decode_tails
                                .bytes
                                .load(Ordering::SeqCst)
                                .saturating_sub(encoded.bytes.len() as u64)
                                + self
                                    .encoded_probes
                                    .borrow()
                                    .iter()
                                    .map(|tile| tile.bytes.len() as u64)
                                    .sum::<u64>(),
                        );
                        let compression = self.options.compression;
                        encoded = self
                            .controlled(async {
                                tokio::task::spawn_blocking(move || {
                                    let _permit = permit;
                                    _permit.tails.pixel_decodes.fetch_add(1, Ordering::SeqCst);
                                    encoded.convert_to_png(size, budget, compression)?;
                                    Ok(encoded)
                                })
                                .await
                                .map_err(|_| {
                                    Error::Internal("probe conversion task failed".into())
                                })?
                            })
                            .await?;
                    }
                    self.place_encoded(encoded)
                        .await
                        .map_err(|e| resource_context(e, &tile.request))?;
                }
                match (width, height) {
                    (Some(width), Some(height)) => Ok(ProbeOutcome::Available { width, height }),
                    _ => Ok(ProbeOutcome::Missing),
                }
            }
            .await;
            self.evict_failed_tile(&tile, &result);
            return match result {
                Ok(outcome) => Ok(outcome),
                Err(error) if error.is_terminal() || error.is_output() => {
                    Err(resource_context(error, &tile.request))
                }
                Err(_) => Ok(ProbeOutcome::Missing),
            };
        }
        match self.tile(&tile).await {
            Ok(decoded) => {
                let width = std::num::NonZeroU64::new(u64::from(decoded.decoded.image.width()));
                let height = std::num::NonZeroU64::new(u64::from(decoded.decoded.image.height()));
                if tile.placement.role.output {
                    self.place(&tile, decoded)
                        .await
                        .map_err(|error| resource_context(error, &tile.request))?;
                }
                match (width, height) {
                    (Some(width), Some(height)) => Ok(ProbeOutcome::Available { width, height }),
                    _ => Ok(ProbeOutcome::Missing),
                }
            }
            Err(error) if error.is_terminal() || error.is_output() => {
                Err(resource_context(error, &tile.request))
            }
            Err(_) => Ok(ProbeOutcome::Missing),
        }
    }

    async fn acquire_tile(&self, tile: Tile) -> Result<(), Error> {
        let result = async {
            if matches!(self.format, OutputFormat::IiifDir | OutputFormat::Zif) {
                let encoded = self.encoded_tile(&tile).await?;
                self.controls.checkpoint(false).await?;
                return self.place_encoded(encoded).await;
            }
            let decoded = self.tile(&tile).await?;
            self.controls.checkpoint(false).await?;
            self.place(&tile, decoded).await
        }
        .await;
        self.evict_failed_tile(&tile, &result);
        result
            .map_err(|error| resource_context(error, &tile.request))
            .inspect_err(|error| {
                let mut stats = self.instrumentation.borrow_mut();
                if error.retryable() {
                    stats.failed_transient += 1;
                } else {
                    stats.failed_permanent += 1;
                }
                if !matches!(error.cause(), Error::Cancelled) {
                    self.diagnostics.record(
                        DiagnosticLevel::Warn,
                        "tile",
                        serde_json::json!(error),
                    );
                }
            })
    }

    async fn finish(&self, request: FinishRequest) -> Result<Output, Error> {
        self.controls.checkpoint(false).await?;
        let partial = !request.missing.is_empty();
        let destination_for = |format| match &self.options.output {
            OutputTarget::File(path) => path.clone(),
            OutputTarget::AutoDir { dir, format } => {
                auto_output_path(dir, request.title.as_deref(), *format, partial)
            }
            OutputTarget::AutoImageDir { dir } => {
                auto_output_path(dir, request.title.as_deref(), format, partial)
            }
        };
        let tiled = self.tiled.borrow_mut().take();
        let tiled_result = if let Some(writer) = tiled {
            let destination = destination_for(self.format);
            let destination = if partial {
                crate::output::partial_path_for(&destination)
            } else {
                destination.clone()
            };
            let controls = self.controls.clone();
            let reused = request.reused_tiles.clone();
            Some(
                tokio::task::spawn_blocking(move || {
                    let writer = Arc::try_unwrap(writer)
                        .map_err(|_| Error::Internal("tile placement still active".into()))?
                        .into_inner()
                        .map_err(|_| Error::Internal("tile writer poisoned".into()))?;
                    writer.finish(&destination, &reused, &controls.0.cancelled)
                })
                .await
                .map_err(|_| Error::Internal("tile output task failed".into()))??,
            )
        } else {
            None
        };
        let mut prepared = if let Some(prepared) = tiled_result {
            prepared
        } else {
            if self.raster.borrow().is_none() {
                let dimensions = request.canvas.clone().unwrap_or_else(|| {
                    let mut dimensions = Size {
                        width: 0,
                        height: 0,
                    };
                    for pending in self.pending_pixels.borrow().iter() {
                        let image = &pending.pixels.decoded.image;
                        let w = image.width().min(
                            pending
                                .placement
                                .expected_size
                                .as_ref()
                                .map_or(image.width(), |s| s.width),
                        );
                        let h = image.height().min(
                            pending
                                .placement
                                .expected_size
                                .as_ref()
                                .map_or(image.height(), |s| s.height),
                        );
                        dimensions.width = dimensions
                            .width
                            .max(pending.placement.position.x.saturating_add(w));
                        dimensions.height = dimensions
                            .height
                            .max(pending.placement.position.y.saturating_add(h));
                    }
                    dimensions
                });
                self.start_raster(dimensions, request.title.as_deref())
                    .await?;
            }
            let pipe = Arc::clone(&self.raster.borrow().as_ref().expect("raster task").pipe);
            let producer = Arc::clone(&pipe);
            let reused = request.reused_tiles.clone();
            let permit = self.decode_tails.reserve(0);
            self.controlled(async {
                tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    producer.finish(&reused)
                })
                .await
                .map_err(|_| Error::Internal("pixel producer task failed".into()))?
            })
            .await?;
            let task = self.raster.borrow_mut().take().expect("raster task");
            let mut wait = std::pin::pin!(task.wait());
            let mut updates = tokio::time::interval(Duration::from_millis(100));
            let staging = loop {
                tokio::select! {
                    result = &mut wait => break result?,
                    _ = updates.tick() => self.report_preparation(&pipe),
                }
            };
            self.report_preparation(&pipe);
            crate::output::PreparedOutput {
                staging: crate::output::StagedOutput::File(staging),
                size: pipe.size.clone(),
                pixel_decodes: 0,
                late_writes: pipe.late(),
            }
        };
        let image_size = size(&prepared.size);
        self.instrumentation.borrow_mut().pixel_decodes += prepared.pixel_decodes;
        let late_repaints = prepared.late_writes;
        let mut published = if partial {
            crate::output::partial_path_for(&destination)
        } else {
            destination
        };
        let mut collisions = 0;
        let encoded_bytes = loop {
            let validation = crate::output::validate_destination(
                &published,
                &self.format,
                self.options.overwrite,
            );
            let result = if validation.is_ok() {
                let path = published.clone();
                let controls = self.controls.clone();
                let overwrite = self.options.overwrite;
                let (output, result) = tokio::task::spawn_blocking(move || {
                    let result = prepared.publish(&path, overwrite, &controls.0.cancelled);
                    (prepared, result)
                })
                .await
                .map_err(|_| Error::Internal("output publication task failed".into()))?;
                prepared = output;
                result
            } else {
                validation.map(|_| 0)
            };
            match result {
                Ok(bytes) => break bytes,
                Err(Error::OutputExists)
                    if matches!(self.options.output, OutputTarget::AutoDir { .. })
                        && collisions < 9_999 =>
                {
                    collisions += 1;
                    published = self.next_auto_destination(request.title.as_deref(), partial);
                }
                Err(error) => return Err(error),
            }
        };
        let acquired = self.acquired.borrow();
        let mut instrumentation = self.instrumentation.borrow().clone();
        instrumentation.pixel_decodes += self.decode_tails.pixel_decodes.load(Ordering::SeqCst);
        instrumentation.peak_retained_bytes =
            instrumentation.peak_retained_bytes.max(self.pixels.peak());
        instrumentation.peak_decode_inflight_bytes =
            self.decode_tails.peak_bytes.load(Ordering::SeqCst);
        instrumentation.encoded_bytes = encoded_bytes;
        instrumentation.late_repaints = late_repaints;
        let output = Output {
            canvas: Some(Size {
                width: image_size.x,
                height: image_size.y,
            }),
            format,
            missing: request.missing,
            disposition: OutputDisposition::NativePublication,
        };
        self.diagnostics.finish(if partial { "partial-completed" } else { "completed" },
            serde_json::json!({"width": image_size.x, "height": image_size.y, "format": format.as_str(), "missing": output.missing.len()}));
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
        Err(Error::ChoiceFailed(
            "native image selection requires a configured policy"
                .to_string()
                .into(),
        ))
    }

    async fn choose_level(&self, _image: Image) -> Result<u32, Error> {
        Err(Error::ChoiceFailed(
            "native level selection requires a configured policy"
                .to_string()
                .into(),
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
        if let Some(error) = self
            .raster
            .borrow()
            .as_ref()
            .and_then(|task| task.pipe.error())
        {
            return Err(error);
        }
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

    fn report(&self, mut progress: Progress) {
        if let Some(task) = self.raster.borrow().as_ref() {
            progress.preparation = Some(OutputPreparation {
                completed_pixels: task.pipe.consumed(),
                total_pixels: u64::from(task.pipe.size.width) * u64::from(task.pipe.size.height),
            });
        }
        if progress.source_format.is_some() {
            *self.source_format.borrow_mut() = progress.source_format.clone();
        }
        self.diagnostics.observe(&progress);
        *self.last_progress.borrow_mut() = progress.clone();
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
        self.tiled.borrow_mut().take();
        self.encoded_probes.borrow_mut().clear();
        let task = self.raster.borrow_mut().take();
        if let Some(task) = task {
            task.abort().await;
        }
        self.pending_pixels.borrow_mut().clear();
        while self.decode_tails.active.load(Ordering::SeqCst) != 0 {
            let changed = self.decode_tails.changed.notified();
            if self.decode_tails.active.load(Ordering::SeqCst) != 0 {
                changed.await;
            }
        }
    }
}

fn resource_context(error: Error, request: &ResourceRequest) -> Error {
    match error {
        // Host operations wrap their failures once: never stack contexts.
        Error::Resource { .. } => error,
        error => {
            let kind = match request.purpose {
                RequestPurpose::Metadata => ResourceKind::Metadata,
                RequestPurpose::Tile => ResourceKind::Tile,
                RequestPurpose::Probe => ResourceKind::Probe,
            };
            error.resource(request.uri.clone(), kind)
        }
    }
}

fn size(size: &Size) -> Vec2d {
    Vec2d {
        x: size.width,
        y: size.height,
    }
}
fn cancelled() -> Error {
    Error::Cancelled
}

#[derive(Default)]
struct DecodeTails {
    pixel_decodes: AtomicU64,
    active: AtomicUsize,
    bytes: AtomicU64,
    peak_bytes: AtomicU64,
    pixel_decodes: AtomicU64,
    encoded_retained: AtomicU64,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_limit_precedes_pixel_decoding_and_cleanup_awaits_every_worker() {
        let directory =
            crate::output::temp_sibling(&std::env::temp_dir().join("decode-reservation"));
        std::fs::create_dir(&directory).expect("test directory");
        let source = directory.join("image.dzi");
        let tiles = directory.join("image_files/9");
        std::fs::create_dir_all(&tiles).expect("tiles");
        std::fs::write(&source, "<Image TileSize=\"512\" Overlap=\"0\" Format=\"png\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"512\" Height=\"512\"/></Image>").expect("DZI");
        image::RgbaImage::new(512, 512)
            .save(tiles.join("0_0.png"))
            .expect("tile");
        let host = NativeHost::new(JobOptions {
            input_url: source.to_string_lossy().into_owned(),
            output: OutputTarget::File(directory.join("out.png")),
            output_retain_cap: 2 << 20,
            largest: true,
            cache_dir: Some(directory.join("cache")),
            ..Default::default()
        })
        .expect("host");
        let error = host
            .transport
            .block_on(dezoomify::dezoomify(
                host.inputs(),
                host.algorithm_options(),
                &host,
            ))
            .expect_err("tile cannot fit its decode reservation");
        assert!(
            matches!(error.cause(),Error::LimitExceeded {limit} if limit.reason == LimitReason::Memory)
        );
        assert_eq!(host.decode_tails.pixel_decodes.load(Ordering::SeqCst), 0);
        assert_eq!(host.decode_tails.active.load(Ordering::SeqCst), 0);
        assert_eq!(host.pixels.current(), 0);
        assert!(host.raster.borrow().is_none());
        assert!(!directory.join("out.png").exists());
        assert!(!std::fs::read_dir(&directory).expect("directory").any(|e| e
            .expect("entry")
            .file_name()
            .to_string_lossy()
            .contains(".tmp.")));
        std::fs::remove_dir_all(directory).expect("cleanup");
    }

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
            assert_eq!(acquisition.await.unwrap_err(), Error::Cancelled);
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
}
