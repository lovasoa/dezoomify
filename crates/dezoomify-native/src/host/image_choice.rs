use super::{ImageSelection, NativeHost};
use base64::Engine as _;
use dezoomify::model::{Catalog, CatalogEntry, DiagnosticLevel, Error, Tile};

impl NativeHost<'_> {
    pub(super) async fn select_image(&self, catalog: Catalog) -> Result<u32, Error> {
        self.controls.checkpoint(false).await?;
        let last = catalog
            .entries
            .len()
            .checked_sub(1)
            .ok_or(Error::PlanEmpty)?;
        if last == 0 || self.options.image_index.is_some() || self.image_chooser.borrow().is_none()
        {
            return Ok(self.options.image_index.unwrap_or(0).min(last) as u32);
        }
        let ImageSelection {
            mut answer,
            mut preview,
        } = self
            .image_chooser
            .borrow_mut()
            .as_mut()
            .ok_or(Error::InteractionExpired)?(catalog.clone())?;
        self.controlled(async {
            tokio::select! {
                biased;
                result = &mut answer => result,
                () = self.image_previews(&catalog, &mut preview) => answer.await,
            }
        })
        .await
    }

    async fn image_previews(&self, catalog: &Catalog, changed: &mut dyn FnMut(u32, String)) {
        for (index, entry) in catalog.entries.iter().enumerate() {
            let CatalogEntry::Image(image) = entry else {
                continue;
            };
            let Some(tile) = &image.preview else { continue };
            match self.image_thumbnail(tile).await {
                Ok(Some(thumbnail)) => changed(index as u32, thumbnail),
                Ok(None) => {}
                Err(error) => {
                    if self.controls.is_cancelled() {
                        return;
                    }
                    self.diagnostics.record(
                        DiagnosticLevel::Debug,
                        "image-preview-failed",
                        serde_json::json!({"request": tile.request.uri, "error": error}),
                    );
                }
            }
        }
    }

    async fn image_thumbnail(&self, tile: &Tile) -> Result<Option<String>, Error> {
        let Some(size) = &tile.placement.canvas else {
            return Ok(None);
        };
        if size.width == 0 || size.height == 0 || size.width > 1024 || size.height > 1024 {
            return Ok(None);
        }
        let pixels = self.tile(tile).await?;
        let image = &pixels.decoded.image;
        if image.width() < size.width || image.height() < size.height {
            return Ok(None);
        }
        let crop = image::imageops::crop_imm(image, 0, 0, size.width, size.height);
        let scale = (160.0 / f64::from(size.width.max(size.height))).min(1.0);
        let thumbnail = image::imageops::thumbnail(
            &*crop,
            (f64::from(size.width) * scale).round().max(1.0) as u32,
            (f64::from(size.height) * scale).round().max(1.0) as u32,
        );
        let png = crate::imaging::encode_png(
            &thumbnail,
            image::codecs::png::CompressionType::Fast,
            None,
            None,
        )?;
        Ok(Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{JobOptions, OutputTarget};
    use dezoomify::{model::*, Host};

    #[test]
    fn graphical_choice_previews_complete_tiles_before_selecting_a_non_default_image() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tiles/0-0.png");
        let tile = Tile {
            index: 0,
            request: ResourceRequest {
                uri: url::Url::from_file_path(&path).unwrap().into(),
                headers: vec![],
                purpose: RequestPurpose::Tile,
            },
            placement: TilePlacement {
                position: Point { x: 0, y: 0 },
                canvas: Some(Size {
                    width: 256,
                    height: 256,
                }),
                expected_size: Some(Size {
                    width: 256,
                    height: 256,
                }),
                processing: ProcessingRecipe::None,
                role: TileRole::output(),
            },
        };
        let previews = std::cell::RefCell::new(Vec::new());
        let host = NativeHost::new(JobOptions {
            input_url: "https://images.test/catalog".into(),
            output: OutputTarget::AutoImageDir {
                dir: std::env::temp_dir(),
            },
            ..Default::default()
        })
        .unwrap();
        host.on_choose_image(|catalog| {
            assert_eq!(catalog.entries.len(), 2);
            let (send, receive) = tokio::sync::oneshot::channel();
            let mut send = Some(send);
            let previews = &previews;
            Ok(ImageSelection {
                answer: Box::pin(
                    async move { receive.await.map_err(|_| Error::InteractionExpired) },
                ),
                preview: Box::new(move |index, uri| {
                    let encoded = uri.strip_prefix("data:image/png;base64,").unwrap();
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(encoded)
                        .unwrap();
                    let image = image::load_from_memory(&bytes).unwrap();
                    assert_eq!((image.width(), image.height()), (160, 160));
                    previews.borrow_mut().push(index);
                    if index == 1 {
                        send.take().unwrap().send(index).unwrap();
                    }
                }),
            })
        });
        let image = Image {
            title: None,
            source_url: None,
            preview: Some(tile),
            size: None,
            format: "test".into(),
            levels: vec![],
        };
        let catalog = Catalog {
            entries: vec![
                CatalogEntry::Image(image.clone()),
                CatalogEntry::Image(image),
            ],
        };
        assert_eq!(
            host.transport.block_on(host.choose_image(catalog)).unwrap(),
            1
        );
        assert_eq!(*previews.borrow(), [0, 1]);
    }
}
