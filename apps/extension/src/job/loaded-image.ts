/** Injected into the source document; reads intrinsic sizes without fetching or decoding. */
export function findLoadedImage() {
  let image: { url: string; width: number; height: number } | undefined;
  for (const img of document.images) {
    const { naturalWidth: width, naturalHeight: height } = img;
    const url = img.currentSrc || img.src;
    if (
      img.complete &&
      Math.min(width, height) >= 512 &&
      width * height >= 2_000_000 &&
      (!image || width * height > image.width * image.height) &&
      ((url.length <= 2048 && /^https?:\/\//.test(url)) ||
        (url.length <= 8 * 1024 * 1024 && /^data:image\/[^;,]+;base64,/.test(url)))
    )
      image = { url, width, height };
  }
  return { documentUrl: location.href, image };
}
