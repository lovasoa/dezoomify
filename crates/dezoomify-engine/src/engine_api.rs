//! Canonical engine API: one opaque job behind explicit commands and
//! host effects.
//!
//! This module publishes the job interface every product drives:
//!
//! ```text
//! dezoomify_engine::engine_api::EngineJob
//! dezoomify_engine::engine_api::JobOptions
//! dezoomify_engine::engine_api::UserCommand
//! dezoomify_engine::engine_api::Effect
//! dezoomify_engine::engine_api::EffectId
//! dezoomify_engine::engine_api::EffectResult
//! dezoomify_engine::engine_api::Failure
//! dezoomify_engine::engine_api::JobSnapshot
//! dezoomify_engine::engine_api::Update
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
//! [`JobSnapshot`]; snapshots are projections (no secrets, pixels, paths,
//! or handles); timers report elapsed time as explicit completions (no
//! clocks in the engine); tile success is body-free (bytes travel only
//! through `provide_metadata`, and user commands can never supply bytes).
//!
//! Surface guarantees, all enforced by the facade:
//!
//! * The facade delegates to the inner [`crate::Job`], so correlation is
//!   tile/request-ordinal based under the hood; the per-attempt
//!   [`EffectId`] mapping lives in this layer and every attempt mints a
//!   fresh ID.
//! * Same-job deferred follow-up (bounded follow/cycle, no host recursive
//!   replacement jobs) executes through [`UserCommand::FollowDeferred`]:
//!   the catalog is replaced in place with no new job ID.
//! * Output bytes/commit race finalization and cleanup acknowledgements
//!   are accepted and idempotent: a `CleanupAcknowledged` completion for a
//!   release effect refreshes the projection without touching terminal
//!   state.
//!
//! ```rust
//! use dezoomify_engine::engine_api::*;
//! use dezoomify_protocol::dto::{JobState, SnapshotTerminalDto};
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
//!     .provide_metadata(metadata[0].id(), ResponseMetadata::new(), DZI)
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
//! let tile_ids: Vec<EffectId> = update.tile_effects().iter().map(|effect| effect.id()).collect();
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
//!         finalize[0].id(),
//!         EffectResult::OutputCommitted {
//!             disposition: OutputDisposition::NativePublication,
//!         },
//!     )
//!     .expect("output committed");
//! assert_eq!(update.snapshot.lifecycle, JobState::Completed);
//! assert!(matches!(
//!     update.snapshot.terminal,
//!     Some(SnapshotTerminalDto::Completed)
//! ));
//! ```

use std::collections::HashMap;

use dezoomify_core::Vec2d;
use dezoomify_core::core::discovery::{FetchCause, FetchCode, TransportKind};
use dezoomify_core::core::model::{CatalogEntry, ProcessingRecipe as CoreProcessingRecipe};
use dezoomify_protocol::dto::{
    EngineSnapshotDto, ErrorDto as ProtocolErrorDto, ErrorPhase as ProtocolErrorPhase,
    FailureCategoryDto, JobState, MissingTileDto, OutputDispositionDto,
    OutputFormat as ProtocolOutputFormat, SizeDto as ProtocolSizeDto, SnapshotDecisionDto,
    SnapshotDeferredDto, SnapshotOutputDto, SnapshotProgressDto, SnapshotSelectionDto,
    SnapshotTerminalDto, TileFailureDto,
};

use crate::retry::TileFailure as InnerFailure;
use crate::{Config, Job, JobCommand as InnerCommand, JobEffect as InnerEffect, Outcome};
pub use dezoomify_protocol::dto::RecoveryChoice;

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
    /// First image, largest (last) level, no prompting.
    FirstImageLargestLevel,
}

/// Requested output encoding.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OutputFormat {
    /// PNG encoding.
    #[default]
    Png,
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
            max_concurrent_decodes: self.max_concurrent.clamp(1, 64),
            max_tiles: self.max_tiles,
            max_retries: self.max_retries,
            max_buffers: self.max_concurrent.max(16),
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

