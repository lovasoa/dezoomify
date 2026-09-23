//! Tile-source descriptions used by every zoom level.

use std::error::Error;
use std::fmt;
use std::sync::Arc;

use crate::Vec2d;

use super::adaptive::{AdaptiveSource, DiscoverableGrid, DiscoverableStep};
use super::model::{ProcessingRecipe, Request, TileRole, TileSpec};

pub(crate) type TileProgramCursor =
    Box<dyn Iterator<Item = Result<TileSpec, TileSourceError>> + Send>;

/// The single engine-facing start state for every built-in tile program.
///
/// Concrete source variants remain available as a compatibility facade, but
/// the job engine consumes only this contract. Resolved programs enumerate
/// lazily; observation-driven programs continue through `DiscoverableStep`.
pub(crate) enum TileProgramStart {
    Planned {
        tiles: TileProgramCursor,
        total: u64,
        canvas: Option<Vec2d>,
    },
    Discovering(DiscoverableStep),
}

/// Shared behavior implemented by every concrete tile program.
pub(crate) trait TileProgram: fmt::Debug + Send + Sync {
    fn kind_name(&self) -> &'static str;
    fn image_size(&self) -> Option<Vec2d>;
    fn tile_size(&self) -> Option<Vec2d>;
    fn overlap(&self) -> Option<Vec2d>;
    fn count(&self) -> Option<u64>;
    fn start(&self) -> TileProgramStart;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TileSourceError {
    ZeroImageDimensions,
    ZeroTileDimensions,
    ArithmeticOverflow,
    InvalidTile(String),
    InvalidDimensions,
}

impl fmt::Display for TileSourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroImageDimensions => f.write_str("image dimensions must be greater than zero"),
            Self::ZeroTileDimensions => f.write_str("tile dimensions must be greater than zero"),
            Self::ArithmeticOverflow => f.write_str("tile geometry overflowed u32"),
            Self::InvalidTile(message) => f.write_str(message),
            Self::InvalidDimensions => f.write_str("a tile has invalid dimensions"),
        }
    }
}

impl Error for TileSourceError {}

/// A meaningful coordinate in a grid's standardized row-major domain.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct GridCoord {
    pub column: u32,
    pub row: u32,
}

impl From<GridCoord> for Vec2d {
    fn from(value: GridCoord) -> Self {
        Self {
            x: value.column,
            y: value.row,
        }
    }
}

/// Geometry and identity of one cell in a validated grid.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GridTile {
    pub coord: GridCoord,
    pub row_major_ordinal: u64,
    pub image_size: Vec2d,
    pub cell_size: Vec2d,
    pub cell_extent: Vec2d,
    pub destination: Vec2d,
    pub expected_size: Vec2d,
}

/// Format-specific request behavior for a geometrically known grid.
pub trait GridRequests: fmt::Debug + Send + Sync {
    fn request(&self, tile: GridTile) -> Request;

    fn use_first_tile_as_referer(&self) -> bool {
        true
    }

    fn processing(&self) -> ProcessingRecipe {
        ProcessingRecipe::None
    }
}

struct ClosureRequests<F> {
    request: F,
    processing: ProcessingRecipe,
}

impl<F> fmt::Debug for ClosureRequests<F> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("request closure")
    }
}

impl<F: Fn(GridTile) -> Request + Send + Sync> GridRequests for ClosureRequests<F> {
    fn request(&self, tile: GridTile) -> Request {
        (self.request)(tile)
    }

    fn processing(&self) -> ProcessingRecipe {
        self.processing
    }
}

#[derive(Clone)]
pub struct Grid {
    image_size: Vec2d,
    tile_size: Vec2d,
    overlap: Vec2d,
    shape: Vec2d,
    count: u64,
    requests: Arc<dyn GridRequests>,
}

impl fmt::Debug for Grid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Grid")
            .field("image_size", &self.image_size)
            .field("tile_size", &self.tile_size)
            .field("overlap", &self.overlap)
            .field("shape", &self.shape)
            .field("count", &self.count)
            .field("requests", &self.requests)
            .finish()
    }
}

