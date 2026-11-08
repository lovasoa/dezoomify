import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { findImageDownloadLink, findLoadedImage } from "../src/loaded-image.ts";

/** Stub the document the selector reads; sizes come from intrinsic dimensions. */
function withDocument(t, images) {
  const previous = globalThis.document;
  t.after(() => {
    globalThis.document = previous;
  });
  globalThis.document = { images };
}

test("selects a loaded image by intrinsic size, independent of CSS size or URL format", (t) => {
  const image = (width, height, src, complete = true) => ({
    naturalWidth: width,
    naturalHeight: height,
    src,
    complete,
    width: 20,
    height: 20,
  });
  withDocument(t, []);
  const artwork = image(3000, 4000, "https://gallery.example/thumb.jpg");
  artwork.currentSrc = "https://gallery.example/full.jpg";
  document.images = [
    image(512, 512, "https://gallery.example/tile"),
    image(10000, 400, "https://gallery.example/banner"),
    artwork,
    image(5000, 5000, "https://gallery.example/pending", false),
  ];
  assert.deepEqual(findLoadedImage(), {
    url: artwork.currentSrc,
    width: 3000,
    height: 4000,
  });
  document.images = [image(1800, 1200, "data:image/png;base64,AAAA")];
  assert.equal(findLoadedImage().url, document.images[0].src);
  document.images = [image(512, 512, "https://gallery.example/tile")];
  assert.equal(findLoadedImage(), undefined);
});

test("only an unambiguous explicit image download is used as a link fallback", (t) => {
  const url = "https://images.example/full.JPG?download=1";
  const links = [
    `<a href="https://images.example/unmarked.jpg">Ordinary link</a>`,
    `<a download href="https://images.example/catalog.pdf">Catalog</a>`,
    `<a download href="javascript:alert(1)">Invalid</a>`,
  ];
  const scan = (...extra) => {
    globalThis.document = parseHTML(
      `<html><body>${links.concat(extra).join("")}</body></html>`,
    ).document;
    return findImageDownloadLink();
  };
  withDocument(t, undefined);
  assert.equal(scan(), undefined);
  assert.equal(
    scan(`<a download href="${url}">Full image</a>`, `<a download href="${url}">Again</a>`),
    url,
  );
  assert.equal(
    scan(
      `<a download href="${url}">Full image</a>`,
      `<a download href="https://images.example/other.png">Other image</a>`,
    ),
    undefined,
  );
});

test("viewer originals outrank large DOM images without inheriting thumbnail thresholds", (t) => {
  withDocument(t, [
    {
      complete: true,
      naturalWidth: 4000,
      naturalHeight: 3000,
      src: "https://gallery.example/banner.jpg",
    },
  ]);
  const original = { url: "https://images.example/original.jpg", width: 800, height: 600 };
  assert.deepEqual(
    findLoadedImage([
      { ...original, url: "javascript:bad", width: 9000 },
      { ...original, width: 0 },
      { ...original, width: 400 },
      original,
      original,
    ]),
    original,
  );
});
