#![allow(clippy::result_large_err)]
//! Shared discovery, selection, acquisition, and output policy.
use crate::{
    Host, Vec2d,
    core::{self, DiscoveredEntry, DiscoveryCatalog, TileRole, TileSource, TileSpec},
    model::*,
};
use core::discovery::{DiscoveryInput, DiscoveryLimits};
use futures_util::{StreamExt, stream};
use std::{cell::RefCell, collections::HashSet};

/// Dezoom one input using the platform capabilities owned by `host`.
/// Settlement runs before every return, including validation and cancellation.
pub async fn dezoomify(
    inputs: Vec<JobInput>,
    options: Options,
    host: &impl Host,
) -> Result<Output, Error> {
    let result = run(inputs, &options, host).await;
    host.settle().await;
    result
}

async fn run(inputs: Vec<JobInput>, options: &Options, host: &impl Host) -> Result<Output, Error> {
    validate(&inputs, options)?;
    host.checkpoint(Gate::Cancellation).await?;
    host.report(Progress {
        total: None,
        ..Default::default()
    });
    let followed = RefCell::new(
        inputs
            .iter()
            .filter(|input| input.kind.unwrap_or_default() == DiscoveryInputKind::Source)
            .map(|input| input.url.clone())
            .collect(),
    );
    let catalog = discover(inputs, options, host, &followed).await?;
    let (image, level) = select(catalog, options, host, &followed).await?;
    let mut progress = Progress {
        phase: ProgressPhase::Planning,
        source_format: Some(image.format.into()),
        title: image.title.clone(),
        selected: image.levels[level].source.image_size().map(size),
        maximum: image
            .levels
            .iter()
            .filter_map(|level| level.source.image_size())
            .max_by_key(|size| size.area())
            .map(size),
        completed: 0,
        total: None,
    };
    host.report(progress.clone());
    host.checkpoint(Gate::Cancellation).await?;
    let (source, previous) = match &image.levels[level].source {
        TileSource::Adaptive(source) => {
            let resolved = source
                .resolve(host, options.max_tiles)
                .await?
                .ok_or_else(empty_plan)?;
            (TileSource::Grid(resolved.grid), resolved.previously_output)
        }
        TileSource::Generic(source) => {
            let resolved = source
                .resolve(host, options.max_tiles)
                .await?
                .ok_or_else(empty_plan)?;
            (TileSource::Grid(resolved.grid), resolved.previously_output)
        }
        TileSource::Grid(grid) => (TileSource::Grid(grid.clone()), Vec::new()),
        TileSource::Positioned(source) => (TileSource::Positioned(source.clone()), Vec::new()),
    };
    let total = source.count().ok_or_else(empty_plan)?;
    if total == 0 {
        return Err(empty_plan());
    }
    if total > u64::from(options.max_tiles) {
        return Err(Error::new(
            "job.resource-limit",
            ErrorPhase::Acquisition,
            format!("tile plan exceeds max_tiles {}", options.max_tiles),
        ));
    }
    let canvas = source.image_size().map(size);
    let tiles: Box<dyn Iterator<Item = Result<TileSpec, core::TileSourceError>>> = match source {
        TileSource::Grid(grid) => Box::new(grid.tiles_row_major()),
        TileSource::Positioned(source) => Box::new(source.tiles()),
        TileSource::Adaptive(_) | TileSource::Generic(_) => unreachable!("geometry is resolved"),
    };
    progress.phase = ProgressPhase::Acquisition;
    progress.selected = canvas.clone();
    progress.total = Some(total);
    progress.completed = previous.len() as u64;
    host.report(progress.clone());
    let mut reused_tiles = Vec::with_capacity(previous.len());
    let tiles = tiles
        .filter(|tile| {
            if let Ok(tile) = tile
                && previous.contains(&tile.destination)
            {
                reused_tiles.push(ReusedTile {
                    index: tile.ordinal,
                    position: Point {
                        x: tile.destination.x,
                        y: tile.destination.y,
                    },
                });
                false
            } else {
                true
            }
        })
        .map(|tile| {
            tile.map(|tile| portable_tile(tile, canvas.clone()))
                .map_err(Error::from)
        });
    let mut missing = acquire_round(tiles, host, options, &mut progress).await?;
    if progress.completed == 0 {
        let mut error = missing
            .first()
            .and_then(|(_, failures)| failures.first())
            .cloned()
            .unwrap_or_else(empty_plan)
            .with_code("job.no-usable-tiles");
        error.phase = ErrorPhase::Acquisition;
        error.message = "no usable tiles were acquired".into();
        if let Some((tile, _)) = missing.first() {
            error
                .request
                .get_or_insert_with(|| tile.request.uri.clone());
        }
        return Err(error);
    }
    while !missing.is_empty() {
        missing.sort_by_key(|(tile, _)| tile.index);
        host.checkpoint(Gate::Acquisition).await?;
        let choice = match options.partial {
            PartialPolicy::Keep => RecoveryChoice::Keep,
            PartialPolicy::Discard => RecoveryChoice::Discard,
            PartialPolicy::Prompt => {
                host.choose_partial(MissingTiles {
                    missing: missing
                        .iter()
                        .map(|(tile, failures)| MissingTile {
                            tile: tile.index,
                            failures: failures.clone(),
                        })
                        .collect(),
                })
                .await?
            }
        };
        match choice {
            RecoveryChoice::Keep => break,
            RecoveryChoice::Discard => {
                return Err(Error::new(
                    "job.partial-discarded",
                    ErrorPhase::Acquisition,
                    "partial output was discarded",
                ));
            }
            RecoveryChoice::Retry => {
                let retry = std::mem::take(&mut missing);
                missing = acquire_round(
                    retry.into_iter().map(|(tile, _)| Ok(tile)),
                    host,
                    options,
                    &mut progress,
                )
                .await?;
            }
        }
    }
    host.checkpoint(Gate::Acquisition).await?;
    progress.phase = ProgressPhase::Output;
    host.report(progress);
    host.finish(FinishRequest {
        canvas,
        format: options.output,
        title: image.title,
        missing: missing.into_iter().map(|(tile, _)| tile.index).collect(),
        reused_tiles,
    })
    .await
}

