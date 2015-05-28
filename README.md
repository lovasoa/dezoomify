#Dezoomify
#Download zoomable images

_Dezoomify_ makes a downloadable image from an image viewable via a flash or html5 zoomable image interface.
It works with several different zommable image tools, from several different websites (see the list below). 

Input : the URL of a site containing a zoomable image viewer.

Output : An image that you can download (by right-clicking on it, and choosing *Save Image as...*).

## Try it
If you are not interested in the source code and just want to assemble tiles of (dezoomify) a zoomify-powered image, go there : [unzoomify an image](http://ophir.lojkine.free.fr/dezoomify/dezoomify.html)

## Supported zoomable image formats
The following formats are supported by dezzomify:
 * [Zoomify](http://www.zoomify.com/) : Most common zoomable image format. *dezoomify* used to support only this, hence the name.
 * [National Gallery](http://www.nationalgallery.org.uk/) : The national gallery uses its own zoomable image format.
 * [Deep Zoom](http://en.wikipedia.org/wiki/Deep_Zoom) : Zoomable image format created by Microsoft. Dezoomify has a special support for the following websites that use *Deep Zoom*:
  * The [British Library](http://www.bl.uk/)
  * The [World Digital Library (WDL)](http://www.wdl.org/fr/)
 * [Zoomify single-file format](https://github.com/lovasoa/dezoomify/wiki/PFF-format-description) : Less common format used by zoomify, where all tiles are in a single *.pff* file, and are queried through a java servlet.

## Screenshots
![dezoomify main page, a zoomable image downloader](http://pix.toile-libre.org/upload/original/1432804561.png)
![dezoomify downloading an image](http://pix.toile-libre.org/upload/original/1432805025.png)

#Programming Languages
The aim of the script is to do as much as possible in _Javascript_ (with the HTML5 `<canvas>` tag), and only the network-related stuffs on the server side (in this case, _PHP_). The only little piece of _PHP_ that remains in the code is just a proxy, used to circumvent the [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy).

#Wikimedia
This script on wikimedia : [Zoomify in the help about zoomable Images on wikimedia](https://secure.wikimedia.org/wikipedia/commons/wiki/Help:Zoomable_images)

#GPL
> Copyright © 2011-2014 Lovasoa
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
