# Nichibun Mirador regression

`mirador.js.gz` preserves the unmodified [Nichibun bundle](https://iiif.nichibun.ac.jp/IIIF/mirador/mirador.js),
Mirador 2.6.1 built on 2019-11-22 with OpenSeadragon 2.4.1, including its
embedded license notices. It is compressed only to keep the fixture small.
The decompressed SHA-256 is `ec5f94440eed10247eaca2d070cd237288e019037f94ecb0adc14a1a3c263cf3`.

The metadata was captured from [this viewer](https://iiif.nichibun.ac.jp/YSD/detail/002463024.html)
on 2026-10-27. `viewer.html` reduces its initializer; the manifest and image
metadata retain the original addresses and both canvases. Browser tests replay
all requests locally with shared synthetic image tiles and make no live requests.
