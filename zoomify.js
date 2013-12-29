var zoomify = (function () { //Code isolation
	//var PHPSCRIPT = "http://ophir.alwaysdata.net/dezoomify/dezoomify.php" //Use a remote php script if you can't host PHP
	var PHPSCRIPT = "dezoomify.php";

	return {
		"open" : function (url) {
			var codedurl = encodeURIComponent(url);

			var xhr = new XMLHttpRequest();
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
				var infos = xml.getElementsByTagName("IMAGE_PROPERTIES")[0];
				if (!infos) {
					ZoomManager.error();
					console.log(xhr.responseText);
				}
				var data = {};
				data.path = xml.firstChild.getAttribute("path");
				data.width = parseInt(infos.getAttribute("WIDTH"));
				data.height = parseInt(infos.getAttribute("HEIGHT"));
				data.tileSize = parseInt(infos.getAttribute("TILESIZE"));
				data.numTiles = parseInt(infos.getAttribute("NUMTILES")); //Total number of tiles (for all zoom levels)
				data.zoomFactor = 2; //Zooming factor between two consecutive zoom levels

				ZoomManager.readyToRender(data);
			};
			xhr.send(null);
		},
		"getTileURL" : function (col, row, zoom, data) {
			var totalTiles = data.nbrTilesX * data.nbrTilesY;
			var tileGroup = Math.floor((data.numTiles - totalTiles + col + row*data.nbrTilesX) / 256);
			return data.path + "/TileGroup" + tileGroup + "/" + zoom + "-" + col + "-" + row + ".jpg";
		}
	};
})();
ZoomManager.dezoomersList["zoomify"] = zoomify;
ZoomManager.dezoomer = nationalgallery;
