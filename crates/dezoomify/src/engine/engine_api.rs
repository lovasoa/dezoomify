//! Canonical engine API: one opaque job behind explicit commands and
//! host effects.
//!
//! This module publishes the job interface every product drives:
//!
//! ```text
//! dezoomify::engine::EngineJob
//! dezoomify::engine::JobOptions
//! dezoomify::engine::UserCommand
//! dezoomify::model::HostEffect
//! dezoomify::engine::EffectId
//! dezoomify::engine::EffectResult
//! dezoomify::engine::Failure
//! dezoomify::model::Snapshot
//! dezoomify::engine::Update
//! ```
//!
//! Surface:
//!
//! * `EngineJob::start(options) -> Result<(EngineJob, Update), ValidationError>`
//! * `EngineJob::command(&mut self, UserCommand) -> Result<Update, CommandError>`
//! * `EngineJob::complete(&mut self, EffectId, EffectResult) -> Result<Update, CompletionError>`
//! * `EngineJob::provide_metadata(&mut self, EffectId, ResponseMetadata, &[u8]) -> Result<Update, CompletionError>`
//!
//! Rules honored here: one opaque job ID per `EngineJob` (routing tokens
//! stay outside); engine-minted job-scoped [`EffectId`]s with one new ID
//! per attempt; [`Update`] carries newly issued effects plus the current
//! [`Snapshot`]; snapshots are projections (no secrets, pixels, paths,
//! or handles); timers report elapsed time as explicit completions (no
//! clocks in the engine); tile success is body-free (bytes travel only
//! through `provide_metadata`, and user commands can never supply bytes).
//!
//! Surface guarantees, all enforced by the facade:
//!
//! * The facade delegates to the inner [`crate::engine::Job`], so correlation is
//!   tile/request-ordinal based under the hood; the per-attempt
//!   [`EffectId`] mapping lives in this layer and every attempt mints a
//!   fresh ID.
//! * Same-job deferred follow-up (bounded follow/cycle, no host recursive
//!   replacement jobs) executes through [`UserCommand::FollowDeferred`]:
//!   the catalog is replaced in place with no new job ID.
//! * Output bytes/commit race finalization is correlated through one
//!   outstanding effect. Decision and cleanup effects are notifications:
//!   decisions are answered by [`UserCommand::AnswerPartial`] and cleanup
//!   needs no acknowledgement.
//!
//! ```rust
//! use dezoomify::engine::*;
//! use dezoomify::model::{JobState, OutputDisposition, Terminal};
//!
//! const DZI: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
//! <Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
//!   <Size Width="512" Height="512"/>
//! </Image>
//! "#;
//!
//! // Discovery input -> catalog -> selection -> tiles -> finalize -> terminal.
//! let options = JobOptions::new(vec![DiscoveryInput::new("https://example.test/image.dzi")]);
//! let (mut job, update) = EngineJob::start(options).expect("valid options");
//! assert_eq!(update.snapshot.lifecycle, JobState::Discovering);
//! let metadata = update.metadata_effects();
//! assert_eq!(metadata.len(), 1);
//!
//! let update = job
//!     .provide_metadata(metadata[0].correlation().expect("metadata correlation"), ResponseMetadata::new(), DZI)
//!     .expect("metadata bytes");
//! assert_eq!(update.snapshot.lifecycle, JobState::AwaitingImageSelection);
//!
//! let update = job
//!     .command(UserCommand::SelectImage { image: 0 })
//!     .expect("select image");
//! assert_eq!(update.snapshot.lifecycle, JobState::AwaitingLevelSelection);
//!
//! let levels = update.snapshot.selection.level_count;
//! let update = job
//!     .command(UserCommand::SelectLevel { level: levels - 1 })
//!     .expect("select largest level");
//! assert_eq!(update.snapshot.lifecycle, JobState::AcquiringTiles);
//!
//! // Complete every planned tile, then await finalization.
//! let tile_ids: Vec<EffectId> = update.tile_effects().iter().filter_map(|effect| effect.correlation()).collect();
//! assert_eq!(tile_ids.len(), 4);
//! let mut update = update;
//! for id in tile_ids {
//!     update = job.complete(id, EffectResult::TileAcquired).expect("tile done");
//! }
//! assert_eq!(update.snapshot.lifecycle, JobState::Finalizing);
//! let finalize = update.finalize_effects();
//! assert_eq!(finalize.len(), 1);
//!
//! let update = job
//!     .complete(
//!         finalize[0].correlation().expect("finalization correlation"),
//!         EffectResult::OutputCommitted {
//!             disposition: OutputDisposition::NativePublication,
//!         },
//!     )
//!     .expect("output committed");
//! assert_eq!(update.snapshot.lifecycle, JobState::Completed);
//! assert!(matches!(
//!     update.snapshot.terminal,
//!     Some(Terminal::Completed)
//! ));
//! ```

use std::collections::HashMap;

use crate::core::discovery::{FetchCause, FetchCode, TransportKind};
use crate::core::model::DiscoveredEntry;
use crate::model::{
    CatalogEntry, Decision, DeferredEntry, Error as ProtocolError,
    ErrorPhase as ProtocolErrorPhase, FailureCategory, HostEffect as Effect, JobState, MissingTile,
    OutputDisposition, OutputFormat, OutputSummary, Point, Progress, RecoveryChoice,
    RequestPurpose, ResourceRequest, Selection, Size, Snapshot, Terminal, TileFailure,
    TilePlacement,
};

use crate::engine::retry::TileFailure as InnerFailure;
pub use crate::engine::transition::JobError as EngineError;
use crate::engine::{Config, Job, JobCommand as InnerCommand, JobEffect as InnerEffect, Outcome};

/// One ordered discovery root: a URL the host can fetch, or inline bytes
/// the engine evaluates directly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryInput {
    /// Input URL (`http(s)`, `file://`, or a local path, up to 2048 bytes).
    pub url: String,
    /// Inline bytes, when the host already holds the resource.
    pub contents: Option<Vec<u8>>,
}

impl DiscoveryInput {
    /// Discovery root fetched by the host.
    #[must_use]
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            contents: None,
        }
    }

    /// Discovery root evaluated directly from supplied bytes.
    #[must_use]
    pub fn with_contents(url: impl Into<String>, contents: impl Into<Vec<u8>>) -> Self {
        Self {
            url: url.into(),
            contents: Some(contents.into()),
        }
    }
}