impl Grid {
    pub fn new(
        image_size: Vec2d,
        tile_size: Vec2d,
        overlap: Vec2d,
        requests: impl GridRequests + 'static,
    ) -> Result<Self, TileSourceError> {
        if image_size.x == 0 || image_size.y == 0 {
            return Err(TileSourceError::ZeroImageDimensions);
        }
        if tile_size.x == 0 || tile_size.y == 0 {
            return Err(TileSourceError::ZeroTileDimensions);
        }
        let shape = image_size.ceil_div(tile_size);
        let count = u64::from(shape.x)
            .checked_mul(u64::from(shape.y))
            .ok_or(TileSourceError::ArithmeticOverflow)?;
        // Validate every multiplication used by iteration up front.
        shape
            .x
            .saturating_sub(1)
            .checked_mul(tile_size.x)
            .ok_or(TileSourceError::ArithmeticOverflow)?;
        shape
            .y
            .saturating_sub(1)
            .checked_mul(tile_size.y)
            .ok_or(TileSourceError::ArithmeticOverflow)?;
        Ok(Self {
            image_size,
            tile_size,
            overlap,
            shape,
            count,
            requests: Arc::new(requests),
        })
    }

    pub fn with_requests(
        image_size: Vec2d,
        tile_size: Vec2d,
        overlap: Vec2d,
        requests: impl Fn(GridTile) -> Request + Send + Sync + 'static,
    ) -> Result<Self, TileSourceError> {
        Self::with_processed_requests(
            image_size,
            tile_size,
            overlap,
            ProcessingRecipe::None,
            requests,
        )
    }

    pub(crate) fn with_processed_requests(
        image_size: Vec2d,
        tile_size: Vec2d,
        overlap: Vec2d,
        processing: ProcessingRecipe,
        requests: impl Fn(GridTile) -> Request + Send + Sync + 'static,
    ) -> Result<Self, TileSourceError> {
        Self::new(
            image_size,
            tile_size,
            overlap,
            ClosureRequests {
                request: requests,
                processing,
            },
        )
    }

    #[must_use]
    pub const fn image_size(&self) -> Vec2d {
        self.image_size
    }

    #[must_use]
    pub const fn tile_size(&self) -> Vec2d {
        self.tile_size
    }

    #[must_use]
    pub const fn overlap(&self) -> Vec2d {
        self.overlap
    }

    #[must_use]
    pub const fn shape(&self) -> Vec2d {
        self.shape
    }

    #[must_use]
    pub const fn count(&self) -> u64 {
        self.count
    }

    /// Iterate tiles lazily in standardized row-major order.
    #[must_use]
    pub fn tiles_row_major(&self) -> GridTiles {
        GridTiles {
            grid: self.clone(),
            next: 0,
        }
    }

    fn grid_tile(&self, ordinal: u64) -> GridTile {
        let coord = GridCoord {
            column: u32::try_from(ordinal % u64::from(self.shape.x)).unwrap(),
            row: u32::try_from(ordinal / u64::from(self.shape.x)).unwrap(),
        };
        let origin = Vec2d {
            x: coord.column * self.tile_size.x,
            y: coord.row * self.tile_size.y,
        };
        let cell = self.tile_size.min(self.image_size - origin);
        let leading = Vec2d {
            x: self.overlap.x.min(origin.x),
            y: self.overlap.y.min(origin.y),
        };
        let remaining = self.image_size - origin - cell;
        let trailing = self.overlap.min(remaining);
        let destination = origin - leading;
        let expected_size = cell + leading + trailing;
        GridTile {
            coord,
            row_major_ordinal: ordinal,
            image_size: self.image_size,
            cell_size: self.tile_size,
            cell_extent: cell,
            destination,
            expected_size,
        }
    }

