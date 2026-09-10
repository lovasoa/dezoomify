//! Authoritative protocol v1 data transfer objects. Every wire type is
//! declared here exactly once; `generate.rs` projects this module into
//! TypeScript, JSON Schema, and capability manifests.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/// Protocol major version. Unknown majors are rejected before any work.
pub const PROTOCOL_MAJOR: u32 = 1;
/// Protocol minor version. Additive optional fields only.
pub const PROTOCOL_MINOR: u32 = 0;
/// Exact version marker carried by every control message.
pub const PROTOCOL_VERSION: &str = "1.0";

/// A negotiated version range `[min, max]` (inclusive, same major).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionRange {
    pub min: String,
    pub max: String,
}

impl VersionRange {
    #[must_use]
    pub fn v1() -> Self {
        Self {
            min: PROTOCOL_VERSION.to_string(),
            max: PROTOCOL_VERSION.to_string(),
        }
    }
}

/// Returns `Ok(())` for supported v1 versions, else a typed version error.
pub fn negotiate_version(requested: &str) -> Result<(), ErrorDto> {
    if requested == PROTOCOL_VERSION || requested == "1" {
        Ok(())
    } else {
        Err(ErrorDto::new(
            "protocol.incompatible",
            ErrorPhase::Handshake,
            format!(
                "unsupported protocol version {requested}; this host speaks {PROTOCOL_VERSION}"
            ),
        ))
    }
}

// ---------------------------------------------------------------------------
// Stable IDs (lossless in JavaScript: short validated strings)
// ---------------------------------------------------------------------------

macro_rules! id_type {
    ($name:ident, $prefix:literal, $scope:literal) => {
        #[doc = concat!("Stable `", $prefix, "` identifier. Scope: ", $scope, ".")]
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        pub struct $name(String);

        impl $name {
            #[must_use]
            pub fn new(value: impl Into<String>) -> Option<Self> {
                let value = value.into();
                let prefix = concat!($prefix, ":");
                if value.starts_with(prefix) && value.len() > prefix.len() && value.len() <= 128 {
                    Some(Self(value))
                } else {
                    None
                }
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl std::str::FromStr for $name {
            type Err = String;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::new(s).ok_or_else(|| format!("wrong id kind for {}", $prefix))
            }
        }
    };
}

id_type!(SessionId, "sess", "one WASM/job session; freed on dispose");
id_type!(ScanId, "scan", "one explicit extension scan generation");
id_type!(CandidateId, "cand", "one scan candidate within its scan");
id_type!(JobId, "job", "one end-to-end user request");
id_type!(
    OperationId,
    "op",
    "one core discovery operation within a job"
);
id_type!(
    RequestId,
    "req",
    "one protocol request awaiting correlation"
);
id_type!(ImageId, "img", "one catalog image within its catalog");
id_type!(LevelId, "lvl", "one level within its image");
id_type!(TileId, "tile", "one tile within its level");
id_type!(AttemptId, "att", "one fetch/decode attempt within its tile");
id_type!(
    EffectId,
    "fx",
    "one host effect awaiting exactly one response"
);
id_type!(
    BufferId,
    "buf",
    "one byte-buffer handle with generation scope"
);
id_type!(DestinationId, "dst", "one host-granted output destination");
id_type!(OutputId, "out", "one finalized output within its job");
id_type!(RecoveryId, "rec", "one recovery decision request");
id_type!(HandoffId, "hand", "one handoff envelope");

// ---------------------------------------------------------------------------
// Bounded integers (never `usize` on the wire)
// ---------------------------------------------------------------------------

/// Maximum coordinate/dimension/count on the wire (fits JS safe integers).
pub const MAX_DIMENSION: u64 = 1 << 30;
/// Maximum tiles/probes/retries/queue entries.
pub const MAX_COUNT: u64 = 1 << 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoundedU64(u64);

impl BoundedU64 {
    pub fn new(value: u64, max: u64) -> Result<Self, ErrorDto> {
        if value <= max {
            Ok(Self(value))
        } else {
            Err(ErrorDto::new(
                "protocol.out-of-range",
                ErrorPhase::Validation,
                format!("value {value} exceeds bound {max}"),
            ))
        }
    }

    #[must_use]
    pub fn get(self) -> u64 {
        self.0
    }
}

// ---------------------------------------------------------------------------
// Runtime limits, format grid, transports (one generation source for TS)
// ---------------------------------------------------------------------------

/// Largest browser-tab canvas area in pixels (16384 x 16384, legacy parity).
pub const MAX_BROWSER_AREA: u64 = 268_435_456;
/// Metadata proxy response cap in bytes (2 MiB, mirrors the server limit).
pub const PROXY_MAX_BYTES: u64 = 2_097_152;
/// Direct-first metadata head-start window in milliseconds.
pub const METADATA_WINDOW_MS: u64 = 1_500;

/// Active-transport labels (mirrors browser-runtime types.ts, verified by tests).
pub const DIRECT_TRANSPORT_LABEL: &str = "Direct from your browser";
pub const PROXY_TRANSPORT_LABEL: &str = "Metadata proxy";

/// Format grid in registry precedence order: (id, display name).
/// Mirrors `dezoomify-core/src/core/registry.rs` BUILTINS snapshot (18 entries).
pub const FORMAT_GRID: &[(&str, &str)] = &[
    ("custom", "Custom tiles"),
    ("google_arts_and_culture", "Arts & Culture"),
    ("zoomify", "Zoomify"),
    ("iiif", "IIIF"),
    ("deepzoom", "Seadragon (Deep Zoom Image)"),
    ("generic", "Generic dezoomer"),
    ("krpano", "krpano"),
    ("iipimage", "IIPImage"),
    ("xlimage", "XLimage"),
    ("topviewer", "TopViewer"),
    ("fsi", "FSI"),
    ("lizardtech", "LizardTech ImageServer"),
    ("vls", "VLS"),
    ("hungaricana", "Hungaricana"),
    ("wmts", "WMTS"),
    ("arcgis", "ArcGIS MapServer"),
    ("pnav", "pnav"),
    ("bulk_text", "Bulk text"),
];

/// Power-user format ids (subset of FORMAT_GRID, hidden by default).
pub const POWER_USER_FORMATS: &[&str] = &["custom", "bulk_text"];

// ---------------------------------------------------------------------------
// Requests and byte-buffer ownership
// ---------------------------------------------------------------------------

/// Purpose of a resource request (metadata vs tile vs probe).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestPurpose {
    Metadata,
    Tile,
    Probe,
}

