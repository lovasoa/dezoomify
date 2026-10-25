//! Compile live viewer observations into the same grids used by format parsers.
//! Host-owned capabilities load tiles; Rust owns their placement and edge sizes.

use std::collections::HashSet;

use crate::Vec2d;
use crate::core::discovery::Metadata;
use crate::core::{
    DiscoveryError, DiscoveryResource, ImagePlan, ParsedResource, Request, ResolvedLevel,
};
use crate::model::{ViewerLevel, ViewerObservation};

impl Metadata for ViewerObservation {
    fn decode(self, _: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
        let pyramid = self.dezoomify_viewer;
        let base = url::Url::parse(&pyramid.resource_base).map_err(invalid)?;
        let source = url::Url::parse(&pyramid.source_url).map_err(invalid)?;
        let mut document = base.clone();
        document.set_fragment(source.fragment());
        if !matches!(source.scheme(), "http" | "https")
            || document != source
            || pyramid.resource_base.len() > 2048
            || !base.fragment().is_some_and(valid_capability)
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
                grid(&pyramid.resource_base, level)
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ParsedResource::CanonicalSource {
            uri: pyramid.source_url,
            parsed: Box::new(ParsedResource::Image(ImagePlan::new(None, levels))),
        })
    }
}

fn valid_capability(fragment: &str) -> bool {
    let mut parts = fragment.split('/');
    parts.next() == Some("dezoomify-viewer-tile")
        && parts.next().is_some_and(|token| {
            !token.is_empty()
                && token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
        && parts.next() == Some("image")
        && parts.next().is_none()
}

fn invalid(detail: impl std::fmt::Display) -> DiscoveryError {
    DiscoveryError::InvalidMetadata(detail.to_string())
}

fn grid(base: &str, level: ViewerLevel) -> Result<ResolvedLevel, DiscoveryError> {
    let base = base.to_owned();
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
            Request::new(format!(
                "{base}/{id}/{}/{}/{}/{}.png",
                tile.coord.column, tile.coord.row, tile.expected_size.x, tile.expected_size.y,
            ))
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