/// One request header the host sends with a tile fetch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeaderPair {
    /// Header name.
    pub name: String,
    /// Header value.
    pub value: String,
}

/// Pixel position of one tile's top-left corner in the output image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TilePosition {
    /// Pixels from the left edge.
    pub x: u32,
    /// Pixels from the top edge.
    pub y: u32,
}

/// Pixel extent of one tile or the output canvas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TileSize {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
}

fn tile_position_of(size: Vec2d) -> TilePosition {
    TilePosition {
        x: size.x,
        y: size.y,
    }
}

fn tile_size_of(size: Vec2d) -> TileSize {
    TileSize {
        width: size.x,
        height: size.y,
    }
}

/// One unit of work the host must carry out. Each effect completes exactly
/// once through `complete` (or `provide_metadata` for metadata bodies).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    /// Acquire one metadata resource.
    AcquireMetadata { id: EffectId, uri: String },
    /// Acquire and decode one tile, with the complete output placement the
    /// host needs at acquisition time (position, expected size, canvas,
    /// processing recipe), so acquisition and decode failures surface
    /// through the same tile outcome. Probe tiles observe geometry only
    /// (bytes stay with the host); a successful probe the plan reuses is
    /// marked `probe_output`.
    AcquireTile {
        id: EffectId,
        tile: u32,
        uri: String,
        headers: Vec<HeaderPair>,
        processing: CoreProcessingRecipe,
        destination: TilePosition,
        expected_size: Option<TileSize>,
        canvas: Option<TileSize>,
        probe: bool,
        probe_output: bool,
    },
    /// Wait before retrying one tile; the host reports the elapsed timer.
    WaitRetryTimer {
        id: EffectId,
        tile: u32,
        attempt: u32,
        delay_ms: u64,
    },
    /// Assemble, encode, and save or display the output exactly once.
    FinalizeOutput {
        id: EffectId,
        partial: bool,
        canvas: Option<TileSize>,
    },
    /// Ask the user what to do about missing tiles.
    RequestPartialDecision {
        id: EffectId,
        generation: u32,
        missing: Vec<u32>,
    },
    /// Release kept resources after cancellation or failure (idempotent).
    CancelRelease { id: EffectId },
}

impl Effect {
    /// Engine-minted correlation for this effect.
    #[must_use]
    pub const fn id(&self) -> EffectId {
        match *self {
            Self::AcquireMetadata { id, .. }
            | Self::AcquireTile { id, .. }
            | Self::WaitRetryTimer { id, .. }
            | Self::FinalizeOutput { id, .. }
            | Self::RequestPartialDecision { id, .. }
            | Self::CancelRelease { id, .. } => id,
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

/// Honest output disposition reported by the host that performed the save.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputDisposition {
    /// A native host published output files.
    NativePublication,
    /// A browser host initiated the save.
    BrowserSaveInitiated,
    /// A browser host has the output ready to save.
    BrowserSaveReady,
    /// Tiles were shown without readable bytes; no output exists.
    DisplayOnly,
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
    /// Kept resources released after cancellation or failure.
    CleanupAcknowledged,
}

/// Unit progress for the active phase (never moves backward; totals stay
/// unknown until the plan resolves).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    /// Work units finished.
    pub completed: u64,
    /// Work units known, when the plan declares a total.
    pub total: Option<u64>,
}

/// Current selection state (positions into the kept catalog).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    /// Chosen image position, once selected.
    pub image: Option<u32>,
    /// Chosen level position, once selected.
    pub level: Option<u32>,
    /// Selectable level positions for the chosen image.
    pub level_count: u32,
    /// The kept catalog with full geometry, once discovered. Replaced when
    /// a deferred catalog entry is followed within the same job.
    pub catalog: Option<dezoomify_protocol::dto::CatalogDto>,
    /// Still-deferred catalog entries: position plus follow-up URI. The
    /// host follows one within the same job; the entries are reported,
    /// never silently replaced by host-side recursion.
    pub deferred: Vec<DeferredEntry>,
}