async fn discover(
    inputs: Vec<JobInput>,
    options: &Options,
    host: &impl Host,
    followed: &RefCell<HashSet<String>>,
) -> Result<DiscoveryCatalog, Error> {
    let registry = match options.format.as_deref() {
        None | Some("auto") => core::default_registry(),
        Some(format) => core::registry_for(format).ok_or_else(|| {
            Error::new(
                "job.unknown-format",
                ErrorPhase::Validation,
                format!("unknown format: {format}"),
            )
        })?,
    };
    let catalog = registry
        .discover(
            inputs
                .into_iter()
                .map(|input| DiscoveryInput {
                    url: input.url,
                    contents: input.contents.map(String::into_bytes),
                    kind: input.kind.unwrap_or_default(),
                })
                .collect(),
            DiscoveryLimits {
                concurrent: options.max_concurrent as usize,
                ..Default::default()
            },
            |request, interaction| async move {
                host.checkpoint(Gate::Cancellation).await?;
                let uri = request.uri.clone();
                let result = host
                    .fetch(
                        ResourceRequest {
                            uri: request.uri,
                            headers: request.headers,
                            purpose: RequestPurpose::Metadata,
                        },
                        interaction,
                    )
                    .await
                    .map_err(|error| {
                        let mut error = crate::retry::classify(error);
                        error.request.get_or_insert_with(|| uri.clone());
                        error
                    })?;
                if let ResourceRead::Response { response } = &result {
                    if let Some(final_uri) =
                        response.final_uri.as_ref().filter(|uri| !uri.is_empty())
                    {
                        let mut followed = followed.borrow_mut();
                        if followed.contains(&uri) {
                            followed.insert(final_uri.clone());
                        }
                    }
                    if response.bytes.is_empty() {
                        let mut err = Error::new(
                            "job.empty-resource",
                            ErrorPhase::Discovery,
                            "metadata resource is empty",
                        );
                        err.request = response.final_uri.clone();
                        return Err(err);
                    }
                    if u64::try_from(response.bytes.len()).unwrap_or(u64::MAX) > options.max_bytes {
                        let mut err = Error::new(
                            "job.resource-limit",
                            ErrorPhase::Discovery,
                            "metadata resource exceeds max_bytes",
                        );
                        err.request = response.final_uri.clone();
                        return Err(err);
                    }
                }
                Ok(result)
            },
        )
        .await
        .map_err(|error| match error {
            core::DiscoveryError::Host(error) => *error,
            error => {
                let cause = match &error {
                    core::DiscoveryError::NoCandidateAccepted { diagnostics }
                        if diagnostics.iter().all(|diagnostic| {
                            matches!(
                                diagnostic.kind,
                                core::RejectionKind::FetchFailed
                                    | core::RejectionKind::DidNotMatchUrl
                            )
                        }) =>
                    {
                        diagnostics
                            .iter()
                            .find_map(|diagnostic| diagnostic.cause.as_deref())
                            .cloned()
                    }
                    _ => None,
                };
                let mut failure = cause.unwrap_or_else(|| {
                    Error::new(
                        "job.discovery-failed",
                        ErrorPhase::Discovery,
                        "No zoomable image was found",
                    )
                });
                failure.detail.get_or_insert_with(|| error.detail());
                failure
            }
        })?;
    let mut seen = HashSet::new();
    for entry in catalog.entries() {
        let (warnings, levels) = match entry {
            DiscoveredEntry::Ready(image) => (image.warnings.as_slice(), image.levels.as_slice()),
            DiscoveredEntry::Deferred(resource) => (resource.warnings.as_slice(), &[][..]),
        };
        for warning in warnings
            .iter()
            .chain(levels.iter().flat_map(|level| &level.warnings))
        {
            if seen.insert(warning) {
                host.warn(warning.clone());
            }
        }
    }
    Ok(catalog)
}

