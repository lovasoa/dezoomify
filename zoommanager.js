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
UI.ratio = 1;
UI.MAX_CANVAS_AREA = 16384 * 16384; // See https://github.com/jhildenbiddle/canvas-size

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

@param {Object} data : Image source information, containing width and height of the image.
**/
UI.setupRendering = function (data) {
	document.body.className = "loading";
	document.getElementById("error").setAttribute("hidden", true);
	var area = data.width * data.height;
	for (var maxArea = UI.MAX_CANVAS_AREA; maxArea > 8; maxArea /= 2) {
		UI.ratio = Math.min(Math.sqrt(maxArea / area), 1);
		UI.canvas.width = data.width * UI.ratio;
		UI.canvas.height = data.height * UI.ratio;
		UI.ctx = UI.canvas.getContext("2d");
		try {
			UI.ctx.getImageData(0, 0, 1, 1); // Tests whether the canvas was successfully allocated
			break;
		} catch (_) { }
	}
	UI.canvas.onclick = UI.changeSize;
	UI.changeSize();
};

/**
Draw a tile on the canvas, at the given position.

@param {Image} tile : The tile image
@param {Number} x position
@param {Number} y position
*/
UI.drawTile = function (tileImg, x, y) {
	var r = UI.ratio, w = tileImg.width, h = tileImg.height;
	UI.ctx.drawImage(tileImg,
		Math.floor(x * r),
		Math.floor(y * r),
		Math.ceil(w * r),
		Math.ceil(h * r)
	);
};

/**
Display an error in the UI.

@param {String} errmsg The error message
*/
UI.error = function (errmsg) {
	document.getElementById("percent").textContent = "";
	document.getElementById("error").removeAttribute("hidden");
	var error_img = "error.svg?error=" + encodeURIComponent(errmsg);
	document.getElementById("error-img").src = error_img;
	if (errmsg) {
		document.getElementById("errormsg").textContent = errmsg;
		var urltxt = document.getElementById("url").value;
		try {
			var url = new URL(urltxt);
		} catch (e) { // not a valid URL
			var url = new URL("invalid://invalid?source=" + urltxt);
		}
		document.getElementById("gh-search").href =
			"https://github.com/lovasoa/dezoomify/issues?q=" +
			encodeURIComponent(url.host);
		document.getElementById("gh-open-issue").href =
			"https://github.com/lovasoa/dezoomify/issues/new" +
			"?labels=" + "new%20site%20support" +
			"&title=" + encodeURIComponent(url.host) +
			"&body=" + encodeURIComponent(
				"Hello everyone,\n\n I am having issues when trying to download " + url +
				"\n\nDezoomify reports:\n\n```\n" + errmsg + "\n```\n" +
				"I don't understand this message. Can someone please help me ?"
			);
	}
};

window.onerror = function (errmsg, source, lineno) {
	UI.error(errmsg + '\n\n(' + source + ':' + lineno + ')');
}

/**
Reset the UI to the initial state.
*/
UI.reset = function () {
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
	if (!percent) {
		document.getElementById("percent").innerHTML = text;
		return;
	}
	percent = parseInt(percent);
	document.getElementById("percent").innerHTML = text + ' (' + percent + "%)";
	document.getElementById("progressbar").style.width = percent + "%";
	document.getElementById("progressbar").setAttribute("aria-valuenow", percent);
	document.title = "(" + percent + "%) Dezoomify";
};

/**
Update UI after the image has loaded.
*/
UI.loadEnd = function () {
	var status = document.getElementById("status");
	var a = document.createElement("a");
	a.download = "dezoomify-result.jpg";
	a.href = "#";
	a.textContent = "Converting image...";
	a.className = "button";
	try {
		// Try to export the image
		UI.canvas.toBlob(function (blob) {
			if (!(blob instanceof Blob)) {
				console.error("Unable to access the canvas image data, got an unexpected value", blob);
				status.className = "finished";
			}
			var url = URL.createObjectURL(blob);
			a.href = url;
			a.textContent = "Save image";
		}, "image/jpeg", 0.95);
		document.body.className = "download";
		status.appendChild(a);
	} catch (e) {
		status.className = "finished";
	}
};