/// What the job does when tiles are missing after retries run out.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PartialPolicy {
    /// Missing tiles fail the job without output.
    Fail,
    /// Missing tiles are encoded with the gaps marked.
    Keep,
    /// The job pauses and asks through a typed decision effect.
    #[default]
    Prompt,
}

/// Explicit selection default for headless callers. The engine never
/// guesses: manual callers select, auto callers name the rule up front.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SelectionPolicy {
    /// Every image/level choice arrives as a [`UserCommand`].
    #[default]
    Manual,
    /// Browser policy: choose the ready image with the largest declared
    /// level, then its largest level within the declared canvas limits.
    BrowserLargestFitting {
        max_width: u32,
        max_height: u32,
        max_area: u64,
    },
    /// Native automatic selection: select the configured catalog position
    /// (clamped to the last entry), follow it if deferred, then choose its
    /// level using native precedence and optional caps.
    NativeAutomatic {
        image_index: usize,
        largest: bool,
        max_width: Option<u32>,
        max_height: Option<u32>,
        zoom_level: Option<usize>,
    },
}

/// Fixed input intent for one job: ordered discovery inputs, format
/// selection, selection/partial/retry policy, output format, and host
/// budgets. All bounds are validated before any work starts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobOptions {
    /// Ordered discovery roots; the first root yielding a catalog wins.
    pub inputs: Vec<DiscoveryInput>,
    /// Format selector: `None`/`"auto"` auto-detects, otherwise the single
    /// named format is used.
    pub format: Option<String>,
    /// Selection default for headless callers.
    pub selection: SelectionPolicy,
    /// Partial-output policy applied when tiles are missing.
    pub partial: PartialPolicy,
    /// Requested output encoding.
    pub output: OutputFormat,
    /// Maximum concurrent tile acquisitions.
    pub max_concurrent: u32,
    /// Maximum planned tiles.
    pub max_tiles: u32,
    /// Retry budget: transient failures retry at most this many times
    /// after the initial attempt (0 means first failure settles the tile).
    pub max_retries: u32,
    /// Maximum bytes accepted for one metadata resource.
    pub max_bytes: u64,
    /// Maximum same-job deferred catalog follows (0 disables following).
    pub max_deferred_follows: u32,
    /// Base retry wait in milliseconds (see [`Config::retry_base_delay_ms`]).
    pub retry_base_delay_ms: u64,
}

impl JobOptions {
    /// Options with default budgets, manual selection, and prompted partials.
    #[must_use]
    pub fn new(inputs: Vec<DiscoveryInput>) -> Self {
        let defaults = Config::default();
        Self {
            inputs,
            format: None,
            selection: SelectionPolicy::Manual,
            partial: PartialPolicy::Prompt,
            output: OutputFormat::Png,
            max_concurrent: defaults.max_concurrent_fetches,
            max_tiles: defaults.max_tiles,
            max_retries: defaults.max_retries,
            max_bytes: defaults.max_bytes,
            max_deferred_follows: defaults.max_deferred_follows,
            retry_base_delay_ms: defaults.retry_base_delay_ms,
        }
    }

    fn config(&self) -> Config {
        Config {
            max_concurrent_fetches: self.max_concurrent,
            max_tiles: self.max_tiles,
            max_retries: self.max_retries,
            max_bytes: self.max_bytes,
            max_deferred_follows: self.max_deferred_follows,
            retry_base_delay_ms: self.retry_base_delay_ms,
        }
    }
}

/// User intent. Commands can never supply bytes or claim publication;
/// bytes travel through `provide_metadata` and publication is reported by
/// the host through [`EffectResult::OutputCommitted`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UserCommand {
    /// Zero-based position into the kept catalog.
    SelectImage { image: u32 },
    /// Follow one still-deferred catalog entry within the same job
    /// (zero-based position). Bounded and cycle-guarded; the catalog is
    /// replaced on success with no new job ID.
    FollowDeferred { image: u32 },
    /// Zero-based position into the selected image's levels.
    SelectLevel { level: u32 },
    /// Answer the outstanding partial decision.
    AnswerPartial {
        generation: u32,
        decision: RecoveryChoice,
    },
    /// Stop scheduling new acquisitions; in-flight work settles.
    Pause,
    /// Re-drive pending work, including timers created while paused.
    Resume,
    /// Stop new work and release kept resources.
    Cancel,
}

/// Engine-minted correlation for one issued effect, scoped to the job.
/// Every attempt carries a new ID; hosts echo the ID back verbatim and the
/// engine never remaps it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct EffectId(pub u32);

impl EffectId {
    /// Raw job-scoped number (for logs and diagnostics only).
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0
    }
}

impl std::fmt::Display for EffectId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "effect:{}", self.0)
    }
}

impl Effect {
    /// Engine-minted correlation for effects that require a completion.
    #[must_use]
    pub const fn correlation(&self) -> Option<EffectId> {
        match self {
            Self::AcquireResource { request } | Self::AcquireTile { request, .. } => {
                Some(EffectId(request.id))
            }
            Self::WaitRetryTimer { effect, .. } | Self::FinalizeOutput { effect, .. } => {
                Some(EffectId(*effect))
            }
            Self::CancelWork | Self::RequestDecision { .. } => None,
        }
    }
}

/// Host-observed metadata response facts (no bytes; those travel as the
/// `provide_metadata` argument).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResponseMetadata {
    /// Post-redirect URL the host actually read, when it has one.
    pub final_uri: Option<String>,
}

impl ResponseMetadata {
    /// Response facts without a post-redirect URL.
    #[must_use]
    pub fn new() -> Self {
        Self { final_uri: None }
    }
}

/// Structured failure: closed category/code plus HTTP status, retry-after
/// hint, resource/transport context, and bounded diagnostics. Hosts report
/// observed facts only; the engine adds the correlated request context.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    /// Stable machine-readable code (never a display string).
    pub code: String,
    /// Observed HTTP status, when the failure was an HTTP refusal.
    pub http: Option<u16>,
    /// Host-observed `retry-after` in milliseconds, when present.
    pub retry_after_ms: Option<u64>,
    /// Transport that attempted the fetch, when known.
    pub transport: Option<TransportKind>,
    /// Bounded diagnostic detail (never secrets, pixels, paths, handles).
    pub detail: Option<String>,
}