/// One still-deferred catalog entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeferredEntry {
    /// Catalog position.
    pub position: u32,
    /// Follow-up URI to resolve within the same job.
    pub uri: String,
}

/// Outstanding partial decision payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecisionPayload {
    /// Outstanding decision generation.
    pub generation: u32,
    /// Tiles settled as missing, with full structured detail.
    pub missing: Vec<(u32, Vec<InnerFailure>)>,
}

/// Output summary: geometry, completeness, and the honest disposition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutputSummary {
    /// Declared canvas size in pixels, when the plan declares one.
    pub canvas: Option<(u32, u32)>,
    /// Requested encoding.
    pub format: OutputFormat,
    /// Whether the output covers every planned tile.
    pub complete: bool,
    /// Tiles missing from the output.
    pub missing: Vec<u32>,
    /// How the output was saved, once the host reports it.
    pub disposition: Option<OutputDisposition>,
}

/// Job projection: lifecycle, pause flag, progress, selection/decision
/// payload, terminal result, and output summary. No secrets, pixels,
/// paths, or handles cross here.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobSnapshot {
    /// Job-scoped revision, advanced once per accepted public transition.
    pub revision: u32,
    /// Observable lifecycle phase (canonical protocol vocabulary).
    pub lifecycle: JobState,
    /// Pause overlay: no new acquisitions while set.
    pub paused: bool,
    /// Acquisition progress.
    pub progress: Progress,
    /// Selection payload.
    pub selection: Selection,
    /// Outstanding partial decision, when one is awaited.
    pub decision: Option<DecisionPayload>,
    /// Terminal outcome, once finished (canonical protocol vocabulary).
    pub terminal: Option<SnapshotTerminalDto>,
    /// Output summary, once the plan declares geometry.
    pub output: Option<OutputSummary>,
}

/// Engine answer: newly issued effects plus the current snapshot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Update {
    /// Effects issued by this transition, in order.
    pub effects: Vec<Effect>,
    /// Current job projection.
    pub snapshot: JobSnapshot,
}

