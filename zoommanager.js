/**
@mainpage Helper classes from zoomifiers

Classes defined here:
 - @ref UI : User interface management, interaction with HTML. SHouldn't be used directly by dezoomers.
 - @ref ZoomManager : Helper to be used by dezoomers
*/

/**
User interface management, interaction with HTML
@class UI
*/
var UI = {};
UI.canvas = document.getElementById("rendering-canvas");
UI.dezoomers = document.getElementById("dezoomers");

/**
Adjusts the size of the image, so that is fits page width or page height
**/
UI.changeSize = function () {
	var width = UI.canvas.width, height = UI.canvas.height;
	switch (this.fit) {
		case "width":
			this.fit = "height";
			UI.canvas.style.height = window.innerHeight + "px";
			UI.canvas.style.width = window.innerHeight / height * width + "px";
			break;
		case "height":
			this.fit = "none";
			UI.canvas.style.width = width + "px";
			UI.canvas.style.height = height + "px";
			break;
		default:
			this.fit = "width";
			UI.canvas.style.width = window.innerWidth + "px";
			UI.canvas.style.height = window.innerWidth / width * height + "px";
	}
};

/**
Sets the width and height of the canvas

@param {Object} data : Image source informations, containing width and height of the image.
**/
UI.setupRendering = function (data) {
	document.getElementById("status").className = "loading";
	UI.canvas.width = data.width;
	UI.canvas.height = data.height;
	UI.canvas.onclick = UI.changeSize;
	UI.ctx = UI.canvas.getContext("2d");
	UI.changeSize();
};

/**
Draw a tile on the canvas, at the given position.

@param {Image} tile : The tile image
@param {Number} x position
@param {Number} y position
*/
UI.drawTile = function(tileImg, x, y) {
	UI.ctx.drawImage(tileImg, x, y);
};

/**
Display an error in the UI.

@param {String} errmsg The error message
*/
UI.error = function(errmsg) {
	if (errmsg) {
		document.getElementById("errormsg").textContent = errmsg;
	}
	document.getElementById("percent").textContent = "";
	document.getElementById("error").removeAttribute("hidden");
};

window.onerror = function(errmsg, source, lineno) {
	UI.error(errmsg + ' (' + source + ':' + lineno + ')');
}

/**
Reset the UI to the initial state.
*/
UI.reset = function() {
	document.getElementById("error").setAttribute("hidden", "hidden");
	document.getElementById("status").className = "";
	UI.canvas.width = UI.canvas.height = 0;
};

/**
Update the state of the progress bar.

@param {Number} percentage (between 0 and 100)
@param {String} description current state description
*/
UI.updateProgress = function (percent, text) {
	document.getElementById("percent").innerHTML = text + ' (' + parseInt(percent) + "%)";
	document.getElementById("progressbar").style.width = percent + "%";
};

/**
Update UI after the image has loaded.
*/
UI.loadEnd = function() {
	var status = document.getElementById("status");
	var a = document.createElement("a");
	a.download = "dezoomify-result.jpg";
	a.href = "#";
	a.textContent = "Converting image...";
	a.className = "button";
	try {
		// Try to export the image
		UI.canvas.toBlob(function(blob){
			var url = URL.createObjectURL(blob);
			a.href = url;
			a.textContent = "Save image";
		}, "image/jpeg", 0.95);
		status.className = "download";
		status.appendChild(a);
	} catch(e) {
		status.className = "finished";
	}
};

/**
Add a new button for a new dezoomer.

@param {Object} dezoomer the dezoomer object
*/
UI.addDezoomer = function(dezoomer) {
	var label = document.createElement("label")
	var input = document.createElement("input");
	input.type = "radio"
	input.name = "dezoomer";
	input.id   = "dezoomer-" + dezoomer.name;
	label.title= dezoomer.description;
	input.onclick = function() {
		ZoomManager.setDezoomer(dezoomer);
	}
	label.appendChild(input);
	label.appendChild(document.createTextNode(dezoomer.name));
	UI.dezoomers.appendChild(label);
};

/**
@brief Set the dezoomer that is currently used.

@param {String} dezoomerName name of the dezoomer
*/
UI.setDezoomer = function(dezoomerName) {
	document.getElementById("dezoomer-"+dezoomerName).checked = true;
}


/**
Contains helper functions for dezoomers
@class
*/
var ZoomManager = {};

/**
@brief Signal an error

@param {String} errmsg The error text
@throws {Error} err The given error
*/
ZoomManager.error = function (errmsg) {
	UI.error(errmsg);
	throw new Error(errmsg);
};

ZoomManager.updateProgress = function (progress, msg) {
	UI.updateProgress(progress, msg);
};
ZoomManager.loadEnd = function () {
	UI.loadEnd();
}