impl Failure {
    /// Failure facts with code only.
    #[must_use]
    pub fn new(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            http: None,
            retry_after_ms: None,
            transport: None,
            detail: None,
        }
    }

    fn into_inner(self) -> InnerFailure {
        InnerFailure::new(self.code, self.http, self.retry_after_ms, self.detail)
    }
}

/// Host completion for one outstanding effect. Tile success carries no
/// body: acquired tiles are recorded by ID, displayed tiles complete
/// without readable bytes, and failures carry structured [`Failure`]s.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EffectResult {
    /// One tile acquired and decoded.
    TileAcquired,
    /// One tile shown as an ordinary image (no readable bytes).
    TileDisplayed,
    /// One tile failed with structured facts.
    TileFailed(Failure),
    /// One probe tile observed with geometry.
    ProbeAvailable { width: u32, height: u32 },
    /// One probe tile missing.
    ProbeMissing,
    /// One metadata fetch failed with structured facts.
    MetadataFailed(Failure),
    /// One retry timer elapsed.
    TimerElapsed,
    /// The awaited output operation succeeded.
    OutputCommitted { disposition: OutputDisposition },
    /// The awaited output operation failed.
    OutputFailed { code: String, message: String },
}

/// Engine answer: newly issued effects plus the current snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Update {
    /// Effects issued by this transition, in order.
    pub effects: Vec<Effect>,
    /// Current job projection.
    pub snapshot: Snapshot,
}

impl Update {
    /// Effects acquiring metadata.
    #[must_use]
    pub fn metadata_effects(&self) -> Vec<&Effect> {
        self.effects
            .iter()
            .filter(|effect| matches!(effect, Effect::AcquireResource { .. }))
            .collect()
    }

    /// Effects acquiring ordinary tiles.
    #[must_use]
    pub fn tile_effects(&self) -> Vec<&Effect> {
        self.effects
            .iter()
            .filter(|effect| matches!(effect, Effect::AcquireTile { .. }))
            .collect()
    }

    /// Effects awaiting final output.
    #[must_use]
    pub fn finalize_effects(&self) -> Vec<&Effect> {
        self.effects
            .iter()
            .filter(|effect| matches!(effect, Effect::FinalizeOutput { .. }))
            .collect()
    }
}

/// Option validation failure.
pub type ValidationError = EngineError;
/// User-command rejection.
pub type CommandError = EngineError;
/// Effect-completion rejection (unknown/stale effect, wrong result kind).
pub type CompletionError = EngineError;

/// Outstanding engine-minted effect awaiting its host completion.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Outstanding {
    Metadata { request: u32, uri: String },
    Tile { tile: u32 },
    Probe { tile: u32 },
    Timer { tile: u32, attempt: u32 },
    Finalize,
}

/// Which outstanding engine effect an adapter correlation id names. Adapters
/// correlate through the engine's own outstanding [`EffectId`]s instead of
/// keeping a second correlation machine: request ids round-trip as effect
/// ids, and timers/finalize resolve through the queries below.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutstandingKind {
    /// An outstanding metadata acquisition.
    Metadata,
    /// An outstanding ordinary tile acquisition.
    Tile,
    /// An outstanding probe acquisition.
    Probe,
}

/// One end-to-end user request behind the canonical API.
#[derive(Debug)]
pub struct EngineJob {
    inner: Job,
    options: JobOptions,
    revision: u32,
    next_effect: u32,
    outstanding: HashMap<EffectId, Outstanding>,
    /// Host failure context behind the latest metadata failure, retained so
    /// the terminal `Failed` error and snapshot keep the observed facts
    /// (code, transport, HTTP status). Cleared when a catalog wins, exactly
    /// like the adapter-side retention it replaces.
    discovery_failure: Option<ProtocolError>,
    disposition: Option<OutputDisposition>,
}

enum SelectionChoice {
    Image { image: u32 },
    FollowDeferred { image: u32 },
    NoImages,
}

fn pixel_area(width: u32, height: u32) -> u128 {
    u128::from(width) * u128::from(height)
}

fn browser_area(width: u32, height: u32) -> Option<u128> {
    (width > 0 && height > 0).then(|| pixel_area(width, height))
}

fn browser_selection(snapshot: &Snapshot) -> Option<SelectionChoice> {
    let Some(catalog) = snapshot.selection.catalog.as_ref() else {
        return Some(SelectionChoice::NoImages);
    };
    let mut best: Option<(usize, Option<u128>)> = None;
    for (index, entry) in catalog.entries.iter().enumerate() {
        let CatalogEntry::Image(image) = entry else {
            continue;
        };
        if image.levels.is_empty() {
            continue;
        }
        let image_area = image
            .levels
            .iter()
            .filter_map(|level| level.size.as_ref())
            .filter_map(|size| browser_area(size.width, size.height))
            .max();
        if best.is_none_or(|(_, best_area)| image_area.unwrap_or(0) >= best_area.unwrap_or(0)) {
            best = Some((index, image_area));
        }
    }
    if let Some((image, _)) = best {
        return Some(SelectionChoice::Image {
            image: u32::try_from(image).unwrap_or(u32::MAX),
        });
    }
    if let Some((index, _)) = catalog
        .entries
        .iter()
        .enumerate()
        .find(|(_, entry)| matches!(entry, CatalogEntry::ImageRequest(_)))
    {
        return Some(SelectionChoice::FollowDeferred {
            image: u32::try_from(index).unwrap_or(u32::MAX),
        });
    }
    Some(SelectionChoice::NoImages)
}

fn browser_level_selection(
    snapshot: &Snapshot,
    max_width: u32,
    max_height: u32,
    max_area: u64,
) -> Option<u32> {
    let catalog = snapshot.selection.catalog.as_ref()?;
    let image_index = usize::try_from(snapshot.selection.image?).ok()?;
    let CatalogEntry::Image(image) = catalog.entries.get(image_index)? else {
        return None;
    };
    let mut fitting: Option<(usize, u128)> = None;
    let mut smallest: Option<(usize, u128)> = None;
    for (index, level) in image.levels.iter().enumerate() {
        let Some(size) = level.size.as_ref() else {
            continue;
        };
        let Some(level_area) = browser_area(size.width, size.height) else {
            continue;
        };
        if size.width <= max_width
            && size.height <= max_height
            && level_area <= u128::from(max_area)
            && fitting.is_none_or(|(_, best_area)| level_area >= best_area)
        {
            fitting = Some((index, level_area));
        }
        if smallest.is_none_or(|(_, smallest_area)| level_area < smallest_area) {
            smallest = Some((index, level_area));
        }
    }
    fitting
        .or(smallest)
        .map(|(index, _)| u32::try_from(index).unwrap_or(u32::MAX))
        .or_else(|| {
            image
                .levels
                .len()
                .checked_sub(1)
                .map(|index| u32::try_from(index).unwrap_or(u32::MAX))
        })
}

