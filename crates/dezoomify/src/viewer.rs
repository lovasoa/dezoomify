//! Compile live viewer observations into the same grids used by format parsers.
//! Host-owned capabilities load tiles; Rust owns their placement and edge sizes.

use std::collections::HashSet;

use crate::Vec2d;
use crate::core::{DiscoveryError, FormatSpec, ImagePlan, ParsedResource, ResolvedLevel};
use crate::model::{TileSource, ViewerLevel, ViewerPyramid, ViewerTileRequest};

/// Registered so `format=viewer` resolves and stays listed; typed observations
/// compile without document parsing, and no URL matches this format's routes.
pub const SPEC: FormatSpec = FormatSpec::new("viewer", &[]).with_display_name("Page viewer");

/// Compile one live-viewer pyramid into source grids. `source_url` names the
/// page the Host loaded the pyramid from; the Host resolves its handle for this
/// job only.
pub(crate) fn compile_pyramid(
    source_url: &str,
    pyramid: ViewerPyramid,
) -> Result<ParsedResource, DiscoveryError> {
    let ViewerPyramid { handle, levels } = pyramid;
    if !matches!(
        url::Url::parse(source_url).map_err(invalid)?.scheme(),
        "http" | "https"
    ) || source_url.len() > 2048
        || !valid_handle(&handle)
        || levels.is_empty()
        || levels.len() > 64
    {
        return Err(invalid("invalid viewer source or level count"));
    }
    let mut ids = HashSet::new();
    let levels = levels
        .into_iter()
        .map(|level| {
            if !ids.insert(level.level) {
                return Err(invalid("duplicate viewer level"));
            }
            grid(&handle, source_url, level)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ParsedResource::Image(ImagePlan::new(None, levels)))
}

fn valid_handle(handle: &str) -> bool {
    !handle.is_empty()
        && handle.len() <= 128
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn invalid(detail: impl std::fmt::Display) -> DiscoveryError {
    DiscoveryError::InvalidMetadata(detail.to_string())
}

fn grid(
    handle: &str,
    source_url: &str,
    level: ViewerLevel,
) -> Result<ResolvedLevel, DiscoveryError> {
    let handle = handle.to_owned();
    let source_url = source_url.to_owned();
    let id = level.level;
    let source = crate::core::Grid::with_requests(
        Vec2d {
            x: level.size.width,
            y: level.size.height,
        },
        Vec2d {
            x: level.tile_size.width,
            y: level.tile_size.height,
        },
        Vec2d {
            x: level.overlap.width,
            y: level.overlap.height,
        },
        move |tile| {
            TileSource::Viewer(ViewerTileRequest {
                handle: handle.clone(),
                source_url: source_url.clone(),
                level: id,
                column: tile.coord.column,
                row: tile.coord.row,
            })
        },
    )
    .map_err(invalid)?;
    if source.shape()
        != (Vec2d {
            x: level.grid_size.width,
            y: level.grid_size.height,
        })
    {
        return Err(invalid("viewer grid does not cover the declared image"));
    }
    Ok(ResolvedLevel::new(source))
}