/**
Start listening for tile loads

@return {Number} The timer ID
*/
ZoomManager.startTimer = function () {
	var wasLoaded = 0; // Number of tiles that were loaded last time we watched
	var timer = setInterval(function () {
		/*Update the User Interface each 500ms, and not in addTile, because it would
		slow down the all process to update the UI too often.*/
		var loaded = ZoomManager.status.loaded, total = ZoomManager.status.totalTiles;
		if (loaded !== wasLoaded) {
			// Update progress if new tiles were loaded
			ZoomManager.updateProgress(100 * loaded / total, "Loading the tiles...");
			wasLoaded = loaded;
		}
		if (loaded == total) {
			clearInterval(timer);
			ZoomManager.loadEnd();
		}
	}, 500);
	return timer;
};


/**
Tells that we are ready
*/
ZoomManager.readyToRender = function(data) {

	data.nbrTilesX = data.nbrTilesX || Math.ceil(data.width / data.tileSize);
	data.nbrTilesY = data.nbrTilesY|| Math.ceil(data.height / data.tileSize);
	data.totalTiles = data.totalTiles || data.nbrTilesX*data.nbrTilesY;
	data.zoomFactor = data.zoomFactor || 2;
	data.baseZoomLevel = data.baseZoomLevel || 0;

	ZoomManager.status.totalTiles = data.totalTiles;
	ZoomManager.data = data;
	UI.setupRendering(data);

	ZoomManager.updateProgress(0, "Preparing tiles load...");
	ZoomManager.startTimer();

	var render = ZoomManager.dezoomer.render || ZoomManager.defaultRender;
	setTimeout(render, 1, data); //Give time to refresh the UI, in case render would take a long time
};

ZoomManager.defaultRender = function (data) {
	var zoom = data.maxZoomLevel || ZoomManager.findMaxZoom(data);
	var x=0, y=0;

	function nextTile() {
		var url = ZoomManager.dezoomer.getTileURL(x,y,zoom,data);
		if (data.origin) url = ZoomManager.resolveRelative(url, data.origin);
		ZoomManager.addTile(url, x*data.tileSize, y*data.tileSize);

		x++;
		if (x >= data.nbrTilesX) {x = 0; y++;}
		if (y < data.nbrTilesY) ZoomManager.nextTick(nextTile);
	}

	nextTile();
};

/**
@function nextTick
Call a function, but not immediatly
*/
ZoomManager.nextTick = (function(doAnim) {
	if (doAnim) return function(f){return requestAnimationFrame(f)}
	else return function(f) {return setTimeout(f, 5)}
})(!!window.requestAnimationFrame);

/**
Request a tile from the server

@param {String} url - tile URL
@param {Number} x - position in px
@param {Number} y - position in px
@param {Number} [n=0] - Number of time the tile has already been requested
*/
ZoomManager.addTile = function addTile(url, x, y, ntries) {
	//Request a tile from the server and display it once it loaded
	ntries = ntries | 0; // Number of time the tile has already been requested
	var img = new Image;
	img.addEventListener("load", function () {
		UI.drawTile(img, x, y);
		ZoomManager.status.loaded ++;
	});
	img.addEventListener("error", function(evt) {
		if (ntries < 5) {
			// Maybe the server is just busy right now, or we are running on a bad connection
			nextTime = Math.pow(10*Math.random(), ntries);
			setTimeout(addTile, nextTime, url, x, y, ntries+1);
		} else {
			ZoomManager.error("Unable to load tile.\n" +
												"Check that your internet connection is working and that you can access this url: " + url);
		}
	});
	if (ZoomManager.proxy_tiles) {
		url = ZoomManager.proxy_tiles + "?url=" + encodeURIComponent(url);
		if (ZoomManager.cookies.length > 0) {
			url += "&cookies=" + encodeURIComponent(ZoomManager.cookies);
		}
		img.crossOrigin = "anonymous";
	}
	img.src = url;
};

/**
Start the dezoomifying process
*/
ZoomManager.open = function(url) {
	ZoomManager.init();
	if (url.indexOf("http") !== 0) {
		throw new Error("You must provide a valid HTTP URL.");
	}
	if (typeof ZoomManager.dezoomer.findFile === "function") {
		ZoomManager.dezoomer.findFile(url, function foundFile(filePath) {
			ZoomManager.updateProgress(0, "Found image. Trying to open it...");
			ZoomManager.dezoomer.open(ZoomManager.resolveRelative(filePath, url));
		});
		ZoomManager.updateProgress(0, "The dezoomer is trying to locate the zoomable image...");
	} else {
		ZoomManager.dezoomer.open(url);
		ZoomManager.updateProgress(0, "Launched dezoomer...");
	}
};

/**
@callback fileCallback
@param {string|Document|Object} response
@param {XMLHttpRequest} request
*/