async fn select(
    mut catalog: DiscoveryCatalog,
    options: &Options,
    host: &impl Host,
    followed: &RefCell<HashSet<String>>,
) -> Result<(core::ResolvedImage, usize), Error> {
    let mut remaining_follows = options.max_deferred_follows;
    loop {
        host.checkpoint(Gate::Cancellation).await?;
        if catalog.is_empty() {
            return Err(empty_plan());
        }
        let index = match &options.selection {
            SelectionPolicy::Interactive => {
                host.choose_image(catalog.public_catalog()).await? as usize
            }
            SelectionPolicy::Automatic { image_index, .. } => (*image_index).min(catalog.len() - 1),
            SelectionPolicy::Fitting { .. } => catalog
                .entries()
                .iter()
                .enumerate()
                .filter_map(|(index, entry)| match entry {
                    DiscoveredEntry::Ready(image) => Some((
                        index,
                        image
                            .levels
                            .iter()
                            .filter_map(|level| level.source.image_size())
                            .map(|size| size.area())
                            .max()
                            .unwrap_or(0),
                    )),
                    _ => None,
                })
                .max_by_key(|(_, area)| *area)
                .map_or(0, |(index, _)| index),
        };
        let Some(entry) = catalog.into_entries().into_iter().nth(index) else {
            return Err(Error::new(
                "job.invalid-selection",
                ErrorPhase::Validation,
                "image selection is out of range",
            ));
        };
        match entry {
            DiscoveredEntry::Deferred(resource) => {
                if remaining_follows == 0 || !followed.borrow_mut().insert(resource.uri.clone()) {
                    return Err(Error::new(
                        "job.deferred-limit",
                        ErrorPhase::Discovery,
                        "deferred image follow limit or cycle",
                    ));
                }
                remaining_follows -= 1;
                catalog =
                    discover(vec![JobInput::new(&resource.uri)], options, host, followed).await?;
            }
            DiscoveredEntry::Ready(image) => {
                let level = match &options.selection {
                    SelectionPolicy::Interactive => {
                        host.choose_level((&image).into()).await? as usize
                    }
                    policy => select_level(&image, policy).ok_or_else(empty_plan)?,
                };
                if level >= image.levels.len() {
                    return Err(Error::new(
                        "job.invalid-selection",
                        ErrorPhase::Validation,
                        "level selection is out of range",
                    ));
                }
                return Ok((image, level));
            }
        }
    }
}