/// One portable resource description. URI text is preserved exactly after
/// the core's approved normalization; secret headers are never carried here
/// (hosts attach scoped authorization out-of-band and redact logs).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestDto {
    pub id: RequestId,
    pub uri: String,
    #[serde(default)]
    pub headers: Vec<HeaderDto>,
    pub purpose: RequestPurpose,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeaderDto {
    pub name: String,
    pub value: String,
}

/// A position in the output image, in pixels from the top-left corner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PointDto {
    pub x: u64,
    pub y: u64,
}

/// A pixel size (output canvas or planned tile extent).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SizeDto {
    pub width: u64,
    pub height: u64,
}

/// Host-neutral placement of one tile in the output image, projected from
/// the core tile plan. `position` is the top-left output corner;
/// `expected_size` is the planned extent when the plan declares it (absent
/// when only decoding reveals the extent); `canvas` is the declared output
/// size when the plan declares one; `processing` is the stable recipe id
/// the host must apply to the acquired bytes before decoding. Native
/// assembly and browser canvas hosts consume the same values.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TilePlacementDto {
    pub position: PointDto,
    pub expected_size: Option<SizeDto>,
    pub canvas: Option<SizeDto>,
    pub processing: String,
}

/// Out-of-band byte buffer: JSON references the handle, never base64 bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BufferHandle {
    pub id: BufferId,
    pub generation: u32,
    pub length: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
}

/// Who owns a buffer now; stale reuse is a typed error, never use-after-free.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BufferState {
    Allocated,
    Committed,
    Consumed,
    Freed,
}