fn native_image_selection(snapshot: &Snapshot, image_index: usize) -> Option<SelectionChoice> {
    let catalog = snapshot.selection.catalog.as_ref()?;
    let position = image_index.min(catalog.entries.len().checked_sub(1)?);
    let image = u32::try_from(position).unwrap_or(u32::MAX);
    match catalog.entries.get(position)? {
        CatalogEntry::Image(_) => Some(SelectionChoice::Image { image }),
        CatalogEntry::ImageRequest(_) => Some(SelectionChoice::FollowDeferred { image }),
    }
}

fn native_level_selection(
    snapshot: &Snapshot,
    largest: bool,
    max_width: Option<u32>,
    max_height: Option<u32>,
    zoom_level: Option<usize>,
) -> Option<u32> {
    let catalog = snapshot.selection.catalog.as_ref()?;
    let image_index = usize::try_from(snapshot.selection.image?).ok()?;
    let CatalogEntry::Image(image) = catalog.entries.get(image_index)? else {
        return None;
    };
    let levels = &image.levels;
    if levels.is_empty() {
        return None;
    }
    if let Some(requested) = zoom_level {
        return u32::try_from(requested.min(levels.len() - 1)).ok();
    }
    if largest || (max_width.is_none() && max_height.is_none()) {
        return levels
            .iter()
            .enumerate()
            .max_by_key(|(_, level)| {
                level
                    .size
                    .as_ref()
                    .map_or(0, |size| pixel_area(size.width, size.height))
            })
            .and_then(|(index, _)| u32::try_from(index).ok());
    }

    let fits = |width: u32, height: u32| {
        max_width.is_none_or(|cap| width > 0 && width <= cap)
            && max_height.is_none_or(|cap| height > 0 && height <= cap)
    };
    if let Some((index, _)) = levels
        .iter()
        .enumerate()
        .filter(|(_, level)| {
            level
                .size
                .as_ref()
                .is_some_and(|size| fits(size.width, size.height))
        })
        .max_by_key(|(_, level)| {
            level
                .size
                .as_ref()
                .map_or(0, |size| pixel_area(size.width, size.height))
        })
    {
        return u32::try_from(index).ok();
    }

    // Native fallback treats an unknown width as larger than every known
    // width; `min_by_key` retains the first level on equal widths.
    levels
        .iter()
        .enumerate()
        .min_by_key(|(_, level)| level.size.as_ref().map_or(u32::MAX, |size| size.width))
        .and_then(|(index, _)| u32::try_from(index).ok())
}

impl EngineJob {
    /// Validate job options without starting: inputs, budgets, and format.
    ///
    /// # Errors
    ///
    /// Returns [`ValidationError`] for the same inputs [`EngineJob::start`]
    /// rejects.
    pub fn validate_options(options: &JobOptions) -> Result<(), ValidationError> {
        if options.inputs.is_empty()
            || options
                .inputs
                .iter()
                .any(|input| !crate::engine::job::is_valid_input_url(&input.url))
        {
            return Err(EngineError::new(
                "job.invalid-input",
                "inputs must contain valid http(s) URLs, file:// URIs, or local paths up to 2048 bytes",
            ));
        }
        let config = options.config();
        config
            .validate()
            .map_err(|error| EngineError::new(&error.code, error.message))?;
        if let SelectionPolicy::BrowserLargestFitting {
            max_width,
            max_height,
            max_area,
        } = options.selection
            && (max_width == 0 || max_height == 0 || max_area == 0)
        {
            return Err(EngineError::new(
                "job.invalid-options",
                "browser selection limits must be positive",
            ));
        }
        Ok(())
    }

    /// Validate options and enter discovery with the first effects.
    ///
    /// # Errors
    ///
    /// Returns [`ValidationError`] when inputs are empty or invalid, the
    /// format name is unknown, or a budget fails validation.
    pub fn start(options: JobOptions) -> Result<(Self, Update), ValidationError> {
        Self::validate_options(&options)?;
        let mut inner = Job::new(options.inputs.clone(), options.config());
        if let Some(name) = options.format.clone() {
            inner.set_format(Some(name));
        }
        let mut job = Self {
            inner,
            options,
            revision: 0,
            next_effect: 0,
            outstanding: HashMap::new(),
            discovery_failure: None,
            disposition: None,
        };
        job.inner.start()?;
        job.bump_revision()?;
        let update = job.drain()?;
        let update = job.apply_policies(update)?;
        Ok((job, update))
    }

    /// Apply one user command (selection, partial answer, pause, resume,
    /// cancel). Commands never supply bytes and never claim publication.
    ///
    /// # Errors
    ///
    /// Returns [`CommandError`] for wrong-phase commands, stale decision
    /// answers, and post-terminal input.
    pub fn command(&mut self, command: UserCommand) -> Result<Update, CommandError> {
        let outcome = self.apply_command_inner(command)?;
        if outcome == Outcome::Applied {
            self.bump_revision()?;
        }
        let update = self.drain()?;
        self.apply_policies(update)
    }

    fn apply_command_inner(&mut self, command: UserCommand) -> Result<Outcome, EngineError> {
        let inner = match command {
            UserCommand::SelectImage { image } => InnerCommand::SelectImage { image },
            UserCommand::FollowDeferred { image } => InnerCommand::FollowDeferred { image },
            UserCommand::SelectLevel { level } => InnerCommand::SelectLevel { level },
            UserCommand::AnswerPartial {
                generation,
                decision,
            } => InnerCommand::RecoveryChoice {
                generation,
                choice: decision,
            },
            UserCommand::Pause => InnerCommand::Pause,
            UserCommand::Resume => InnerCommand::Resume,
            UserCommand::Cancel => InnerCommand::Cancel,
        };
        self.inner.on_command(inner)
    }