    fn tile(&self, ordinal: u64) -> Result<TileSpec, TileSourceError> {
        let tile = self.grid_tile(ordinal);
        let mut request = self.requests.request(tile);
        if self.requests.use_first_tile_as_referer() {
            // Legacy parity: Referer carries the full first-tile URI.
            // Redaction happens at the log/diagnostic boundary via
            // `redact_uri`, never by altering wire bytes.
            if request.header("Referer").is_none() {
                request =
                    request.with_header("Referer", self.requests.request(self.grid_tile(0)).uri);
            }
        }
        let ordinal = u32::try_from(ordinal).map_err(|_| TileSourceError::ArithmeticOverflow)?;
        Ok(TileSpec {
            ordinal,
            request,
            destination: tile.destination,
            expected_size: Some(tile.expected_size),
            processing: self.requests.processing(),
            role: TileRole::Output,
        })
    }
}

pub struct GridTiles {
    grid: Grid,
    next: u64,
}

impl Iterator for GridTiles {
    type Item = Result<TileSpec, TileSourceError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.next >= self.grid.count {
            return None;
        }
        let ordinal = self.next;
        self.next += 1;
        Some(self.grid.tile(ordinal))
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = usize::try_from(self.grid.count - self.next).unwrap_or(usize::MAX);
        (remaining, Some(remaining))
    }
}

pub(crate) trait PositionedGenerator: fmt::Debug + Send + Sync {
    fn count(&self) -> u64;
    fn tile(&self, ordinal: u64) -> Result<PositionedTile, TileSourceError>;
}

#[derive(Clone, Debug)]
pub struct PositionedTile {
    pub request: Request,
    pub destination: Vec2d,
    pub processing: ProcessingRecipe,
}

#[derive(Clone)]
pub struct Positioned {
    canvas_size: Option<Vec2d>,
    generator: Arc<dyn PositionedGenerator>,
}

impl fmt::Debug for Positioned {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Positioned")
            .field("canvas_size", &self.canvas_size)
            .field("count", &self.count())
            .finish_non_exhaustive()
    }
}

impl Positioned {
    pub(crate) fn from_generator(
        canvas_size: Option<Vec2d>,
        generator: impl PositionedGenerator + 'static,
    ) -> Self {
        Self {
            canvas_size,
            generator: Arc::new(generator),
        }
    }

    /// Keep grid placement, but leave decoded edge-tile sizes unspecified.
    /// Padded tiles must be cropped at the canvas edge instead of scaled.
    pub(crate) fn from_padded_grid(grid: Grid) -> Self {
        Self::from_generator(Some(grid.image_size()), PaddedGrid { grid })
    }

    #[must_use]
    pub const fn image_size(&self) -> Option<Vec2d> {
        self.canvas_size
    }

    #[must_use]
    pub fn count(&self) -> u64 {
        self.generator.count()
    }

    #[must_use]
    pub fn tiles(&self) -> PositionedTiles {
        PositionedTiles {
            source: self.clone(),
            next: 0,
        }
    }
}

#[derive(Debug)]
struct PaddedGrid {
    grid: Grid,
}

impl PositionedGenerator for PaddedGrid {
    fn count(&self) -> u64 {
        self.grid.count()
    }

    fn tile(&self, ordinal: u64) -> Result<PositionedTile, TileSourceError> {
        let tile = self.grid.grid_tile(ordinal);
        Ok(PositionedTile {
            request: self.grid.requests.request(tile),
            destination: tile.destination,
            processing: self.grid.requests.processing(),
        })
    }
}

pub struct PositionedTiles {
    source: Positioned,
    next: u64,
}

impl Iterator for PositionedTiles {
    type Item = Result<TileSpec, TileSourceError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.next >= self.source.count() {
            return None;
        }
        let ordinal = self.next;
        self.next += 1;
        Some(self.source.generator.tile(ordinal).and_then(|tile| {
            Ok(TileSpec {
                ordinal: u32::try_from(ordinal).map_err(|_| TileSourceError::ArithmeticOverflow)?,
                request: tile.request,
                destination: tile.destination,
                expected_size: None,
                processing: tile.processing,
                role: TileRole::Output,
            })
        }))
    }
}

