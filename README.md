# Dezoomify

[![Dezoomify cover image](./cover.png)](https://ophir.alwaysdata.net/dezoomify/dezoomify.html)

## Download zoomable images

_Dezoomify_ extracts full high-resolution images from online zoomable image interfaces.
It works with several zoomable image tools, from several different websites (see the list below).
It takes as input the URL of a a zoomable image and gives as output an image that you can download (by right-clicking on it, and choosing *Save Image as...*).

In order to find the URL of the zoomable that dezoomify requires, you can install the [**dezoomify browser extension**](https://github.com/lovasoa/dezoomify-extension/#dezoomify-extension). Alternatively, you can also try to [find the zoomable image URL yourself](https://github.com/lovasoa/dezoomify/wiki/Dezoomify-FAQ).

## Try it
If you are not interested in the source code and just want to assemble tiles of (dezoomify) a zoomify-powered image, go there : [**unzoomify an image**](https://ophir.alwaysdata.net/dezoomify/dezoomify.html)

## Troubleshooting
#### FAQ
If you have problems while downloading an image, then read the **[FAQ](https://github.com/lovasoa/dezoomify/wiki/Dezoomify-FAQ)**.
#### Reporting issues
Your bug reports and feature requests are welcome!
Please go the the [Github issue page of the project](https://github.com/lovasoa/dezoomify/issues),
and explain your problem.
Please be clear, and give the URL of the page containing the image dezoomify
failed to process.

## Supported zoomable image formats
The following formats are supported by dezoomify:

* [Zoomify](http://www.zoomify.com/) : Most common zoomable image format. *dezoomify* used to support only this, hence the name.
* [Deep Zoom](http://en.wikipedia.org/wiki/Deep_Zoom) : Zoomable image format created by Microsoft.
* [Arts & Culture](https://artsandculture.google.com/) (formerly Google Art Project): a cooperation between google and several international museums. [More info about the controversy around this dezoomer.](https://github.com/lovasoa/dezoomify/issues/435).
* [IIIF](https://iiif.io): The International Image Interoperability Framework, used on many websites, including [National Gallery](https://www.nationalgallery.org.uk/), [National Library of Israel](https://www.nli.org.il/), and [National Library of Scotland](https://www.nls.uk/).
* [Zoomify single-file format](https://github.com/lovasoa/pff-extract/wiki/Zoomify-PFF-file-format-documentation) : Less common format used by zoomify, where all tiles are in a single *.pff* file, and are queried through a java servlet.
* [XLimage](http://www.centrica.it/products/xlimage-2/), a zoomable image format developed by an Italian company.
* **TopViewer**, also named **Memorix Maior picture viewer**, used by Picturae Memorix sites.
* [krpano Panorama Viewer](http://krpano.com), mainly used in panoramic images and interactive virtual tours.
* [FSI Viewer](https://www.neptunelabs.com/products/fsi-viewer/), zoomable image server by NeptuneLabs GmbH.
* [Visual Library Server](https://www.semantics.de/visual_library/), by semantics
* [Micr.io](https://micr.io/)'s non-IIIF format.
* [Hungaricana](https://hungaricana.hu/en/) a format found only on the **Hungarian Cultural Heritage Portal**, that hosts half a million images.
* [WMTS](https://www.ogc.org/standards/wmts/), the OpenGIS Web Map Tile Service standard.
* Mnesys image viewer.
* PNAV image viewer, used by several museum collection sites.

The most prominent supported websites with live compatibility tests include :
- Arts & Culture (artsandculture.google.com)
- Czech Digital Library (api.ceskadigitalniknihovna.cz)
- Memoire des hommes (memoiredeshommes.defense.gouv.fr)
- National Gallery (nationalgallery.org.uk)
- National Gallery of Victoria (ngv.vic.gov.au)
- CSNTM manuscripts (collections.csntm.org)
- National Library of Australia (nla.gov.au)
- National Library of Israel (nli.org.il)
- National Library of Scotland (nls.uk)
- Academia Sinica Bronze Rubbings (bronze.asdc.sinica.edu.tw)
- Westchester County Archives (collections.westchestergov.com)
- Bibliotheques specialisees de Paris (bibliotheques-specialisees.paris.fr)
- FSI Viewer examples (neptunelabs.com)
- Geographicus (geographicus.com)
- krpano examples (krpano.com)
- Memorix TopViewer sites (images.memorix.nl)
- OpenSeadragon Zoomify examples (openseadragon.github.io)
- PNAV collection sites, including catalog.shm.ru, collection.pushkinmuseum.art, and collection.ethnomuseum.ru


Dezoomify also has a
[generic dezoomer](https://github.com/lovasoa/dezoomify/wiki/Generic-dezoomer-tutorial).
If the zoomable image format is simple enough, you just have to enter a pattern of tile
URL, and dezoomify will be able to work with it.

## Screenshots
![dezoomify downloading an image](https://user-images.githubusercontent.com/552629/95110615-9723ba80-073e-11eb-8845-2ccf6e557480.gif)

## Video tutorial
[![Video tutorial for dezzomify](http://pix.toile-libre.org/upload/original/1460095793.png)](https://www.youtube.com/watch?v=RtyckiAE5Eo)

# Programming Languages
The aim of the script is to do as much as possible in _Javascript_ (with the HTML5 `<canvas>` tag), and only the network-related stuffs on the server side. The only little piece of server-side code that remains in the code is just a proxy, used to circumvent the [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy).
The proxy is implemented in Javascript as a Cloudflare Pages Function ([functions/proxy.js](functions/proxy.js)) and reused by the Node app through [node-app/proxy.js](node-app/proxy.js).

## Wikimedia
This script on wikimedia : [Zoomify in the help about zoomable Images on wikimedia](https://secure.wikimedia.org/wikipedia/commons/wiki/Help:Zoomable_images)

## Local development

The browser app is static, but it expects a `/proxy` endpoint. Cloudflare Pages serves [functions/proxy.js](functions/proxy.js) at that route. The deterministic test server in [tests/fixture-server.js](tests/fixture-server.js) also provides a fixture-backed `/proxy` route for local tests.

Run deterministic tests from [tests](tests):

```sh
npm test
```

Run live compatibility checks manually:

```sh
npm run test:live
```

Live compatibility tests intentionally touch real websites and run the browser app against each URL. They fail when automatic detection, metadata loading, or the first tile load breaks. Do not use live-only behavior as the sole regression coverage for a dezoomer; keep deterministic fixtures in [tests/dezoomers.spec.js](tests/dezoomers.spec.js) for protocol behavior, and use [tests/live-compat.spec.js](tests/live-compat.spec.js) to notice when real-world examples have changed.

## GPL
> Copyright © 2011-2017 Lovasoa
>
>  This file is part of Dezoomify.
>
>  Dezoomify is free software; you can redistribute it and/or modify
>  it under the terms of the GNU General Public License as published by
>  the Free Software Foundation; either version 2 of the License, or
>  (at your option) any later version.
>
>  Dezoomify is distributed in the hope that it will be useful,
>  but WITHOUT ANY WARRANTY; without even the implied warranty of
>  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
>  GNU General Public License for more details.
>
>  You should have received a copy of the GNU General Public License
>  along with Dezoomify; if not, write to the Free Software
>  Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301
>  USA*/
