//! Real core discovery for browser hosts: a thin, effect-free surface over
//! [`dezoomify_core`]'s pull-based [`DiscoveryOperation`]. The host fetches
//! the resources the core asks for (through its own transport), feeds the
//! bytes back, and finally requests the tile plan of a chosen level. All
//! responses are JSON over the wasm boundary; no bytes are retained beyond
//! one provide call, and nothing here performs I/O.

use dezoomify_core::core::adaptive::{DiscoverableStep, ObservationResult};
use dezoomify_core::core::discovery::{DiscoveryOperation, ResourceFailure, ResourceResponse};
use dezoomify_core::core::model::{CatalogEntry, ProcessingRecipe, Request, TileRole};
use dezoomify_core::core::registry::default_registry;
use dezoomify_core::core::tile_plan::{Grid, TileSource, TileSourceError};
use serde::Serialize;

use crate::error::{redact, AdapterError, AdapterErrorCode};

fn malformed(message: impl Into<String>) -> AdapterError {
    AdapterError::new(AdapterErrorCode::Malformed, message.into())
}

/// One host fetch the core needs. `headers` are extra request headers the
/// format layer requires (e.g. legacy Referer parity); the host merges its
/// own defaults.
#[derive(Serialize)]
struct NeedDto<'a> {
    id: usize,
    uri: &'a str,
    headers: serde_json::Value,
    purpose: &'static str,
}

#[derive(Serialize)]
struct TileDto {
    uri: String,
    headers: serde_json::Value,
    x: u32,
    y: u32,
    w: Option<u32>,
    h: Option<u32>,
    processing: &'static str,
}

#[derive(Serialize)]
struct PlanDto {
    kind: &'static str,
    canvas: Option<PointDto>,
    tiles: Vec<TileDto>,
}

#[derive(Serialize)]
struct PointDto {
    x: u32,
    y: u32,
}

/// One discovery + tile-planning session over the core registry.
pub struct DiscoverySession {
    operation: Option<DiscoveryOperation>,
    catalog: Option<dezoomify_core::core::model::ImageCatalog>,
    probe_steps: std::collections::HashMap<(usize, usize), dezoomify_core::core::adaptive::ProbeContinuation>,
    resolved: std::collections::HashMap<(usize, usize), TileSource>,
}

impl DiscoverySession {
    /// Start discovery for `input_url` with the default core limits.
    ///
    /// # Errors
    ///
    /// `malformed` when the URL is empty or not http(s).
    pub fn new(input_url: &str) -> Result<Self, AdapterError> {
        if input_url.is_empty()
            || input_url.len() > 2048
            || !(input_url.starts_with("https://") || input_url.starts_with("http://"))
        {
            return Err(malformed(
                "discovery requires an http(s) input_url up to 2048 bytes",
            ));
        }
        let registry = default_registry(input_url);
        Ok(Self {
            operation: Some(registry.start(input_url)),
            catalog: None,
            probe_steps: std::collections::HashMap::new(),
            resolved: std::collections::HashMap::new(),
        })
    }

    /// Next resource the core needs, serialized as JSON (`null` when the
    /// core has everything it needs and `finish` may be called).
    ///
    /// # Errors
    ///
    /// `wrong-state` when discovery already finished.
    #[must_use]
    pub fn next_need(&mut self) -> Option<String> {
        let operation = self.operation.as_mut()?;
        let need = operation.next_priority_need().ok()??;
        let headers = serde_json::to_value(&need.request.headers).unwrap_or_default();
        let dto = NeedDto {
            id: need.id.0,
            uri: &need.request.uri,
            headers,
            purpose: "metadata",
        };
        serde_json::to_string(&dto).ok()
    }

    /// Provide the fetched bytes for one outstanding need.
    ///
    /// # Errors
    ///
    /// `malformed` for unknown request ids or core rejections.
    pub fn provide(
        &mut self,
        request_id: usize,
        bytes: Vec<u8>,
        final_uri: Option<String>,
    ) -> Result<(), AdapterError> {
        let operation = self
            .operation
            .as_mut()
            .ok_or_else(|| malformed("discovery already finished"))?;
        let mut response = ResourceResponse::new(
            dezoomify_core::core::discovery::RequestId(request_id),
            bytes,
        );
        if let Some(uri) = final_uri {
            response = response.with_final_uri(uri);
        }
        operation.provide(response).map_err(discovery_error)?;
        Ok(())
    }