// ---------------------------------------------------------------------------
// Catalog and selection
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Readiness {
    Ready,
    Deferred,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelDto {
    pub id: LevelId,
    pub width: u64,
    pub height: u64,
    pub tile_width: u64,
    pub tile_height: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDto {
    pub id: ImageId,
    pub label: String,
    pub format: String,
    pub width: u64,
    pub height: u64,
    pub readiness: Readiness,
    pub source_kind: String,
    pub levels: Vec<LevelDto>,
}

/// Stable ordered catalog projection (never exposes private core enums).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogDto {
    pub images: Vec<ImageDto>,
}

// ---------------------------------------------------------------------------
// Scan DTOs
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartScan {
    pub scan: ScanId,
    pub tab_label: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CandidateDto {
    pub id: CandidateId,
    pub url: String,
    pub format_hint: String,
    pub confidence: u8,
    pub reason: String,
    pub dedup_key: String,
    pub source_frame: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanSnapshot {
    pub scan: ScanId,
    pub candidates: Vec<CandidateDto>,
    pub complete: bool,
}

// ---------------------------------------------------------------------------
// Extension source/job bindings
// ---------------------------------------------------------------------------

/// Browser-verified ownership for one extension job. `tab_id` and `frame_id`
/// are supplied by the browser message sender, never trusted from webpage
/// content. A navigation increments `document_generation`, invalidating all
/// source-context work associated with an earlier document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceBindingDto {
    pub job: JobId,
    pub tab_id: i64,
    pub frame_id: i64,
    pub document_generation: u32,
}

/// A bounded, acknowledged discovery delivery from a source-tab script.
/// Candidates are metadata only; response bytes use chunked transfer and are
/// never embedded in a control message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CandidateChunkDto {
    pub binding: SourceBindingDto,
    pub request: RequestId,
    pub candidates: Vec<CandidateDto>,
    pub complete: bool,
}

/// A source-context acquisition request. The coordinator routes this only to
/// the browser sender named by `binding`; page content never supplies a
/// binding or authorizes an origin itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceFetchRequestDto {
    pub binding: SourceBindingDto,
    pub request: RequestDto,
}

/// One bounded out-of-band byte chunk. `buffer` ownership follows the normal
/// buffer lifecycle and `sequence` is acknowledged before another chunk is
/// retained, providing backpressure across Chromium's JSON message boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ByteChunkDto {
    pub binding: SourceBindingDto,
    pub request: RequestId,
    pub sequence: u32,
    pub buffer: BufferHandle,
    pub final_chunk: bool,
}

/// Receiver acknowledgement for one `ByteChunkDto` sequence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkAcknowledgementDto {
    pub binding: SourceBindingDto,
    pub request: RequestId,
    pub sequence: u32,
}

/// Source-tab response state for one correlated request. These stable values
/// let a job retain independent extension transport while accurately reporting
/// loss of the source document or a required user grant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExtensionTransportOutcome {
    SourceDocumentLost,
    AccessRequired,
    RedirectUnavailable,
    Cancelled,
    Network,
    Throttled,
    Malformed,
    LimitExceeded,
    Disconnected,
}

// ---------------------------------------------------------------------------
// Job commands (shared UI/CLI -> job)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum JobCommand {
    Start {
        job: JobId,
        input_url: String,
    },
    ProvideResource {
        job: JobId,
        request: RequestId,
        buffer: BufferHandle,
    },
    ProvideFetchFailure {
        job: JobId,
        request: RequestId,
        error: ErrorDto,
    },
    SelectImage {
        job: JobId,
        image: ImageId,
    },
    SelectLevel {
        job: JobId,
        level: LevelId,
    },
    ProvideDecodeOutcome {
        job: JobId,
        tile: TileId,
        ok: bool,
    },
    ProvideProcessOutcome {
        job: JobId,
        tile: TileId,
        ok: bool,
    },
    ProvideWriteOutcome {
        job: JobId,
        tile: TileId,
        ok: bool,
    },
    ProvideEncodeOutcome {
        job: JobId,
        ok: bool,
    },
    ProvideFinalizeOutcome {
        job: JobId,
        output: OutputId,
        ok: bool,
    },
    ProvidePublicationOutcome {
        job: JobId,
        output: OutputId,
        ok: bool,
    },
    RetryReady {
        job: JobId,
        attempt: AttemptId,
    },
    PartialChoice {
        job: JobId,
        recovery: RecoveryId,
        keep_partial: bool,
    },
    DestinationResponse {
        job: JobId,
        destination: DestinationId,
        granted: bool,
    },
    Cancel {
        job: JobId,
    },
    Pause {
        job: JobId,
    },
    Resume {
        job: JobId,
    },
}