impl TileProgram for Grid {
    fn kind_name(&self) -> &'static str {
        "grid"
    }

    fn image_size(&self) -> Option<Vec2d> {
        Some(self.image_size())
    }

    fn tile_size(&self) -> Option<Vec2d> {
        Some(self.tile_size())
    }

    fn overlap(&self) -> Option<Vec2d> {
        Some(self.overlap())
    }

    fn count(&self) -> Option<u64> {
        Some(self.count())
    }

    fn start(&self) -> TileProgramStart {
        TileProgramStart::Planned {
            tiles: Box::new(self.tiles_row_major()),
            total: self.count(),
            canvas: Some(self.image_size()),
        }
    }
}

impl TileProgram for Positioned {
    fn kind_name(&self) -> &'static str {
        "positioned"
    }

    fn image_size(&self) -> Option<Vec2d> {
        self.image_size()
    }

    fn tile_size(&self) -> Option<Vec2d> {
        None
    }

    fn overlap(&self) -> Option<Vec2d> {
        None
    }

    fn count(&self) -> Option<u64> {
        Some(self.count())
    }

    fn start(&self) -> TileProgramStart {
        TileProgramStart::Planned {
            tiles: Box::new(self.tiles()),
            total: self.count(),
            canvas: self.image_size(),
        }
    }
}

impl TileProgram for DiscoverableGrid {
    fn kind_name(&self) -> &'static str {
        "discoverable-grid"
    }

    fn image_size(&self) -> Option<Vec2d> {
        None
    }

    fn tile_size(&self) -> Option<Vec2d> {
        None
    }

    fn overlap(&self) -> Option<Vec2d> {
        None
    }

    fn count(&self) -> Option<u64> {
        None
    }

    fn start(&self) -> TileProgramStart {
        TileProgramStart::Discovering(self.clone().start())
    }
}

impl TileProgram for AdaptiveSource {
    fn kind_name(&self) -> &'static str {
        "adaptive"
    }

    fn image_size(&self) -> Option<Vec2d> {
        self.declared_grid().map(Grid::image_size)
    }

    fn tile_size(&self) -> Option<Vec2d> {
        self.declared_grid().map(Grid::tile_size)
    }

    fn overlap(&self) -> Option<Vec2d> {
        self.declared_grid().map(Grid::overlap)
    }

    fn count(&self) -> Option<u64> {
        self.declared_grid().map(Grid::count)
    }

    fn start(&self) -> TileProgramStart {
        TileProgramStart::Discovering(self.start())
    }
}

/// A format-owned program using the same contract as the shared sources.
#[derive(Clone, Debug)]
pub struct CustomTileSource(Arc<dyn TileProgram>);

impl CustomTileSource {
    pub(crate) fn new(program: impl TileProgram + 'static) -> Self {
        Self(Arc::new(program))
    }
}

#[derive(Clone, Debug)]
pub enum TileSource {
    Grid(Grid),
    Positioned(Positioned),
    Adaptive(AdaptiveSource),
    Custom(CustomTileSource),
}

impl TileSource {
    fn program(&self) -> &dyn TileProgram {
        match self {
            Self::Grid(program) => program,
            Self::Positioned(program) => program,
            Self::Adaptive(program) => program,
            Self::Custom(program) => program.0.as_ref(),
        }
    }

    pub(crate) fn custom(program: impl TileProgram + 'static) -> Self {
        Self::Custom(CustomTileSource::new(program))
    }

    pub(crate) fn start(&self) -> TileProgramStart {
        self.program().start()
    }

    /// Stable public source-kind vocabulary for catalog presentation.
    #[must_use]
    pub fn kind_name(&self) -> &'static str {
        self.program().kind_name()
    }

    #[must_use]
    pub fn image_size(&self) -> Option<Vec2d> {
        self.program().image_size()
    }

    #[must_use]
    pub fn tile_size(&self) -> Option<Vec2d> {
        self.program().tile_size()
    }

    #[must_use]
    pub fn overlap(&self) -> Option<Vec2d> {
        self.program().overlap()
    }

    #[must_use]
    pub fn count(&self) -> Option<u64> {
        self.program().count()
    }
}

impl From<Grid> for TileSource {
    fn from(value: Grid) -> Self {
        Self::Grid(value)
    }
}

impl From<Positioned> for TileSource {
    fn from(value: Positioned) -> Self {
        Self::Positioned(value)
    }
}

