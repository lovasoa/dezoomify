//! Last-resort policy for image resources observed by a browser Host.
use super::*;

const MAX_IMAGES: usize = 64;

#[derive(Default)]
pub(super) struct Evidence {
    images: RefCell<Vec<String>>,
    resources: RefCell<HashSet<String>>,
}

impl Evidence {
    pub(super) fn collect(&self, inputs: &[JobInput]) {
        for input in inputs {
            if matches!(
                input.kind,
                Some(DiscoveryInputKind::ObservedResource | DiscoveryInputKind::ObservedImage)
            ) {
                self.resources.borrow_mut().insert(input.url.clone());
            }
            if input.kind == Some(DiscoveryInputKind::ObservedImage) {
                self.image(&input.url);
            }
        }
    }

    fn image(&self, url: &str) {
        let mut images = self.images.borrow_mut();
        if images.len() < MAX_IMAGES && !images.iter().any(|image| image == url) {
            images.push(url.to_owned());
        }
    }

    pub(super) fn into_urls(self) -> Vec<String> {
        self.images.into_inner()
    }

    pub(super) async fn fetch(
        &self,
        request: core::Request,
        interaction: Interaction,
        options: &Options,
        host: &impl Host,
        followed: &RefCell<HashSet<String>>,
    ) -> Result<ResourceRead, Error> {
        let url = request.uri.clone();
        let read = fetch_metadata(request, interaction, options, host, followed).await?;
        // A viewer may fetch a JPEG and put a data: or blob: image in the DOM
        // (RSL #1241). Retain only its already-observed HTTP resource URL.
        if self.resources.borrow().contains(&url)
            && let ResourceRead::Response { response } = &read
            && is_raster(&response.bytes)
        {
            self.image(&url);
        }
        Ok(read)
    }
}

fn is_raster(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"))
}

pub(super) async fn discover(
    urls: Vec<String>,
    options: &Options,
    host: &impl Host,
) -> Result<Option<DiscoveryCatalog>, Error> {
    let mut pending = stream::iter(
        urls.into_iter()
            .take(options.max_tiles as usize)
            .enumerate()
            .map(|(order, url)| async move {
                host.checkpoint(Gate::Cancellation).await?;
                let tile = TileSpec {
                    ordinal: 0,
                    request: core::Request::new(&url),
                    destination: Vec2d::default(),
                    expected_size: None,
                    processing: ProcessingRecipe::None,
                    role: TileRole::probe(),
                };
                let mut remaining = 1;
                let measured = probe(host, tile, &mut remaining).await;
                match measured {
                    Ok(core::ObservationResult::Available { size })
                        if size.x.min(size.y) >= 512 && size.area() >= 2_000_000 =>
                    {
                        Ok(Some((size.area(), std::cmp::Reverse(order), url, size)))
                    }
                    Err(error) if error.is_terminal() => Err(error),
                    _ => Ok(None),
                }
            }),
    )
    .buffer_unordered(options.max_concurrent as usize);
    let mut largest = None;
    while let Some(result) = pending.next().await {
        if let Some(image) = result?
            && largest.as_ref().is_none_or(
                |best: &(u64, std::cmp::Reverse<usize>, String, Vec2d)| {
                    (image.0, image.1) > (best.0, best.1)
                },
            )
        {
            largest = Some(image);
        }
    }
    let Some((_, _, url, dimensions)) = largest else {
        return Ok(None);
    };
    let request = core::Request::new(&url);
    let level = core::ResolvedLevel::grid(dimensions, dimensions, move |_| request.clone())?;
    let catalog = core::ImagePlan::new(core::image_title(&url), vec![level])
        .compile("loaded-image")
        .map_err(discovery_failure)?
        .with_source_url(&url);
    Ok(Some(catalog))
}
