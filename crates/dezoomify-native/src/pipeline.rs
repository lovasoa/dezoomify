//! Native download pipeline: core discovery → tile plan → concurrent bounded
//! download → decode/assemble → encode → atomic write → real output digest.
//!
//! All network I/O goes through [`crate::http`]; all format logic stays in
//! `dezoomify-core`. Failures are honest: the pipeline never fabricates
//! progress, completion, or hashes.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use dezoomify_core::core::adaptive::{DiscoverableStep, ObservationResult};
use dezoomify_core::core::discovery::{DiscoveryOperation, ResourceFailure, ResourceResponse};
use dezoomify_core::core::model::{
    CatalogEntry, ImageCatalog, ImageDescriptor, LevelDescriptor, ProcessingRecipe, Request,
    TileRole, TileSpec,
};
use dezoomify_core::core::registry::default_registry;
use dezoomify_core::core::tile_plan::TileSource;
use dezoomify_core::Vec2d;

use crate::error::NativeError;
use crate::http::{fetch, FetchLimits};
use crate::output::{validate_destination, write_atomic, OutputFormat};

/// Pipeline configuration: fetch limits, tile bounds, concurrency.
#[derive(Clone, Debug)]
pub struct PipelineConfig {
    /// Trusted user headers (`-H`). May carry cookies; sent to the input
    /// origin and same-host redirects only. Never persisted or logged.
    pub user_headers: BTreeMap<String, String>,
    pub fetch: FetchLimits,
    pub max_tiles: usize,
    pub max_concurrent: usize,
    pub max_retries: u32,
    /// Hard cap on composed canvas bytes (RGBA, 4 bytes/pixel).
    pub max_canvas_bytes: u64,
}

impl Default for PipelineConfig {
    fn default() -> Self {
        Self {
            user_headers: BTreeMap::new(),
            fetch: FetchLimits::default(),
            max_tiles: 1 << 20,
            max_concurrent: 6,
            max_retries: 3,
            max_canvas_bytes: 1 << 30,
        }
    }
}

/// Progress event emitted by the pipeline. Kinds: `discovery`, `downloading`,
/// `encoding`. Details carry counts; nothing is fabricated.
#[derive(Clone, Debug)]
pub struct PipelineEvent {
    pub kind: String,
    pub detail: BTreeMap<String, String>,
}

/// Successful pipeline result with the digest of the bytes actually written.
#[derive(Clone, Debug)]
pub struct PipelineOutcome {
    pub output_path: PathBuf,
    pub output_hash: String,
    pub tile_count: usize,
    pub image_size: Vec2d,
}

