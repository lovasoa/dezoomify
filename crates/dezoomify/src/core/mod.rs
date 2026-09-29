//! Format discovery, image geometry, and tile planning.

pub mod adaptive;
pub mod discovery;
pub mod model;
pub mod processing;
pub mod registry;
pub mod tile_plan;
pub mod uri;

pub use adaptive::{AdaptiveSource, DiscoverableGrid, ObservationResult, ResolvedGrid};
pub use discovery::{
    CandidateDiagnostic, DiscoveryContext, DiscoveryError, DiscoveryMatch, DiscoveryResource,
    DiscoveryRoute, FormatSpec, ParsedResource, RejectionKind,
};
pub(crate) use model::floor_index;
pub use model::{
    CatalogPlan, DeferredResource, DiscoveredEntry, DiscoveryCatalog, ImagePlan, ProcessingRecipe,
    Request, ResolvedImage, ResolvedLevel, TileRole, TileSpec,
};
pub use processing::ProcessingError;
pub use registry::{Registry, builtin_names, default_registry, registry_for};
pub use tile_plan::{
    Grid, GridCoord, GridRequests, GridTile, Positioned, PositionedTile, TileSource,
    TileSourceError,
};
pub use uri::{image_title, origin_only, resolve_relative, resolve_url_template};