// ---------------------------------------------------------------------------
// Host effects (job -> host; every effect has correlation + one response)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum HostEffect {
    AcquireResource {
        effect: EffectId,
        job: JobId,
        request: RequestDto,
    },
    AcquireTile {
        effect: EffectId,
        job: JobId,
        request: RequestDto,
        /// Engine tile id correlating this acquisition with the later
        /// `decode-pixels` effect for the same tile.
        tile: TileId,
        /// Complete output placement for the acquired bytes (see
        /// [`TilePlacementDto`]). Hosts that assemble images read the
        /// placement here, at acquisition time, so acquisition failures and
        /// decode failures surface through the same tile outcome.
        placement: TilePlacementDto,
    },
    RequestDestination {
        effect: EffectId,
        job: JobId,
        format: String,
    },
    /// Decode (or verify the earlier acquisition-time decode of) one tile's
    /// pixels. Hosts that decode during acquisition (the native and browser
    /// model) find their decoded tile already held and treat this effect as
    /// the draw/hold checkpoint; tile bytes never cross the effect.
    DecodePixels {
        effect: EffectId,
        job: JobId,
        tile: TileId,
    },
    ProcessPixels {
        effect: EffectId,
        job: JobId,
        tile: TileId,
    },
    /// Allocate the output surface. `canvas` declares the output size when
    /// the plan knows it; hosts without a declared size derive it from the
    /// accumulated placements. `format` is the output codec id.
    OpenEncoder {
        effect: EffectId,
        job: JobId,
        format: String,
        canvas: Option<SizeDto>,
    },
    WriteOutput {
        effect: EffectId,
        job: JobId,
        tile: TileId,
    },
    FinalizeEncoder {
        effect: EffectId,
        job: JobId,
    },
    PublishOutput {
        effect: EffectId,
        job: JobId,
        output: OutputId,
    },
    /// Release every per-tile resource this host retained for the job
    /// (decoded bitmaps, surfaces, buffers). The adapter frees its own
    /// arena bytes when the tile outcome settles, so no buffer reference
    /// accompanies this effect.
    ReleaseBytes {
        effect: EffectId,
        job: JobId,
    },
    CancelWork {
        effect: EffectId,
        job: JobId,
    },
    RequestDecision {
        effect: EffectId,
        job: JobId,
        recovery: RecoveryId,
    },
}

// ---------------------------------------------------------------------------
// Events (job -> UI; absolute snapshots, terminal exactly once)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EventKind {
    Replayable,
    Transient,
    DecisionRequesting,
    Terminal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum JobEvent {
    ScanSnapshot {
        job: JobId,
        snapshot: ScanSnapshot,
    },
    JobState {
        job: JobId,
        state: String,
    },
    Catalog {
        job: JobId,
        catalog: CatalogDto,
    },
    Progress {
        job: JobId,
        acquired: u64,
        total: u64,
    },
    Warning {
        job: JobId,
        error: ErrorDto,
    },
    RecoveryRequest {
        job: JobId,
        recovery: RecoveryId,
        actions: Vec<RecoveryAction>,
    },
    OutputReady {
        job: JobId,
        output: OutputId,
    },
    Completed {
        job: JobId,
        output: OutputId,
    },
    PartialCompleted {
        job: JobId,
        output: OutputId,
    },
    Failed {
        job: JobId,
        error: ErrorDto,
    },
    Cancelled {
        job: JobId,
    },
    Paused {
        job: JobId,
    },
    Resumed {
        job: JobId,
    },
}