    /// Complete one outstanding effect with a body-free result. Metadata
    /// bodies travel through `provide_metadata`, never here.
    ///
    /// Wrong-kind and validation rejections leave the outstanding effect
    /// live so the host can still answer it with the correct kind; only
    /// accepted completions settle it. A rejected `OutputCommitted` never
    /// sets the output disposition.
    ///
    /// # Errors
    ///
    /// Returns [`CompletionError`] for unknown effects, duplicate
    /// completions (each effect settles exactly once), wrong result kinds,
    /// and post-terminal completions that would mutate state.
    pub fn complete(
        &mut self,
        effect: EffectId,
        result: EffectResult,
    ) -> Result<Update, CompletionError> {
        let outstanding = self.outstanding.get(&effect).cloned().ok_or_else(|| {
            EngineError::new(
                "job.stale-effect",
                format!("{effect} is unknown or already settled"),
            )
        })?;
        let (inner, disposition) = self.translate_completion(effect, outstanding, result)?;
        let applied = match self.inner.on_command(inner) {
            Ok(Outcome::Ignored) => {
                // Late success/failure after the acquisition settled: the
                // effect was live when issued, so the completion is
                // accepted but changes nothing further.
                self.outstanding.remove(&effect);
                false
            }
            Ok(Outcome::Applied) => {
                self.outstanding.remove(&effect);
                // Publication is claimed only once the inner machine accepts
                // the finalize completion: rejected `OutputCommitted` answers
                // leave the disposition unset.
                if let Some(disposition) = disposition {
                    self.disposition = Some(disposition);
                }
                true
            }
            Err(error) => return Err(error),
        };
        if applied {
            self.bump_revision()?;
        }
        let update = self.drain()?;
        self.apply_policies(update).map_err(|error| {
            EngineError::new(
                &error.code,
                format!("policy follow-up failed: {}", error.message),
            )
        })
    }

    /// Supply one metadata body for an outstanding metadata effect.
    ///
    /// # Errors
    ///
    /// Returns [`CompletionError`] for unknown effects, duplicate supply,
    /// over-limit or empty bodies, and wrong effect kinds.
    pub fn provide_metadata(
        &mut self,
        effect: EffectId,
        response: ResponseMetadata,
        bytes: &[u8],
    ) -> Result<Update, CompletionError> {
        let outstanding = self.outstanding.get(&effect).cloned().ok_or_else(|| {
            EngineError::new(
                "job.stale-effect",
                format!("{effect} is unknown or already settled"),
            )
        })?;
        let Outstanding::Metadata { request, .. } = outstanding else {
            return Err(EngineError::new(
                "job.wrong-result-kind",
                format!("{effect} is not a metadata effect"),
            ));
        };
        if bytes.is_empty() {
            return Err(EngineError::new(
                "job.empty-resource",
                "metadata bodies must not be empty",
            ));
        }
        // Wrong-kind and empty-body rejections leave the effect live; only
        // an accepted or inner-rejected answer settles it. Inner rejections
        // (post-terminal, over-limit terminal) consume the effect because
        // the inner machine observed the answer.
        let outcome = match self.inner.on_command(InnerCommand::ResourceBytes {
            request,
            bytes: bytes.to_vec(),
            final_uri: response.final_uri.filter(|uri| !uri.is_empty()),
        }) {
            Ok(outcome) => {
                self.outstanding.remove(&effect);
                outcome
            }
            Err(error) => {
                self.outstanding.remove(&effect);
                return Err(error);
            }
        };
        if outcome == Outcome::Applied {
            self.bump_revision()?;
        }
        let update = self.drain()?;
        self.apply_policies(update).map_err(|error| {
            EngineError::new(
                &error.code,
                format!("policy follow-up failed: {}", error.message),
            )
        })
    }

    /// Current job projection without issuing work.
    #[must_use]
    pub fn snapshot(&self) -> Snapshot {
        self.project()
    }

    /// Current job projection packaged as an empty answer: no new effects,
    /// only the snapshot. Hosts use it when a completion arrives with
    /// nothing to reply (cancel/terminal guard).
    #[must_use]
    pub fn snapshot_update(&self) -> Update {
        Update {
            effects: Vec::new(),
            snapshot: self.project(),
        }
    }

    /// Which outstanding effect `effect` names, if it is still unsettled.
    /// Adapters correlate request ids through this instead of retaining
    /// their own request tables: unknown or already-settled ids report
    /// `None`, exactly like a stale completion.
    #[must_use]
    pub fn outstanding_kind(&self, effect: EffectId) -> Option<OutstandingKind> {
        match self.outstanding.get(&effect) {
            Some(Outstanding::Metadata { .. }) => Some(OutstandingKind::Metadata),
            Some(Outstanding::Tile { .. }) => Some(OutstandingKind::Tile),
            Some(Outstanding::Probe { .. }) => Some(OutstandingKind::Probe),
            _ => None,
        }
    }

    /// Outstanding retry-timer effect for one `(tile, attempt)` wait, if the
    /// host still holds it. Absent timers are stale completions the host
    /// tolerates with no work.
    #[must_use]
    pub fn outstanding_timer(&self, tile: u32, attempt: u32) -> Option<EffectId> {
        self.outstanding
            .iter()
            .find_map(|(id, outstanding)| match outstanding {
                Outstanding::Timer {
                    tile: pending,
                    attempt: pending_attempt,
                } if *pending == tile && *pending_attempt == attempt => Some(*id),
                _ => None,
            })
    }

    /// Outstanding finalize effect, if the host awaits output. Absent means
    /// no output operation is awaited.
    #[must_use]
    pub fn outstanding_finalize(&self) -> Option<EffectId> {
        self.outstanding
            .iter()
            .find_map(|(id, outstanding)| match outstanding {
                Outstanding::Finalize => Some(*id),
                _ => None,
            })
    }

    /// Retain host failure context for one outstanding metadata effect. The
    /// terminal `Failed` error keeps these observed facts (naming the
    /// request URI from the issued effect), so adapters forward the context
    /// without retaining it themselves. Calls for unknown or non-metadata
    /// effects are ignored; a winning catalog clears the retention.
    pub fn note_metadata_failure(&mut self, effect: EffectId, mut error: ProtocolError) {
        let Some(Outstanding::Metadata { uri, .. }) = self.outstanding.get(&effect) else {
            return;
        };
        error.request = Some(uri.clone());
        self.discovery_failure = Some(error);
    }

