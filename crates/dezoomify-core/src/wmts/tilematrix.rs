//! WMTS tile-matrix sets, bounds, and CRS math.
//!
//! Split from `wmts/mod.rs` (todo 4.1): this module owns `TileMatrixSet`
//! parsing plus Web Mercator projection. Layer wiring lives in `layer`,
//! XML tree parsing in `capabilities`.

use super::capabilities::XmlElement;
use super::capabilities::{required_text, same_name};
use crate::Vec2d;
use crate::core::DiscoveryError;

pub(crate) const RADIUS: f64 = 6_378_137.0;
pub(crate) const HALF_SIZE: f64 = std::f64::consts::PI * RADIUS;
pub(crate) const METRES_PER_PIXEL: f64 = 0.28e-3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CoordinateReference {
    Geographic,
    WebMercator,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Bounds {
    pub(crate) left: f64,
    pub(crate) bottom: f64,
    pub(crate) right: f64,
    pub(crate) top: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct MatrixLimit {
    pub(crate) matrix: String,
    pub(crate) minimum_column: u32,
    pub(crate) maximum_column: u32,
    pub(crate) minimum_row: u32,
    pub(crate) maximum_row: u32,
}

#[derive(Clone, Debug)]
pub(crate) struct TileMatrix {
    pub(crate) identifier: String,
    pub(crate) scale_denominator: f64,
    pub(crate) top_left: (f64, f64),
    pub(crate) tile_size: Vec2d,
    pub(crate) matrix_size: Vec2d,
}

#[derive(Debug)]
pub(crate) struct MatrixSet {
    pub(crate) identifier: String,
    pub(crate) matrices: Vec<TileMatrix>,
}

#[derive(Debug)]
pub(crate) struct MatrixSetLink {
    pub(crate) matrix_set: String,
    pub(crate) limits: Vec<MatrixLimit>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct LayerBounds {
    pub(crate) reference: CoordinateReference,
    pub(crate) lower: (f64, f64),
    pub(crate) upper: (f64, f64),
}

pub(crate) fn parse_matrix_set(element: &XmlElement) -> Result<MatrixSet, DiscoveryError> {
    let identifier = required_text(element, "Identifier", "matrix set identifier")?;
    let supported_crs = required_text(element, "SupportedCRS", "matrix set CRS")?;
    let reference = coordinate_reference(&supported_crs).ok_or_else(|| {
        DiscoveryError::Session(format!(
            "unsupported WMTS coordinate reference system: {supported_crs}"
        ))
    })?;
    if reference != CoordinateReference::WebMercator {
        return Err(DiscoveryError::Session(
            "WMTS tile matrix set is not Web Mercator".into(),
        ));
    }
    let matrices = element
        .children_named("TileMatrix")
        .map(parse_matrix)
        .collect::<Result<Vec<_>, _>>()?;
    if matrices.is_empty() {
        return Err(DiscoveryError::Session(
            "WMTS tile matrix set has no tile matrices".into(),
        ));
    }
    Ok(MatrixSet {
        identifier,
        matrices,
    })
}

pub(crate) fn parse_matrix(element: &XmlElement) -> Result<TileMatrix, DiscoveryError> {
    let identifier = required_text(element, "Identifier", "matrix identifier")?;
    let scale_denominator = positive_number(
        &required_text(element, "ScaleDenominator", "scale denominator")?,
        "scale denominator",
    )?;
    let top_left = coordinates(
        &required_text(element, "TopLeftCorner", "top-left corner")?,
        "top-left corner",
    )?;
    let tile_size = Vec2d {
        x: positive_integer(
            &required_text(element, "TileWidth", "tile width")?,
            "tile width",
        )?,
        y: positive_integer(
            &required_text(element, "TileHeight", "tile height")?,
            "tile height",
        )?,
    };
    let matrix_size = Vec2d {
        x: positive_integer(
            &required_text(element, "MatrixWidth", "matrix width")?,
            "matrix width",
        )?,
        y: positive_integer(
            &required_text(element, "MatrixHeight", "matrix height")?,
            "matrix height",
        )?,
    };
    Ok(TileMatrix {
        identifier,
        scale_denominator,
        top_left,
        tile_size,
        matrix_size,
    })
}

pub(crate) fn parse_layer_bounds(
    layer: &XmlElement,
) -> Result<Option<LayerBounds>, DiscoveryError> {
    let projected = layer.children_named("BoundingBox").next();
    let geographic = layer.children_named("WGS84BoundingBox").next();
    let Some(element) = projected.or(geographic) else {
        return Ok(None);
    };
    let reference = if same_name(&element.name, "WGS84BoundingBox") {
        CoordinateReference::Geographic
    } else {
        element
            .attribute("crs")
            .and_then(coordinate_reference)
            .ok_or_else(|| DiscoveryError::Session("unsupported WMTS bounding-box CRS".into()))?
    };
    let lower = coordinates(
        &required_text(element, "LowerCorner", "bounding-box lower corner")?,
        "bounding-box lower corner",
    )?;
    let upper = coordinates(
        &required_text(element, "UpperCorner", "bounding-box upper corner")?,
        "bounding-box upper corner",
    )?;
    if lower.0 > upper.0 || lower.1 > upper.1 {
        return Err(DiscoveryError::Session(
            "WMTS bounding box has invalid corner order".into(),
        ));
    }
    Ok(Some(LayerBounds {
        reference,
        lower,
        upper,
    }))
}

pub(crate) fn project_bounds(bounds: LayerBounds) -> Result<Bounds, DiscoveryError> {
    let (left, bottom) = project_coordinate(bounds.lower.0, bounds.lower.1, bounds.reference)?;
    let (right, top) = project_coordinate(bounds.upper.0, bounds.upper.1, bounds.reference)?;
    Ok(Bounds {
        left,
        bottom,
        right,
        top,
    })
}

pub(crate) fn parse_matrix_set_link(element: &XmlElement) -> Result<MatrixSetLink, DiscoveryError> {
    let matrix_set = required_text(element, "TileMatrixSet", "linked matrix set")?;
    let limits = element
        .children_named("TileMatrixSetLimits")
        .next()
        .map(|limits| {
            limits
                .children_named("TileMatrixLimits")
                .map(parse_matrix_limit)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(MatrixSetLink { matrix_set, limits })
}

pub(crate) fn parse_matrix_limit(element: &XmlElement) -> Result<MatrixLimit, DiscoveryError> {
    let matrix = required_text(element, "TileMatrix", "matrix limit identifier")?;
    let minimum_column = nonnegative_integer(
        &required_text(element, "MinTileCol", "minimum tile column")?,
        "minimum tile column",
    )?;
    let maximum_column = nonnegative_integer(
        &required_text(element, "MaxTileCol", "maximum tile column")?,
        "maximum tile column",
    )?;
    let minimum_row = nonnegative_integer(
        &required_text(element, "MinTileRow", "minimum tile row")?,
        "minimum tile row",
    )?;
    let maximum_row = nonnegative_integer(
        &required_text(element, "MaxTileRow", "maximum tile row")?,
        "maximum tile row",
    )?;
    if minimum_column > maximum_column || minimum_row > maximum_row {
        return Err(DiscoveryError::Session(
            "WMTS tile matrix limits have invalid ranges".into(),
        ));
    }
    Ok(MatrixLimit {
        matrix,
        minimum_column,
        maximum_column,
        minimum_row,
        maximum_row,
    })
}

pub(crate) fn coordinate_reference(value: &str) -> Option<CoordinateReference> {
    let value = value.trim().to_ascii_lowercase();
    if value.contains("crs84") || value.ends_with("4326") {
        Some(CoordinateReference::Geographic)
    } else if value.ends_with("3857") {
        Some(CoordinateReference::WebMercator)
    } else {
        None
    }
}

pub(crate) fn project_coordinate(
    x: f64,
    y: f64,
    reference: CoordinateReference,
) -> Result<(f64, f64), DiscoveryError> {
    if !x.is_finite() || !y.is_finite() {
        return Err(DiscoveryError::Session(
            "WMTS bounding box has non-finite coordinates".into(),
        ));
    }
    match reference {
        CoordinateReference::WebMercator => Ok((x, y)),
        CoordinateReference::Geographic => {
            if !(-180.0..=180.0).contains(&x) || !(-90.0..=90.0).contains(&y) || y.abs() >= 90.0 {
                return Err(DiscoveryError::Session(
                    "invalid WMTS geographic bounding box".into(),
                ));
            }
            let projected_y = RADIUS * (std::f64::consts::PI * (y + 90.0) / 360.0).tan().ln();
            let projected = (HALF_SIZE * x / 180.0, projected_y);
            projected.1.is_finite().then_some(projected).ok_or_else(|| {
                DiscoveryError::Session("invalid WMTS geographic bounding box".into())
            })
        }
    }
}

pub(crate) fn coordinates(text: &str, label: &str) -> Result<(f64, f64), DiscoveryError> {
    let values: Vec<_> = text
        .split_ascii_whitespace()
        .map(str::parse::<f64>)
        .collect::<Result<_, _>>()
        .map_err(|_| DiscoveryError::Session(format!("invalid WMTS {label}")))?;
    match values.as_slice() {
        [x, y] if x.is_finite() && y.is_finite() => Ok((*x, *y)),
        _ => Err(DiscoveryError::Session(format!("invalid WMTS {label}"))),
    }
}

pub(crate) fn positive_number(text: &str, label: &str) -> Result<f64, DiscoveryError> {
    let value = text
        .parse::<f64>()
        .map_err(|_| DiscoveryError::Session(format!("invalid WMTS {label}")))?;
    (value.is_finite() && value > 0.0)
        .then_some(value)
        .ok_or_else(|| DiscoveryError::Session(format!("invalid WMTS {label}")))
}

pub(crate) fn positive_integer(text: &str, label: &str) -> Result<u32, DiscoveryError> {
    let value = positive_number(text, label)?;
    (value.fract() == 0.0 && value <= f64::from(u32::MAX))
        .then(|| value.to_string().parse::<u32>())
        .transpose()
        .map_err(|_| DiscoveryError::Session(format!("invalid WMTS {label}")))?
        .ok_or_else(|| DiscoveryError::Session(format!("invalid WMTS {label}")))
}

pub(crate) fn nonnegative_integer(text: &str, label: &str) -> Result<u32, DiscoveryError> {
    let value = text
        .parse::<u64>()
        .map_err(|_| DiscoveryError::Session(format!("invalid WMTS {label}")))?;
    u32::try_from(value).map_err(|_| DiscoveryError::Session(format!("invalid WMTS {label}")))
}

pub(crate) fn count_between(minimum: u32, maximum: u32) -> Result<u32, DiscoveryError> {
    maximum
        .checked_sub(minimum)
        .and_then(|value| value.checked_add(1))
        .ok_or_else(|| DiscoveryError::Session("WMTS tile range is too large".into()))
}