impl JobEvent {
    #[must_use]
    pub fn kind(&self) -> EventKind {
        match self {
            Self::ScanSnapshot { .. }
            | Self::JobState { .. }
            | Self::Catalog { .. }
            | Self::Progress { .. }
            | Self::OutputReady { .. }
            | Self::Paused { .. }
            | Self::Resumed { .. } => EventKind::Replayable,
            Self::Warning { .. } => EventKind::Transient,
            Self::RecoveryRequest { .. } => EventKind::DecisionRequesting,
            Self::Completed { .. }
            | Self::PartialCompleted { .. }
            | Self::Failed { .. }
            | Self::Cancelled { .. } => EventKind::Terminal,
        }
    }

    #[must_use]
    pub fn is_terminal(&self) -> bool {
        self.kind() == EventKind::Terminal
    }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilitiesDto {
    pub input_schemes: Vec<String>,
    pub fetch_modes: Vec<String>,
    pub decoders: Vec<String>,
    pub processing_ops: Vec<String>,
    pub encoders: Vec<String>,
    pub destination_modes: Vec<String>,
    pub storage_modes: Vec<String>,
    pub max_concurrency: u64,
    pub max_tile_bytes: u64,
    #[serde(default)]
    pub bulk_supported: bool,
    #[serde(default = "default_handoff_supported")]
    pub handoff_supported: bool,
    /// Pause v1 (suspend-acquisition): the job stops scheduling new tiles,
    /// finishes in-flight work, retains decoded output, and resumes on
    /// command. Missing (N-1) defaults to false, disabling pause controls
    /// without breaking the 1.0 handshake.
    #[serde(default)]
    pub paused_supported: bool,
}

fn default_handoff_supported() -> bool {
    true
}

impl CapabilitiesDto {
    /// Website baseline: 6 concurrent tile workers with per-host 5/s pacing.
    /// The shared UI gates controls from this declaration and the job engine
    /// re-validates the final request, so checks are never UI-only.
    ///
    /// Todo 5.3: the website runs a single-queue (enqueue while a job runs,
    /// sequential) in its integration layer, so `bulk_supported` is true.
    /// The engine stays single-job; the queue never runs concurrent jobs.
    ///
    /// Todo 5.7: Pause v1 (suspend-acquisition) is supported, so
    /// `paused_supported` is true. The website pauses tile scheduling in its
    /// integration layer; the engine pauses new `acquire-tile` effects.
    #[must_use]
    pub fn browser_baseline() -> Self {
        Self {
            input_schemes: vec!["https".into(), "http".into()],
            fetch_modes: vec!["direct".into(), "ordinary-image-display".into()],
            decoders: vec!["png".into(), "jpeg".into()],
            processing_ops: vec!["composite".into()],
            encoders: vec!["png".into()],
            destination_modes: vec!["save".into()],
            storage_modes: vec!["none".into()],
            max_concurrency: 6,
            max_tile_bytes: 8 << 20,
            bulk_supported: true,
            handoff_supported: true,
            paused_supported: true,
        }
    }

    /// Honest native baseline: PNG, JPEG, TIFF, ZIF, and WebP output to a
    /// single file plus static `iiif-dir` tile trees, with an optional tile resume cache
    /// and a sequential bulk queue. Deferred bulk-text entries resolve one at
    /// a time through fresh bounded jobs. Handoff import is supported. Wave 2
    /// widens these fields only alongside the matching pipeline, encoder,
    /// cache, and bulk-runner implementation.
    ///
    /// Todo 5.3: the desktop integration runs a sequential multi-job queue
    /// (enqueue, progress per job, cancel one/all, retry failed) over the
    /// single-job engine, so `bulk_supported` is true. The CLI `--bulk` loop
    /// keeps its one-bounded-run-per-entry shape and shares the same
    /// per-entry plus totals reporting.
    ///
    /// Todo 5.7: Pause v1 (suspend-acquisition) is supported, so
    /// `paused_supported` is true. The engine stops scheduling new tiles
    /// while paused; resume re-drives the pending queue.
    #[must_use]
    pub fn native_baseline() -> Self {
        Self {
            fetch_modes: vec!["native".into()],
            decoders: vec!["png".into(), "jpeg".into(), "tiff".into()],
            encoders: vec![
                "png".into(),
                "jpeg".into(),
                "tiff".into(),
                "zif".into(),
                "webp".into(),
            ],
            destination_modes: vec!["file".into(), "iiif-dir".into()],
            storage_modes: vec!["cache".into()],
            max_concurrency: 16,
            bulk_supported: true,
            handoff_supported: true,
            paused_supported: true,
            ..Self::browser_baseline()
        }
    }