    fn translate_completion(
        &self,
        effect: EffectId,
        outstanding: Outstanding,
        result: EffectResult,
    ) -> Result<(InnerCommand, Option<OutputDisposition>), CompletionError> {
        let wrong_kind = |effect: EffectId| {
            EngineError::new(
                "job.wrong-result-kind",
                format!("result does not match {effect}"),
            )
        };
        match (outstanding, result) {
            (Outstanding::Tile { tile }, EffectResult::TileAcquired) => {
                Ok((InnerCommand::TileAcquired { tile }, None))
            }
            (Outstanding::Tile { tile }, EffectResult::TileDisplayed) => {
                Ok((InnerCommand::TileDisplayed { tile }, None))
            }
            (Outstanding::Tile { tile }, EffectResult::TileFailed(failure)) => Ok((
                InnerCommand::TileFailed {
                    tile,
                    failure: failure.into_inner(),
                },
                None,
            )),
            (Outstanding::Probe { tile }, EffectResult::ProbeAvailable { width, height }) => {
                if width == 0 || height == 0 {
                    return Err(EngineError::new(
                        "job.invalid-result",
                        "probe observations carry non-zero dimensions",
                    ));
                }
                Ok((
                    InnerCommand::ProbeOutcome {
                        tile,
                        outcome: crate::model::ProbeOutcome::Available {
                            width: std::num::NonZeroU64::new(u64::from(width)).ok_or_else(
                                || {
                                    EngineError::new(
                                        "job.invalid-result",
                                        "probe width does not fit the contract range",
                                    )
                                },
                            )?,
                            height: std::num::NonZeroU64::new(u64::from(height)).ok_or_else(
                                || {
                                    EngineError::new(
                                        "job.invalid-result",
                                        "probe height does not fit the contract range",
                                    )
                                },
                            )?,
                        },
                    },
                    None,
                ))
            }
            (Outstanding::Probe { tile }, EffectResult::ProbeMissing) => Ok((
                InnerCommand::ProbeOutcome {
                    tile,
                    outcome: crate::model::ProbeOutcome::Missing,
                },
                None,
            )),
            (Outstanding::Metadata { request, .. }, EffectResult::MetadataFailed(failure)) => {
                let transport = failure.transport.unwrap_or(TransportKind::Direct);
                let cause = FetchCause {
                    code: FetchCode::from_string(failure.code.clone()),
                    http: failure.http,
                    transport,
                    reason: None,
                };
                Ok((InnerCommand::FetchFailure { request, cause }, None))
            }
            (Outstanding::Timer { tile, attempt }, EffectResult::TimerElapsed) => {
                Ok((InnerCommand::RetryTimerElapsed { tile, attempt }, None))
            }
            (Outstanding::Finalize, EffectResult::OutputCommitted { disposition }) => {
                Ok((InnerCommand::FinalizationSucceeded, Some(disposition)))
            }
            (Outstanding::Finalize, EffectResult::OutputFailed { code, message }) => {
                Ok((InnerCommand::FinalizationFailed { code, message }, None))
            }
            _ => Err(wrong_kind(effect)),
        }
    }

    /// Explicit selection/partial policies for headless callers: with an
    /// auto selection rule the facade selects or follows deferred entries
    /// without prompting, and with a fail/keep partial policy it answers the
    /// decision in the same transition instead of surfacing it.
    fn apply_policies(&mut self, mut update: Update) -> Result<Update, EngineError> {
        if update.snapshot.lifecycle == JobState::AwaitingImageSelection {
            let choice = match self.options.selection {
                SelectionPolicy::Manual => None,
                SelectionPolicy::BrowserLargestFitting { .. } => {
                    browser_selection(&update.snapshot)
                }
                SelectionPolicy::NativeAutomatic { image_index, .. } => Some(
                    native_image_selection(&update.snapshot, image_index)
                        .unwrap_or(SelectionChoice::NoImages),
                ),
            };
            match choice {
                Some(SelectionChoice::Image { image }) => {
                    self.apply_command_inner(UserCommand::SelectImage { image })?;
                    update.effects.extend(self.drain()?.effects);
                    update.snapshot = self.project();
                }
                Some(SelectionChoice::FollowDeferred { image }) => {
                    match self.apply_command_inner(UserCommand::FollowDeferred { image }) {
                        Ok(_) => {
                            update.effects.extend(self.drain()?.effects);
                            update.snapshot = self.project();
                        }
                        Err(rejection) => {
                            self.inner.fail_via_cleanup(
                                "discovery.deferred",
                                format!(
                                    "automatic deferred catalog follow rejected ({}): {}",
                                    rejection.code, rejection.message
                                ),
                            )?;
                            update.effects.extend(self.drain()?.effects);
                            update.snapshot = self.project();
                        }
                    }
                }
                Some(SelectionChoice::NoImages) => {
                    self.inner.fail_via_cleanup(
                        "job.no-images",
                        "discovery completed without a selectable image".to_string(),
                    )?;
                    update.effects.extend(self.drain()?.effects);
                    update.snapshot = self.project();
                }
                None => {}
            }
        }
        if update.snapshot.lifecycle == JobState::AwaitingLevelSelection {
            let level = match self.options.selection {
                SelectionPolicy::Manual => None,
                SelectionPolicy::BrowserLargestFitting {
                    max_width,
                    max_height,
                    max_area,
                } if update.snapshot.selection.level_count > 0 => Some(
                    browser_level_selection(&update.snapshot, max_width, max_height, max_area)
                        .unwrap_or(update.snapshot.selection.level_count - 1),
                ),
                SelectionPolicy::NativeAutomatic {
                    largest,
                    max_width,
                    max_height,
                    zoom_level,
                    ..
                } => native_level_selection(
                    &update.snapshot,
                    largest,
                    max_width,
                    max_height,
                    zoom_level,
                ),
                _ => None,
            };
            if let Some(level) = level {
                self.apply_command_inner(UserCommand::SelectLevel { level })?;
                update.effects.extend(self.drain()?.effects);
                update.snapshot = self.project();
            } else if matches!(
                self.options.selection,
                SelectionPolicy::NativeAutomatic { .. }
            ) {
                self.inner.fail_via_cleanup(
                    "job.plan-empty",
                    "selected image has no zoom levels".to_string(),
                )?;
                update.effects.extend(self.drain()?.effects);
                update.snapshot = self.project();
            }
        }
        if update.snapshot.lifecycle == JobState::AwaitingPartialDecision {
            match self.options.partial {
                PartialPolicy::Prompt => {}
                PartialPolicy::Fail => {
                    let generation = update
                        .snapshot
                        .decision
                        .as_ref()
                        .map(|decision| decision.generation)
                        .unwrap_or(0);
                    self.apply_command_inner(UserCommand::AnswerPartial {
                        generation,
                        decision: RecoveryChoice::Discard,
                    })?;
                    update.effects.extend(self.drain()?.effects);
                    update.snapshot = self.project();
                }
                PartialPolicy::Keep => {
                    let generation = update
                        .snapshot
                        .decision
                        .as_ref()
                        .map(|decision| decision.generation)
                        .unwrap_or(0);
                    self.apply_command_inner(UserCommand::AnswerPartial {
                        generation,
                        decision: RecoveryChoice::Keep,
                    })?;
                    update.effects.extend(self.drain()?.effects);
                    update.snapshot = self.project();
                }
            }
        }
        Ok(update)
    }

