var seadragon = (function () { //Code isolation
	//var PHPSCRIPT = "http://ophir.alwaysdata.net/dezoomify/dezoomify.php" //Use a remote php script if you can't host PHP
	var PHPSCRIPT = "proxy.php";

	return {
		"name" : "Seadragon (Deep Zoom Image)",
		"open" : function (url) {
			var codedurl = encodeURIComponent(url);

			var xhr = new XMLHttpRequest();
			xhr.overrideMimeType('text/xml');

			xhr.open("GET", PHPSCRIPT + "?url=" + codedurl, true);

			xhr.onloadstart = function () {
				ZoomManager.updateProgress(0, "Sent a request in order to get informations about the image...");
			};
			xhr.onerror = function (e) {
				console.log("XHR error", e);
				ZoomManager.error("Unable to connect to the proxy server to get the required informations.");
			};
			xhr.onloadend = function () {
				var xml = xhr.responseXML;
				var infos = xml.getElementsByTagName("Image")[0];
				if (!infos) {
					ZoomManager.error();
					console.log(xhr.responseText);
				}
				var size = xml.getElementsByTagName("Size")[0];
				var data = {};

				data.path = url.replace(/\.[^.\/]*$/,'') + "_files"; //replace extension by _files
				data.tileSize = parseInt(infos.getAttribute("TileSize"));
				data.overlap = parseInt(infos.getAttribute("Overlap"));
				data.format = infos.getAttribute("Format");

				data.width = parseInt(size.getAttribute("Width"));
				data.height = parseInt(size.getAttribute("Height"));

				data.zoomFactor = 2; //Zooming factor between two consecutive zoom levels
				data.maxZoomLevel = Math.ceil(Math.log2(Math.max(data.width, data.height)));

				ZoomManager.readyToRender(data);
			};
			xhr.send(null);
		},
		"getTileURL" : function (col, row, zoom, data) {
			return data.path + "/" + zoom + "/" + col + "_" + row + "." + data.format;
		}
	};
})();
ZoomManager.addDezoomer(seadragon);