impl Update {
    /// Effects acquiring metadata.
    #[must_use]
    pub fn metadata_effects(&self) -> Vec<&Effect> {
        self.effects
            .iter()
            .filter(|effect| matches!(effect, Effect::AcquireMetadata { .. }))
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

/// Rejection with a stable code and message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineError {
    /// Stable namespaced code (never a display string).
    pub code: String,
    /// Human-readable detail.
    pub message: String,
}

impl EngineError {
    /// Stable rejection with a code and message.
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for EngineError {}

/// Option validation failure.
pub type ValidationError = EngineError;
/// User-command rejection.
pub type CommandError = EngineError;
/// Effect-completion rejection (unknown/stale effect, wrong result kind).
pub type CompletionError = EngineError;

/// Outstanding engine-minted effect awaiting its host completion.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Outstanding {
    Metadata { request: u32 },
    Tile { tile: u32 },
    Probe { tile: u32 },
    Timer { tile: u32, attempt: u32 },
    Finalize,
    Decision { generation: u32 },
    Cancel,
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
    /// Request URIs by outstanding effect id, so host failure context can
    /// name the request it came from without any adapter-side retention.
    effect_uris: HashMap<EffectId, String>,
    /// Host failure context behind the latest metadata failure, retained so
    /// the terminal `Failed` error and snapshot keep the observed facts
    /// (code, transport, HTTP status). Cleared when a catalog wins, exactly
    /// like the adapter-side retention it replaces.
    discovery_failure: Option<ProtocolErrorDto>,
    disposition: Option<OutputDisposition>,
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
                .any(|input| !crate::job::is_valid_input_url(&input.url))
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
        let inner_inputs: Vec<crate::JobInput> = options
            .inputs
            .iter()
            .map(|input| match input.contents.clone() {
                Some(bytes) => crate::JobInput::with_contents(input.url.clone(), bytes),
                None => crate::JobInput::new(input.url.clone()),
            })
            .collect();
        let mut inner = Job::new_with_inputs(inner_inputs, options.config())
            .map_err(|error| EngineError::new(&error.code, error.message))?;
        if let Some(name) = options.format.clone() {
            inner.set_format(Some(name));
        }
        let mut job = Self {
            inner,
            options,
            revision: 0,
            next_effect: 0,
            outstanding: HashMap::new(),
            effect_uris: HashMap::new(),
            discovery_failure: None,
            disposition: None,
        };
        job.inner
            .start()
            .map_err(|error| EngineError::new(&error.code, error.message))?;
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
        self.inner
            .on_command(inner)
            .map_err(|error| EngineError::new(&error.code, error.message))
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
        // Cleanup acknowledgements are accepted idempotently with no inner
        // input: the inner machine already rests terminal, so the ack only
        // refreshes the projection. Wrong-kind and validation rejections
        // leave the outstanding effect live so the host can still answer it
        // with the correct kind; only accepted completions settle it.
        if matches!(outstanding, Outstanding::Cancel)
            && matches!(result, EffectResult::CleanupAcknowledged)
        {
            self.outstanding.remove(&effect);
            self.effect_uris.remove(&effect);
            return self.drain();
        }
        let (inner, disposition) = self.translate_completion(effect, outstanding, result)?;
        let applied = match self.inner.on_command(inner) {
            Ok(Outcome::Ignored) => {
                // Late success/failure after the acquisition settled: the
                // effect was live when issued, so the completion is
                // accepted but changes nothing further.
                self.outstanding.remove(&effect);
                self.effect_uris.remove(&effect);
                false
            }
            Ok(Outcome::Applied) => {
                self.outstanding.remove(&effect);
                self.effect_uris.remove(&effect);
                // Publication is claimed only once the inner machine accepts
                // the finalize completion: rejected `OutputCommitted` answers
                // leave the disposition unset.
                if let Some(disposition) = disposition {
                    self.disposition = Some(disposition);
                }
                true
            }
            Err(error) => {
                return Err(EngineError::new(&error.code, error.message));
            }
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
        let Outstanding::Metadata { request } = outstanding else {
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
                self.effect_uris.remove(&effect);
                outcome
            }
            Err(error) => {
                self.outstanding.remove(&effect);
                self.effect_uris.remove(&effect);
                return Err(EngineError::new(&error.code, error.message));
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
    pub fn snapshot(&self) -> JobSnapshot {
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

    /// Project the canonical wire snapshot for the active job: the same
    /// fold every host renders. No new work is issued.
    #[must_use]
    pub fn project_dto(&self) -> dezoomify_protocol::dto::EngineSnapshotDto {
        EngineSnapshotDto::from(&self.snapshot())
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
    pub fn note_metadata_failure(&mut self, effect: EffectId, mut error: ProtocolErrorDto) {
        if !matches!(
            self.outstanding.get(&effect),
            Some(Outstanding::Metadata { .. })
        ) {
            return;
        }
        if let Some(uri) = self.effect_uris.get(&effect) {
            error.request = Some(uri.clone());
        }
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
                        outcome: dezoomify_protocol::dto::ProbeOutcome::Available {
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
                    outcome: dezoomify_protocol::dto::ProbeOutcome::Missing,
                },
                None,
            )),
            (Outstanding::Metadata { request }, EffectResult::MetadataFailed(failure)) => {
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
    /// auto selection rule the facade selects without prompting, and with
    /// a fail/keep partial policy it answers the decision in the same
    /// transition instead of surfacing it.
    fn apply_policies(&mut self, mut update: Update) -> Result<Update, EngineError> {
        if self.options.selection == SelectionPolicy::FirstImageLargestLevel {
            if update.snapshot.lifecycle == JobState::AwaitingImageSelection {
                self.apply_command_inner(UserCommand::SelectImage { image: 0 })?;
                update = self.drain()?;
            }
            if update.snapshot.lifecycle == JobState::AwaitingLevelSelection
                && update.snapshot.selection.level_count > 0
            {
                let level = update.snapshot.selection.level_count - 1;
                self.apply_command_inner(UserCommand::SelectLevel { level })?;
                update = self.drain()?;
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
                    update = self.drain()?;
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
                    update = self.drain()?;
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
            if let Some(effect) = self.project_effect(effect)? {
                effects.push(effect);
            }
        }
        if self.inner.state() == crate::State::AwaitingImageSelection
            && self.inner.catalog().is_some()
        {
            self.discovery_failure = None;
        }
        Ok(Update {
            effects,
            snapshot: self.project(),
        })
    }

    /// Project one inner effect onto a canonical effect with a fresh
    /// per-attempt ID. Returns `None` only for effects the canonical
    /// surface does not expose (none today: every effect projects).
    fn project_effect(&mut self, effect: InnerEffect) -> Result<Option<Effect>, EngineError> {
        let id = self.mint_effect()?;
        match effect {
            InnerEffect::AcquireResource { request, uri, .. } => {
                self.outstanding
                    .insert(id, Outstanding::Metadata { request });
                self.effect_uris.insert(id, uri.clone());
                Ok(Some(Effect::AcquireMetadata { id, uri }))
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
                let pairs: Vec<HeaderPair> = headers
                    .into_iter()
                    .map(|(name, value)| HeaderPair { name, value })
                    .collect();
                if probe {
                    self.outstanding.insert(id, Outstanding::Probe { tile });
                } else {
                    self.outstanding.insert(id, Outstanding::Tile { tile });
                }
                Ok(Some(Effect::AcquireTile {
                    id,
                    tile,
                    uri,
                    headers: pairs,
                    processing,
                    destination: tile_position_of(destination),
                    expected_size: expected_size.map(tile_size_of),
                    canvas: canvas.map(tile_size_of),
                    probe,
                    probe_output,
                }))
            }
            InnerEffect::FinalizeOutput {
                partial, canvas, ..
            } => {
                self.outstanding.insert(id, Outstanding::Finalize);
                Ok(Some(Effect::FinalizeOutput {
                    id,
                    partial,
                    canvas: canvas.map(tile_size_of),
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
                    id,
                    tile,
                    attempt,
                    delay_ms,
                }))
            }
            InnerEffect::CancelWork => {
                self.outstanding.insert(id, Outstanding::Cancel);
                Ok(Some(Effect::CancelRelease { id }))
            }
            InnerEffect::RequestDecision { generation } => {
                let missing = self
                    .inner
                    .missing_detail()
                    .iter()
                    .map(|(tile, _)| *tile)
                    .collect();
                self.outstanding
                    .insert(id, Outstanding::Decision { generation });
                Ok(Some(Effect::RequestPartialDecision {
                    id,
                    generation,
                    missing,
                }))
            }
        }
    }

    /// Project the current snapshot from inner state plus absorbed events.
    /// Lifecycle and terminal use the canonical protocol vocabulary
    /// directly: the inner machine already runs on it, so no mapping table
    /// exists here.
    fn project(&self) -> JobSnapshot {
        let lifecycle = match self.inner.state() {
            crate::State::Completed
            | crate::State::PartiallyCompleted
            | crate::State::Failed
            | crate::State::Cancelled => self.terminal_lifecycle(),
            state => state,
        };
        let (completed, total) = self.inner.acquisition_progress();
        let terminal = self.terminal();
        JobSnapshot {
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
                catalog: self.inner.catalog().map(crate::projection::project_catalog),
                deferred: self.inner.catalog().map_or_else(Vec::new, |catalog| {
                    catalog
                        .entries()
                        .iter()
                        .enumerate()
                        .filter_map(|(index, entry)| {
                            let CatalogEntry::Deferred(deferred) = entry else {
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
            decision: self
                .inner
                .pending_decision()
                .map(|generation| DecisionPayload {
                    generation,
                    missing: self.inner.missing_detail(),
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

    fn terminal(&self) -> Option<SnapshotTerminalDto> {
        match self.inner.terminal_kind() {
            Some("completed") => Some(SnapshotTerminalDto::Completed),
            Some("partial-completed") => Some(SnapshotTerminalDto::PartialCompleted {
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
                let mut error = ProtocolErrorDto::new(code, phase, message);
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
                Some(SnapshotTerminalDto::Failed { error })
            }
            Some("cancelled") => Some(SnapshotTerminalDto::Cancelled),
            _ => None,
        }
    }

    fn output_summary(&self) -> Option<OutputSummary> {
        let canvas = self.inner.canvas_size().map(|size| (size.x, size.y));
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

impl From<&JobSnapshot> for EngineSnapshotDto {
    /// Project one canonical snapshot onto the wire DTO. Single projector:
    /// every host renders identical state from the same snapshot. Lifecycle
    /// and terminal already use the protocol vocabulary, so both cross
    /// verbatim.
    fn from(snapshot: &JobSnapshot) -> Self {
        let output = snapshot.output.as_ref().and_then(|output| {
            let canvas = output.canvas.map(|(width, height)| ProtocolSizeDto {
                width: u64::from(width),
                height: u64::from(height),
            });
            if canvas.is_none() && snapshot.progress.total.unwrap_or(0) == 0 {
                return None;
            }
            Some(SnapshotOutputDto {
                canvas,
                format: ProtocolOutputFormat::Png,
                complete: output.complete,
                missing: output.missing.clone(),
                disposition: output.disposition.map(|disposition| match disposition {
                    OutputDisposition::NativePublication => OutputDispositionDto::NativePublication,
                    OutputDisposition::BrowserSaveInitiated => {
                        OutputDispositionDto::BrowserSaveInitiated
                    }
                    OutputDisposition::BrowserSaveReady => OutputDispositionDto::BrowserSaveReady,
                    OutputDisposition::DisplayOnly => OutputDispositionDto::DisplayOnly,
                }),
            })
        });
        EngineSnapshotDto {
            revision: snapshot.revision,
            lifecycle: snapshot.lifecycle,
            paused: snapshot.paused,
            progress: SnapshotProgressDto {
                completed: snapshot.progress.completed,
                total: snapshot.progress.total,
            },
            selection: SnapshotSelectionDto {
                image: snapshot.selection.image,
                level: snapshot.selection.level,
                level_count: snapshot.selection.level_count,
                catalog: snapshot.selection.catalog.clone(),
                deferred: snapshot
                    .selection
                    .deferred
                    .iter()
                    .map(|entry| SnapshotDeferredDto {
                        position: entry.position,
                        uri: entry.uri.clone(),
                    })
                    .collect(),
            },
            decision: snapshot
                .decision
                .as_ref()
                .map(|decision| SnapshotDecisionDto {
                    generation: decision.generation,
                    missing: decision
                        .missing
                        .iter()
                        .map(|(tile, failures)| MissingTileDto {
                            tile: *tile,
                            failures: failures
                                .iter()
                                .map(|failure| TileFailureDto {
                                    code: failure.code.clone(),
                                    category: match failure.category {
                                        crate::retry::FailureCategory::Permanent => {
                                            FailureCategoryDto::Permanent
                                        }
                                        crate::retry::FailureCategory::Transient => {
                                            FailureCategoryDto::Transient
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
            terminal: snapshot.terminal.clone(),
            output,
        }
    }
}