    /// Mint one job-scoped effect ID (checked arithmetic).
    fn mint_effect(&mut self) -> Result<EffectId, EngineError> {
        let id = EffectId(self.next_effect);
        self.next_effect = self.next_effect.checked_add(1).ok_or_else(|| {
            EngineError::new("job.overflow", "effect id counter overflowed".to_string())
        })?;
        Ok(id)
    }

    fn bump_revision(&mut self) -> Result<(), EngineError> {
        self.revision = self.revision.checked_add(1).ok_or_else(|| {
            EngineError::new("job.overflow", "snapshot revision counter overflowed")
        })?;
        Ok(())
    }

    /// Drain newly issued inner effects and mint canonical IDs once.
    fn drain(&mut self) -> Result<Update, EngineError> {
        let mut effects = Vec::new();
        for effect in self.inner.drain_effects() {
            if let Some(effect) = self.issue_effect(effect)? {
                effects.push(effect);
            }
        }
        if self.inner.state() == crate::engine::State::AwaitingImageSelection
            && self.inner.catalog().is_some()
        {
            self.discovery_failure = None;
        }
        Ok(Update {
            effects,
            snapshot: self.project(),
        })
    }

    /// Issue one scheduler effect onto a canonical effect with a fresh
    /// per-attempt ID. Returns `None` only for effects the canonical
    /// surface does not expose (none today: every effect projects).
    fn issue_effect(&mut self, effect: InnerEffect) -> Result<Option<Effect>, EngineError> {
        let id = self.mint_effect()?;
        match effect {
            InnerEffect::AcquireResource { request, uri, .. } => {
                self.outstanding.insert(
                    id,
                    Outstanding::Metadata {
                        request,
                        uri: uri.clone(),
                    },
                );
                Ok(Some(Effect::AcquireResource {
                    request: ResourceRequest {
                        id: id.get(),
                        uri,
                        headers: Vec::new(),
                        purpose: RequestPurpose::Metadata,
                    },
                }))
            }
            InnerEffect::AcquireTile {
                tile,
                uri,
                headers,
                processing,
                destination,
                expected_size,
                canvas,
                probe,
                probe_output,
            } => {
                let pairs = headers;
                if probe {
                    self.outstanding.insert(id, Outstanding::Probe { tile });
                } else {
                    self.outstanding.insert(id, Outstanding::Tile { tile });
                }
                Ok(Some(Effect::AcquireTile {
                    request: ResourceRequest {
                        id: id.get(),
                        uri,
                        headers: pairs,
                        purpose: if probe {
                            RequestPurpose::Probe
                        } else {
                            RequestPurpose::Tile
                        },
                    },
                    tile,
                    placement: TilePlacement {
                        position: Point {
                            x: destination.x,
                            y: destination.y,
                        },
                        expected_size: expected_size.map(|size| Size {
                            width: size.x,
                            height: size.y,
                        }),
                        canvas: canvas.map(|size| Size {
                            width: size.x,
                            height: size.y,
                        }),
                        processing,
                        probe_output,
                    },
                }))
            }
            InnerEffect::FinalizeOutput {
                partial, canvas, ..
            } => {
                self.outstanding.insert(id, Outstanding::Finalize);
                Ok(Some(Effect::FinalizeOutput {
                    effect: id.get(),
                    partial,
                    format: self.options.output,
                    canvas: canvas.map(|size| Size {
                        width: size.x,
                        height: size.y,
                    }),
                }))
            }
            InnerEffect::WaitForRetry {
                tile,
                attempt,
                delay_ms,
            } => {
                self.outstanding
                    .insert(id, Outstanding::Timer { tile, attempt });
                Ok(Some(Effect::WaitRetryTimer {
                    effect: id.get(),
                    tile,
                    attempt,
                    delay_ms,
                }))
            }
            InnerEffect::CancelWork => Ok(Some(Effect::CancelWork)),
            InnerEffect::RequestDecision { generation } => {
                Ok(Some(Effect::RequestDecision { generation }))
            }
        }
    }

