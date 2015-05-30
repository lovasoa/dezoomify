var xlimage = (function () { //Code isolation
	return {
		"name": "XLimage",
		"findFile" : function getZoomifyPath (baseUrl, callback) {
			// kbr.be
			var kbrMatch = baseUrl.match(/kbr.be\/multi\/([\w\d-]+)Viewer/);
			if (kbrMatch) {
				var id = kbrMatch[1];
				var pagenum = parseInt(prompt("What is the number of the page you want to download?"));
				var padded = ("000" + (pagenum+1)).slice(-3);
				return callback("/multi/"+id+"Viewer/xml.php?/multi/"+id+"/"+padded+".imgi?cmd=info");
			}
			// If nothing worked, treat the url as the one of a raw xml
			return callback(baseUrl);
		},
		"open" : function (url) {
			ZoomManager.getFile(url, "xml", function (doc, xhr) {
				var data = {};
				data.origin = url.replace(/\/xml\.php.*/,"");
				data.width = parseInt(doc.getElementsByTagName("width")[0].innerHTML);
				data.height = parseInt(doc.getElementsByTagName("height")[0].innerHTML);
				data.tileSize = parseInt(doc.getElementsByTagName("tileside")[0].innerHTML);
				data.remote = doc.getElementsByTagName("remote")[0].innerHTML;
				data.maxZoomLevel = 1;
				ZoomManager.readyToRender(data);
			});
		},
		"getTileURL" : function (x,y,z, data) {
			return data.origin+"/xml.php?"+data.remote+"?cmd=tile&x="+x+"&y="+y+"&z="+z;
		}
	};
})();
ZoomManager.addDezoomer(xlimage);
