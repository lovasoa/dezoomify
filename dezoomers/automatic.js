var automatic = (function () { //Code isolation
	return {
		"name": "Select automatically",
		"description": "Tries to guess which dezoomer to use by selectioning among known url patterns",
		"open" : function (url) {
				// Find dezoomer to the one that that will most probably
				// be able to dezoom url, and call the callback with it

				// First, try to match the URL
				for (dezoomerName in ZoomManager.dezoomersList) {
					var dezoomer = ZoomManager.dezoomersList[dezoomerName];
					if (dezoomer.urls) {
						for (var i=0; i<dezoomer.urls.length; i++) {
							var urlRegex = dezoomer.urls[i];
							if (url.match(urlRegex)) {
								ZoomManager.setDezoomer(dezoomer);
								return ZoomManager.open(url);
							}
						}
					}
				}

				// Then, if url didn't match, try to match the contents
				// Match recursively the page contents and all its iframe children
				var urlstack = [url];
				function processNextUrl() {
					var nextUrl = urlstack.shift();
					if (!nextUrl) {
						var msg = "Unable to find a proper dezoomer for:\n" + url;
						throw new Error(msg);
					}
					nextUrl = ZoomManager.resolveRelative(nextUrl, url);

					ZoomManager.getFile(nextUrl, {type:"htmltext"}, function(contents) {
						var iframeRegex = /<i?frame[^>]*src=["']([^"']+)/g;
						var match;
						while (match = iframeRegex.exec(contents)) {
							urlstack.push(match[1]);
						}

						for (dezoomerName in ZoomManager.dezoomersList) {
							var dezoomer = ZoomManager.dezoomersList[dezoomerName];
							if (dezoomer.contents) {
								for (var i=0; i<dezoomer.contents.length; i++) {
									var regex = dezoomer.contents[i];
									if (contents.match(regex)) {
										ZoomManager.setDezoomer(dezoomer);
										return ZoomManager.open(nextUrl);
									}
								}
							}
						}
						processNextUrl();
					});
				}
				processNextUrl();
		},
	};
})();
ZoomManager.addDezoomer(automatic);
ZoomManager.setDezoomer(automatic);