    /// Project the current snapshot from inner state plus absorbed events.
    /// Lifecycle and terminal use the canonical protocol vocabulary
    /// directly: the inner machine already runs on it, so no mapping table
    /// exists here.
    fn project(&self) -> Snapshot {
        let lifecycle = match self.inner.state() {
            crate::engine::State::Completed
            | crate::engine::State::PartiallyCompleted
            | crate::engine::State::Failed
            | crate::engine::State::Cancelled => self.terminal_lifecycle(),
            state => state,
        };
        let (completed, total) = self.inner.acquisition_progress();
        let terminal = self.terminal();
        Snapshot {
            revision: self.revision,
            lifecycle,
            paused: self.inner.is_paused(),
            progress: Progress {
                completed,
                total: Some(total),
            },
            selection: Selection {
                image: self.inner.selected_image(),
                level: self.inner.selected_level(),
                level_count: self
                    .inner
                    .selected_image()
                    .map_or(0, |image| self.inner.level_count(image)),
                catalog: self.inner.catalog().map(|catalog| catalog.public_catalog()),
                deferred: self.inner.catalog().map_or_else(Vec::new, |catalog| {
                    catalog
                        .entries()
                        .iter()
                        .enumerate()
                        .filter_map(|(index, entry)| {
                            let DiscoveredEntry::Deferred(deferred) = entry else {
                                return None;
                            };
                            u32::try_from(index).ok().map(|position| DeferredEntry {
                                position,
                                uri: deferred.uri.clone(),
                            })
                        })
                        .collect()
                }),
            },
            decision: self.inner.pending_decision().map(|generation| Decision {
                generation,
                missing: self
                    .inner
                    .missing_detail()
                    .iter()
                    .map(|(tile, failures)| MissingTile {
                        tile: *tile,
                        failures: failures
                            .iter()
                            .map(|failure| TileFailure {
                                code: failure.code.clone(),
                                category: match failure.category {
                                    crate::engine::retry::FailureCategory::Permanent => {
                                        FailureCategory::Permanent
                                    }
                                    crate::engine::retry::FailureCategory::Transient => {
                                        FailureCategory::Transient
                                    }
                                },
                                http: failure.http,
                                retry_after_ms: failure.retry_after_ms,
                                detail: failure.detail.clone(),
                            })
                            .collect(),
                    })
                    .collect(),
            }),
            output: self.output_summary(),
            terminal,
        }
    }

    fn terminal_lifecycle(&self) -> JobState {
        match self.inner.terminal_kind() {
            Some("completed") => JobState::Completed,
            Some("partial-completed") => JobState::PartiallyCompleted,
            Some("failed") => JobState::Failed,
            Some("cancelled") => JobState::Cancelled,
            _ => JobState::Failed,
        }
    }

    fn terminal(&self) -> Option<Terminal> {
        match self.inner.terminal_kind() {
            Some("completed") => Some(Terminal::Completed),
            Some("partial-completed") => Some(Terminal::PartialCompleted {
                missing: self
                    .inner
                    .missing_detail()
                    .iter()
                    .map(|(tile, _)| *tile)
                    .collect(),
            }),
            Some("failed") => {
                let (code, message) = self
                    .inner
                    .terminal_error()
                    .map(|(code, message)| (code.clone(), message.clone()))
                    .unwrap_or_else(|| ("job.failed".to_string(), "job failed".to_string()));
                let missing: Vec<u32> = self
                    .inner
                    .missing_detail()
                    .iter()
                    .map(|(tile, _)| *tile)
                    .collect();
                let phase = failure_phase_for(&code, !missing.is_empty());
                let mut error = ProtocolError::new(code, phase, message);
                // The retained host failure context patches the terminal
                // error, so the absolute snapshot never discards what the
                // event stream keeps.
                if let Some(enriched) = &self.discovery_failure {
                    let mut patched = enriched.clone();
                    if patched.detail.is_none() && patched.message != error.message {
                        patched.detail = Some(error.message.clone());
                    }
                    error = patched;
                }
                Some(Terminal::Failed { error })
            }
            Some("cancelled") => Some(Terminal::Cancelled),
            _ => None,
        }
    }

    fn output_summary(&self) -> Option<OutputSummary> {
        let canvas = self.inner.canvas_size().map(|size| Size {
            width: size.x,
            height: size.y,
        });
        if canvas.is_none() && self.inner.acquisition_progress().1 == 0 {
            return None;
        }
        let (completed, total) = self.inner.acquisition_progress();
        let missing: Vec<u32> = self
            .inner
            .missing_detail()
            .iter()
            .map(|(tile, _)| *tile)
            .collect();
        Some(OutputSummary {
            canvas,
            format: self.options.output,
            complete: total > 0 && completed == total && missing.is_empty(),
            missing,
            disposition: self.disposition,
        })
    }
}

/// Attribute an engine failure code to its protocol phase. Codes are
/// stable API (never display text); the phase is derived from the code
/// and whether tiles settled as missing.
fn failure_phase_for(code: &str, has_missing_tiles: bool) -> ProtocolErrorPhase {
    if has_missing_tiles || code == "job.partial-discarded" {
        ProtocolErrorPhase::Acquisition
    } else if code.starts_with("output.") || code.starts_with("job.plan") {
        ProtocolErrorPhase::Output
    } else {
        ProtocolErrorPhase::Discovery
    }
}

#[cfg(test)]
mod native_selection_tests {
    use super::*;
    use crate::model::{Catalog, Image, Level};

    fn snapshot_with_levels(levels: &[(u32, u32)]) -> Snapshot {
        let image = Image {
            title: None,
            format: "test".to_string(),
            size: None,
            source_kind: "test".to_string(),
            levels: levels
                .iter()
                .enumerate()
                .map(|(index, (width, height))| Level {
                    label: index.to_string(),
                    size: (*width > 0 && *height > 0).then_some(Size {
                        width: *width,
                        height: *height,
                    }),
                    tile_size: Some(Size {
                        width: 1,
                        height: 1,
                    }),
                })
                .collect(),
        };
        Snapshot {
            revision: 0,
            lifecycle: JobState::AwaitingLevelSelection,
            paused: false,
            progress: Progress {
                completed: 0,
                total: None,
            },
            selection: Selection {
                image: Some(0),
                level: None,
                level_count: u32::try_from(levels.len()).expect("test level count fits"),
                catalog: Some(Catalog {
                    entries: vec![CatalogEntry::Image(image)],
                }),
                deferred: Vec::new(),
            },
            decision: None,
            terminal: None,
            output: None,
        }
    }

    #[test]
    fn native_largest_and_fitting_area_ties_choose_the_last_level() {
        let snapshot = snapshot_with_levels(&[(2, 3), (3, 2), (1, 1)]);
        assert_eq!(
            native_level_selection(&snapshot, true, None, None, None),
            Some(1)
        );
        assert_eq!(
            native_level_selection(&snapshot, false, Some(3), Some(3), None),
            Some(1)
        );
    }

    #[test]
    fn native_width_fallback_keeps_first_tie_and_prefers_known_widths() {
        let snapshot = snapshot_with_levels(&[(4, 1), (4, 2), (0, 100), (0, 200)]);
        assert_eq!(
            native_level_selection(&snapshot, false, Some(0), None, None),
            Some(0)
        );
        let unknown = snapshot_with_levels(&[(0, 1), (0, 2)]);
        assert_eq!(
            native_level_selection(&unknown, false, Some(0), None, None),
            Some(0)
        );
    }
}
