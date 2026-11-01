export interface LoadedImage {
  url: string;
  width: number;
  height: number;
}

/** Injected without module closures. Prefer identified viewer originals over
 * incidental DOM images; supplied candidates must belong to live scanned documents.
 * Read intrinsic sizes without fetching or decoding. */
export function findLoadedImage(viewerImages: LoadedImage[] = []) {
  let image: LoadedImage | undefined;
  for (const candidate of viewerImages) select(candidate);
  if (image) return { documentUrl: location.href, image };
  for (const img of document.images) {
    const { naturalWidth: width, naturalHeight: height } = img;
    const url = img.currentSrc || img.src;
    if (img.complete && Math.min(width, height) >= 512 && width * height >= 2_000_000)
      select({ url, width, height });
  }
  return { documentUrl: location.href, image };

  function select(candidate: LoadedImage) {
    const { url, width, height } = candidate;
    if (
      Number.isSafeInteger(width) &&
      width > 0 &&
      Number.isSafeInteger(height) &&
      height > 0 &&
      (!image || width * height > image.width * image.height) &&
      ((url.length <= 2048 && /^https?:\/\//.test(url)) ||
        (url.length <= 8 * 1024 * 1024 && /^data:image\/[^;,]+;base64,/.test(url)))
    )
      image = { url, width, height };
  }
}

/** A second fallback: one explicit image download, without guessing its dimensions. */
export function findImageDownloadLink() {
  const urls = new Set<string>();
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[download][href]")) {
    const url = URL.parse(link.href);
    if (
      url &&
      /^https?:$/.test(url.protocol) &&
      url.href.length <= 2048 &&
      /\.(jpe?g|png|webp|gif|avif|tiff?|bmp)$/i.test(url.pathname)
    )
      urls.add(url.href);
  }
  return { documentUrl: location.href, url: urls.size === 1 ? [...urls][0] : undefined };
}
