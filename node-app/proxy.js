"use strict";
var http = require("http");
var stream = require("stream");

var server = new http.Server();
server.on("request", function(req, res){
  // Make our response readable through CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Set-Cookie");

  // Get the "cookies" and "url" query parameters
  var requestUrl = new URL(req.url, "http://127.0.0.1");
  var query = {
    url: requestUrl.searchParams.get("url"),
    cookies: requestUrl.searchParams.get("cookies")
  };

  console.log("Requested: " + query.url);

  // Function to call if any kind of error occurs
  function failRes (err) {
    res.writeHead(500, {'Content-Type': 'text/plain'});
    res.end(err.toString() + "\n");
  }

  try {
    if (!query.url) throw new Error("Missing url query parameter");

    var headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/40.0.2214.85 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "identity"
    };
    if (query.cookies) headers.Cookie = query.cookies;

    fetch(query.url, { headers: headers, redirect: "follow" })
      .then(function(targetRes) {
        res.statusCode = targetRes.status;
        targetRes.headers.forEach(function(value, name) {
          name = name.toLowerCase();
          if (name !== "set-cookie" && name !== "content-encoding" && name !== "content-length") {
            res.setHeader(name, value);
          }
        });

        var cookies = targetRes.headers.getSetCookie ?
          targetRes.headers.getSetCookie() :
          targetRes.headers.get("set-cookie");
        if (cookies) {
          if (!Array.isArray(cookies)) cookies = [cookies];
          // Transmit only the cookie contents through our custom header
          res.setHeader("X-Set-Cookie",
                        cookies.map(c => c.match(/^[^;]*/)[0] + ';').join(""));
        }

        if (targetRes.body) {
          stream.Readable.fromWeb(targetRes.body).pipe(res);
        } else {
          res.end();
        }
      }).catch(failRes);
  } catch (e) {failRes(e)}
});

module.exports = server;
// Start the server only if called as a standalone script
if (require.main === module) {
  server.listen(8181);
  console.log("listening on port 8181");
}
