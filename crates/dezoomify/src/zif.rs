//! ZIF pyramids: pure incremental metadata parsing and ranged encoded tiles.

use std::sync::Arc;

use zif_tiff::{DataChunk, ParseState, Parser};

use crate::Vec2d;
use crate::core::discovery::{
    DiscoveryError, DiscoveryResource, FormatSpec, ParsedResource, metadata, url_matches,
};
use crate::core::{ImagePlan, Request, ResolvedLevel};

pub const SPEC: FormatSpec = FormatSpec::new(
    "zif",
    &[metadata(url_matches(is_zif))
        .resolve_metadata(initial_request)
        .then_decode(decode)],
)
.with_display_name("ZIF");

// Large indexes are read incrementally, within every product's metadata cap.
const METADATA_CHUNK_BYTES: u64 = 1024 * 1024;

pub(crate) fn is_zif(uri: &str) -> bool {
    uri.split(['?', '#'])
        .next()
        .unwrap_or(uri)
        .to_ascii_lowercase()
        .ends_with(".zif")
}

fn invalid(error: impl std::fmt::Display) -> DiscoveryError {
    DiscoveryError::InvalidMetadata(format!("ZIF: {error}"))
}

fn ranged(uri: &str, range: std::ops::Range<u64>) -> Result<Request, DiscoveryError> {
    if range.is_empty() {
        return Err(invalid("empty byte range"));
    }
    let end = range
        .end
        .min(range.start.saturating_add(METADATA_CHUNK_BYTES));
    Ok(Request::new(uri).with_header("Range", format!("bytes={}-{}", range.start, end - 1)))
}

fn initial_request(uri: &str) -> Result<Request, DiscoveryError> {
    ranged(uri, 0..16)
}

pub(crate) fn follow(
    resource: DiscoveryResource<'_>,
    reference: &str,
) -> Result<ParsedResource, DiscoveryError> {
    let ParsedResource::Follow(request) = resource.follow_relative(reference) else {
        unreachable!("relative references produce requests")
    };
    Ok(ParsedResource::FollowWith(
        initial_request(&request.uri)?,
        decode,
    ))
}

fn chunk(resource: DiscoveryResource<'_>) -> Result<Option<DataChunk>, DiscoveryError> {
    let Some(range) = resource
        .request()
        .and_then(|request| request.header("range"))
    else {
        return Ok(None);
    };
    let (start, end) = range
        .strip_prefix("bytes=")
        .and_then(|value| value.split_once('-'))
        .ok_or_else(|| invalid("invalid metadata range"))?;
    let start = start.parse::<u64>().map_err(invalid)?;
    let end = end.parse::<u64>().map_err(invalid)?;
    let end = end
        .checked_add(1)
        .ok_or_else(|| invalid("range overflow"))?;
    DataChunk::new(start..end, resource.bytes().to_vec())
        .map(Some)
        .map_err(invalid)
}

fn decode(resource: DiscoveryResource<'_>) -> Result<ParsedResource, DiscoveryError> {
    let mut parser = Parser::new();
    let mut covered = Vec::new();
    // Decoder functions remain pure: prior bounded reads carry the state needed
    // to reconstruct the parser, without owning Host tasks or mutable globals.
    for previous in resource.context().resources() {
        if previous.final_uri() == resource.final_uri()
            && let Some(chunk) = chunk(previous)?
        {
            covered.push(chunk.range());
            parser.feed(chunk).map_err(invalid)?;
        }
    }
    let current = chunk(resource)?.ok_or_else(|| invalid("missing metadata range"))?;
    covered.push(current.range());
    match parser.feed(current).map_err(invalid)? {
        ParseState::Need { range, .. } => Ok(ParsedResource::FollowIntermediate(
            ranged(resource.final_uri(), missing_range(range.range(), covered)?)?,
            decode,
        )),
        ParseState::Done { .. } => {
            image_plan(resource.final_uri(), parser.finish().map_err(invalid)?)
        }
    }
}

fn missing_range(
    mut needed: std::ops::Range<u64>,
    mut covered: Vec<std::ops::Range<u64>>,
) -> Result<std::ops::Range<u64>, DiscoveryError> {
    // The library requests a whole array until its cached chunks cover it.
    // Advance past the supplied prefix before applying our per-read bound.
    covered.sort_unstable_by_key(|range| range.start);
    for range in covered {
        if range.end <= needed.start {
            continue;
        }
        if range.start > needed.start {
            needed.end = needed.end.min(range.start);
            break;
        }
        needed.start = needed.start.max(range.end);
        if needed.is_empty() {
            return Err(invalid("parser requested bytes already supplied"));
        }
    }
    Ok(needed)
}

fn image_plan(uri: &str, image: zif_tiff::Image) -> Result<ParsedResource, DiscoveryError> {
    if !image.levels().windows(2).all(|pair| {
        let (w, h) = pair[0].dimensions();
        let (next_w, next_h) = pair[1].dimensions();
        (next_w < w || next_h < h)
            && [(w / 2).max(1), w.div_ceil(2)].contains(&next_w)
            && [(h / 2).max(1), h.div_ceil(2)].contains(&next_h)
    }) {
        return Err(invalid("directory chain is not an image pyramid"));
    }
    let image = Arc::new(image);
    let mut levels = Vec::new();
    for (index, level) in image.levels().iter().enumerate() {
        if !matches!(level.codec(), zif_tiff::Codec::Jpeg | zif_tiff::Codec::Png) {
            return Err(invalid("unsupported tile codec"));
        }
        let size = |(x, y)| -> Result<Vec2d, DiscoveryError> {
            Ok(Vec2d {
                x: u32::try_from(x).map_err(invalid)?,
                y: u32::try_from(y).map_err(invalid)?,
            })
        };
        // A partially written ZIF may have empty tile slots. It cannot produce
        // a complete output, and must never turn into an invalid HTTP range.
        if image
            .level_tiles(index)
            .map_err(invalid)?
            .any(|tile| tile.byte_range().is_empty())
        {
            return Err(invalid("pyramid contains an empty tile"));
        }
        let source = Arc::clone(&image);
        let uri = uri.to_owned();
        levels.push(ResolvedLevel::grid(
            size(level.dimensions())?,
            size(level.tile_size())?,
            move |tile| {
                let range = source
                    .level(index)
                    .unwrap()
                    .tile(u64::from(tile.coord.column), u64::from(tile.coord.row))
                    .unwrap()
                    .byte_range();
                Request::new(&uri)
                    .with_header("Range", format!("bytes={}-{}", range.start, range.end - 1))
            },
        )?);
    }
    Ok(ParsedResource::Image(ImagePlan::new(None, levels)))
}
