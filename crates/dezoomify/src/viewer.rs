//! Compile live viewer observations into the same grids used by format parsers.
//! Host-owned capabilities load tiles; Rust owns their placement and edge sizes.

use std::collections::HashSet;

use crate::Vec2d;
use crate::core::discovery::{Metadata, json_metadata};
use crate::core::{
    DiscoveryError, DiscoveryResource, FormatSpec, ImagePlan, ParsedResource, ResolvedLevel,
};
use crate::model::{TileSource, ViewerLevel, ViewerObservation, ViewerTileRequest};

pub const SPEC: FormatSpec = FormatSpec::new("viewer", &[json_metadata::<ViewerObservation>()])
    .with_display_name("Page viewer");

impl Metadata for ViewerObservation {
    fn decode(self, _: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
        let pyramid = self.dezoomify_viewer;
        let source = url::Url::parse(&pyramid.source_url).map_err(invalid)?;
        if !matches!(source.scheme(), "http" | "https")
            || pyramid.source_url.len() > 2048
            || !valid_handle(&pyramid.handle)
            || pyramid.levels.is_empty()
            || pyramid.levels.len() > 64
        {
            return Err(invalid("invalid viewer source or level count"));
        }
        let mut ids = HashSet::new();
        let levels = pyramid
            .levels
            .into_iter()
            .map(|level| {
                if !ids.insert(level.level) {
                    return Err(invalid("duplicate viewer level"));
                }
                grid(&pyramid.handle, &pyramid.source_url, level)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ParsedResource::CanonicalSource {
            uri: pyramid.source_url,
            parsed: Box::new(ParsedResource::Image(ImagePlan::new(None, levels))),
        })
    }
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
