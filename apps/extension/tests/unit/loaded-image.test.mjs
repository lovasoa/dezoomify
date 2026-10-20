import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { findImageDownloadLink, findLoadedImage } from "../../src/job/loaded-image.ts";

test("selects a loaded image by intrinsic size, independent of CSS size or URL format", (t) => {
  const image = (width, height, src, complete = true) => ({
    naturalWidth: width,
    naturalHeight: height,
    src,
    complete,
    width: 20,
    height: 20,
  });
  const previous = { location: globalThis.location, document: globalThis.document };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.location = { href: "https://gallery.example/" };
  globalThis.document = { images: [] };
  const artwork = image(3000, 4000, "https://gallery.example/thumb.jpg");
  artwork.currentSrc = "https://gallery.example/full.jpg";
  document.images = [
    image(512, 512, "https://gallery.example/tile"),
    image(10000, 400, "https://gallery.example/banner"),
    artwork,
    image(5000, 5000, "https://gallery.example/pending", false),
  ];
  assert.deepEqual(findLoadedImage().image, { url: artwork.currentSrc, width: 3000, height: 4000 });
  document.images = [image(1800, 1200, "data:image/png;base64,AAAA")];
  assert.equal(findLoadedImage().image.url, document.images[0].src);
  document.images = [image(512, 512, "https://gallery.example/tile")];
  assert.equal(findLoadedImage().image, undefined);
});

test("only an unambiguous explicit image download is used as a link fallback", (t) => {
  const previous = { location: globalThis.location, document: globalThis.document };
  t.after(() => Object.assign(globalThis, previous));
  globalThis.location = { href: "https://gallery.example/" };
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
    return findImageDownloadLink().url;
  };
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
