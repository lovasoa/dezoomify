var UI = {};
UI.canvas = document.getElementById("rendering-canvas");
UI.dezoomers = document.getElementById("dezoomers");

/** Adjusts the size of the image, so that is fits page width or page height
**/
UI.changeSize = function () {
	var width = UI.canvas.width, height = UI.canvas.height;
	console.log("changeSize");
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
/** Sets the width and height of the canvas
**/
UI.setupRendering = function (data) {
	document.getElementById("urlform").style.display = "none";
	UI.canvas.width = data.width;
	UI.canvas.height = data.height;
	UI.canvas.onclick = UI.changeSize;
	UI.ctx = UI.canvas.getContext("2d");
	UI.changeSize();
	console.log("Image size: " + data.width + "x" + data.height);
};

UI.drawTile = function(tileImg, x, y) {
	UI.ctx.drawImage(tileImg, x, y);
};

UI.error = function(errmsg) {
	var elem = document.getElementById("error");
	if (errmsg) elem.innerHTML = errmsg;
	elem.style.display = "block";
};

UI.updateProgress = function (percent, text) {
	document.getElementById("percent").innerHTML = text + ' (' + parseInt(percent) + ") %";
	document.getElementById("progressbar").style.width = percent + "%";
};

UI.loadEnd = function() {
	document.getElementById("status").style.display = "none";
};

UI.addDezoomer = function(dezoomer) {
	var label = document.createElement("label")
	var input = document.createElement("input");
	input.type = "radio"
	input.name = "dezoomer";
	input.id   = "dezoomer-" + dezoomer.name;
	input.onclick = function() {
		ZoomManager.setDezoomer(dezoomer);
	}
	label.appendChild(input);
	label.appendChild(document.createTextNode(dezoomer.name));
	UI.dezoomers.appendChild(label);
};

UI.setDezoomer = function(dezoomerName) {
	document.getElementById("dezoomer-"+dezoomerName).checked = true;
}

var ZoomManager = {};

ZoomManager.error = function (errmsg) {
	console.error(errmsg);
	UI.error(errmsg);
};
ZoomManager.updateProgress = UI.updateProgress;

ZoomManager.status = {
	"loaded" : 0,
	"totalTiles" : 1
};

ZoomManager.startTimer = function () {
	var timer = setInterval(function () {
		/*Update the User Interface each 500ms, and not in addTile, because it would
		slow down the all process to update the UI too often.*/
		var loaded = ZoomManager.status.loaded, total = ZoomManager.status.totalTiles;
		ZoomManager.updateProgress(100 * loaded / total, "Loading the tiles...");

		if (loaded == total) {
			clearInterval(timer);
			ZoomManager.loadEnd();
		}
	}, 500);
	return timer;
};

ZoomManager.loadEnd = UI.loadEnd;


ZoomManager.readyToRender = function(data) {

	data.nbrTilesX = data.nbrTilesX || Math.ceil(data.width / data.tileSize);
	data.nbrTilesY = data.nbrTilesY|| Math.ceil(data.height / data.tileSize);
	data.totalTiles = data.totalTiles || data.nbrTilesX*data.nbrTilesY;

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
		x++;
		if (x >= data.nbrTilesX) {
			x = 0;
			y++;
		}
		var url = ZoomManager.dezoomer.getTileURL(x,y,zoom,data);
		if (data.origin) url = ZoomManager.resolveRelative(url, data.origin);
		ZoomManager.addTile(url, x*data.tileSize, y*data.tileSize);

		if (y < data.nbrTilesY) requestAnimationFrame(nextTile);
	}

	nextTile();
};

ZoomManager.addTile = function (url, x, y) {
	//Demande une partie de l'image au serveur, et l'affiche lorsqu'elle est reçue
	var img = document.createElement("img");
	img.onload = function () {
		UI.drawTile(img, x, y);
		ZoomManager.status.loaded ++;
	};
	img.src = url;
};

ZoomManager.open = function(url) {
	if (url.indexOf("http") !== 0) {
		return ZoomManager.error("You must provide a valid URL.");
	}
	if (typeof ZoomManager.dezoomer.findFile === "function") {
		ZoomManager.dezoomer.findFile(url, function foundFile(filePath) {
			ZoomManager.dezoomer.open(ZoomManager.resolveRelative(filePath, url));
		});
	} else {
		ZoomManager.dezoomer.open(url);
	}
};

/**
 * Call callback with the contents of the page at url
 */
ZoomManager.getFile = function (url, type, callback) {
	var PHPSCRIPT = "proxy.php";
	var xhr = new XMLHttpRequest();

	var codedurl = encodeURIComponent(url);
	xhr.open("GET", PHPSCRIPT + "?url=" + codedurl, true);

	xhr.onloadstart = function () {
		ZoomManager.updateProgress(0, "Sent a request in order to get informations about the image...");
	};
	xhr.onerror = function (e) {
		ZoomManager.error("Unable to connect to the proxy server to get the required informations.");
		console.log("XHR error", e);
	};
	xhr.onloadend = function () {
		callback(xhr.response, xhr);
	};

	if (type === "xml") {
		xhr.responseType = "document";
		xhr.overrideMimeType("text/xml");
	} else {
		xhr.responseType = "text";
		xhr.overrideMimeType("text/plain");
	}
	xhr.send(null);
};

/**
 * Return the absolute path, given a relative path and a base
 */
ZoomManager.resolveRelative = function resolveRelative(path, base) {
	// absolute URL
	if (path.match(/\w*:\/\//)) {
		return path;
	}
	// Upper directory
	if (path.startsWith("../")) {
		return resolveRelative(path.slice(3), base.replace(/\/[^\/]*$/, ''));
	}
	// Relative to the root
	if (path.startsWith('/')) {
		var match = base.match(/(\w*:\/\/)?[^\/]*\//) || [base];
		return match[0] + path.slice(1);
	}
	//relative to the current directory
	return base.replace(/\/[^\/]*$/, "") + '/' + path;
};

/** Returns the maximum zoom level, knowing the image size, the tile size, and the multiplying factor between two consecutive zoom levels 
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

ZoomManager.setDezoomer = function(dezoomer) {
	ZoomManager.dezoomer = dezoomer;
	UI.setDezoomer(dezoomer.name);
}