    /// Report a failed host fetch for one outstanding need.
    ///
    /// # Errors
    ///
    /// `malformed` for unknown request ids or core rejections.
    pub fn provide_failure(
        &mut self,
        request_id: usize,
        message: &str,
    ) -> Result<(), AdapterError> {
        let operation = self
            .operation
            .as_mut()
            .ok_or_else(|| malformed("discovery already finished"))?;
        operation
            .provide_failure(ResourceFailure {
                id: dezoomify_core::core::discovery::RequestId(request_id),
                message: message.to_string(),
            })
            .map_err(discovery_error)?;
        Ok(())
    }

    /// Complete discovery and project the catalog to JSON:
    /// `{"images":[{"id","title","format","warnings","levels":[...]}]}`
    /// where each level carries `index`, `title`, `scale`, `warnings`, and
    /// `imageSize` when the source declares one up front.
    ///
    /// # Errors
    ///
    /// `wrong-state` when called twice; `malformed` on core errors.
    pub fn finish(&mut self) -> Result<String, AdapterError> {
        if self.catalog.is_some() {
            return Err(AdapterError::new(
                AdapterErrorCode::WrongState,
                "discovery already finished",
            ));
        }
        let operation = self
            .operation
            .take()
            .ok_or_else(|| AdapterError::new(AdapterErrorCode::WrongState, "no operation"))?;
        let catalog = operation.finish().map_err(discovery_error)?;
        #[derive(Serialize)]
        struct LevelDto {
            index: usize,
            title: Option<String>,
            scale: Option<u32>,
            warnings: Vec<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            image_size: Option<PointDto>,
        }
        #[derive(Serialize)]
        struct ImageDto {
            id: usize,
            title: Option<String>,
            format: String,
            warnings: Vec<String>,
            levels: Vec<LevelDto>,
        }
        #[derive(Serialize)]
        struct CatalogDto {
            images: Vec<ImageDto>,
        }
        let mut images = Vec::new();
        for (index, entry) in catalog.entries().iter().enumerate() {
            match entry {
                CatalogEntry::Ready(image) => {
                    let levels = image
                        .levels
                        .iter()
                        .enumerate()
                        .map(|(level_index, level)| LevelDto {
                            index: level_index,
                            title: level.title.clone(),
                            scale: level.scale_factor,
                            warnings: level.warnings.clone(),
                            image_size: level.source.image_size().map(|size| PointDto {
                                x: size.x,
                                y: size.y,
                            }),
                        })
                        .collect();
                    images.push(ImageDto {
                        id: index,
                        title: image.title.clone(),
                        format: image.format.as_str().to_string(),
                        warnings: image.warnings.clone(),
                        levels,
                    });
                }
                CatalogEntry::Deferred(_) => {
                    return Err(AdapterError::new(
                        AdapterErrorCode::Malformed,
                        "catalog contains an image whose metadata was not fetched",
                    ));
                }
            }
        }
        self.catalog = Some(catalog);
        serde_json::to_string(&CatalogDto { images })
            .map_err(|e| malformed(format!("catalog projection failed: {e}")))
    }