/**
Add a new button for a new dezoomer.

@param {Object} dezoomer the dezoomer object
*/
UI.addDezoomer = function (dezoomer) {
	var label = document.createElement("label")
	var input = document.createElement("input");
	input.type = "radio"
	input.name = "dezoomer";
	input.id = "dezoomer-" + dezoomer.name;
	label.title = dezoomer.description;
	input.onclick = function () {
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
UI.setDezoomer = function (dezoomerName) {
	document.getElementById("dezoomer-" + dezoomerName).checked = true;
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
	// Display only the first error, until the ZoomManager in reinitialized
	if (!ZoomManager.status.error) {
		ZoomManager.status.error = true;
		UI.error(errmsg);
		throw new Error(errmsg);
	}
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
		if (loaded >= total) {
			clearInterval(timer);
			ZoomManager.loadEnd();
		}
	}, 500);
	return timer;
};


/**
Tells that we are ready
*/
ZoomManager.readyToRender = function (data) {
	if (ZoomManager.data) {
		console.log("Only one dezoom can be active at a time", data);
		return;
	}

	data.nbrTilesX = data.nbrTilesX || Math.ceil(data.width / data.tileSize);
	data.nbrTilesY = data.nbrTilesY || Math.ceil(data.height / data.tileSize);
	data.totalTiles = data.totalTiles || data.nbrTilesX * data.nbrTilesY;
	data.zoomFactor = data.zoomFactor || 2;
	data.baseZoomLevel = data.baseZoomLevel || 0;
	data.overlap = data.overlap || 0;

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
	var x = 0, y = 0;

	function addTile(url, x, y, data) {
		if (typeof url === "string") {
			if (data.origin) url = ZoomManager.resolveRelative(url, data.origin);
			ZoomManager.addTile(url, x * data.tileSize - data.overlap, y * data.tileSize - data.overlap);
		} else { // Promise
			url.then(function (url) {
				addTile(url, x, y, data)
			}).catch(ZoomManager.error.bind(ZoomManager));
		}
	}

	function nextTile() {
		var url = ZoomManager.dezoomer.getTileURL(x, y, zoom, data);
		if (typeof Promise !== "undefined") {
			var x0 = x, y0 = y;
			Promise.resolve(url)
				.then(function (url) { addTile(url, x0, y0, data) })
				.catch(ZoomManager.error);
		} else {
			addTile(url, x, y, data);
		}

		x++;
		if (x >= data.nbrTilesX) { x = 0; y++; }
		if (y < data.nbrTilesY) ZoomManager.nextTick(nextTile);
	}

	nextTile();
};

ZoomManager.MAX_REQUESTS_PER_SECOND = 5;

/**
@function nextTick
Call a function, but not immediatly
@param {Function} f - the function to call
*/
ZoomManager.nextTick = function (f) {
	return setTimeout(f, 1000 / ZoomManager.MAX_REQUESTS_PER_SECOND);
};

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
		ZoomManager.status.loaded++;
	});
	img.addEventListener("error", function (evt) {
		if (ntries < 5) {
			// Maybe the server is just busy right now, or we are running on a bad connection
			nextTime = Math.pow(10 * Math.random(), ntries);
			setTimeout(addTile, nextTime, url, x, y, ntries + 1);
		} else {
			ZoomManager.error("Unable to load tile.\n" +
				"Check that your internet connection is working " +
				"and that you can access this url:\n" + url);
		}
	});
	if (ZoomManager.proxy_tiles) {
		url = ZoomManager.proxy_tiles + "?url=" + encodeURIComponent(url);
		if (ZoomManager.cookies.length > 0) {
			url += "&cookies=" + encodeURIComponent(ZoomManager.cookies);
		}
		img.crossOrigin = "anonymous";
	}
	// Don't tell the tile host the request comes from dezoomify
	img.referrerPolicy = "no-referrer";
	img.src = url;
};

