/******************/
/*Module: ZoomTool*/
/******************/
var g_aZoomTool = [];

function ZoomTool(id) {
    this.container = document.getElementById(id);
    if (!this.container)
        return;
    this.data = ZoomTool.parseData(this.container);
    this.fallbackImage;
    this.viewport;
    this.tiles;
    this.main;
    this.controls;
    this.mark;
    this.pressed = false;
    this.ticker = 0;
    this.ie = (navigator.userAgent.search(/MSIE/i) > -1);
    this.ieVersion = -1;
    if (this.ie) {
        var ua = navigator.userAgent;
        var re = new RegExp("MSIE ([0-9]{1,}[\.0-9]{0,})");
        if (re.exec(ua) != null)
            this.ieVersion = parseFloat(RegExp.$1);
    }
    this.safari = (navigator.userAgent.search(/Safari/i) > -1);
    this.grabCursor = (navigator.userAgent.search(/KHTML|Opera|MSIE/i) > -1 ? 'pointer' : '-moz-grab');
    this.dragCursor = (navigator.userAgent.search(/KHTML|Opera|MSIE/i) > -1 ? 'move' : '-moz-grabbing');
    this.cache = {};
    this.map = null;
    this.area = null;
    this.tilePath =
        (this.data.siteWebRoot != undefined ? this.data.siteWebRoot : "/") + "custom/ng/tile.php?id=";
    this.idCache = {};
    this.previousZoom = this.data.zoom;
    this.fadeTime = this.data.fade != undefined ? this.data.fade : 20;
    this.draw = true;
    this.links = {};
    this.obfuscateCache = {};
    this.dimensionCache = {};
    this.attach();
}
ZoomTool.parseData = function (container) {
    var data = {};
    for (var i = 0; i < container.childNodes.length; i++) {
        if (container.childNodes[i].className == 'data') {
            var dl = container.childNodes[i];
            for (var n = 0; n < dl.childNodes.length; n = n + 2) {
                var val = dl.childNodes[n + 1].innerHTML;
                if (!isNaN(val)) val = val / 1;
                if (val == "false") val = 0;
                data[dl.childNodes[n].innerHTML] = val;
            }
            break;
        }
    }
    /**
     * http://boxuk.unfuddle.com/projects/15733/tickets/by_number/6?cycle=true
     *
     * (kludgy) fix for:
     *
     * "If you zoom in then switch to full screen it centres the full screen
     * image on the top left point you had on the painting page, which is OK
     * but centre to centre would make more sense."
     *
     * @todo tidy this up - remove magic numbers
     */
    if (data.x != 0 && data.y != 0) {
        data.x -= (document.documentElement.clientWidth / data.levelStep) - 240;
        data.y -= (document.documentElement.clientHeight / data.levelStep) - 232;
    }
    return data;
};
ZoomTool.prototype = {
    attach: function () {
        if (this.ie) {
            document.body.ondragstart = function () {
                return false;
            };
        }
        var divs = this.container.getElementsByTagName('DIV');
        for (var i = 0; i < divs.length; i++) {
            var child = divs[i];
            var childClass = child.className.substr(0, child.className.indexOf(' ') != -1 ? child.className.indexOf(' ') : child.className.length);
            switch (childClass) {
            case 'map':
                this.setMap(child);
                break;
            case 'tiles':
                this.tiles = child;
                break;
            case 'viewport':
                this.viewport = child;
                break;
            case 'main':
                this.main = child;
                break;
            case 'controls':
                this.setControls(child);
                break;
            case 'footer':
                this.footer = child;
                break;
            }
        }
        this.mark = {
            x: this.data.x,
            y: this.data.y
        };
        for (var t = 0; t < this.tiles.childNodes.length; t++) {
            var tile = this.tiles.childNodes[t];
            var tileId = tile.src.substr(tile.src.indexOf('id=') + 3);
            tile.tileId = tileId;
            tile.zoom = this.data.zoom;
            tile.tileLoaded = true;
            tile.self = this;
            if (this.ie) {
                tile.oncontextmenu = function () {
                    return false;
                };
                tile.onmousedown = this.onMouseDown;
                tile.ondblclick = this.onMouseDoubleClick;
                if (this.grabCursor)
                    tile.style.cursor = this.grabCursor;
                tile.unselectable = 'on';
            }
            this.cache[tileId] = tile;
        }
        this.viewport.self = this;
        this.viewport.onmousedown = this.onMouseDown;
        this.viewport.onmouseup = this.viewport.onmouseout = this.onMouseUp;
        if (window.addEventListener) {
            window.addEventListener('DOMMouseScroll', ZoomTool.onMouseWheel, false);
        } else {
            window.onmousewheel = document.onmousewheel = ZoomTool.onMouseWheel;
        }
        if (this.ie) {
            document.attachEvent('onkeypress', ZoomTool.onKeyPress);
            document.attachEvent('onkeydown', ZoomTool.onKeyDown);
        } else {
            window.onkeypress = ZoomTool.onKeyPress;
            window.onkeydown = ZoomTool.onKeyDown;
        }
        if (this.grabCursor)
            this.viewport.style.cursor = this.grabCursor;
        this.setArrowAmount();
        g_aZoomTool[g_aZoomTool.length] = this;
        this.updateMap();
        this.updateControls();
        /**
         * To get around the problem of National Gallery using their own images
         * rather than the automatically generated ones they should be using,
         * grab hold of the original image. When the user zooms in and out we'll either
         * 1) Use this image when the zoom level is 1, or
         * 2) Use the automatically generated images when the zoom level is greater than 1
         * Doesn't apply in full screen.
         *
         * See this.getFallbackImage() and this.positionTiles()
         */
        if (this.data.fullscreen) {
            this.setupFullscreen();
        } else {
            var p_oThis = this;
            $(document).ready(
                function () {
                    p_oThis.fallbackImage = p_oThis.getFallbackImage('.tiles > .tile');
                    /**
                     * Replace the original image with the manipulated copy
                     * (manipulating the original image itself is buggy)
                     */
                    /*$('.tiles').empty().append(
p_oThis.fallbackImage
);*/
                }
            );
        }
    },
    setArrowAmount: function () {
        this.arrowAmount = {
            x: this.viewport.clientWidth / 6,
            y: this.viewport.clientHeight / 6
        };
    },
    setControls: function (controls) {
        if (controls.className.indexOf('controlsRight') != -1)
            this.controlsRight = controls;
        else
            this.controlsBottom = controls;
        var links = controls.getElementsByTagName('A');
        for (var n = 0; n < links.length; n++) {
            var link = links[n];
            var self = this;
            this.links[link.className] = link;
            switch (link.className) {
            case 'zoomIn':
                link.onclick = function (e) {
                    self.zoom(+1);
                    var evt = e || window.event;
                    if (evt.preventDefault) {
                        evt.preventDefault();
                    } else {
                        evt.returnValue = false;
                        evt.cancelBubble = true;
                    }
                };
                break;
            case 'zoomOut':
                link.onclick = function (e) {
                    self.zoom(-1);
                    var evt = e || window.event;
                    if (evt.preventDefault) {
                        evt.preventDefault();
                    } else {
                        evt.returnValue = false;
                        evt.cancelBubble = true;
                    }
                };
                break;
            case 'moveRight':
                link.onclick = function (e) {
                    self.move('right');
                    var evt = e || window.event;
                    if (evt.preventDefault) {
                        evt.preventDefault();
                    } else {
                        evt.returnValue = false;
                        evt.cancelBubble = true;
                    }
                };
                break;
            case 'moveUp':
                link.onclick = function (e) {
                    self.move('up');
                    var evt = e || window.event;
                    if (evt.preventDefault) {
                        evt.preventDefault();
                    } else {
                        evt.returnValue = false;
                        evt.cancelBubble = true;
                    }
                };
                break;
            case 'moveDown':
                link.onclick = function (e) {
                    self.move('down');
                    e.preventDefault();
                };
                break;
            case 'moveLeft':
                link.onclick = function (e) {
                    self.move('left');
                    var evt = e || window.event;
                    if (evt.preventDefault) {
                        evt.preventDefault();
                    } else {
                        evt.returnValue = false;
                        evt.cancelBubble = true;
                    }
                };
                break;
            case 'reset':
                link.onclick = function (e) {
                    self.reset();
                    var evt = e || window.event;
                    if (evt.preventDefault) {
                        evt.preventDefault();
                    } else {
                        evt.returnValue = false;
                        evt.cancelBubble = true;
                    }
                };
                break;
            case 'fullscreen':
                link.onclick = function (e) {
                    self.fullscreen();
                    var evt = e || window.event;
                    if (evt.preventDefault) {
                        evt.preventDefault();
                    } else {
                        evt.returnValue = false;
                        evt.cancelBubble = true;
                    }
                };
                break;
            }
        }
        var divs = controls.getElementsByTagName('DIV');
        var numDivs = divs.length;
        for (var n = 0; n < numDivs; n++) {
            if (divs[n].className == 'slider') {
                this.setSlider(divs[n]); /* break; */
            } else if (divs[n].className == 'sliderBounds') {
                this.setSliderBounds(divs[n]);
            }
        }
    },
    setMap: function (map) {
        this.map = map;
        this.map.self = this;
        this.map.onmousedown = this.onMapMouseDown;
        this.area = map.getElementsByTagName('DIV')[0].getElementsByTagName('DIV')[0];
        this.area.self = this;
    },
    setSliderBounds: function (sliderBounds) {
        var me = this;
        sliderBounds.onmousedown = function (e) {
            e = e ? e : window.event;
            pos = me.getCoords(e, sliderBounds.parentNode);
            if (!pos.y || pos.y < 0)
                return false;
            var slideMax = me.data.viewportCY - me.data.slideMargin;
            var slideStep = slideMax / me.data.max;
            var slidePos = Math.floor(me.data.max - (pos.y / slideStep) + 1);
            if (slidePos != me.data.zoom) {
                me.zoom(slidePos > me.data.zoom ? 1 : -1);
            }
            return false;
        };
    },
    setSlider: function (slider) {
        this.slider = slider;
        var me = this;
        slider.onmousedown = function (e) {
            e = e ? e : window.event;
            slider.dragging = true;
            slider.parentNode.style.cursor = 'pointer';
            slider.parentNode.onmousemove = function (e) {
                e = e ? e : window.event;
                pos = me.getCoords(e, slider.parentNode);
                if (!pos.y || pos.y < 0)
                    return false;
                var offsetHeight = slider.getElementsByTagName('IMG')[0].offsetHeight;
                if (pos.y > (slider.parentNode.offsetHeight - offsetHeight))
                    pos.y = (slider.parentNode.offsetHeight - offsetHeight);
                me.setSliderPadding(pos.y);
                var slideMax = me.data.viewportCY - me.data.slideMargin;
                var slideStep = slideMax / me.data.max;
                var slidePos = Math.floor(me.data.max - (pos.y / slideStep) + 1);
                if (slidePos != me.data.zoom) {
                    me.zoom(slidePos > me.data.zoom ? 1 : -1);
                }
                return false;
            };
            slider.parentNode.onmouseup = function (e) {
                me.stopSliderDragging();
            };
            document.onmouseup = function (e) {
                me.stopSliderDragging();
            };
            return false;
        };
    },
    stopSliderDragging: function () {
        this.slider.parentNode.onmousemove = function () {};
        this.slider.parentNode.onmouseup = function () {};
        this.slider.dragging = false;
        this.slider.parentNode.style.cursor = 'default';
        document.onmouseup = function () {};
        return false;
    },
    setupFullscreen: function () {
        this.footer.style.position = 'absolute';
        this.footer.style.positionTop = '-1000px';
        this.footer.style.display = 'block';
        this.footerHeight = this.footer.offsetHeight;
        this.footer.style.display = 'none';
        this.data.slideMargin += 30;
        this.resize();
        this.main.style.display = 'block';
        this.controlsRight.style.display = 'block';
        this.data.x += (this.data.viewportCX / this.data.levelStep);
        this.data.y += (this.data.viewportCY / this.data.levelStep);
        this.positionTiles({
            x: this.data.x,
            y: this.data.y
        }, true, true, false);
        var self = this;
        window.onresize = function () {
            self.resize();
            self.positionTiles({
                x: self.data.x,
                y: self.data.y
            }, true, true, false);
        };
    },
    resize: function () {
        var clientHeight = (document.documentElement.clientHeight - (17 * 2) - this.footerHeight);
        var clientWidth = document.documentElement.lastChild.clientWidth;
        this.data.viewportCX = clientWidth;
        this.data.viewportCY = clientHeight;
        this.main.parentNode.style.height = clientHeight + 'px';
        this.main.style.height = clientHeight + 'px';
        this.controlsRight.style.height = clientHeight + 'px';
        this.slider.parentNode.style.height = (clientHeight - this.data.slideMargin) + 'px';
        this.main.parentNode.style.width = clientWidth + 'px';
        this.main.style.width = (clientWidth - 36) + 'px';
        this.footer.style.positionBottom = '17px';
        this.footer.style.positionLeft = '17px';
        this.footer.style.display = 'block';
        this.footer.style.width = (clientWidth - 5 - 165) + 'px';
    },
    getCoords: function (e, relativeTo) {
        var offset = {
            left: 0,
            top: 0
        };
        for (var parentNode = relativeTo; parentNode; parentNode = parentNode.offsetParent) {
            offset.top += parentNode.offsetTop;
            offset.left += parentNode.offsetLeft;
        }
        return {
            'x': (e.pageX || (e.clientX + (document.documentElement.scrollLeft || document.body.scrollLeft))) - offset.left,
            'y': (e.pageY || (e.clientY + (document.documentElement.scrollTop || document.body.scrollTop))) - offset.top
        };
    },
    getDimensions: function () {
        var dimensions = this.dimensionCache[this.data.zoom];
        if (!dimensions) {
            var width = (this.data.nw ? this.data.nw : this.data.width / Math.pow(this.data.levelStep, this.data.max - this.data.zoom));
            var height = (this.data.nh ? this.data.nh : this.data.height / Math.pow(this.data.levelStep, this.data.max - this.data.zoom));
            dimensions = this.dimensionCache[this.data.zoom] = {
                width: width,
                height: height,
                rows: Math.ceil(height / this.data.tileSize),
                cols: Math.ceil(width / this.data.tileSize)
            };
        }
        return dimensions;
    },
    reset: function () {
        if (window.stop)
            window.stop();
        this.draw = false;
        this.tiles.innerHTML = '';
        this.cache = {};
        while (this.data.zoom > 1) {
            this.zoom(-1);
        }
        this.draw = true;
        this.clear();
        this.positionTiles({
            x: this.data.x,
            y: this.data.y
        }, true, true, false);
        return false;
    },
    zoom: function (direction) {
        var newLevel = this.data.zoom + direction;
        if (newLevel < 1 || newLevel > this.data.max) {
            return false;
        }
        var dimensions = this.getDimensions();
        var multiplier;
        if (direction == 1) {
            multiplier = this.data.levelStep;
        } else {
            multiplier = 1 / this.data.levelStep;
        }
        var coords = {
            'x': Math.floor(this.viewport.offsetWidth / 2),
            'y': Math.floor(this.viewport.offsetHeight / 2)
        };
        var offset = {
            'x': coords.x - this.data.x,
            'y': coords.y - this.data.y
        };
        var newOffset = {
            'x': Math.floor(offset.x * multiplier),
            'y': Math.floor(offset.y * multiplier)
        };
        this.data.x = coords.x - newOffset.x;
        this.data.y = coords.y - newOffset.y;
        this.previousZoom = this.data.zoom;
        this.data.zoom = newLevel;
        this.data.nw = (this.data.width / Math.pow(this.data.levelStep, this.data.max)) * (Math.pow(this.data.levelStep, this.data.zoom));
        this.data.nh = (this.data.height / Math.pow(this.data.levelStep, this.data.max)) * (Math.pow(this.data.levelStep, this.data.zoom));
        this.clear();
        this.positionTiles({
            x: this.data.x,
            y: this.data.y
        }, true, true, true);
        return false;
    },
    updateControls: function () {
        if (this.slider && !this.slider.dragging) {
            var slideMax = this.data.viewportCY - this.data.slideMargin;
            var slideOffset = (slideMax - this.slider.childNodes[0].offsetHeight) - ((slideMax - this.slider.childNodes[0].offsetHeight) / (this.data.max - 1) * (this.data.zoom - 1));
            this.setSliderPadding(Math.round(slideOffset));
        }
        if (this.links['zoomIn'])
            this.links['zoomIn'].className = 'zoomIn' + (this.data.zoom + 1 > this.data.max ? ' disabled' : '');
        if (this.links['zoomOut'])
            this.links['zoomOut'].className = 'zoomOut' + (this.data.zoom - 1 < 1 ? ' disabled' : '');
        var dimensions = this.getDimensions();
        if (this.links['moveLeft'])
            this.links['moveLeft'].className = 'moveLeft' + (this.data.x >= 0 ? ' disabled' : '');
        if (this.links['moveUp'])
            this.links['moveUp'].className = 'moveUp' + (this.data.y >= 0 ? ' disabled' : '');
        if (this.links['moveRight'])
            this.links['moveRight'].className = 'moveRight' + (this.data.x <= -(dimensions.width - this.viewport.offsetWidth) ? ' disabled' : '');
        if (this.links['moveDown'])
            this.links['moveDown'].className = 'moveDown' + (this.data.y <= -(dimensions.height - this.viewport.offsetHeight) ? ' disabled' : '');
    },
    checkBounds: function (coords, dimensions) {
        if (coords.y > 0) {
            if (dimensions.height < this.viewport.offsetHeight)
                coords.y = (this.viewport.offsetHeight - dimensions.height) / 2;
            else
                coords.y = 0;
        } else if (coords.y < -(dimensions.height - this.viewport.offsetHeight)) {
            if (dimensions.height < this.viewport.offsetHeight)
                coords.y = (this.viewport.offsetHeight - dimensions.height) / 2;
            else
                coords.y = -(dimensions.height - this.viewport.offsetHeight);
        }
        if (coords.x > 0) {
            if (dimensions.width < this.viewport.offsetWidth)
                coords.x = (this.viewport.offsetWidth - dimensions.width) / 2;
            else
                coords.x = 0;
        } else if (coords.x < -(dimensions.width - this.viewport.offsetWidth)) {
            if (dimensions.width < this.viewport.offsetWidth)
                coords.x = (this.viewport.offsetWidth - dimensions.width) / 2;
            else
                coords.x = -(dimensions.width - this.viewport.offsetWidth);
        }
        return coords;
    },
    getFallbackImage: function (p_selector) {
        var originalImage = $(p_selector);
        $imageHeight = originalImage.height();
        $imageWidth = originalImage.width();
        $viewportHeight = this.viewport.clientHeight;
        $viewportWidth = this.viewport.clientWidth;
        if ($imageHeight > $imageWidth) {
            $scaleFactor = $viewportHeight / $imageHeight;
        } else {
            $scaleFactor = $viewportHeight / $imageHeight;
            if ($imageWidth * $scaleFactor > $viewportWidth) {
                $scaleFactor = $viewportWidth / $imageWidth;
            }
        }
        $imageWidth = $imageWidth * $scaleFactor;
        $imageHeight = $imageHeight * $scaleFactor;
        $offsetLeft = ($viewportWidth - $imageWidth) / 2;
        $offsetTop = ($viewportHeight - $imageHeight) / 2;
        fallbackImage = originalImage.clone();
        fallbackImage.css({
            'margin': '0px',
            'padding': '0px',
            'top': $offsetTop + 'px',
            'left': $offsetLeft + 'px',
            'width': $imageWidth + 'px',
            'height': $imageHeight + 'px'
        });
        return fallbackImage;
    },
    positionTiles: function (coords, checkBounds, addMissing, forceFade) {
        var dimensions = this.getDimensions();
        if (checkBounds) {
            coords = this.checkBounds(coords, dimensions);
        }
        var tileNum = 0;
        var rows = dimensions.rows;
        var cols = dimensions.cols;
        var loadTiles = [];
        var loadTile = 0;
        for (var c = 0; c < cols; c++) {
            for (var r = 0; r < rows; r++) {
                var tx = Math.floor(coords.x + (c * this.data.tileSize));
                var ty = Math.floor(coords.y + (r * this.data.tileSize));
                var visible = (
                    tx + this.data.tileSize > 0 && tx < this.viewport.offsetWidth &&
                    ty + this.data.tileSize > 0 && ty < this.viewport.offsetHeight
                );
                var preload = (
                    tx + this.data.tileSize > -this.viewport.offsetWidth &&
                    tx + this.viewport.offsetWidth < this.viewport.offsetWidth &&
                    ty + this.data.tileSize > -this.viewport.offsetHeight &&
                    ty + this.viewport.offsetHeight < this.viewport.offsetHeight
                );
                var tileId = this.getTileId(this.data.contentId, this.data.zoom, r, c);
                var tile = this.cache[tileId];
                if (!visible) {
                    if (tile) {
                        for (var t = 0; t < this.tiles.childNodes.length; t++) {
                            if (this.tiles.childNodes[t].tileId == tile.tileId)
                                this.tiles.removeChild(tile);
                        }
                    }
                    continue;
                }
                if (!tile && addMissing) {
                    if (this.data.zoom == 1 && this.data.firstLevel == 'untiled' && (c > 0 || r > 0)) {
                        continue;
                    }
                    tile = this.cache[tileId] = document.createElement('img');
                    tile.tileId = tileId;
                    tile.className = 'tile';
                    tile.self = this;
                    tile.zoom = this.data.zoom;
                    tile.tiles = this.tiles;
                    tile.alt = '';
                    if (this.draw && this.fadeTime) {
                        this.startTileFade(tile);
                    }
                    var visibleX = this.data.tileSize;
                    if (tx < 0) {
                        visibleX += tx;
                    } else if (tx + this.data.tileSize > this.viewport.offsetWidth) {
                        visibleX -= (tx + this.data.tileSize) - this.viewport.offsetWidth;
                    }
                    var visibleY = this.data.tileSize;
                    if (ty < 0) {
                        visibleY += ty;
                    } else if (ty + this.data.tileSize > this.viewport.offsetHeight) {
                        visibleY -= (ty + this.data.tileSize) - this.viewport.offsetHeight;
                    }
                    var visiblePixels = visibleX * visibleY;
                    loadTiles[loadTile++] = [tile, tileId, visiblePixels];
                    if (this.ie) {
                        tile.onmousedown = this.onMouseDown;
                        tile.ondblclick = this.onMouseDoubleClick;
                        tile.oncontextmenu = function () {
                            return false;
                        };
                        tile.unselectable = 'on';
                    }
                } else if (tile && forceFade && this.draw && this.fadeTime) {
                    this.startTileFade(tile);
                }
                if (tile) {
                    var present = false;
                    var numTiles = this.tiles.childNodes.length;
                    for (var t = 0; t < numTiles; t++) {
                        if (this.tiles.childNodes[t].tileId == tile.tileId) {
                            present = true;
                            break;
                        }
                    }
                    if (!present && this.draw)
                        this.tiles.appendChild(tile);
                    tile.style.left = tx + 'px';
                    tile.style.top = ty + 'px';
                }
            }
        }
        if (this.fallbackImage && this.data.zoom == 1) {
            $('.tiles').empty().append(
                this.fallbackImage
            )
        } else {
            loadTiles.sort(this.sortTiles);
            var numLoadTiles = loadTiles.length;
            for (var t = 0; t < numLoadTiles; t++) {
                loadTiles[t][0].src = this.tilePath + loadTiles[t][1];
            }
        }
        this.data.x = coords.x;
        this.data.y = coords.y;
        this.updateMap();
        this.updateControls();
        return coords;
    },
    sortTiles: function (a, b) {
        return a[2] == b[2] ? 0 : (a[2] > b[2] ? -1 : 1);
    },
    startTileFade: function (tile) {
        this.setOpacity(tile, 1);
        if (tile.tileLoaded) {
            var thisTile = tile;
            tile.intervalId = window.setInterval(function () {
                thisTile.self.fade(thisTile.self, thisTile);
            }, tile.self.fadeTime);
        } else {
            tile.onload = function () {
                var thisTile = this;
                this.intervalId = window.setInterval(function () {
                    thisTile.self.fade(thisTile.self, thisTile);
                }, this.self.fadeTime);
                this.onload = function () {};
                this.tileLoaded = true;
                return true;
            };
        }
    },
    setOpacity: function (object, value) {
        if (value < 1 || value > 10) value = 10;
        object.style.opacity = value / 10;
        if (this.ie)
            object.style.filter = 'alpha(opacity=' + (value * 10) + ')';
    },
    getOpacity: function (object) {
        var opacity = 10;
        if (object.style.opacity) {
            opacity = (object.style.opacity * 10);
        } else if (object.style.filter) {
            var filter = object.style.filter;
            var key = 'opacity=';
            var value = filter.substring(filter.indexOf(key) + key.length);
            value = value.substring(0, value.indexOf(')'));
            if (value) {
                opacity = (value / 10);
            }
        }
        return opacity;
    },
    fade: function (self, tile) {
        var opacity = self.getOpacity(tile);
        if (opacity < 10) {
            self.setOpacity(tile, opacity + 2);
        } else if (tile.intervalId) {
            window.clearInterval(tile.intervalId);
        }
    },
    clear: function () {
        for (var i = 0; i < this.tiles.childNodes.length;) {
            var tile = this.tiles.childNodes[i];
            if (tile.tagName == 'IMG') {
                if (tile.zoom != this.data.zoom) {
                    this.tiles.removeChild(tile);
                    continue;
                }
            }
            i++;
        }
    },
    getTileId: function (contentId, zoom, r, c) {
        var key = contentId + ',' + zoom + ',' + r + ',' + c;
        var id = this.idCache[key];
        if (!id) {
            id = this.idCache[key] = this.obfuscate(
                this.pad(r, 2) +
                this.pad(contentId, 5) +
                this.pad(c, 2) +
                this.pad(zoom, 2)
            );
        }
        return id;
    },
    pad: function (value, chars) {
        return ('00000' + value).substr(-chars);
    },
    obfuscate: function (value) {
        var result = this.obfuscateCache[value];
        if (!result) {
            var from = '0123456789';
            var to = 'vRfOdXapKz';
            var keylen = from.length;
            var valuelen = value.length;
            var result = '';
            for (var i = 0; i < valuelen; i++) {
                for (var n = 0; n < keylen; n++) {
                    if (value.charAt(i) == from.charAt(n)) {
                        result = result + to.charAt(n);
                        break;;
                    }
                }
            }
            this.obfuscateCache[value] = result;
        }
        return result;
    },
    onMouseDown: function (e) {
        e = e ? e : window.event;
        if (e.button > 1) return false;
        var self = this.self;
        if (!self) return false;
        var coords = self.getCoords(e, self.viewport);
        if (
            coords.x < 0 || coords.x > self.viewport.offsetWidth ||
            coords.y < 0 || coords.y > self.viewport.offsetHeight
        ) {
            e.cancelBubble = true;
            if (self.grabCursor)
                self.viewport.style.cursor = self.grabCursor;
        } else {
            self.pressed = true;
            if (self.ie && e.srcElement.tagName == 'IMG') {
                e.srcElement.onmousemove = (self.pressed ? self.onMouseMove : function () {});
                e.srcElement.onmouseup = (self.pressed ? self.onMouseUp : function () {});
                for (t = 0; t < self.tiles.childNodes.length; t++) {
                    self.tiles.childNodes[t].onmousemove = (self.pressed ? self.onMouseMove : function () {});
                    self.tiles.childNodes[t].onmouseup = (self.pressed ? self.onMouseUp : function () {});
                    if (self.grabCursor)
                        self.tiles.childNodes[t].style.cursor = self.grabCursor;
                    self.tiles.unselectable = true;
                }
            } else {
                self.viewport.onmousemove = (self.pressed ? self.onMouseMove : function () {});
            }
            self.mark = {
                x: coords.x - self.data.x,
                y: coords.y - self.data.y
            };
            if (self.dragCursor)
                self.viewport.style.cursor = self.dragCursor;
        }
        return false;
    },
    onMouseMove: function (e) {
        e = e ? e : window.event;
        var self = this.self;
        if (!self) return false;
        self.ticker++;
        if (self.ticker % 2 == 0) {
            var move = self.getCoords(e, self.viewport);
            if (
                move.x < 0 || move.x > self.viewport.offsetWidth ||
                move.y < 0 || move.y > self.viewport.offsetHeight
            ) {
                self.onMouseUp(e);
                /*
http://boxuk.unfuddle.com/projects/15733/tickets/by_number/3?cycle=true
If the user clicks in and then drags out of the thumbnail
subsequent mouse moves over the thumbnail act as �drag� actions.
(A mouse down and mouse up on the thumbnail fixes this so looks
like a need to react to �mouse leave� as well as �mouse up�?)
*/
                for (t = 0; t < self.tiles.childNodes.length; t++) {
                    var tile = self.tiles.childNodes[t];
                    tile.onmousemove = function () {};
                    tile.onmouseup = function () {};
                }
                self.viewport.onmousemove = function () {};
            }
            var coords = {
                x: move.x - self.mark.x,
                y: move.y - self.mark.y
            };
            self.positionTiles(coords, true, true, false);
        }
        return false;
    },
    onMouseUp: function (e) {
        var self = this.self;
        if (!self) {
            return true;
        }
        if (self.pressed) {
            self.pressed = false;
            if (self.ie) {
                for (t = 0; t < self.tiles.childNodes.length; t++) {
                    var tile = self.tiles.childNodes[t];
                    tile.onmousemove = function () {};
                    tile.onmouseup = function () {};
                }
            }
            self.viewport.onmousemove = function () {};
            if (self.grabCursor)
                self.viewport.style.cursor = self.grabCursor;
        }
        return false;
    },
    onMouseDoubleClick: function (e) {
        e = e ? e : window.event;
        var self = this.self;
        if (!self)
            return;
        if (self.data.zoom == self.data.max)
            return;
        var target = self.getTarget(e);
        if (!(target.className == 'tile' || target.className == 'viewport')) {
            return;
        }
        var point = self.getCoords(e, self.viewport);
        var coords = {
            x: (self.viewport.offsetWidth / 2) - (point.x - self.data.x),
            y: (self.viewport.offsetHeight / 2) - (point.y - self.data.y)
        };
        self.positionTiles(coords, false, true, false);
        self.zoom(1);
    },
    getTarget: function (e) {
        var target = null;
        if (e.target)
            target = e.target;
        else if (e.srcElement)
            target = e.srcElement;
        if (target.nodeType == 3)
            target = target.parentNode;
        return target;
    },
    move: function (direction, amount) {
        if (this.data.zoom == 1)
            return false;
        var coords;
        var prevCoords = {
            x: this.data.x,
            y: this.data.y
        };
        if (!amount) {
            this.setArrowAmount();
            if (direction == 'left' || direction == 'right')
                amount = this.arrowAmount.x;
            else
                amount = this.arrowAmount.y;
        }
        switch (direction) {
        case 'left':
            coords = {
                x: this.data.x + (amount),
                y: this.data.y
            };
            break;
        case 'right':
            coords = {
                x: this.data.x - (amount),
                y: this.data.y
            };
            break;
        case 'up':
            coords = {
                x: this.data.x,
                y: this.data.y + (amount)
            };
            break;
        case 'down':
            coords = {
                x: this.data.x,
                y: this.data.y - (amount)
            };
            break;
        }
        var newCoords = this.positionTiles(coords, true, true, false);
        return prevCoords.x != newCoords.x || prevCoords.y != newCoords.y;
    },
    handleKey: function (keyCode) {
        if (keyCode == 38) return this.move('up');
        if (keyCode == 39) return this.move('right');
        if (keyCode == 40) return this.move('down');
        if (keyCode == 37) return this.move('left');
        if (keyCode == 107) return this.zoom(+1);
        if (!this.ie && (keyCode == 61)) return this.zoom(+1);
        if (this.ie && (keyCode == 187)) return this.zoom(+1);
        if (keyCode == 109 || keyCode == 189) return this.zoom(-1);
        /*
if (keyCode == 109) return this.zoom(-1);
if (this.ie && (keyCode == 95 || keyCode == 43)) { return false; }
if (keyCode == 45 || keyCode == 95)
{
return this.zoom(-1);
}
if (keyCode == 43)
{
return this.zoom(1);
}
*/
        return false;
    },
    updateMap: function () {
        if (!this.area)
            return;
        if (this.data.zoom == 1) {
            this.area.style.display = 'none';
            return;
        } else {
            this.area.style.display = 'block';
        }
        var dimensions = this.getDimensions();
        var box = {
            left: Math.floor((this.map.offsetWidth / dimensions.width) * -this.data.x),
            top: Math.floor((this.map.offsetHeight / dimensions.height) * -this.data.y),
            width: Math.floor((this.map.offsetWidth / dimensions.width) * this.viewport.offsetWidth) - 1,
            height: Math.floor((this.map.offsetHeight / dimensions.height) * this.viewport.offsetHeight) - 1
        };
        if (box.left < 0) box.left = 0;
        if (box.top < 0) box.top = 0;
        if (box.left + box.width > this.map.offsetWidth - 2) box.width = this.map.offsetWidth - box.left - 2;
        if (box.top + box.height > this.map.offsetHeight - 2) box.height = this.map.offsetHeight - box.top - 2;
        if (box.width < 0 || box.height < 0) {
            return;
        }
        this.area.style.left = box.left + 'px';
        this.area.style.top = box.top + 'px';
        this.area.style.width = box.width + 'px';
        this.area.style.height = box.height + 'px';
    },
    onAreaMouseMove: function (e) {
        e = e ? e : window.event;
        var self = this.self;
        if (!self) return false;
        var move = self.getCoords(e, self.map);
        var pos = {
            x: move.x - (self.area.offsetWidth / 2),
            y: move.y - (self.area.offsetHeight / 2)
        };
        var dimensions = self.getDimensions();
        var coords = {
            x: (dimensions.width / self.map.offsetWidth) * -pos.x,
            y: (dimensions.height / self.map.offsetHeight) * -pos.y
        };
        self.positionTiles(coords, true, true, false);
        return false;
    },
    onMapMouseUp: function (e) {
        e = e ? e : window.event;
        var self = this.self;
        if (!self) return false;
        self.map.onmousemove = function () {};
        self.map.onmouseout = function () {};
        self.map.onmouseup = function () {};
        return false;
    },
    onMapMouseOut: function (e) {
        e = e ? e : window.event;
        e.cancelBubble = true;
        if (e.stopPropagation) e.stopPropagation();
        var self = this.self;
        if (!self) return false;
        if (ZoomTool.checkMouseLeave(this, e)) {
            self.map.onmousemove = function () {};
            self.map.onmouseout = function () {};
            self.map.onmouseup = function () {};
        }
        return false;
    },
    onMapMouseDown: function (e) {
        e = e ? e : window.event;
        if (e.button > 1) return false;
        var self = this.self;
        if (!self || self.data.zoom == 1)
            return false;
        var move = self.getCoords(e, self.map);
        var pos = {
            x: move.x - (self.area.offsetWidth / 2),
            y: move.y - (self.area.offsetHeight / 2)
        };
        var dimensions = self.getDimensions();
        var coords = {
            x: (dimensions.width / self.map.offsetWidth) * -pos.x,
            y: (dimensions.height / self.map.offsetHeight) * -pos.y
        };
        self.positionTiles(coords, true, true, false);
        self.map.onmousemove = self.onAreaMouseMove;
        self.map.onmouseout = self.onMapMouseOut;
        self.map.onmouseup = self.onMapMouseUp;
        return false;
    },
    onMapMouseDoubleClick: function (e) {
        e = e ? e : window.event;
        var self = this.self;
        if (!self) return false;
        self.onMapMouseDown(e);
        self.zoom(1);
        return false;
    },
    fullscreen: function (e) {
        if (this.data.fullscreen)
            return false;
        var args = 'server.php?controller=content&contentType=ConMediaFile&contentId=' + this.data.contentId;
        args += '&moduleId=ZoomTool';
        args += '&z=' + this.data.zoom;
        args += '&x=' + this.data.x;
        args += '&y=' + this.data.y;
        var popup = 0;
        if (window.open) {
            popup = window.open(
                (this.data.siteWebRoot != undefined ? this.data.siteWebRoot : "/") + args,
                'ZoomTool_' + this.data.contentId,
                'status=0,toolbar=0,location=0,menubar=0,resizable=1,scrollbars=0'
            );
            popup.focus();
            if (this.ie) {
                popup.moveTo(window.screenLeft + 10, window.screenTop + 10);
            } else {
                popup.moveTo(window.screenX + 10, window.screenY + 10);
            }
            popup.resizeTo(document.documentElement.clientWidth - 10, document.documentElement.clientHeight - 10);
        }
        if (!popup) {
            alert('Popups are being blocked by your browser');
        }
        return false;
    },
    onMouseWheel: function (e) {
        if (!(
            (e.target && e.target == this.viewport) ||
            (e.srcElement && e.srcElement.className == 'tile')
        ))
            return true;
        var direction = 0;
        if (e.wheelDelta) {
            direction = e.wheelDelta > 0 ? 1 : -1;
        } else if (e.detail) {
            direction = e.detail > 0 ? -1 : 1;
        }
        if (!direction)
            return true;
        if (e.preventDefault)
            e.preventDefault();
        else
            e.returnValue = false;
        this.zoom(direction);
        return false;
    },
    setSliderPadding: function (p) {
        if (this.totalSliderHeight == null || this.totalSliderHeight == 0) {
            this.totalSliderHeight = document.getElementById('sliderAll').offsetHeight;
            if (this.ie && this.ieVersion <= 6) {
                this.totalSliderHeight -= 13;
            }
            if (this.totalSliderHeight == 0) {
                return;
            }
        }
        var sliderHeight = document.getElementById('sliderDraggable').offsetHeight;
        document.getElementById('sliderPaddingTop').style.height = p + 'px';
        var sliderTopHeight = document.getElementById('sliderPaddingTop').offsetHeight;
        var sliderBottomHeight = this.totalSliderHeight - sliderTopHeight - sliderHeight;
        if (this.ie && this.ieVersion <= 6) {}
        if (sliderBottomHeight < 0) {
            sliderBottomHeight = 0;
        }
        document.getElementById('sliderPaddingBottom').style.height = sliderBottomHeight + "px";
        var sum = (document.getElementById('sliderDraggable').offsetHeight + document.getElementById('sliderPaddingTop').offsetHeight + document.getElementById('sliderPaddingBottom').offsetHeight);
        if (sum > this.totalSliderHeight) {
            var pxToMove = (sum - this.totalSliderHeight);
            var curTopH = document.getElementById('sliderPaddingTop').offsetHeight;
            var newH = (curTopH - pxToMove);
            if (newH >= 0) {
                document.getElementById('sliderPaddingTop').style.height = (curTopH - pxToMove) + "px";
            }
        }
        /*
window.status="TOT: " + this.totalSliderHeight
+ " BOT: " + document.getElementById('sliderPaddingBottom').offsetHeight
+ " TOP: " + document.getElementById('sliderPaddingTop').offsetHeight
+ " SL: " + document.getElementById('sliderDraggable').offsetHeight
+ " SUM: " + sum
+ " p: " + p
;
*/
    }
};
ZoomTool.onKeyPress = function (e) {
    e = e ? e : window.event;
    for (var i = 0; i < g_aZoomTool.length; i++) {
        if (g_aZoomTool[i].handleKey(e.keyCode))
            return false;
    }
    return true;
};
ZoomTool.onKeyDown = function (e) {
    e = e ? e : window.event;
    for (var i = 0; i < g_aZoomTool.length; i++) {
        if (g_aZoomTool[i].handleKey(e.keyCode))
            return false;
    }
    return true;
};
ZoomTool.onMouseWheel = function (e) {
    e = e ? e : window.event;
    if (g_aZoomTool[0])
        return g_aZoomTool[0].onMouseWheel(e);
    return true;
};
ZoomTool.containsDOM = function (container, containee) {
    var isParent = false;
    do {
        if ((isParent = container == containee))
            break;
        containee = containee.parentNode;
    }
    while (containee != null);
    return isParent;
};
ZoomTool.checkMouseLeave = function (element, evt) {
    if (element.contains && evt.toElement) {
        return !element.contains(evt.toElement);
    } else if (evt.relatedTarget) {
        return !ZoomTool.containsDOM(element, evt.relatedTarget);
    } else return false;
};