    /// Project the tile plan of one level. For grid/positioned sources this
    /// is the full plan; for probe-driven sources the first response is a
    /// `probe` step and the host answers via [`Self::probe_submit`] until
    /// the plan resolves.
    ///
    /// # Errors
    ///
    /// `wrong-state` before [`Self::finish`]; `malformed` for bad indexes.
    pub fn level_tiles(&mut self, image: usize, level: usize) -> Result<String, AdapterError> {
        let catalog = self.catalog.as_ref().ok_or_else(|| {
            AdapterError::new(AdapterErrorCode::WrongState, "discovery not finished")
        })?;
        let descriptor = catalog
            .entries()
            .get(image)
            .ok_or_else(|| malformed("image index out of range"))?;
        let entry = match descriptor {
            CatalogEntry::Ready(image) => image,
            CatalogEntry::Deferred(_) => {
                return Err(malformed("image metadata was not fetched"))
            }
        };
        let level_descriptor = entry
            .levels
            .get(level)
            .ok_or_else(|| malformed("level index out of range"))?;
        let source = self
            .resolved
            .get(&(image, level))
            .cloned()
            .unwrap_or_else(|| level_descriptor.source.clone());
        match source {
            TileSource::Grid(grid) => self.project_grid(grid),
            TileSource::Positioned(positioned) => {
                let canvas = positioned.image_size();
                let mut tiles = Vec::new();
                for tile in positioned.tiles() {
                    let tile = tile.map_err(tile_error)?;
                    if tile.role == TileRole::Probe {
                        continue;
                    }
                    tiles.push(project_tile(&tile.request, None, tile.destination, tile.processing));
                }
                Ok(project_plan("resolved", canvas, tiles))
            }
            TileSource::DiscoverableGrid(discoverable) => {
                let step = discoverable.start();
                self.advance_probe(image, level, step)
            }
            TileSource::Adaptive(adaptive) => self.advance_probe(image, level, adaptive.start()),
        }
    }

    /// Submit one probe observation (decoded tile size, or missing) and
    /// return the next probe step or the resolved plan.
    ///
    /// # Errors
    ///
    /// `wrong-state` when no probe is pending for the level.
    pub fn probe_submit(
        &mut self,
        image: usize,
        level: usize,
        ok: bool,
        width: u32,
        height: u32,
    ) -> Result<String, AdapterError> {
        let step = self
            .probe_steps
            .remove(&(image, level))
            .ok_or_else(|| AdapterError::new(
                AdapterErrorCode::WrongState,
                "no probe pending for this level",
            ))?;
        let observation = match (ok, width, height) {
            (true, w, h) if w > 0 && h > 0 => ObservationResult::Available {
                size: dezoomify_core::Vec2d { x: w, y: h },
            },
            _ => ObservationResult::Missing,
        };
        let next = step.submit(observation).map_err(tile_error)?;
        self.advance_probe(image, level, next)
    }

    fn advance_probe(
        &mut self,
        image: usize,
        level: usize,
        step: DiscoverableStep,
    ) -> Result<String, AdapterError> {
        match step {
            DiscoverableStep::Probe { tile, continuation } => {
                #[derive(Serialize)]
                struct ProbeDto {
                    kind: &'static str,
                    id: usize,
                    uri: String,
                    headers: serde_json::Value,
                }
                let headers = serde_json::to_value(&tile.request.headers).unwrap_or_default();
                let dto = ProbeDto {
                    kind: "probe",
                    id: 0,
                    uri: tile.request.uri.clone(),
                    headers,
                };
                self.probe_steps.insert((image, level), continuation);
                serde_json::to_string(&dto)
                    .map_err(|e| malformed(format!("probe projection failed: {e}")))
            }
            DiscoverableStep::Resolved { grid, .. } => {
                self.resolved
                    .insert((image, level), TileSource::Grid(grid.clone()));
                self.project_grid(grid)
            }
            DiscoverableStep::Empty => Err(AdapterError::new(
                AdapterErrorCode::Malformed,
                "probing found no tiles for this level",
            )),
            DiscoverableStep::Error(error) => Err(tile_error(error)),
        }
    }

    fn project_grid(&self, grid: Grid) -> Result<String, AdapterError> {
        let canvas = grid.image_size();
        let mut tiles = Vec::new();
        for tile in grid.tiles_row_major() {
            let tile = tile.map_err(tile_error)?;
            if tile.role == TileRole::Probe {
                continue;
            }
            tiles.push(project_tile(
                &tile.request,
                tile.expected_size,
                tile.destination,
                tile.processing,
            ));
        }
        Ok(project_plan("resolved", Some(canvas), tiles))
    }

    /// Apply one core processing recipe to fetched tile bytes.
    ///
    /// # Errors
    ///
    /// `malformed` for unknown recipes or processing failures.
    pub fn apply_processing(&self, recipe: &str, bytes: Vec<u8>) -> Result<Vec<u8>, AdapterError> {
        let parsed = match recipe {
            "none" => ProcessingRecipe::None,
            "google-arts-decrypt" => ProcessingRecipe::GoogleArtsDecrypt,
            other => return Err(malformed(format!("unknown processing recipe {other}"))),
        };
        parsed.apply(bytes).map_err(|e| malformed(e.to_string()))
    }
}

