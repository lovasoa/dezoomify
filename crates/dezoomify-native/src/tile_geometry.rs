//! Pure placement, clipping, and grid-cell geometry in source pixels, with a
//! top-left origin. Tile writers own I/O and output coordinate transforms.
use dezoomify::model::{OutputGrid, ReusedTile, Size, TilePlacement};
use std::collections::BTreeMap;

/// Translate provisional probe identities to final plan order by placement.
/// Ordinary acquisition indices pass through unchanged.
pub(crate) struct TileOrder(BTreeMap<(u32, u32), u32>);

impl TileOrder {
    pub(crate) fn new(reused: &[ReusedTile]) -> Self {
        let mut positions = BTreeMap::new();
        for tile in reused {
            positions
                .entry((tile.position.x, tile.position.y))
                .or_insert(tile.index);
        }
        Self(positions)
    }

    pub(crate) fn index(&self, provisional: u32, x: u32, y: u32) -> u32 {
        self.0.get(&(x, y)).copied().unwrap_or(provisional)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}
impl Rect {
    pub(crate) fn intersects(self, other: Self) -> bool {
        self.x < other.x.saturating_add(other.w)
            && other.x < self.x.saturating_add(self.w)
            && self.y < other.y.saturating_add(other.h)
            && other.y < self.y.saturating_add(self.h)
    }
}

impl Rect {
    pub(crate) fn placed(placement: &TilePlacement, size: &Size, canvas: Option<&Size>) -> Self {
        let extent = placement.expected_size.as_ref().unwrap_or(size);
        let rect = Self {
            x: placement.position.x,
            y: placement.position.y,
            w: extent.width.min(size.width),
            h: extent.height.min(size.height),
        };
        canvas.map_or(rect, |canvas| rect.clipped(canvas))
    }

    pub(crate) fn clipped(mut self, canvas: &Size) -> Self {
        self.w = self.w.min(canvas.width.saturating_sub(self.x));
        self.h = self.h.min(canvas.height.saturating_sub(self.y));
        self
    }

    pub(crate) fn intersection(self, other: Self) -> Self {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        Self {
            x,
            y,
            w: self
                .x
                .saturating_add(self.w)
                .min(other.x.saturating_add(other.w))
                .saturating_sub(x),
            h: self
                .y
                .saturating_add(self.h)
                .min(other.y.saturating_add(other.h))
                .saturating_sub(y),
        }
    }

    /// Final row-major ordinal after probe remapping, independent of overlap.
    /// Canvas and cell dimensions must be positive.
    pub(crate) fn grid_cell(grid: &OutputGrid, canvas: &Size, index: u32) -> Self {
        let columns = canvas.width.div_ceil(grid.tile_size.width);
        Self {
            x: index % columns * grid.tile_size.width,
            y: index / columns * grid.tile_size.height,
            w: grid.tile_size.width,
            h: grid.tile_size.height,
        }
        .clipped(canvas)
    }
}
