//! Native platform operations used directly by the shared async algorithm.
mod image_choice;
mod workers;
use crate::output::auto_output_path;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use workers::BlockingTasks;

use crate::{
    diagnostics::Diagnostics,
    http::{FetchLimits, FetchOutcome, TlsPolicy, UserHeaders},
    imaging::{load_image_with_metadata, DecodedTile},
    options::{JobOptions, OutputTarget},
    pixel_pipe::PixelPipe,
    raster::EncoderTask,
    transport::NativeTransport,
};
use dezoomify::{host::Host, model::*, Vec2d};

/// Native acquisition accepts resource tiles only; viewer handles belong to a browser job.
struct ResourceTile {
    index: u32,
    request: ResourceRequest,
    placement: TilePlacement,
}

impl TryFrom<Tile> for ResourceTile {
    type Error = Error;

    fn try_from(tile: Tile) -> Result<Self, Error> {
        match tile.source {
            TileSource::Resource(request) => Ok(Self {
                index: tile.index,
                request,
                placement: tile.placement,
            }),
            TileSource::Viewer(_) => Err(Error::InvalidInput(
                "Live viewer tiles require their browser extension session".into(),
            )),
        }
    }
}

/// Shared cancellation and pause controls, independent of the calling executor.
#[derive(Clone, Default)]
pub struct Controls(Arc<ControlState>);

#[derive(Default)]
struct ControlState {
    cancelled: AtomicBool,
    paused: AtomicBool,
    changed: tokio::sync::Notify,
    retry_waiting: AtomicBool,
    reader: std::sync::Mutex<Option<std::sync::Weak<PixelPipe>>>,
}
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
    /// Retry attempts admitted by the algorithm.
    pub retries_scheduled: u64,
    /// Total timer wait served (ms).
    pub timer_wait_ms: u64,
    /// Response body bytes fetched (metadata plus tiles).
    pub bytes_fetched: u64,
    /// Peak concurrent in-flight tasks.
    pub peak_inflight: usize,
    /// Peak retained encoded tiles, decoded probes, and metadata for tiled output.
    /// Raster composition, process RSS, and the OS file cache are excluded.
    pub peak_retained_bytes: u64,
    /// Peak in-flight decode bytes: encoded bodies held by blocking decode
    /// tails (including tails detached by cancelling their parent task).
    /// Bounded by the acquisition slots times the response byte limit;
    /// tracked separately from retained tiled output.
    pub peak_decode_inflight_bytes: u64,
    /// Total bytes in the committed output, not resident memory.
    pub encoded_bytes: u64,
    /// Pixel decoder calls; header inspection and tile reuse do not count.
    pub pixel_decodes: u64,
    /// Incoming strip contributions discarded after ownership handoff.
    pub late_repaints: u64,
}

/// Set only after destination publication succeeds. A prepared document page has
/// no publication of its own; its document owner publishes the complete file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Publication {
    pub path: PathBuf,
    pub tile_count: usize,
    pub source_format: String,
    pub output: Output,
    pub instrumentation: Instrumentation,
}

fn automatic_image_format(size: Vec2d, transparent: bool) -> OutputFormat {
    if !transparent
        && crate::imaging::check_dimensions(
            OutputFormat::Jpeg,
            &Size {
                width: size.x,
                height: size.y,
            },
        )
        .is_ok()
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

    /// Wait for cancellation, including an earlier request. Dropping this future
    /// is safe; completion does not imply that active workers have settled.
    pub async fn wait_cancelled(&self) {
        loop {
            let changed = self.0.changed.notified();
            if self.is_cancelled() {
                return;
            }
            changed.await;
        }
    }

    /// Race cancellable waits against invocation cancellation and encoder errors.
    async fn until_stopped<T>(
        &self,
        future: impl Future<Output = Result<T, Error>>,
    ) -> Result<T, Error> {
        let pipe = self
            .0
            .reader
            .lock()
            .expect("control reader lock")
            .as_ref()
            .and_then(std::sync::Weak::upgrade);
        let failure = async {
            match pipe {
                Some(pipe) => pipe.wait_failed().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            () = self.wait_cancelled() => Err(cancelled()),
            error = failure => Err(error),
            result = future => result,
        }
    }

    /// Apply the shared gate policy; cancellation wakes either gate immediately.
    #[allow(clippy::result_large_err)] // Host methods share the canonical error value.
    async fn checkpoint(&self, gate: Gate) -> Result<(), Error> {
        loop {
            let changed = self.0.changed.notified();
            if self.is_cancelled() {
                return Err(cancelled());
            }
            if gate == Gate::Cancellation
                || !(self.0.paused.load(Ordering::SeqCst)
                    || self.0.retry_waiting.load(Ordering::SeqCst))
            {
                return Ok(());
            }
            changed.await;
        }
    }
}

type RetryAnswer<'a> = Pin<Box<dyn Future<Output = Result<RetryChoice, Error>> + 'a>>;
type RetryCallback<'a> = Box<dyn FnMut(TileAcquisition) -> RetryAnswer<'a> + 'a>;

/// An image choice and thumbnail sink. Ready answers skip previews; graphical
/// callers may keep the answer pending while publishing optional thumbnails.
pub struct ImageSelection<'a> {
    pub answer: Pin<Box<dyn Future<Output = Result<u32, Error>> + 'a>>,
    pub preview: Box<dyn FnMut(u32, String) + 'a>,
}
type ImageChooser<'a> = Box<dyn FnMut(Catalog) -> Result<ImageSelection<'a>, Error> + 'a>;
type LevelAnswer<'a> = Pin<Box<dyn Future<Output = Result<u32, Error>> + 'a>>;
type LevelChooser<'a> = Box<dyn FnMut(Image) -> LevelAnswer<'a> + 'a>;