/**
Start the dezoomifying process
*/
ZoomManager.open = function (url) {
	ZoomManager.init();
	if (url.indexOf("http") !== 0) {
		throw new Error("You must provide a valid HTTP URL.");
	}
	if (typeof ZoomManager.dezoomer.findFile === "function") {
		ZoomManager.dezoomer.findFile(url, function foundFile(filePath, infos) {
			ZoomManager.updateProgress(0, "Found image. Trying to open it...");
			ZoomManager.dezoomer.open(ZoomManager.resolveRelative(filePath, url), infos);
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
@param {{type:String, allow_failure?: boolean, error_callback: (err:string)=>any, is_tile?: boolean}} params
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

	function onerror(error_msg) {
		if (params.error_callback) params.error_callback(error_msg);
		if (params.allow_failure) console.log("non-fatal error: ", error_msg);
		else ZoomManager.error(error_msg);
	}

	xhr.open("GET", requesturl, true);

	xhr.onloadstart = function () {
		if (!params.is_tile)
			ZoomManager.updateProgress(0, "Sent a request in order to get information about the image...");
	};
	xhr.onerror = function (e) {
		onerror("Unable to connect to the proxy server " +
			"to get the required information.\n\nXHR error:\n" + e);
	};
	xhr.onload = function () {
		var response = xhr.response;

		/// If the proxy failed to make the request
		if (xhr.status === 500) {
			var msg = "Unable to fetch " + url;
			var responseText =
				typeof response === "string" ? response :
					(response instanceof ArrayBuffer) ? new TextDecoder("utf-8").decode(response) :
						"";
			if (responseText) {
				msg += "\nThe server responded:\n" + responseText;
				if (responseText.match(/403 forbidden/i)) {
					msg += "\nSee dezoomify's wiki page about protected pages.";
				}
			}
			return onerror(msg);
		} else if (xhr.status === 429) {
			var msg = "Our server has received too many requests, and our provider is blocking new requests. " +
				"You can donate on https://github.com/sponsors/lovasoa to participate to the hosting fees. " +
				"Once we collect over 5$/month overall, we will switch to a paid plan of the provider, allowing more requests to go through every day. " +
				"For more details, see https://github.com/lovasoa/dezoomify/issues/337#issuecomment-773498488.";
			return onerror(msg);
		}

		var cookie = xhr.getResponseHeader("X-Set-Cookie");
		if (cookie) ZoomManager.cookies += cookie;
		// Custom error message on invalid XML
		if (type === "xml" &&
			(response === null || response.documentElement.tagName === "parsererror")) {
			return onerror("Invalid XML:\n" + url);
		}
		// Custom error message on invalid JSON
		if (type === "json" && xhr.response === null) {
			return onerror("Invalid JSON:\n" + url);
		}
		// Decode html encoded entities
		if (type === "htmltext") {
			response = ZoomManager.decodeHTMLentities(response);
		}
		callback(response, xhr);
	};

	switch (type) {
		case "xml":
			xhr.responseType = "document";
			xhr.overrideMimeType("text/xml");
			break;
		case "json":
			xhr.responseType = "json";
			xhr.overrideMimeType("application/json");
			break;
		case "binary":
			xhr.responseType = "arraybuffer";
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
ZoomManager.decodeHTMLentities = (function () {
	var dict = {
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": "\""
	};
	var regEx = /&(?:amp|lt|gt|quot|#(?:x[\da-f]+|\d+));/gi;
	function replacer(entity) {
		entity = entity.toLowerCase();
		return dict[entity] ||
			String.fromCharCode(parseInt('0' + entity.slice(2, -1)));
	}

	return function decodeHTMLentities(text) {
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
	return Math.ceil(Math.log(size / data.tileSize) / Math.log(data.zoomFactor)) + (data.baseZoomLevel || 0);
};

ZoomManager.dezoomersList = {};
ZoomManager.addDezoomer = function (dezoomer) {
	ZoomManager.dezoomersList[dezoomer.name] = dezoomer;
	UI.addDezoomer(dezoomer);
}

/**
Set the active dezoomer
*/
ZoomManager.setDezoomer = function (dezoomer) {
	ZoomManager.dezoomer = dezoomer;
	UI.setDezoomer(dezoomer.name);
}

ZoomManager.reset = function () {
	// This variable will store cookies set by previous requests
	ZoomManager.setDezoomer(ZoomManager.dezoomersList["Select automatically"]);
};

/**
Initialize the ZoomManager
*/
ZoomManager.init = function () {
	// Called before open()
	if (!ZoomManager.cookies) ZoomManager.cookies = "";
	if (!ZoomManager.proxy_url) ZoomManager.proxy_url = "proxy.php";
	ZoomManager.status = {
		"error": false,
		"loaded": 0,
		"totalTiles": 1
	};
	UI.reset();
};
