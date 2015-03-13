var zoomifyPFF = (function () { //Code isolation
	return {
		"name": "Zoomify PFF",
		"findFile" : function getZoomifyPath (baseUrl, callback) {
			ZoomManager.getFile(baseUrl, "text", function (text, xhr) {
				// for the zoomify flash player, the path is in the zoomifyImagePath
				// attribute of a tag
				var f = text.match(/zoomifyImagePath=([^\'"&]*)[\'"&]/)[1];
				var ip = text.match(/zoomifyServerIP=([^\'"&]*)[\'"&]/)[1];
				var path = text.match(/zoomifyTileHandlerPath=([^\'"&]*)[\'"&]/)[1];
				return callback("http://"+ip+path+"?file="+f);
			});
		},
		"open" : function (url) {
			ZoomManager.getFile(url+"&requestType=1", "text", function (text, xhr) {
				var data = {};
				data.origin = url;
				data.width = parseInt(text.match(/width=.(\d+)/i)[1]);
				data.height = parseInt(text.match(/height=.(\d+)/i)[1]);
				data.tileSize = parseInt(text.match(/tileSize=.(\d+)/i)[1]);
				data.numTiles = parseInt(text.match(/numTiles=.(\d+)/i)[1]);
				data.version = parseInt(text.match(/version=.(\d+)/i)[1]);
				data.headerSize = parseInt(text.match(/headerSize=.(\d+)/i)[1]);
				data.zoomFactor = 2; //Zooming factor between two consecutive zoom levels

				var begin = 0x424 + data.headerSize,
						end   = begin + 8*data.numTiles;
				ZoomManager.getFile(url+"&requestType=2&begin="+begin+"&end="+end, "text", function(text) {
					var s = parseInt(text.match(/reply_data=(\d+)/)[1]);
					data.offsets = text.split(',')[1]
														 .match(/[ \d]{9}/g)
														 .map(function(x){return parseInt(x)+s});
					ZoomManager.readyToRender(data);
				});
			});
		},
		"getTileURL" : function (col, row, zoom, data) {
			var idx = col + row*data.nbrTilesX,
					begin = data.offsets[idx],
					end = data.offsets[idx+1];
			return data.origin+"&requestType=0&head="+data.headerSize+"&begin="+begin+"&end="+end;
		}
	};
})();
ZoomManager.addDezoomer(zoomifyPFF);
