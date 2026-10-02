use quick_xml::{Reader, events::Event};
use serde::Deserialize;

use crate::Vec2d;
use crate::core::{
    CatalogPlan, DeferredResource, DiscoveryError, DiscoveryResource, ImagePlan, ParsedResource,
    Request, ResolvedLevel, resolve_relative,
};

use super::{invalid, viewer};

pub(super) fn root_name(text: &str) -> Option<String> {
    let mut reader = Reader::from_str(text);
    loop {
        match reader.read_event().ok()? {
            Event::Start(tag) | Event::Empty(tag) => {
                return Some(tag.name().as_ref().to_owned());
            }
            Event::Eof => return None,
            _ => {}
        }
    }
}

#[derive(Deserialize)]
struct Pal {
    #[serde(rename = "@ver")]
    ver: Option<String>,
    #[serde(rename = "@version")]
    version: Option<String>,
    #[serde(rename = "self", default)]
    images: Vec<Root>,
    content: Option<Content>,
}

#[derive(Deserialize)]
struct Root {
    content: Option<Content>,
    #[serde(alias = "#text")]
    title: Option<String>,
}

#[derive(Deserialize)]
struct Content {
    #[serde(rename = "resource", alias = "image", default)]
    resources: Vec<Resource>,
}

#[derive(Deserialize)]
struct Resource {
    #[serde(rename = "@service")]
    service: String,
    #[serde(rename = "@width")]
    width: u32,
    #[serde(rename = "@height")]
    height: u32,
    #[serde(rename = "@tilewidth")]
    tile_width: u32,
    #[serde(rename = "@tileheight")]
    tile_height: u32,
    #[serde(rename = "@min")]
    min: u32,
    #[serde(rename = "@max")]
    max: u32,
    #[serde(rename = "@x")]
    x: i64,
    #[serde(rename = "@y")]
    y: i64,
    #[serde(rename = "@pattern")]
    pattern: Option<String>,
    #[serde(rename = "@mime")]
    mime: Option<String>,
    #[serde(rename = "@divbase")]
    divbase: Option<u32>,
    #[serde(rename = "@url")]
    url: Option<String>,
    #[serde(rename = "@overlap", default)]
    overlap: u32,
}

fn version(value: &str) -> Result<(u32, u32), DiscoveryError> {
    let unsupported = || invalid(format!("unsupported version {value:?}"));
    let (major, minor) = value.split_once('.').ok_or_else(unsupported)?;
    if !value.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err(unsupported());
    }
    Ok((
        major.parse().map_err(|_| unsupported())?,
        minor.parse().map_err(|_| unsupported())?,
    ))
}

pub(super) fn image(text: &str, uri: &str) -> Result<ParsedResource, DiscoveryError> {
    let pal: Pal = serde_xml_rs::from_str(text).map_err(invalid)?;
    let declared = pal
        .ver
        .as_deref()
        .or(pal.version.as_deref())
        .unwrap_or("1.1");
    if let (Some(a), Some(b)) = (&pal.ver, &pal.version)
        && version(a)? != version(b)?
    {
        return Err(invalid(format!(
            "contradictory ver={a:?} and version={b:?} declarations"
        )));
    }
    let ceil = match version(declared)? {
        (1, 1 | 2) => false,
        (1, 3) => true,
        _ => return Err(invalid(format!("unsupported version {declared:?}"))),
    };
    let mut resources = pal
        .content
        .iter()
        .chain(pal.images.iter().filter_map(|root| root.content.as_ref()))
        .flat_map(|content| &content.resources);
    let geometry = resources
        .next()
        .ok_or_else(|| invalid("missing image geometry"))?;
    if resources.next().is_some() {
        return Err(invalid("unsupported layout: expected one resource"));
    }
    geometry.validate()?;
    let mut levels = Vec::new();
    for level in geometry.min..=geometry.max {
        if let Some(plan) = geometry.level(uri, level, ceil)? {
            levels.push(plan);
        }
    }
    if levels.is_empty() {
        return Err(invalid("no positive-sized levels"));
    }
    Ok(ParsedResource::Image(ImagePlan::new(
        pal.images.first().and_then(|root| root.title.clone()),
        levels,
    )))
}

impl Resource {
    fn validate(&self) -> Result<(), DiscoveryError> {
        if !self.service.eq_ignore_ascii_case("FZP") {
            return Err(invalid("resource service is not FZP"));
        }
        if self
            .pattern
            .as_deref()
            .is_some_and(|pattern| pattern != "0/00000")
        {
            return Err(invalid(format!(
                "unsupported filename pattern {:?}",
                self.pattern
            )));
        }
        if self
            .mime
            .as_deref()
            .is_some_and(|mime| !mime.eq_ignore_ascii_case("image/jpeg"))
        {
            return Err(invalid(format!(
                "unsupported tile MIME type {:?}",
                self.mime
            )));
        }
        if self.x != 0 || self.y != 0 || self.overlap != 0 {
            return Err(invalid(format!(
                "unsupported nonzero origin or overlap: x={}, y={}, overlap={}",
                self.x, self.y, self.overlap
            )));
        }
        if self.divbase.is_some_and(|base| base != 2) {
            return Err(invalid(format!(
                "unsupported divbase {:?} (expected 2)",
                self.divbase
            )));
        }
        if let Some(url) = self.url.as_deref()
            && url != "."
        {
            return Err(invalid(format!(
                "unsupported resource URL base {url:?} (expected .)"
            )));
        }
        if self.width == 0 || self.height == 0 || self.tile_width == 0 || self.tile_height == 0 {
            return Err(invalid("image and tile dimensions must be positive"));
        }
        if self.min > self.max || self.max >= 32 {
            return Err(invalid("invalid or overflowing stored level range"));
        }
        Ok(())
    }