fn select_level(image: &core::ResolvedImage, policy: &SelectionPolicy) -> Option<usize> {
    let levels = &image.levels;
    match policy {
        SelectionPolicy::Fitting {
            max_width,
            max_height,
            max_area,
        } => {
            let sizes = || {
                levels.iter().enumerate().filter_map(|(i, l)| {
                    l.source
                        .image_size()
                        .filter(|s| s.x > 0 && s.y > 0)
                        .map(|s| (i, s))
                })
            };
            sizes()
                .filter(|(_, s)| s.x <= *max_width && s.y <= *max_height && s.area() <= *max_area)
                .max_by_key(|(_, s)| s.area())
                .or_else(|| sizes().min_by_key(|(_, s)| s.area()))
                .map(|(i, _)| i)
                .or_else(|| levels.len().checked_sub(1))
        }
        SelectionPolicy::Automatic {
            largest,
            max_width,
            max_height,
            zoom_level,
            ..
        } => {
            if let Some(level) = zoom_level {
                return levels.len().checked_sub(1).map(|last| (*level).min(last));
            }
            if *largest || (max_width.is_none() && max_height.is_none()) {
                return levels
                    .iter()
                    .enumerate()
                    .max_by_key(|(_, l)| l.source.image_size().map_or(0, |size| size.area()))
                    .map(|(i, _)| i);
            }
            levels
                .iter()
                .enumerate()
                .filter(|(_, l)| {
                    l.source.image_size().is_some_and(|s| {
                        max_width.is_none_or(|cap| s.x > 0 && s.x <= cap)
                            && max_height.is_none_or(|cap| s.y > 0 && s.y <= cap)
                    })
                })
                .max_by_key(|(_, l)| l.source.image_size().map_or(0, |size| size.area()))
                .map(|(i, _)| i)
                .or_else(|| {
                    levels
                        .iter()
                        .enumerate()
                        .min_by_key(|(_, l)| l.source.image_size().map_or(u32::MAX, |s| s.x))
                        .map(|(i, _)| i)
                })
        }
        SelectionPolicy::Interactive => None,
    }
}

fn size(point: Vec2d) -> Size {
    Size {
        width: point.x,
        height: point.y,
    }
}
fn portable_tile(tile: TileSpec, canvas: Option<Size>) -> Tile {
    Tile {
        index: tile.ordinal,
        request: ResourceRequest {
            uri: tile.request.uri,
            headers: tile.request.headers,
            purpose: if tile.role == TileRole::Output {
                RequestPurpose::Tile
            } else {
                RequestPurpose::Probe
            },
        },
        placement: TilePlacement {
            position: Point {
                x: tile.destination.x,
                y: tile.destination.y,
            },
            expected_size: tile.expected_size.map(size),
            canvas,
            processing: tile.processing,
            role: tile.role,
        },
    }
}
pub(crate) async fn probe(
    host: &impl Host,
    tile: TileSpec,
    remaining: &mut u32,
) -> Result<core::ObservationResult, Error> {
    *remaining = remaining.checked_sub(1).ok_or_else(|| {
        Error::new(
            "job.resource-limit",
            ErrorPhase::Acquisition,
            "probe count exceeds max_tiles",
        )
    })?;
    host.checkpoint(Gate::Cancellation).await?;
    match host
        .probe(portable_tile(tile, None))
        .await
        .map_err(crate::retry::classify)?
    {
        ProbeOutcome::Missing => Ok(core::ObservationResult::Missing),
        ProbeOutcome::Available { width, height } => Ok(core::ObservationResult::Available {
            size: Vec2d {
                x: u32::try_from(width.get())
                    .map_err(|_| core::TileSourceError::InvalidDimensions)?,
                y: u32::try_from(height.get())
                    .map_err(|_| core::TileSourceError::InvalidDimensions)?,
            },
        }),
    }
}

async fn acquire_round(
    tiles: impl Iterator<Item = Result<Tile, Error>>,
    host: &impl Host,
    options: &Options,
    progress: &mut Progress,
) -> Result<Vec<(Tile, Vec<Error>)>, Error> {
    let mut missing = Vec::new();
    let mut pending = stream::iter(tiles.map(|tile| async { acquire(host, tile?, options).await }))
        .buffer_unordered(options.max_concurrent as usize);
    while let Some(result) = pending.next().await {
        let (tile, failures) = result?;
        if let Some(failures) = failures {
            missing.push((tile, failures));
        } else {
            progress.completed += 1;
        }
        host.report(progress.clone());
    }
    Ok(missing)
}