fn project_tile(
    request: &Request,
    expected: Option<dezoomify_core::Vec2d>,
    destination: dezoomify_core::Vec2d,
    processing: ProcessingRecipe,
) -> TileDto {
    TileDto {
        uri: request.uri.clone(),
        headers: serde_json::to_value(&request.headers).unwrap_or_default(),
        x: destination.x,
        y: destination.y,
        w: expected.map(|size| size.x),
        h: expected.map(|size| size.y),
        processing: match processing {
            ProcessingRecipe::None => "none",
            ProcessingRecipe::GoogleArtsDecrypt => "google-arts-decrypt",
        },
    }
}

fn project_plan(kind: &'static str, canvas: Option<dezoomify_core::Vec2d>, tiles: Vec<TileDto>) -> String {
    let dto = PlanDto {
        kind,
        canvas: canvas.map(|size| PointDto { x: size.x, y: size.y }),
        tiles,
    };
    serde_json::to_string(&dto).unwrap_or_else(|_| "{\"kind\":\"error\"}".to_string())
}

fn discovery_error(error: dezoomify_core::core::discovery::DiscoveryError) -> AdapterError {
    AdapterError::new(AdapterErrorCode::Malformed, redact(&error.to_string()))
}

fn tile_error(error: TileSourceError) -> AdapterError {
    AdapterError::new(AdapterErrorCode::Malformed, redact(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const IMAGE_PROPERTIES: &str =
        r#"<IMAGE_PROPERTIES WIDTH="512" HEIGHT="512" NUMTILES="5" VERSION="1.8" TILESIZE="256" />"#;

    #[test]
    fn discovery_and_grid_plan_without_network() {
        let mut session = DiscoverySession::new("https://example.com/a/ImageProperties.xml")
            .expect("session starts");
        // First need: the input url itself.
        let need = session.next_need().expect("need json");
        let need: serde_json::Value = serde_json::from_str(&need).expect("need parses");
        assert_eq!(need["uri"], "https://example.com/a/ImageProperties.xml");
        session
            .provide(need["id"].as_u64().unwrap() as usize, IMAGE_PROPERTIES.as_bytes().to_vec(), None)
            .expect("provide");
        assert!(session.next_need().is_none(), "core is satisfied");
        let catalog = session.finish().expect("catalog");
        let catalog: serde_json::Value = serde_json::from_str(&catalog).expect("catalog parses");
        assert_eq!(catalog["images"].as_array().expect("images").len(), 1);
        assert_eq!(catalog["images"][0]["format"], "zoomify");

        // Largest level: 512x512, 2x2 tiles. Find it by canvas size.
        let mut plan = None;
        for level in 0..catalog["images"][0]["levels"].as_array().unwrap().len() {
            let candidate: serde_json::Value =
                serde_json::from_str(&session.level_tiles(0, level).expect("plan"))
                    .expect("plan parses");
            if candidate["canvas"]["x"] == 512 {
                plan = Some(candidate);
                break;
            }
        }
        let plan = plan.expect("512-wide level exists");
        assert_eq!(plan["kind"], "resolved");
        assert_eq!(plan["tiles"].as_array().expect("tiles").len(), 4);
        assert_eq!(plan["tiles"][0]["processing"], "none");
    }

    #[test]
    fn finish_twice_is_wrong_state() {
        let mut session = DiscoverySession::new("https://example.com/a/ImageProperties.xml")
            .expect("session starts");
        let need = session.next_need().expect("need");
        let need: serde_json::Value = serde_json::from_str(&need).unwrap();
        session
            .provide(need["id"].as_u64().unwrap() as usize, IMAGE_PROPERTIES.as_bytes().to_vec(), None)
            .expect("provide");
        session.finish().expect("first finish");
        assert_eq!(
            session.finish().unwrap_err().code(),
            AdapterErrorCode::WrongState
        );
    }
}
