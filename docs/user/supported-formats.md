# supported-formats

# Supported formats

Zoomable image viewers are built from a handful of underlying formats.
Dezoomify understands the ones below, and picks the right one automatically
from the address you give it — you normally never need to choose. The list
matters when automatic selection fails or when you want to check whether a
site can be supported at all.

Most of these formats are named after the software that serves them. To use
one by hand, paste the address of the page *or* of the small description
file listed below; see [finding the image address](./finding-the-image-address.md)
for how to find that file.

| Format | Used by | What you can paste |
|---|---|---|
| Zoomify | Many museums and libraries | The viewer page, `ImageProperties.xml`, or any tile address |
| Deep Zoom (Seadragon) | Microsoft-style viewers, many digital libraries | The viewer page or the `.dzi` file |
| IIIF | Widely used by national and university libraries | A viewer page, an `info.json` file, or a presentation manifest for whole books |
| Arts & Culture | Google Arts & Culture | The artwork page |
| IIPImage | Image servers recognizable by `FIF=` in addresses | Any address containing `FIF=` |
| TopViewer (Memorix) | Dutch archive portals | The viewer page or a media metadata address |
| krpano | Panoramas and virtual tours | The viewer page or the tour's XML file |
| FSI Viewer | Neptune Labs image servers | The viewer page or the server metadata address |
| LizardTech ImageServer | ImageServer services | A `calcrgn` metadata address |
| Visual Library Server (VLS) | Semantics-based library portals | A `zoom`, `pageview`, or `thumbview` page |
| XLimage | Italian image servers | An `.imgf` or `.imgi` metadata address |
| Hungaricana | Hungarian Cultural Heritage Portal | A gallery page |
| ArcGIS MapServer | Cached map services | The MapServer address |
| WMTS | Geographic map tile services | The capabilities document address |
| pnav | Crop-based image services | An entity page |
| Generic | Any site whose tile addresses follow a simple pattern | A tile address with the two coordinates replaced by `--` |

## Generic

The generic format is the fallback when no named format matches. It needs
tile addresses that differ only by two numbers — the column and the row of
each piece. Paste one tile's address with both numbers replaced by `--`, as
described in [finding the image address](./finding-the-image-address.md#last-resort-describing-the-tile-pattern).

## Is my site supported?

The fastest check is to try it. If it fails, the
[troubleshooting guide](./troubleshooting.md) and
[finding the image address](./finding-the-image-address.md) cover the common
cases. Sites that need a brand-new recipe can be requested by
[opening an issue](https://github.com/lovasoa/dezoomify/issues).