async fn acquire(
    host: &impl Host,
    tile: Tile,
    options: &Options,
) -> Result<(Tile, Option<Vec<Error>>), Error> {
    let mut failures = Vec::new();
    for attempt in 0..=options.max_retries {
        host.checkpoint(Gate::Acquisition).await?;
        match host.acquire_tile(tile.clone()).await {
            Ok(()) => return Ok((tile, None)),
            Err(error)
                if error.code == "job.cancelled"
                    || error.code == "TRANSPORT_CANCELLED"
                    || error.code.starts_with("binding.")
                    || error.phase == ErrorPhase::Output =>
            {
                return Err(error);
            }
            Err(error) => {
                let error = crate::retry::classify(error);
                let retry = error.retryable && attempt < options.max_retries;
                let delay = crate::retry::retry_delay_ms(
                    attempt + 1,
                    error.retry_after_ms,
                    options.retry_base_delay_ms,
                );
                failures.push(error);
                if !retry {
                    break;
                }
                host.checkpoint(Gate::Acquisition).await?;
                host.sleep(delay as u32).await?;
            }
        }
    }
    Ok((tile, Some(failures)))
}

fn empty_plan() -> Error {
    Error::new(
        "job.plan-empty",
        ErrorPhase::Acquisition,
        "the selected level has no tiles",
    )
}
impl From<core::TileSourceError> for Error {
    fn from(error: core::TileSourceError) -> Self {
        Self::new(
            "job.plan-invalid",
            ErrorPhase::Acquisition,
            error.to_string(),
        )
    }
}
fn validate(inputs: &[JobInput], options: &Options) -> Result<(), Error> {
    let valid = |input: &str| {
        if input.is_empty() || input.len() > 2048 {
            return false;
        }
        if let Some(path) = input.strip_prefix("file://") {
            return path.starts_with('/')
                || path
                    .strip_prefix("localhost")
                    .is_some_and(|p| p.is_empty() || p.starts_with('/'));
        }
        if input.as_bytes().get(1) == Some(&b':')
            && input
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
        {
            return true;
        }
        match url::Url::parse(input) {
            Ok(url) => matches!(url.scheme(), "http" | "https"),
            Err(url::ParseError::RelativeUrlWithoutBase) => true,
            Err(_) => false,
        }
    };
    if inputs.is_empty()
        || inputs.len() > 256
        || !inputs
            .iter()
            .any(|i| i.kind.unwrap_or_default() == DiscoveryInputKind::Source)
        || inputs.iter().any(|i| !valid(&i.url))
    {
        return Err(Error::new(
            "job.invalid-input",
            ErrorPhase::Validation,
            "inputs require a user source and at most 256 valid URLs or local paths up to 2048 bytes",
        ));
    }
    if options.max_concurrent == 0 || options.max_tiles == 0 || options.max_bytes == 0 {
        return Err(Error::new(
            "job.invalid-config",
            ErrorPhase::Validation,
            "concurrency, tile, and byte limits must be positive",
        ));
    }
    if options.max_concurrent > 64
        || options.max_tiles > 16_777_216
        || options.max_retries > 1024
        || options.max_bytes < 1024
        || options.max_bytes > 4_294_967_296
        || options.max_deferred_follows > 64
        || options.retry_base_delay_ms > 300_000
    {
        return Err(Error::new(
            "job.resource-limit",
            ErrorPhase::Validation,
            "resource limits are out of range",
        ));
    }
    if options.max_concurrent > options.max_tiles {
        return Err(Error::new(
            "job.invalid-config",
            ErrorPhase::Validation,
            "max_concurrent cannot exceed max_tiles",
        ));
    }
    if let SelectionPolicy::Fitting {
        max_width,
        max_height,
        max_area,
    } = options.selection
        && (max_width == 0 || max_height == 0 || max_area == 0)
    {
        return Err(Error::new(
            "job.invalid-options",
            ErrorPhase::Validation,
            "canvas limits must be positive",
        ));
    }
    if inputs.iter().any(|input| {
        input.contents.as_ref().is_some_and(|contents| {
            contents.is_empty() || contents.len() as u64 > options.max_bytes
        })
    }) {
        return Err(Error::new(
            "job.resource-limit",
            ErrorPhase::Discovery,
            "supplied document exceeds resource limits",
        ));
    }
    Ok(())
}