impl From<AdaptiveSource> for TileSource {
    fn from(value: AdaptiveSource) -> Self {
        Self::Adaptive(value)
    }
}

impl From<DiscoverableGrid> for TileSource {
    fn from(value: DiscoverableGrid) -> Self {
        Self::custom(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct OneTileProgram;

    impl TileProgram for OneTileProgram {
        fn kind_name(&self) -> &'static str {
            "toy"
        }

        fn image_size(&self) -> Option<Vec2d> {
            Some(Vec2d::square(2))
        }

        fn tile_size(&self) -> Option<Vec2d> {
            Some(Vec2d::square(2))
        }

        fn overlap(&self) -> Option<Vec2d> {
            Some(Vec2d::default())
        }

        fn count(&self) -> Option<u64> {
            Some(1)
        }

        fn start(&self) -> TileProgramStart {
            TileProgramStart::Planned {
                tiles: Box::new(std::iter::once(Ok(TileSpec {
                    ordinal: 0,
                    request: Request::new("memory://toy"),
                    destination: Vec2d::default(),
                    expected_size: Some(Vec2d::square(2)),
                    processing: ProcessingRecipe::None,
                    role: TileRole::Output,
                }))),
                total: 1,
                canvas: Some(Vec2d::square(2)),
            }
        }
    }

    #[test]
    fn format_owned_program_uses_the_shared_start_contract() {
        let source = TileSource::custom(OneTileProgram);
        assert_eq!(source.kind_name(), "toy");
        assert_eq!(source.image_size(), Some(Vec2d::square(2)));
        let TileProgramStart::Planned {
            mut tiles, total, ..
        } = source.start()
        else {
            panic!("toy program should be planned")
        };
        assert_eq!(total, 1);
        assert_eq!(tiles.next().unwrap().unwrap().request.uri, "memory://toy");
        assert!(tiles.next().is_none());
    }

    #[derive(Debug)]
    struct Requests;

    impl GridRequests for Requests {
        fn request(&self, tile: GridTile) -> Request {
            Request::new(format!("memory://{}/{}", tile.coord.column, tile.coord.row))
        }
    }

    fn grid(overlap: Vec2d) -> Grid {
        Grid::new(
            Vec2d { x: 5, y: 4 },
            Vec2d { x: 3, y: 2 },
            overlap,
            Requests,
        )
        .unwrap()
    }

    #[test]
    fn exact_count_and_row_major_coordinates() {
        let grid = grid(Vec2d::default());
        assert_eq!(grid.shape(), Vec2d { x: 2, y: 2 });
        assert_eq!(grid.count(), 4);
        let tiles: Vec<_> = grid.tiles_row_major().collect::<Result<_, _>>().unwrap();
        assert_eq!(tiles[0].request.uri, "memory://0/0");
        assert_eq!(tiles[1].request.uri, "memory://1/0");
        assert_eq!(tiles[2].request.uri, "memory://0/1");
        assert_eq!(tiles[3].expected_size, Some(Vec2d { x: 2, y: 2 }));
    }

    #[test]
    fn overlap_rectangles_are_clipped_at_image_edges() {
        let tiles: Vec<_> = grid(Vec2d { x: 1, y: 1 })
            .tiles_row_major()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(tiles[0].destination, Vec2d { x: 0, y: 0 });
        assert_eq!(tiles[0].expected_size, Some(Vec2d { x: 4, y: 3 }));
        assert_eq!(tiles[3].destination, Vec2d { x: 2, y: 1 });
        assert_eq!(tiles[3].expected_size, Some(Vec2d { x: 3, y: 3 }));
    }

    #[test]
    fn zero_geometry_is_rejected() {
        assert_eq!(
            Grid::new(
                Vec2d { x: 0, y: 1 },
                Vec2d::square(1),
                Vec2d::default(),
                Requests,
            )
            .unwrap_err(),
            TileSourceError::ZeroImageDimensions
        );
        assert_eq!(
            Grid::new(
                Vec2d::square(1),
                Vec2d { x: 0, y: 1 },
                Vec2d::default(),
                Requests,
            )
            .unwrap_err(),
            TileSourceError::ZeroTileDimensions
        );
    }
}