    fn level(
        &self,
        uri: &str,
        level: u32,
        ceil: bool,
    ) -> Result<Option<ResolvedLevel>, DiscoveryError> {
        let scale = 1_u32
            .checked_shl(level)
            .ok_or_else(|| invalid("scale overflow"))?;
        let round = |value: u32| {
            if ceil {
                value.div_ceil(scale)
            } else {
                value / scale
            }
        };
        let size = Vec2d {
            x: round(self.width),
            y: round(self.height),
        };
        if size.x == 0 || size.y == 0 {
            return Ok(None);
        }
        let span = Vec2d {
            x: self
                .tile_width
                .checked_mul(scale)
                .ok_or_else(|| invalid("tile width overflow"))?,
            y: self
                .tile_height
                .checked_mul(scale)
                .ok_or_else(|| invalid("tile height overflow"))?,
        };
        let original = Vec2d {
            x: self.width,
            y: self.height,
        };
        validate_fields(size.x, self.tile_width, span.x, original.x)?;
        validate_fields(size.y, self.tile_height, span.y, original.y)?;
        let base = resolve_relative(uri, &format!("{level}/"));
        let plan = ResolvedLevel::grid(
            size,
            Vec2d {
                x: self.tile_width,
                y: self.tile_height,
            },
            move |tile| {
                // Grid coordinates are bounded by the validated level dimensions.
                let x = tile.coord.column * span.x;
                let y = tile.coord.row * span.y;
                let width = span.x.min(original.x - x);
                let height = span.y.min(original.y - y);
                Request::new(format!("{base}{x:05}{y:05}{width:05}{height:05}.jpg"))
            },
        )?;
        Ok(Some(
            plan.with_title(Some(format!("Level {level}")))
                .with_scale_factor(Some(scale)),
        ))
    }
}

fn validate_fields(size: u32, tile: u32, span: u32, original: u32) -> Result<(), DiscoveryError> {
    let last = (size.div_ceil(tile) - 1)
        .checked_mul(span)
        .ok_or_else(|| invalid("original tile coordinate overflow"))?;
    if last >= original || last > 99_999 || span.min(original) > 99_999 {
        return Err(invalid(
            "original coordinates exceed five-digit filename fields",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct Index {
    #[serde(rename = "@title")]
    title: Option<String>,
    #[serde(rename = "item", default)]
    items: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    #[serde(rename = "@resource")]
    resource: Option<String>,
    #[serde(rename = "@ext")]
    ext: Option<String>,
    #[serde(rename = "@label")]
    label: Option<String>,
    #[serde(rename = "@page")]
    page: Option<String>,
}

pub(super) fn index(
    text: &str,
    resource: DiscoveryResource<'_>,
) -> Result<ParsedResource, DiscoveryError> {
    let index: Index = serde_xml_rs::from_str(text).map_err(invalid)?;
    let base = viewer::resource_base(resource)
        .or_else(|| {
            let path = resource
                .final_uri()
                .split(['?', '#'])
                .next()
                .unwrap_or_default();
            let (directory, _) = path.rsplit_once(['/', '\\'])?;
            if directory == "xmls" {
                Some("resources/".into())
            } else {
                directory
                    .strip_suffix("/xmls")
                    .or_else(|| directory.strip_suffix("\\xmls"))
                    .map(|parent| format!("{parent}/resources/"))
            }
        })
        .ok_or_else(|| {
            invalid("page index has no configured resource base or sibling xmls/resources layout")
        })?;
    let mut entries = Vec::new();
    let mut skipped = 0;
    for item in index.items {
        if item
            .ext
            .as_deref()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("fzp"))
        {
            let Some(uri) = item
                .resource
                .as_deref()
                .and_then(|name| viewer::image_uri(&base, name).ok())
            else {
                skipped += 1;
                continue;
            };
            let label = item.label.or(item.page);
            let title = match (&index.title, label) {
                (Some(title), Some(label)) => Some(format!("{title} - {label}")),
                (title, None) => title.clone(),
                (None, label) => label,
            };
            entries.push(DeferredResource {
                uri,
                title,
                warnings: Vec::new(),
            });
        }
    }
    if entries.is_empty() {
        return Err(invalid("page index contains no supported FZP images"));
    }
    if skipped > 0 {
        entries[0].warnings.push(format!(
            "FreezoomPack index: skipped {skipped} images with missing or unsupported resource names"
        ));
    }
    Ok(ParsedResource::Catalog(CatalogPlan::deferred(entries)))
}