    /// Whether this host offers a queue over the single-job engine.
    ///
    /// The shared UI gates queue controls from this declaration; the job
    /// engine still validates each queued request on its own. Branch on this
    /// helper (stable capability), never on display strings.
    #[must_use]
    pub fn supports_bulk_queue(&self) -> bool {
        self.bulk_supported
    }

    /// Negotiated bulk availability for a connection: both peers must support
    /// the queue. An N-1 peer advertising `bulk_supported: false` (or omitting
    /// the field, which defaults to false) disables queue controls without
    /// breaking the version handshake.
    #[must_use]
    pub fn negotiated_bulk(local: &Self, remote: &Self) -> bool {
        local.bulk_supported && remote.bulk_supported
    }

    /// Whether this host supports Pause v1 (suspend-acquisition).
    ///
    /// The shared UI gates pause controls from this declaration; the job
    /// engine still validates each pause/resume on its own. Branch on this
    /// helper (stable capability), never on display strings.
    #[must_use]
    pub fn supports_pause(&self) -> bool {
        self.paused_supported
    }

    /// Negotiated pause availability for a connection: both peers must
    /// support it. An N-1 peer advertising `paused_supported: false` (or
    /// omitting the field, which defaults to false) disables pause controls
    /// without breaking the version handshake.
    #[must_use]
    pub fn negotiated_pause(local: &Self, remote: &Self) -> bool {
        local.paused_supported && remote.paused_supported
    }

    /// Stable capability keys for manifests and negotiation.
    #[must_use]
    pub fn keys(&self) -> Vec<String> {
        vec![
            "fetch_modes".into(),
            "decoders".into(),
            "encoders".into(),
            "bulk".into(),
            "handoff".into(),
            "pause".into(),
        ]
    }
}

// ---------------------------------------------------------------------------
// Handoff (untrusted, non-secret, unsigned input)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffDto {
    pub id: HandoffId,
    pub source_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<CandidateId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<ImageId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_intent: Option<String>,
    pub required_capabilities: Vec<String>,
    pub provenance_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expiry_hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opaque_ref: Option<String>,
}

