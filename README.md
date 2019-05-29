# Dezoomify

## Download zoomable images

_Dezoomify_ downloads images from online zoomable image interfaces.
It works with several zoomable image tools, from several different websites (see the list below).

#### Input
The URL of a webpage containing a zoomable image viewer.
#### Output
An image that you can download (by right-clicking on it, and choosing *Save Image as...*).

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
 * [National Gallery](http://www.nationalgallery.org.uk/) : The national gallery uses its own zoomable image format.
 * [Deep Zoom](http://en.wikipedia.org/wiki/Deep_Zoom) : Zoomable image format created by Microsoft. Dezoomify has a special support for the following websites that use *Deep Zoom*:
  * The [British Library](http://www.bl.uk/)
  * The [World Digital Library (WDL)](http://www.wdl.org/fr/)
  * [Polona](http://polona.pl/), the Polish Digital National Library
  * [BALaT](http://balat.kikirpa.be/), Belgian Art Links and Tools
 * [Zoomify single-file format](https://github.com/lovasoa/pff-extract/wiki/Zoomify-PFF-file-format-documentation) : Less common format used by zoomify, where all tiles are in a single *.pff* file, and are queried through a java servlet.
 * [XLimage](http://www.centrica.it/products/xlimage-2/), a zoomable image format developed by an Italian company. It is used on the following websites:
  * The [Royal Library of Belgium](http://kbr.be/)
 * **TopViewer**, also named **Memorix Maior picture viewer** used on the following websites:
  * [daguerreobase](http://daguerreobase.org/en/), a collection of daguerreotypes.
  * [Several dutch websites](https://picturae.com/nl/website/websites-portfolio) developed by the company picturae.
 * [krpano Panorama Viewer](http://krpano.com), mainly used in panoramic images and interactive virtual tours.
 * [The Tretiakov gallery](http://www.tretyakovgallery.ru/en/), official website of the Третьяковская галерея (in Moscow).
 * [FSI Viewer](https://www.neptunelabs.com/products/fsi-viewer/), zoomable image server by NeptuneLabs GmbH.
 * [Visual Library Server](https://www.semantics.de/visual_library/), by semantics
 * [Google Arts & Culture](https://artsandculture.google.com/) (formerly Google Art Project): a cooperation between google and several international museums

Dezoomify also has a
[generic dezoomer](https://github.com/lovasoa/dezoomify/wiki/Dezoomify-FAQ#the-page-uses-an-image-viewer-that-is-not-supported-by-dezoomify-is-there-still-a-chance-).
If the zoomable image format is simple enough, you just have to enter a pattern of tile
URL, and dezoomify will be able to work with it.

## Screenshots
![dezoomify downloading an image](http://pix.toile-libre.org/upload/original/1460096698.gif)

## Video tutorial
[![Video tutorial for dezzomify](http://pix.toile-libre.org/upload/original/1460095793.png)](https://www.youtube.com/watch?v=RtyckiAE5Eo)

# Programming Languages
The aim of the script is to do as much as possible in _Javascript_ (with the HTML5 `<canvas>` tag), and only the network-related stuffs on the server side. The only little piece of server-side code that remains in the code is just a proxy, used to circumvent the [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy).
We implemented this code both in Javascript ([node-app/proxy.js](node-app/proxy.js)) and PHP ([proxy.php](proxy.php)), so you just need to have either one
on your server to run dezoomify.

## Wikimedia
This script on wikimedia : [Zoomify in the help about zoomable Images on wikimedia](https://secure.wikimedia.org/wikipedia/commons/wiki/Help:Zoomable_images)

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
