# eMuseum inline IIIF geometry

Synthetic GPL-3.0-or-later reproduction of
[Asian Art Museum's viewer](https://searchcollection.asianart.org/objects/13529/the-sixth-sikh-guru-hargobind-singh)
from the user-supplied HAR in [issue #1296](https://github.com/lovasoa/dezoomify/issues/1296).
Only the initializer's shape is retained; pixels come from the shared tiles.

The viewer supplies dimensions, service URL and tile size through
`emuseum/MediaZoom:init`. Its IIIF tile requests work while `info.json` returns
HTTP 400. The fixture preserves that failure so discovery must use the viewer.