impl HandoffDto {
    /// Reject secrets, credentials, local paths, and signature claims.
    pub fn validate(&self) -> Result<(), ErrorDto> {
        for field in [
            self.source_url.as_str(),
            self.opaque_ref.as_deref().unwrap_or(""),
        ] {
            let lower = field.to_ascii_lowercase();
            if field.contains('@') && field.contains(':') && field.contains("://") {
                return Err(ErrorDto::new(
                    "handoff.rejected",
                    ErrorPhase::Validation,
                    "handoff must not carry userinfo credentials",
                ));
            }
            for needle in [
                "cookie",
                "set-cookie",
                "authorization",
                "bearer",
                "signature",
                "token",
                "access_token",
                "access-token",
                "apikey",
                "api-key",
                "api_key",
                "x-api-key",
                "secret",
                "password",
                "session",
                "file://",
                "/etc/",
                "c:\\",
            ] {
                if lower.contains(needle) {
                    return Err(ErrorDto::new(
                        "handoff.rejected",
                        ErrorPhase::Validation,
                        format!("handoff field contains forbidden token {needle}"),
                    ));
                }
            }
        }
        if self.source_url.len() > 2048 {
            return Err(ErrorDto::new(
                "handoff.rejected",
                ErrorPhase::Validation,
                "handoff source_url exceeds 2048 bytes",
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DestinationDto {
    pub id: DestinationId,
    pub format: String,
    pub width: u64,
    pub height: u64,
    pub partial_allowed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputDto {
    pub id: OutputId,
    pub destination: DestinationId,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    pub partial: bool,
}

// ---------------------------------------------------------------------------
// Recovery (typed actions, never message parsing)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryKind {
    Retry,
    EditInput,
    ChooseOutput,
    GrantPermission,
    ChangeTransport,
    KeepPartial,
    DiscardPartial,
    HandoffToNative,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryAction {
    pub id: String,
    pub kind: RecoveryKind,
    pub scope: String,
    pub rationale: String,
}

// ---------------------------------------------------------------------------
// Errors (stable codes + safe structured context for specific UI guidance)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorPhase {
    Handshake,
    Validation,
    Discovery,
    Acquisition,
    Decode,
    Processing,
    Output,
    Publication,
    Cleanup,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorDto {
    pub code: String,
    pub phase: ErrorPhase,
    pub retryable: bool,
    pub message: String,
    #[serde(default)]
    pub recovery: Vec<RecoveryAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_kind: Option<String>,
}

impl ErrorDto {
    #[must_use]
    pub fn new(code: impl Into<String>, phase: ErrorPhase, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            phase,
            retryable: false,
            message: message.into(),
            recovery: Vec::new(),
            request: None,
            transport: None,
            blocked_reason: None,
            resource_kind: None,
        }
    }

    #[must_use]
    pub fn with_transport(mut self, transport: impl Into<String>) -> Self {
        self.transport = Some(transport.into());
        self
    }

    #[must_use]
    pub fn with_resource(mut self, kind: impl Into<String>) -> Self {
        self.resource_kind = Some(kind.into());
        self
    }
}

/// Redact credential-bearing text from error display strings
/// (case-insensitive key match).
#[must_use]
pub fn redact_error_text(input: &str) -> String {
    let mut out = input.to_string();
    for needle in [
        "apikey=",
        "api-key=",
        "api_key=",
        "x-api-key",
        "access_token=",
        "access-token=",
        "token=",
        "bearer",
        "session=",
        "cookie=",
        "set-cookie",
        "authorization:",
        "auth=",
        "secret=",
        "password=",
    ] {
        let mut search_from = 0;
        loop {
            let window = out[search_from..].to_ascii_lowercase();
            let Some(rel) = window.find(needle) else {
                break;
            };
            let pos = search_from + rel;
            let end = out[pos..]
                .find(['&', ' ', '"', '\''])
                .map_or(out.len(), |e| pos + e);
            out.replace_range(pos + needle.len()..end, "REDACTED");
            search_from = pos + needle.len() + "REDACTED".len();
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Top-level control envelope (one stable externally tagged representation)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlEnvelope {
    pub protocol: String,
    #[serde(flatten)]
    pub body: ControlBody,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ControlBody {
    Command(JobCommand),
    Effect(HostEffect),
    Event(JobEvent),
    Scan(ScanSnapshot),
    Handoff(HandoffDto),
    Error(ErrorDto),
}

impl ControlEnvelope {
    pub fn new(body: ControlBody) -> Result<Self, ErrorDto> {
        Ok(Self {
            protocol: PROTOCOL_VERSION.to_string(),
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_json_matches_the_generated_typescript_field_names() {
        let catalog = CatalogDto {
            images: vec![ImageDto {
                id: "img:test".parse().expect("image id"),
                label: "Test".into(),
                format: "test".into(),
                width: 512,
                height: 512,
                readiness: Readiness::Ready,
                source_kind: "grid".into(),
                levels: vec![LevelDto {
                    id: "lvl:test".parse().expect("level id"),
                    width: 512,
                    height: 512,
                    tile_width: 256,
                    tile_height: 256,
                }],
            }],
        };
        let value = serde_json::to_value(catalog).expect("catalog serializes");
        assert_eq!(value["images"][0]["sourceKind"], "grid");
        assert_eq!(value["images"][0]["levels"][0]["tileWidth"], 256);
        assert!(value["images"][0].get("source_kind").is_none());
        assert!(value["images"][0]["levels"][0].get("tile_width").is_none());
    }
}