/**
Call callback with the contents of the page at url
@param {string} url
@param {type:String} options
@param {fileCallback} callback - callback to call when the file is loaded
*/
ZoomManager.getFile = function (url, params, callback) {
	var PHPSCRIPT = ZoomManager.proxy_url;
	var type = params.type || "text";
	var xhr = new XMLHttpRequest();

	// The url we got MIGHT already have been encoded
	// The url we give to the server MUST be encoded
	if (url.match(/%[a-zA-Z0-9]{2}/) === null) url = encodeURI(url);
	// We pass the URL itself as a query parameter, so we have to re-encode it
	var codedurl = encodeURIComponent(url);
	var requesturl = PHPSCRIPT + "?url=" + codedurl;
	if (ZoomManager.cookies.length > 0) {
		requesturl += "&cookies=" + encodeURIComponent(ZoomManager.cookies);
	}
	xhr.open("GET", requesturl, true);

	xhr.onloadstart = function () {
		ZoomManager.updateProgress(1, "Sent a request in order to get informations about the image...");
	};
	xhr.onerror = function (e) {
		throw new Error("Unable to connect to the proxy server to get the required informations. XHR error: " + e);
	};
	xhr.onloadend = function () {
		var response = xhr.response;
		var cookie = xhr.getResponseHeader("X-Set-Cookie");
		if (cookie) ZoomManager.cookies += cookie;
		// Custom error message on invalid XML
		if (type === "xml" &&
				response.documentElement.tagName === "parsererror") {
			return ZoomManager.error("Invalid XML: " + url);
		}
		// Custom error message on invalid JSON
		if (type === "json" && xhr.response === null) {
			return ZoomManager.error("Invalid JSON: " + url);
		}
		// Decode html encoded entities
		if (type === "htmltext") {
			response = ZoomManager.decodeHTMLentities(response);
		}
		callback(response, xhr);
	};

	switch(type) {
		case "xml":
			xhr.responseType = "document";
			xhr.overrideMimeType("text/xml");
			break;
		case "json":
			xhr.responseType = "json";
			xhr.overrideMimeType("application/json");
			break;
		default:
			xhr.responseType = "text";
			xhr.overrideMimeType("text/plain");
	}
	xhr.send(null);
};

/**
Decode HTML special characaters such as "&amp;", "&gt;", ...

@function ZoomManager.decodeHTMLentities
@param {string} str
@return {string} decoded
*/
ZoomManager.decodeHTMLentities = (function (){
	var dict = {
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": "\"",
		"&#x27;": "'",
		"&#x60;": "`"
	};
	var regEx = /(?:&amp;|&lt;|&gt;|&quot;|&#x27;|&#x60;)/g;
	function replacer(entity) {return dict[entity];}

	return function decodeHTMLentities (text) {
		return text.replace(regEx, replacer);
	};
})();

/**
Return the absolute path, given a relative path and a base

@param {string} path - the path, such as "path/to/other/file.jpg"
@param {string} base - the base URL, such as "http://test.com/path/to/first/file.html"
@return {string} resolved - the resolved path, such as "http://test.com/path/to/first/path/to/other/file.jpg"
*/
ZoomManager.resolveRelative = function resolveRelative(path, base) {
	// absolute URL
	if (path.match(/\w*:\/\//)) {
		return path;
	}
  // Protocol-relative URL
	if (path.indexOf("//") === 0) {
		var protocol = base.match(/\w+:/) || ["http:"];
		return protocol[0] + path;
	}
	// Upper directory
	if (path.indexOf("../") === 0) {
		return resolveRelative(path.slice(3), base.replace(/\/[^\/]*$/, ''));
	}
	// Relative to the root
	if (path[0] === '/') {
		var match = base.match(/(\w*:\/\/)?[^\/]*\//) || [base];
		return match[0] + path.slice(1);
	}
	//relative to the current directory
	return base.replace(/\/[^\/]*$/, "") + '/' + path;
};

/**
Returns the maximum zoom level, knowing the image size, the tile size, and the multiplying factor between two consecutive zoom levels
@param {{width:number, height:number}} metadata
@return {number} maxzoom - the maximal zoom level
**/
ZoomManager.findMaxZoom = function (data) {
	//For all zoom levels:
	//size / zoomFactor^(maxZoomLevel - zoomlevel) = numTilesAtThisZoomLevel * tileSize
	//For the baseZoomLevel (0 for zoomify), numTilesAtThisZoomLevel=1
	var size = Math.max(data.width, data.height);
	return Math.ceil(Math.log(size/data.tileSize) / Math.log(data.zoomFactor)) + (data.baseZoomLevel||0);
};

ZoomManager.dezoomersList = {};
ZoomManager.addDezoomer = function(dezoomer) {
	ZoomManager.dezoomersList[dezoomer.name] = dezoomer;
	UI.addDezoomer(dezoomer);
}

/**
Set the active dezoomer
*/
ZoomManager.setDezoomer = function(dezoomer) {
	ZoomManager.dezoomer = dezoomer;
	UI.setDezoomer(dezoomer.name);
}

ZoomManager.reset = function() {
	// This variable will store cookies set by previous requests
	ZoomManager.setDezoomer(ZoomManager.dezoomersList["Select automatically"]);
};

/**
Initialize the ZoomManager
*/
ZoomManager.init = function() {
	// Called before open()
	if (!ZoomManager.cookies) ZoomManager.cookies = "";
	if (!ZoomManager.proxy_url) ZoomManager.proxy_url = "proxy.php";
	ZoomManager.status = {
		"loaded" : 0,
		"totalTiles" : 1
	};
	UI.reset();
};