struct PendingPixels {
    id: u32,
    placement: TilePlacement,
    pixels: DecodedTile,
}

/// Use a fresh host for each image. The shared runner settles it on every exit;
/// callers using staged `Job` operations must call `Host::settle` themselves before
/// releasing the runtime or beginning another page in the same document.
pub struct NativeHost<'a> {
    pub options: JobOptions,
    // Workers retain a clone; replacing this scope would split cancellation.
    controls: Controls,
    pub diagnostics: Diagnostics,
    pub transport: NativeTransport,
    fetch_limits: FetchLimits,
    user: UserHeaders,
    format: OutputFormat,
    raster: RefCell<Option<EncoderTask>>,
    pending_pixels: RefCell<Vec<PendingPixels>>,
    acquired: RefCell<BTreeSet<u32>>,
    instrumentation: RefCell<Instrumentation>,
    inflight: Cell<usize>,
    workers: BlockingTasks,
    clock_start: Instant,
    progress: RefCell<Box<dyn FnMut(Progress) + 'a>>,
    last_progress: RefCell<Progress>,
    retry: RefCell<Option<RetryCallback<'a>>>,
    image_chooser: RefCell<Option<ImageChooser<'a>>>,
    level_chooser: RefCell<Option<LevelChooser<'a>>>,
    approved_attempt: Cell<u32>,
    retry_pending: Cell<bool>,
    published: RefCell<Option<Publication>>,
    source_format: RefCell<Option<String>>,
    output_plan: RefCell<Option<OutputPlan>>,
    tiled: RefCell<Option<crate::tile_output::SharedTileWriter>>,
    encoded_probes: RefCell<Vec<crate::encoded_tile::EncodedTile>>,
    document_page: RefCell<Option<crate::DocumentPage>>,
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
        Self::with_runtime(
            options,
            diagnostics,
            Controls::default(),
            NativeTransport::create_runtime()?,
        )
    }

    /// Retain another runtime owner until all hosts settle, then release it outside
    /// async work: dropping Tokio's last runtime owner within async work can panic.
    pub fn with_runtime(
        options: JobOptions,
        diagnostics: Diagnostics,
        controls: Controls,
        runtime: Arc<tokio::runtime::Runtime>,
    ) -> Result<Self, Error> {
        let options = options.normalized();
        options.validate()?;
        diagnostics.context(serde_json::json!({"input": options.input_url, "settings": {
            "format": options.format, "image_index": options.image_index, "zoom_level": options.zoom_level,
            "largest": options.largest, "max_width": options.max_width, "max_height": options.max_height,
            "parallelism": options.max_concurrent, "retries": options.max_retries,
            "retry_delay_ms": options.retry_base_delay.as_millis(), "pacing": options.pacing,
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
        let transport = NativeTransport::with_runtime(&fetch_limits, runtime)?
            .with_diagnostics(diagnostics.clone());
        let user = UserHeaders::new(
            options.headers.clone(),
            url::Url::parse(&options.input_url)
                .ok()
                .and_then(|url| url.host_str().map(str::to_string)),
        );
        let workers = BlockingTasks::new(controls.clone());
        Ok(Self {
            options,
            controls,
            diagnostics,
            transport,
            fetch_limits,
            user,
            format,
            raster: RefCell::new(None),
            pending_pixels: RefCell::new(Vec::new()),
            acquired: RefCell::default(),
            instrumentation: RefCell::default(),
            inflight: Cell::new(0),
            workers,
            clock_start: Instant::now(),
            progress: RefCell::new(Box::new(|_| {})),
            last_progress: RefCell::new(Progress::default()),
            retry: RefCell::new(None),
            image_chooser: RefCell::new(None),
            level_chooser: RefCell::new(None),
            approved_attempt: Cell::new(0),
            retry_pending: Cell::new(false),
            published: RefCell::new(None),
            source_format: RefCell::new(None),
            output_plan: RefCell::new(None),
            tiled: RefCell::new(None),
            encoded_probes: RefCell::new(Vec::new()),
            document_page: RefCell::new(None),
        })
    }

    /// Attach one exclusive document page before starting this host. The caller
    /// must settle this host before requesting the next page or closing the document.
    pub fn with_document_page(self, page: crate::DocumentPage) -> Result<Self, Error> {
        if self.format != OutputFormat::Pdf {
            return Err(Error::InvalidInput(
                "document page format differs from the image output".into(),
            ));
        }
        *self.document_page.borrow_mut() = Some(page);
        Ok(self)
    }

    pub fn controls(&self) -> &Controls {
        &self.controls
    }

    pub fn on_progress(&self, callback: impl FnMut(Progress) + 'a) {
        *self.progress.borrow_mut() = Box::new(callback);
    }

    /// Sample monotonic milliseconds since this Host was created.
    fn timing(&self) -> HostTiming {
        HostTiming {
            time_ms: self
                .clock_start
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
        }
    }

    pub fn on_retry(&self, callback: impl FnMut(TileAcquisition) -> RetryAnswer<'a> + 'a) {
        *self.retry.borrow_mut() = Some(Box::new(callback));
    }

    /// Register a chooser for multi-entry catalogs without an explicit image index.
    /// Deferred entries can lead to another call. The core validates the returned
    /// zero-based catalog index; pending answers are interrupted by cancellation.
    pub fn on_choose_image(
        &self,
        callback: impl FnMut(Catalog) -> Result<ImageSelection<'a>, Error> + 'a,
    ) {
        *self.image_chooser.borrow_mut() = Some(Box::new(callback));
    }

    /// Register a chooser for multi-level images without an explicit level, largest,
    /// or dimension selector. Return an index in the supplied level order; the core
    /// validates it. Pending answers are interrupted by cancellation. Without a
    /// chooser, the existing automatic resolution policy applies.
    pub fn on_choose_level(&self, callback: impl FnMut(Image) -> LevelAnswer<'a> + 'a) {
        *self.level_chooser.borrow_mut() = Some(Box::new(callback));
    }

    async fn approve_retry(&self, request: &TileAcquisition) -> Result<(), Error> {
        if !request.requires_approval {
            return Ok(());
        }
        loop {
            if request.attempt <= self.approved_attempt.get() {
                return Ok(());
            }
            if self.retry_pending.get() {
                self.controls.checkpoint(Gate::Acquisition).await?;
                continue;
            }
            let answer = self
                .retry
                .borrow_mut()
                .as_mut()
                .ok_or_else(|| Error::InvalidState("retry approval is unavailable".into()))?(
                request.clone(),
            );
            self.retry_pending.set(true);
            self.controls.0.retry_waiting.store(true, Ordering::SeqCst);
            let choice = self.controls.until_stopped(answer).await;
            self.retry_pending.set(false);
            self.controls.0.retry_waiting.store(false, Ordering::SeqCst);
            self.controls.0.changed.notify_waiters();
            match choice? {
                RetryChoice::Retry => self.approved_attempt.set(request.attempt),
                RetryChoice::Cancel => {
                    self.controls.cancel();
                    return Err(Error::Cancelled);
                }
            }
        }
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
            max_concurrent: self.options.max_concurrent as u32,
            max_tiles: self.options.max_tiles as u32,
            max_retries: self.options.max_retries,
            interactive_retries: self.retry.borrow().is_some(),
            max_bytes: self.options.max_bytes,
            max_deferred_follows: 10,
            retry_base_delay_ms: self.options.retry_base_delay.as_millis().min(300_000) as u64,
            pacing: self.options.pacing,
        }
    }

    async fn read(&self, request: &ResourceRequest) -> Result<FetchOutcome, Error> {
        self.instrumentation.borrow_mut().attempts += 1;
        let outcome = self
            .controls
            .until_stopped(self.transport.fetch_resource(
                request,
                Some(&self.user),
                &self.fetch_limits,
            ))
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
                    request: Some(dezoomify::model::bounded_uri(outcome.final_uri)),
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
        store: Option<(PathBuf, String, ResourceRequest)>,
    ) -> Result<DecodedTile, Error> {
        let metrics = self.workers.clone();
        self.workers
            .run_with_bytes("tile decode", bytes.len(), move || {
                let bytes = processing
                    .apply(bytes)
                    .map_err(|error| Error::ProcessingFailed(error.to_string().into()))?;
                if let Some((dir, namespace, request)) = &store {
                    let _ = crate::cache::store(dir, namespace, request, &bytes);
                }
                metrics.record_decode();
                load_image_with_metadata(&bytes).map_err(crate::codecs::decode_error)
            })
            .await
    }

    async fn tile(&self, tile: &ResourceTile) -> Result<DecodedTile, Error> {
        let _flight = Flight::new(self);
        let namespace = crate::cache::job_namespace(&self.options.input_url);
        let dir = self
            .options
            .cache_dir
            .clone()
            .unwrap_or_else(crate::imaging::default_tile_cache_dir);
        if let Some(bytes) = crate::cache::load(&dir, &namespace, &tile.request) {
            self.diagnostics.count("cache_reads", 1.0);
            match self.decode(bytes, Default::default(), None).await {
                Ok(decoded) => return Ok(decoded),
                Err(error) if error.is_terminal() || error.is_output() => return Err(error),
                Err(_) => {}
            }
            self.controls.checkpoint(Gate::Cancellation).await?;
            let _ = std::fs::remove_file(
                dir.join(&namespace)
                    .join(crate::cache::cache_key(&tile.request)),
            );
        }
        let response = self.read(&tile.request).await?;
        self.decode(
            response.body,
            tile.placement.processing,
            Some((dir, namespace, tile.request.clone())),
        )
        .await
    }

    async fn inspect_encoded(
        &self,
        mut bytes: Vec<u8>,
    ) -> Result<(Vec<u8>, Size, crate::codecs::NativeFormat), Error> {
        self.workers
            .run_with_bytes("tile inspection", bytes.len(), move || {
                crate::formats::jpeg::normalize_orientation(&mut bytes);
                let (size, format) = crate::encoded_tile::inspect(&bytes)?;
                Ok((bytes, size, format))
            })
            .await
    }

    async fn encoded_tile(
        &self,
        tile: &ResourceTile,
    ) -> Result<crate::encoded_tile::EncodedTile, Error> {
        let _flight = Flight::new(self);
        let namespace = crate::cache::job_namespace(&self.options.input_url);
        let dir = self
            .options
            .cache_dir
            .clone()
            .unwrap_or_else(crate::imaging::default_tile_cache_dir);
        if let Some(bytes) = crate::cache::load(&dir, &namespace, &tile.request) {
            match self.inspect_encoded(bytes).await {
                Ok((bytes, size, format)) => {
                    self.diagnostics.count("cache_reads", 1.0);
                    return Ok(crate::encoded_tile::EncodedTile {
                        probe_pixels: None,
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
                    .join(crate::cache::cache_key(&tile.request)),
            );
        }
        let response = self.read(&tile.request).await?;
        let processing = tile.placement.processing;

        let request = tile.request.clone();
        let (bytes, size, format) = self
            .workers
            .run_with_bytes("tile processing", response.body.len(), move || {
                let mut bytes = processing
                    .apply(response.body)
                    .map_err(|e| Error::ProcessingFailed(e.to_string().into()))?;
                crate::formats::jpeg::normalize_orientation(&mut bytes);
                let (size, format) = crate::encoded_tile::inspect(&bytes)?;
                let _ = crate::cache::store(&dir, &namespace, &request, &bytes);
                Ok((bytes, size, format))
            })
            .await?;
        Ok(crate::encoded_tile::EncodedTile {
            probe_pixels: None,
            request: Some(tile.request.clone()),
            id: self.storage_index(tile),
            placement: tile.placement.clone(),
            bytes,
            size,
            format,
        })
    }

    fn storage_index(&self, tile: &ResourceTile) -> u32 {
        if tile.placement.role.probe {
            (self.options.max_tiles as u32).saturating_add(tile.index)
        } else {
            tile.index
        }
    }

    fn evict_failed_tile<T>(&self, tile: &ResourceTile, result: &Result<T, Error>) {
        if self.format.uses_encoded_tiles()
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
                    .join(crate::cache::cache_key(&tile.request)),
            );
        }
    }

    async fn place_encoded(&self, tile: crate::encoded_tile::EncodedTile) -> Result<(), Error> {
        let id = tile.id;
        let writer = self.tiled.borrow().as_ref().cloned();
        if let Some(writer) = writer {
            let input_bytes = tile.bytes.len();

            let controls = self.controls.clone();
            let peak = self
                .workers
                .run_with_bytes("tile placement", input_bytes, move || {
                    let result = (|| {
                        let mut writer = writer
                            .lock()
                            .map_err(|_| Error::Internal("tile writer poisoned".into()))?;
                        writer.place(tile, &controls.0.cancelled)?;
                        Ok(writer.peak_retained())
                    })();
                    drop(writer);
                    result
                })
                .await?;
            let mut stats = self.instrumentation.borrow_mut();
            stats.peak_retained_bytes = stats.peak_retained_bytes.max(peak);
        } else {
            let retained = tile.retained_bytes()
                + self
                    .encoded_probes
                    .borrow()
                    .iter()
                    .map(|tile| tile.retained_bytes())
                    .sum::<u64>();

            self.encoded_probes.borrow_mut().push(tile);
            let mut stats = self.instrumentation.borrow_mut();
            stats.peak_retained_bytes = stats.peak_retained_bytes.max(retained);
        }
        self.acquired.borrow_mut().insert(id);
        self.instrumentation.borrow_mut().acquired = self.acquired.borrow().len() as u64;
        Ok(())
    }

    async fn place(&self, tile: &ResourceTile, pixels: DecodedTile) -> Result<(), Error> {
        // Separate resource slots prevent probe indices from colliding with
        // final plan indices. Finish supplies the plan order of reused probes.
        let storage_index = self.storage_index(tile);
        let pipe = self
            .raster
            .borrow()
            .as_ref()
            .map(|task| Arc::clone(&task.pipe));
        if let Some(pipe) = pipe {
            let placement = tile.placement.clone();
            self.workers
                .run("tile placement", move || {
                    pipe.place(storage_index, &placement, pixels)
                })
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

    async fn start_raster(
        &self,
        dimensions: Size,
        title: Option<&str>,
        format: OutputFormat,
        grid: Option<dezoomify::model::OutputGrid>,
    ) -> Result<(), Error> {
        let destination = match &self.options.output {
            OutputTarget::File(path) => path.clone(),
            OutputTarget::AutoDir { dir, format } => auto_output_path(dir, title, *format),
            OutputTarget::AutoImageDir { dir } => auto_output_path(dir, title, format),
        };
        let task = EncoderTask::start(
            &destination,
            dimensions,
            grid.as_ref(),
            format,
            self.options.compression,
            self.controls.clone(),
        )?;
        let pipe = Arc::clone(&task.pipe);
        *self.raster.borrow_mut() = Some(task);
        let pending = std::mem::take(&mut *self.pending_pixels.borrow_mut());
        self.report_preparation(&pipe);
        for pending in pending {
            let target = Arc::clone(&pipe);
            self.workers
                .run("tile placement", move || {
                    target.place(pending.id, &pending.placement, pending.pixels)
                })
                .await?;
            self.report_preparation(&pipe);
        }
        Ok(())
    }

    async fn finish_raster(
        &self,
        request: &FinishRequest,
    ) -> Result<(OutputFormat, crate::output::PreparedOutput), Error> {
        let mut format = self.format;
        if self.raster.borrow().is_none() {
            let dimensions = request.canvas.clone().unwrap_or_else(|| {
                let mut dimensions = Size {
                    width: 0,
                    height: 0,
                };
                for pending in self.pending_pixels.borrow().iter() {
                    let image = &pending.pixels.image;
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
            if matches!(self.options.output, OutputTarget::AutoImageDir { .. }) {
                // Auto waits for alpha and coverage; explicit formats can
                // encode while acquisition is still running.
                let pending = self.pending_pixels.borrow();
                let covered = pending.len() == 1
                    && pending[0].placement.position == (Point { x: 0, y: 0 })
                    && pending[0].pixels.image.width() >= dimensions.width
                    && pending[0].pixels.image.height() >= dimensions.height;
                let grid_covered = self
                    .output_plan
                    .borrow()
                    .as_ref()
                    .is_some_and(|plan| plan.grid.is_some())
                    && pending.iter().all(|tile| {
                        tile.placement.expected_size.as_ref().is_some_and(|extent| {
                            tile.pixels.image.width() >= extent.width
                                && tile.pixels.image.height() >= extent.height
                        })
                    });
                let transparent = !(covered || grid_covered)
                    || pending
                        .iter()
                        .any(|tile| tile.pixels.image.pixels().any(|pixel| pixel[3] != 255));
                format = automatic_image_format(size(&dimensions), transparent);
            }
            let grid = self
                .output_plan
                .borrow()
                .as_ref()
                .and_then(|plan| plan.grid.clone());
            self.start_raster(dimensions, request.title.as_deref(), format, grid)
                .await?;
        }
        let pipe = Arc::clone(&self.raster.borrow().as_ref().expect("raster task").pipe);
        let producer = Arc::clone(&pipe);
        let reused = request.reused_tiles.clone();
        self.workers
            .run("pixel producer", move || producer.finish(&reused))
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
        let prepared = crate::output::PreparedOutput {
            staging: crate::output::StagedOutput::File(staging),
            size: pipe.size.clone(),
            pixel_decodes: 0,
            late_writes: pipe.late(),
        };
        Ok((format, prepared))
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
    async fn observe(&self, _: Interaction) -> Result<JobInputs, Error> {
        Ok(Vec::new())
    }

    async fn parse_html(
        &self,
        query: dezoomify::model::HtmlQuery,
    ) -> Result<dezoomify::model::HtmlDocument, Error> {
        crate::html::parse_html(query).await
    }
    async fn begin_output(&self, plan: OutputPlan) -> Result<(), Error> {
        self.controls.checkpoint(Gate::Cancellation).await?;
        if plan.format != self.format || self.output_plan.borrow().is_some() {
            return Err(Error::InvalidState(
                "output preflight does not match invocation".into(),
            ));
        }
        if let OutputTarget::File(path) = &self.options.output {
            crate::output::validate_destination(path, &self.format, self.options.overwrite)?;
        }
        if self.format.uses_encoded_tiles() {
            let destination = match &self.options.output {
                OutputTarget::File(path) => path.clone(),
                OutputTarget::AutoDir { dir, format } => {
                    auto_output_path(dir, plan.title.as_deref(), *format)
                }
                OutputTarget::AutoImageDir { dir } => {
                    auto_output_path(dir, plan.title.as_deref(), self.format)
                }
            };
            let probes = std::mem::take(&mut *self.encoded_probes.borrow_mut());
            let mut writer = crate::formats::tile_writer(
                &destination,
                &plan,
                self.options.compression,
                self.options.max_tiles as u32,
                self.document_page.borrow_mut().take(),
            )?;
            let controls = self.controls.clone();
            let writer = self
                .workers
                .run("tile preflight", move || {
                    for mut tile in probes {
                        let request = tile.request.take();
                        writer
                            .place(tile, &controls.0.cancelled)
                            .map_err(|e| match request {
                                Some(ref request) => resource_context(e, request),
                                None => e,
                            })?;
                    }
                    Ok(writer)
                })
                .await?;
            let mut stats = self.instrumentation.borrow_mut();
            stats.peak_retained_bytes = stats.peak_retained_bytes.max(writer.peak_retained());
            *self.tiled.borrow_mut() = Some(Arc::new(std::sync::Mutex::new(writer)));
        } else if let Some(dimensions) = &plan.canvas {
            if !matches!(self.options.output, OutputTarget::AutoImageDir { .. }) {
                self.start_raster(
                    dimensions.clone(),
                    plan.title.as_deref(),
                    self.format,
                    plan.grid.clone(),
                )
                .await?;
            }
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
        let tile = ResourceTile::try_from(tile)?;
        if self.format.uses_encoded_tiles() {
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
                    if crate::formats::probe_needs_preparation(self.format, &encoded, &size) {
                        let compression = self.options.compression;
                        let metrics = self.workers.clone();
                        let document = self.format.supports_pages();
                        encoded = self
                            .workers
                            .run_with_bytes("probe conversion", encoded.bytes.len(), move || {
                                metrics.record_decode();
                                if document {
                                    encoded.probe_pixels =
                                        Some(encoded.decode_pixels(&encoded.size)?);
                                } else {
                                    crate::formats::png::convert_tile(
                                        &mut encoded,
                                        size,
                                        compression,
                                    )?;
                                }
                                Ok(encoded)
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
                let width = std::num::NonZeroU64::new(u64::from(decoded.image.width()));
                let height = std::num::NonZeroU64::new(u64::from(decoded.image.height()));
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

    async fn acquire_tile(&self, request: TileAcquisition) -> Result<(), Error> {
        if request.attempt > 0 {
            self.instrumentation.borrow_mut().retries_scheduled += 1;
        }
        self.approve_retry(&request).await?;
        self.controls.checkpoint(Gate::Acquisition).await?;
        let tile = ResourceTile::try_from(request.tile)?;
        let result = async {
            if self.format.uses_encoded_tiles() {
                let encoded = self.encoded_tile(&tile).await?;
                self.controls.checkpoint(Gate::Cancellation).await?;
                return self.place_encoded(encoded).await;
            }
            let decoded = self.tile(&tile).await?;
            self.controls.checkpoint(Gate::Cancellation).await?;
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
        self.controls.checkpoint(Gate::Cancellation).await?;
        let tiled = self.tiled.borrow_mut().take();
        let tiled_result = if let Some(writer) = tiled {
            let controls = self.controls.clone();
            let reused = request.reused_tiles.clone();
            Some(
                self.workers
                    .commit("tile output", move || {
                        let writer = Arc::try_unwrap(writer)
                            .map_err(|_| Error::Internal("tile placement still active".into()))?
                            .into_inner()
                            .map_err(|_| Error::Internal("tile writer poisoned".into()))?;
                        writer.finish(&reused, &controls.0.cancelled)
                    })
                    .await?,
            )
        } else {
            None
        };
        let mut format = self.format;
        let prepared = if let Some(prepared) = tiled_result {
            prepared
        } else {
            let (raster_format, prepared) = self.finish_raster(&request).await?;
            format = raster_format;
            prepared
        };
        let image_size = size(&prepared.size);
        self.instrumentation.borrow_mut().pixel_decodes += prepared.pixel_decodes;
        if matches!(prepared.staging, crate::output::StagedOutput::DocumentPage) {
            return Ok(Output {
                canvas: Some(prepared.size),
                format,
                disposition: OutputDisposition::NativePrepared,
            });
        }
        let late_repaints = prepared.late_writes;
        let target = self.options.output.clone();
        let title = request.title.clone();
        let overwrite = self.options.overwrite;
        let controls = self.controls.clone();
        let (published, encoded_bytes) = self
            .workers
            .commit("output publication", move || {
                crate::output::publish(
                    prepared.staging,
                    &target,
                    title.as_deref(),
                    format,
                    overwrite,
                    &controls.0.cancelled,
                )
            })
            .await?;
        let acquired = self.acquired.borrow();
        let mut instrumentation = self.instrumentation.borrow().clone();
        instrumentation.pixel_decodes += self.workers.stats().pixel_decodes;
        instrumentation.peak_decode_inflight_bytes = self.workers.stats().peak_input_bytes;
        instrumentation.encoded_bytes = encoded_bytes;
        instrumentation.late_repaints = late_repaints;
        let output = Output {
            canvas: Some(Size {
                width: image_size.x,
                height: image_size.y,
            }),
            format,
            disposition: OutputDisposition::NativePublication,
        };
        self.diagnostics.finish("completed",
            serde_json::json!({"width": image_size.x, "height": image_size.y, "format": format.as_str()}));
        *self.published.borrow_mut() = Some(Publication {
            path: published,
            tile_count: acquired.len(),
            source_format: self.source_format.borrow().clone().unwrap_or_default(),
            output: output.clone(),
            instrumentation,
        });
        Ok(output)
    }

    async fn choose_image(&self, catalog: Catalog) -> Result<u32, Error> {
        self.select_image(catalog).await
    }

    async fn choose_level(&self, image: Image) -> Result<u32, Error> {
        self.controls.checkpoint(Gate::Cancellation).await?;
        let JobOptions {
            largest,
            max_width,
            max_height,
            zoom_level,
            ..
        } = &self.options;
        if image.levels.len() > 1
            && zoom_level.is_none()
            && !largest
            && max_width.is_none()
            && max_height.is_none()
        {
            let answer = self
                .level_chooser
                .borrow_mut()
                .as_mut()
                .map(|choose| choose(image.clone()));
            if let Some(answer) = answer {
                return self.controls.until_stopped(answer).await;
            }
        }
        let levels = &image.levels;
        let sizes = levels.iter().enumerate();
        let area = |level: &Level| {
            level
                .size
                .as_ref()
                .map_or(0, |s| u64::from(s.width) * u64::from(s.height))
        };
        let index = if let Some(level) = zoom_level {
            levels.len().checked_sub(1).map(|last| (*level).min(last))
        } else if *largest || (max_width.is_none() && max_height.is_none()) {
            sizes.clone().max_by_key(|(_, l)| area(l)).map(|(i, _)| i)
        } else {
            sizes
                .clone()
                .filter(|(_, l)| {
                    l.size.as_ref().is_some_and(|s| {
                        max_width.is_none_or(|cap| s.width > 0 && s.width <= cap)
                            && max_height.is_none_or(|cap| s.height > 0 && s.height <= cap)
                    })
                })
                .max_by_key(|(_, l)| area(l))
                .map(|(i, _)| i)
                .or_else(|| {
                    sizes
                        .min_by_key(|(_, l)| l.size.as_ref().map_or(u32::MAX, |s| s.width))
                        .map(|(i, _)| i)
                })
        };
        index.map(|i| i as u32).ok_or(Error::PlanEmpty)
    }

    async fn checkpoint(&self, gate: Gate) -> Result<HostTiming, Error> {
        if let Some(error) = self
            .raster
            .borrow()
            .as_ref()
            .and_then(|task| task.pipe.error())
        {
            return Err(error);
        }
        self.controls.checkpoint(gate).await?;
        Ok(self.timing())
    }

    async fn sleep(&self, delay_ms: u32) -> Result<HostTiming, Error> {
        self.instrumentation.borrow_mut().timer_wait_ms += u64::from(delay_ms);
        self.controls
            .until_stopped(async {
                tokio::time::sleep(Duration::from_millis(u64::from(delay_ms))).await;
                Ok(())
            })
            .await?;
        Ok(self.timing())
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
        self.workers.drain().await;
        self.document_page.borrow_mut().take();
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
    fn configured_choices_preserve_native_defaults_caps_and_precedence() {
        let image = Image {
            title: None,
            source_url: None,
            preview: None,
            format: "test".into(),
            size: None,
            levels: [None, Some(1), Some(256), Some(512)]
                .into_iter()
                .map(|width| Level {
                    label: String::new(),
                    tile_size: None,
                    size: width.map(|width| Size {
                        width,
                        height: width,
                    }),
                })
                .collect(),
        };
        for (image_index, largest, max_width, max_height, zoom_level, expected) in [
            (None, false, None, None, None, [3, 3]),
            (Some(1), false, Some(300), Some(300), None, [2, 0]),
            (Some(usize::MAX), true, Some(1), Some(1), None, [3, 3]),
            (None, true, None, None, Some(1), [1, 1]),
            (None, false, None, None, Some(usize::MAX), [3, 3]),
            (None, false, Some(300), None, None, [2, 0]),
            (None, false, None, Some(300), None, [2, 0]),
            (None, false, Some(0), Some(0), None, [1, 0]),
        ] {
            let host = NativeHost::new(JobOptions {
                input_url: "https://images.test/image.dzi".into(),
                output: OutputTarget::AutoImageDir {
                    dir: std::env::temp_dir(),
                },
                image_index,
                largest,
                max_width,
                max_height,
                zoom_level,
                ..Default::default()
            })
            .unwrap();
            host.transport.block_on(async {
                let catalog = Catalog {
                    entries: vec![
                        CatalogEntry::ImageRequest(ImageRequest {
                            title: None,
                            size: None,
                            preview: None,
                            uri: "info.json".into(),
                        }),
                        CatalogEntry::Image(image.clone()),
                    ],
                };
                assert_eq!(
                    host.choose_image(catalog).await.unwrap(),
                    image_index.unwrap_or(0).min(1) as u32
                );
                assert_eq!(host.choose_level(image.clone()).await.unwrap(), expected[0]);
                let mut unknown = image.clone();
                for level in &mut unknown.levels {
                    level.size = None;
                }
                assert_eq!(host.choose_level(unknown).await.unwrap(), expected[1]);

                host.on_choose_level(|_| Box::pin(std::future::ready(Ok(1))));
                let should_prompt =
                    !largest && zoom_level.is_none() && max_width.is_none() && max_height.is_none();
                assert_eq!(
                    host.choose_level(image.clone()).await.unwrap(),
                    if should_prompt { 1 } else { expected[0] }
                );
                let mut single = image.clone();
                single.levels.truncate(1);
                assert_eq!(host.choose_level(single).await.unwrap(), 0);
            });
        }
    }

    #[test]
    fn cancellation_interrupts_a_pending_level_choice() {
        let image: Image = serde_json::from_value(serde_json::json!({
            "format": "test", "levels": [{ "label": "small" }, { "label": "large" }]
        }))
        .unwrap();
        let host = NativeHost::new(JobOptions {
            input_url: "https://images.test/image.dzi".into(),
            ..Default::default()
        })
        .unwrap();
        let controls = host.controls.clone();
        host.on_choose_level(move |_| {
            let controls = controls.clone();
            Box::pin(async move {
                controls.cancel();
                std::future::pending().await
            })
        });
        assert!(matches!(
            host.transport.block_on(host.choose_level(image)),
            Err(Error::Cancelled)
        ));
    }

    #[test]
    fn png_streams_a_large_canvas() {
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
            largest: true,
            cache_dir: Some(directory.join("cache")),
            ..Default::default()
        })
        .expect("host");
        let result = host
            .transport
            .block_on(dezoomify::dezoomify(
                host.inputs(),
                host.algorithm_options(),
                &host,
            ))
            .expect("PNG streams the assembled pixels");
        assert_eq!(
            result.canvas,
            Some(Size {
                width: 512,
                height: 512
            })
        );
        assert_eq!(host.workers.stats().pixel_decodes, 1);

        assert!(host.raster.borrow().is_none());
        assert!(directory.join("out.png").exists());
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
            controls.checkpoint(Gate::Cancellation).await.unwrap();
            let acquisition = controls.checkpoint(Gate::Acquisition);
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
}
