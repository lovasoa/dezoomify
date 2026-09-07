//! WMTS layer selection and level planning.
//!
//! Split from `wmts/mod.rs` (todo 4.1): this module owns `WmtsContext`
//! assembly from layers plus tile URL templates. XML parsing lives in
//! `capabilities`, matrix math in `tilematrix`.

use std::sync::Arc;

use super::capabilities::{
    XmlElement, descendants_named, find_descendant, required_text, text_content,
};
use super::tilematrix::{
    Bounds, MatrixLimit, MatrixSet, MatrixSetLink, TileMatrix, parse_layer_bounds,
    parse_matrix_set, parse_matrix_set_link, project_bounds,
};
use super::tilematrix::{METRES_PER_PIXEL, count_between};
use crate::Vec2d;
use crate::core::{
    DiscoveryError, Grid, LevelDescriptor, Request, StableId, floor_index, resolve_url_template,
};

pub(crate) struct WmtsContext {
    pub(crate) layer_name: String,
    pub(crate) template: Arc<str>,
    pub(crate) matrix_set_name: String,
    pub(crate) style: String,
    pub(crate) bounds: Option<Bounds>,
    pub(crate) matrices: Vec<TileMatrix>,
    pub(crate) limits: Vec<MatrixLimit>,
}

pub(crate) fn parse_context(
    url: &str,
    document: &XmlElement,
) -> Result<WmtsContext, DiscoveryError> {
    let contents = find_descendant(document, "Contents").unwrap_or(document);
    let mut matrix_sets = Vec::new();
    for element in descendants_named(contents, "TileMatrixSet") {
        if let Ok(matrix_set) = parse_matrix_set(element) {
            matrix_sets.push(matrix_set);
        }
    }
    if matrix_sets.is_empty() {
        return Err(DiscoveryError::Session(
            "WMTS has no supported tile matrix set".into(),
        ));
    }

    let mut last_error = None;
    for layer in descendants_named(contents, "Layer") {
        match context_for_layer(url, layer, &matrix_sets) {
            Ok(context) => return Ok(context),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error
        .unwrap_or_else(|| DiscoveryError::Session("WMTS capabilities has no layer".into())))
}

fn context_for_layer(
    url: &str,
    layer: &XmlElement,
    matrix_sets: &[MatrixSet],
) -> Result<WmtsContext, DiscoveryError> {
    let layer_name = required_text(layer, "Identifier", "layer identifier")?;
    let template = resource_template(layer)?;
    validate_template(&template)?;
    let style = layer_style(layer);
    let bounds = parse_layer_bounds(layer)?;
    let links = layer
        .children_named("TileMatrixSetLink")
        .map(parse_matrix_set_link)
        .collect::<Result<Vec<_>, _>>()?;

    let selected = if links.is_empty() {
        matrix_sets
            .iter()
            .next()
            .map(|matrix_set| (matrix_set, None))
    } else {
        links.iter().find_map(|link| {
            matrix_sets
                .iter()
                .find(|matrix_set| matrix_set.identifier == link.matrix_set)
                .map(|matrix_set| (matrix_set, Some(link)))
        })
    }
    .ok_or_else(|| {
        DiscoveryError::Session("WMTS layer has no supported linked tile matrix set".into())
    })?;

    let projected_bounds = bounds.map(project_bounds).transpose()?;
    let (matrix_set, link) = selected;
    Ok(WmtsContext {
        layer_name,
        template: resolve_url_template(url, &template).into(),
        matrix_set_name: matrix_set.identifier.clone(),
        style,
        bounds: projected_bounds,
        matrices: matrix_set.matrices.clone(),
        limits: link.map_or_else(Vec::new, |link: &MatrixSetLink| link.limits.clone()),
    })
}

fn resource_template(layer: &XmlElement) -> Result<String, DiscoveryError> {
    let resources: Vec<_> = layer.children_named("ResourceURL").collect();
    let tile_resources: Vec<_> = resources
        .iter()
        .copied()
        .filter(|resource| {
            resource
                .attribute("resourceType")
                .is_none_or(|kind| kind.eq_ignore_ascii_case("tile"))
        })
        .collect();
    let formats: Vec<_> = layer
        .children_named("Format")
        .map(text_content)
        .filter(|format| !format.is_empty())
        .collect();
    let candidates = if tile_resources.is_empty() {
        resources
    } else {
        tile_resources
    };
    candidates
        .iter()
        .find(|resource| {
            resource.attribute("format").is_some_and(|format| {
                formats
                    .iter()
                    .any(|layer_format| layer_format.eq_ignore_ascii_case(format))
            })
        })
        .or_else(|| candidates.first())
        .and_then(|resource| resource.attribute("template"))
        .filter(|template| !template.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| DiscoveryError::Session("WMTS layer has no tile URL template".into()))
}

fn layer_style(layer: &XmlElement) -> String {
    let styles: Vec<_> = layer.children_named("Style").collect();
    styles
        .iter()
        .find(|style| {
            style
                .attribute("isDefault")
                .is_some_and(|value| value.eq_ignore_ascii_case("true") || value == "1")
        })
        .or_else(|| styles.first())
        .and_then(|style| style.children_named("Identifier").next())
        .map(text_content)
        .filter(|style| !style.is_empty())
        .unwrap_or_else(|| "default".into())
}

pub(crate) fn build_levels(context: &WmtsContext) -> Result<Vec<LevelDescriptor>, DiscoveryError> {
    context
        .matrices
        .iter()
        .enumerate()
        .map(|(ordinal, matrix)| {
            let ((min_column, max_column), (min_row, max_row)) = tile_ranges(context, matrix)?;
            let columns = count_between(min_column, max_column)?;
            let rows = count_between(min_row, max_row)?;
            let width = u64::from(columns)
                .checked_mul(u64::from(matrix.tile_size.x))
                .and_then(|size| u32::try_from(size).ok())
                .ok_or_else(|| DiscoveryError::Session("WMTS image width is too large".into()))?;
            let height = u64::from(rows)
                .checked_mul(u64::from(matrix.tile_size.y))
                .and_then(|size| u32::try_from(size).ok())
                .ok_or_else(|| DiscoveryError::Session("WMTS image height is too large".into()))?;
            let template = Arc::clone(&context.template);
            let matrix_set = context.matrix_set_name.clone();
            let matrix_identifier = matrix.identifier.clone();
            let style = context.style.clone();
            let source = Grid::with_requests(
                StableId::new(format!("wmts:{ordinal}")),
                Vec2d {
                    x: width,
                    y: height,
                },
                matrix.tile_size,
                Vec2d::default(),
                move |tile| {
                    render_template(
                        &template,
                        &matrix_set,
                        &matrix_identifier,
                        &style,
                        min_column + tile.coord.column,
                        min_row + tile.coord.row,
                    )
                },
            )
            .map_err(|error| DiscoveryError::Session(format!("invalid WMTS grid: {error}")))?;
            Ok(LevelDescriptor::new(source)
                .with_title(Some(format!("WMTS matrix {}", matrix.identifier))))
        })
        .collect()
}

type TileRange = (u32, u32);

fn tile_ranges(
    context: &WmtsContext,
    matrix: &TileMatrix,
) -> Result<(TileRange, TileRange), DiscoveryError> {
    let mut columns = (0, matrix.matrix_size.x - 1);
    let mut rows = (0, matrix.matrix_size.y - 1);
    if let Some(bounds) = context.bounds {
        let x_span = f64::from(matrix.tile_size.x) * matrix.scale_denominator * METRES_PER_PIXEL;
        let y_span = f64::from(matrix.tile_size.y) * matrix.scale_denominator * METRES_PER_PIXEL;
        if !x_span.is_finite() || !y_span.is_finite() || x_span <= 0.0 || y_span <= 0.0 {
            return Err(DiscoveryError::Session(
                "WMTS matrix has an invalid tile span".into(),
            ));
        }
        // Parity with the deployed web client: bounds-derived ranges are used
        // as-is and are NOT clamped to MatrixWidth/MatrixHeight. Negative
        // indices are floored at zero (grids cannot enumerate them); ranges
        // above the matrix size are kept, matching web tile URL generation.
        let minimum_column =
            floor_index((bounds.left - matrix.top_left.0) / x_span, "WMTS")?.max(0);
        let maximum_column =
            floor_index((bounds.right - matrix.top_left.0) / x_span, "WMTS")?.max(0);
        let minimum_row = floor_index((matrix.top_left.1 - bounds.top) / y_span, "WMTS")?.max(0);
        let maximum_row = floor_index((matrix.top_left.1 - bounds.bottom) / y_span, "WMTS")?.max(0);
        columns = (
            u32::try_from(minimum_column).map_err(|_| out_of_range())?,
            u32::try_from(maximum_column).map_err(|_| out_of_range())?,
        );
        rows = (
            u32::try_from(minimum_row).map_err(|_| out_of_range())?,
            u32::try_from(maximum_row).map_err(|_| out_of_range())?,
        );
    }
    if let Some(limit) = context
        .limits
        .iter()
        .find(|limit| limit.matrix == matrix.identifier)
    {
        columns.0 = columns.0.max(limit.minimum_column);
        columns.1 = columns.1.min(limit.maximum_column);
        rows.0 = rows.0.max(limit.minimum_row);
        rows.1 = rows.1.min(limit.maximum_row);
    }
    if columns.0 > columns.1 || rows.0 > rows.1 {
        return Err(DiscoveryError::Session(
            "WMTS tile matrix has no tiles in the layer extent".into(),
        ));
    }
    Ok((columns, rows))
}

fn out_of_range() -> DiscoveryError {
    DiscoveryError::Session("WMTS tile coordinate is out of range".into())
}

fn validate_template(template: &str) -> Result<(), DiscoveryError> {
    let mut remaining = template;
    while let Some(start) = remaining.find('{') {
        let after_start = &remaining[start + 1..];
        let end = after_start.find('}').ok_or_else(|| {
            DiscoveryError::Session("WMTS tile URL template has an unclosed placeholder".into())
        })?;
        let placeholder = &after_start[..end];
        if !is_template_placeholder(placeholder) {
            return Err(DiscoveryError::Session(format!(
                "unsupported WMTS tile URL placeholder: {{{placeholder}}}"
            )));
        }
        remaining = &after_start[end + 1..];
    }
    Ok(())
}

fn is_template_placeholder(value: &str) -> bool {
    ["TileMatrixSet", "TileMatrix", "TileRow", "TileCol", "Style"]
        .iter()
        .any(|known| value.eq_ignore_ascii_case(known))
}

fn render_template(
    template: &str,
    matrix_set: &str,
    matrix: &str,
    style: &str,
    column: u32,
    row: u32,
) -> Request {
    let mut uri = String::with_capacity(template.len() + 32);
    let mut remaining = template;
    while let Some(start) = remaining.find('{') {
        uri.push_str(&remaining[..start]);
        let after_start = &remaining[start + 1..];
        let end = after_start.find('}').unwrap_or(after_start.len());
        let placeholder = &after_start[..end];
        match placeholder {
            value if value.eq_ignore_ascii_case("TileMatrixSet") => uri.push_str(matrix_set),
            value if value.eq_ignore_ascii_case("TileMatrix") => uri.push_str(matrix),
            value if value.eq_ignore_ascii_case("TileRow") => uri.push_str(&row.to_string()),
            value if value.eq_ignore_ascii_case("TileCol") => uri.push_str(&column.to_string()),
            value if value.eq_ignore_ascii_case("Style") => uri.push_str(style),
            _ => {
                uri.push('{');
                uri.push_str(placeholder);
                if end < after_start.len() {
                    uri.push('}');
                }
            }
        }
        remaining = if end < after_start.len() {
            &after_start[end + 1..]
        } else {
            ""
        };
    }
    uri.push_str(remaining);
    Request::new(uri)
}