pub fn run(
    input_url: &str,
    output_path: &str,
    overwrite: bool,
    config: &PipelineConfig,
    on_event: &mut dyn FnMut(PipelineEvent),
) -> Result<PipelineOutcome, NativeError> {
    validate_destination(
        std::path::Path::new(output_path),
        &OutputFormat::Png,
        overwrite,
    )
    .map_err(NativeError::from)?;

    let catalog = discover(input_url, config, on_event)?;
    let image = choose_image(catalog)?;
    let level = choose_level(&image.levels)?;
    let plan = plan_level(level, config)?;
    let canvas = download_and_assemble(plan, config, on_event)?;

    let encoded = encode_png(&canvas)?;
    on_event(PipelineEvent {
        kind: "encoding".to_string(),
        detail: BTreeMap::from([("bytes".to_string(), encoded.len().to_string())]),
    });
    let path = PathBuf::from(output_path);
    write_atomic(&path, &encoded).map_err(NativeError::from)?;
    let hash = sha256_hex(&encoded);
    Ok(PipelineOutcome {
        output_path: path,
        output_hash: format!("sha256:{hash}"),
        tile_count: canvas.tile_count,
        image_size: canvas.size,
    })
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

fn discover(
    input_url: &str,
    config: &PipelineConfig,
    on_event: &mut dyn FnMut(PipelineEvent),
) -> Result<ImageCatalog, NativeError> {
    let registry = default_registry(input_url);
    let mut operation: DiscoveryOperation = registry.start(input_url);
    let mut fetched = 0usize;
    loop {
        let Some(need) = operation.next_priority_need().map_err(NativeError::from)? else {
            break;
        };
        fetched += 1;
        on_event(PipelineEvent {
            kind: "discovery".to_string(),
            detail: BTreeMap::from([("resources".to_string(), fetched.to_string())]),
        });
        let headers = merge_headers(&need.request, &config.user_headers);
        match fetch(&need.request.uri, &headers, None, &config.fetch) {
            Ok(outcome) if outcome.ok() => {
                operation
                    .provide(
                        ResourceResponse::new(need.id, outcome.body)
                            .with_final_uri(outcome.final_uri),
                    )
                    .map_err(NativeError::from)?;
            }
            Ok(outcome) => {
                operation
                    .provide_failure(ResourceFailure {
                        id: need.id,
                        message: format!("http status {}", outcome.status),
                    })
                    .map_err(NativeError::from)?;
            }
            Err(error) => {
                operation
                    .provide_failure(ResourceFailure {
                        id: need.id,
                        message: error.message,
                    })
                    .map_err(NativeError::from)?;
            }
        }
    }
    operation.finish().map_err(NativeError::from)
}

fn merge_headers(request: &Request, user: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut merged: BTreeMap<String, String> =
        dezoomify_core::default_headers().into_iter().collect();
    for (name, value) in &request.headers {
        merged.insert(name.to_ascii_lowercase(), value.clone());
    }
    for (name, value) in user {
        merged.insert(name.to_ascii_lowercase(), value.clone());
    }
    merged
}

fn choose_image(catalog: ImageCatalog) -> Result<ImageDescriptor, NativeError> {
    catalog
        .into_entries()
        .into_iter()
        .find_map(|entry| match entry {
            CatalogEntry::Ready(image) => Some(image),
            CatalogEntry::Deferred(_) => None,
        })
        .ok_or_else(|| {
            NativeError::new(
                "discovery.no-image",
                "no zoomable image found at the input url",
            )
        })
}

fn choose_level(levels: &[LevelDescriptor]) -> Result<&LevelDescriptor, NativeError> {
    levels
        .iter()
        .max_by_key(|level| {
            level
                .source
                .image_size()
                .map(|size| u64::from(size.x) * u64::from(size.y))
                .unwrap_or(0)
        })
        .ok_or_else(|| NativeError::new("discovery.no-level", "image has no zoom levels"))
}

// ---------------------------------------------------------------------------
// Tile plan (including generic probe resolution)
// ---------------------------------------------------------------------------

struct Blit {
    destination: Vec2d,
    extent: Option<Vec2d>,
    request: Request,
    processing: ProcessingRecipe,
}

struct Plan {
    canvas_size: Option<Vec2d>,
    blits: Vec<Blit>,
}

fn plan_level(level: &LevelDescriptor, config: &PipelineConfig) -> Result<Plan, NativeError> {
    match &level.source {
        TileSource::Grid(grid) => {
            let mut blits = Vec::new();
            for tile in grid.tiles_row_major() {
                let tile = tile.map_err(NativeError::from)?;
                if tile.role == TileRole::Probe {
                    continue;
                }
                blits.push(Blit {
                    destination: tile.destination,
                    extent: tile.expected_size,
                    request: tile.request,
                    processing: tile.processing,
                });
                check_tile_budget(blits.len(), config)?;
            }
            Ok(Plan {
                canvas_size: Some(grid.image_size()),
                blits,
            })
        }
        TileSource::Positioned(positioned) => {
            let mut blits = Vec::new();
            for tile in positioned.tiles() {
                let tile = tile.map_err(NativeError::from)?;
                if tile.role == TileRole::Probe {
                    continue;
                }
                blits.push(Blit {
                    destination: tile.destination,
                    extent: None,
                    request: tile.request,
                    processing: tile.processing,
                });
                check_tile_budget(blits.len(), config)?;
            }
            Ok(Plan {
                canvas_size: positioned.image_size(),
                blits,
            })
        }
        TileSource::DiscoverableGrid(discoverable) => {
            plan_probing(discoverable.clone().start(), config)
        }
        TileSource::Adaptive(adaptive) => plan_probing(adaptive.start(), config),
    }
}

fn plan_probing(mut step: DiscoverableStep, config: &PipelineConfig) -> Result<Plan, NativeError> {
    let mut blits: Vec<Blit> = Vec::new();
    let mut probed_destinations: HashSet<Vec2d> = HashSet::new();
    loop {
        match step {
            DiscoverableStep::Probe { tile, continuation } => {
                let is_output = tile.role != TileRole::Probe;
                let destination = tile.destination;
                let outcome = probe_tile(&tile, config);
                if is_output && outcome.observed {
                    blits.push(Blit {
                        destination,
                        extent: None,
                        request: tile.request,
                        processing: tile.processing,
                    });
                    probed_destinations.insert(destination);
                }
                step = continuation
                    .submit(outcome.observation)
                    .map_err(NativeError::from)?;
                check_tile_budget(blits.len(), config)?;
            }
            DiscoverableStep::Resolved { grid, .. } => {
                for tile in grid.tiles_row_major() {
                    let tile = tile.map_err(NativeError::from)?;
                    if tile.role == TileRole::Probe
                        || probed_destinations.contains(&tile.destination)
                    {
                        continue;
                    }
                    blits.push(Blit {
                        destination: tile.destination,
                        extent: tile.expected_size,
                        request: tile.request,
                        processing: tile.processing,
                    });
                    check_tile_budget(blits.len(), config)?;
                }
                return Ok(Plan {
                    canvas_size: Some(grid.image_size()),
                    blits,
                });
            }
            DiscoverableStep::Empty => {
                return Err(NativeError::new(
                    "discovery.no-level",
                    "probing found no tiles for this level",
                ));
            }
            DiscoverableStep::Error(error) => {
                return Err(NativeError::new("discovery.tile-plan", error.to_string()));
            }
        }
    }
}

struct ProbeOutcome {
    observation: ObservationResult,
    observed: bool,
}

fn probe_tile(tile: &TileSpec, config: &PipelineConfig) -> ProbeOutcome {
    let missing = || ProbeOutcome {
        observation: ObservationResult::Missing,
        observed: false,
    };
    let headers = merge_headers(&tile.request, &config.user_headers);
    let Ok(outcome) = fetch(&tile.request.uri, &headers, None, &config.fetch) else {
        return missing();
    };
    if !outcome.ok() || outcome.body.is_empty() {
        return missing();
    }
    let Ok(bytes) = tile.processing.apply(outcome.body) else {
        return missing();
    };
    match image::load_from_memory(&bytes) {
        Ok(decoded) => ProbeOutcome {
            observation: ObservationResult::Available {
                size: Vec2d {
                    x: decoded.width(),
                    y: decoded.height(),
                },
            },
            observed: true,
        },
        Err(_) => missing(),
    }
}

fn check_tile_budget(count: usize, config: &PipelineConfig) -> Result<(), NativeError> {
    if count > config.max_tiles {
        return Err(NativeError::new(
            "tile.limit",
            format!("tile count exceeds limit of {}", config.max_tiles),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Download + assemble
// ---------------------------------------------------------------------------

struct Canvas {
    image: image::RgbaImage,
    size: Vec2d,
    tile_count: usize,
}

fn download_and_assemble(
    plan: Plan,
    config: &PipelineConfig,
    on_event: &mut dyn FnMut(PipelineEvent),
) -> Result<Canvas, NativeError> {
    let total = plan.blits.len();
    let mut decoded: Vec<Option<image::RgbaImage>> = Vec::with_capacity(total);
    decoded.resize_with(total, || None);
    let mut pending: Vec<usize> = (0..total).collect();
    let mut round = 0u32;
    while !pending.is_empty() {
        if round > config.max_retries {
            return Err(NativeError::new(
                "tile.download-failed",
                format!(
                    "{} tile(s) still failing after {} retries",
                    pending.len(),
                    config.max_retries
                ),
            ));
        }
        round += 1;
        let mut failures: Vec<usize> = Vec::new();
        for chunk in pending.chunks(config.max_concurrent.max(1)) {
            let blits = &plan.blits;
            std::thread::scope(|scope| {
                let mut handles = Vec::with_capacity(chunk.len());
                for &index in chunk {
                    handles.push((
                        index,
                        scope.spawn(move || fetch_and_decode(&blits[index], config)),
                    ));
                }
                for (index, handle) in handles {
                    match handle.join() {
                        Ok(Ok(tile)) => decoded[index] = Some(tile),
                        Ok(Err(_)) | Err(_) => failures.push(index),
                    }
                }
            });
            let acquired = decoded.iter().filter(|tile| tile.is_some()).count();
            on_event(PipelineEvent {
                kind: "downloading".to_string(),
                detail: BTreeMap::from([
                    ("acquired".to_string(), acquired.to_string()),
                    ("total".to_string(), total.to_string()),
                ]),
            });
        }
        pending = failures;
    }

    let declared = plan.canvas_size;
    let mut width = declared.map_or(1u32, |size| size.x.max(1));
    let mut height = declared.map_or(1u32, |size| size.y.max(1));
    if declared.is_none() {
        for (index, blit) in plan.blits.iter().enumerate() {
            let Some(tile) = &decoded[index] else {
                continue;
            };
            width = width.max(blit.destination.x.saturating_add(tile.width()));
            height = height.max(blit.destination.y.saturating_add(tile.height()));
        }
    }
    if u64::from(width) * u64::from(height) * 4 > config.max_canvas_bytes {
        return Err(NativeError::new(
            "output.canvas-limit",
            "composed image exceeds the canvas size limit",
        ));
    }
    let mut target = image::RgbaImage::new(width, height);
    for (index, blit) in plan.blits.iter().enumerate() {
        let Some(tile) = decoded[index].take() else {
            return Err(NativeError::new(
                "tile.download-failed",
                "tile result missing at assembly time",
            ));
        };
        blit_onto(&mut target, blit, &tile);
    }
    Ok(Canvas {
        image: target,
        size: Vec2d {
            x: width,
            y: height,
        },
        tile_count: total,
    })
}

fn fetch_and_decode(blit: &Blit, config: &PipelineConfig) -> Result<image::RgbaImage, NativeError> {
    let headers = merge_headers(&blit.request, &config.user_headers);
    let outcome = fetch(&blit.request.uri, &headers, None, &config.fetch)?;
    if !outcome.ok() {
        return Err(NativeError::new(
            "tile.http-error",
            format!("tile request returned http status {}", outcome.status),
        ));
    }
    let bytes = blit
        .processing
        .apply(outcome.body)
        .map_err(NativeError::from)?;
    let decoded = image::load_from_memory(&bytes)
        .map_err(|e| NativeError::new("tile.decode-failed", format!("tile decode failed: {e}")))?;
    Ok(decoded.to_rgba8())
}

fn blit_onto(target: &mut image::RgbaImage, blit: &Blit, tile: &image::RgbaImage) {
    let extent = blit.extent.unwrap_or(Vec2d {
        x: tile.width(),
        y: tile.height(),
    });
    let max_w = target.width().saturating_sub(blit.destination.x);
    let max_h = target.height().saturating_sub(blit.destination.y);
    let copy_w = extent.x.min(tile.width()).min(max_w);
    let copy_h = extent.y.min(tile.height()).min(max_h);
    if copy_w == 0 || copy_h == 0 {
        return;
    }
    let cropped = image::imageops::crop_imm(tile, 0, 0, copy_w, copy_h).to_image();
    image::imageops::overlay(
        target,
        &cropped,
        i64::from(blit.destination.x),
        i64::from(blit.destination.y),
    );
}

fn encode_png(canvas: &Canvas) -> Result<Vec<u8>, NativeError> {
    let mut bytes = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
    image::ImageEncoder::write_image(
        encoder,
        canvas.image.as_raw(),
        canvas.image.width(),
        canvas.image.height(),
        image::ExtendedColorType::Rgba8,
    )
    .map_err(|e| NativeError::new("output.encode-failed", format!("png encode failed: {e}")))?;
    Ok(bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}
