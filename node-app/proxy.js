"use strict";
var http = require("http");
var request = require("request");
var url = require("url");

var server = new http.Server();
server.on("request", function(req, res){
  // Make our response readable through CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Set-Cookie");

  // Get the "cookies" and "url" query parameters
  var query = url.parse(req.url, true).query;

  console.log("Requested: " + query.url);

  // Options for the request to be made to the target server
  var targetOptions = {
    url: query.url,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/40.0.2214.85 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Cookie": query.cookies
    }
  }

  // Function to call if any king of error occurs
  function failRes (err) {
    res.writeHead(500, {'Content-Type': 'text/plain'});
    res.end(err.toString() + "\n");
  }
  try {
    request(targetOptions)
      .on("error", failRes)
      .on("response", function(targetRes){
        var cookies = targetRes.headers["set-cookie"];
        if (cookies) {
          // Transmit only the cookie contents through our custom header
          res.setHeader("X-Set-Cookie",
                        cookies.map(c => c.match(/^[^;]*/)[0] + ';').join(""));
        }
      }).pipe(res); // Pipe target response to the response we make to our client
  } catch (e) {failRes(e)}
});

module.exports = server;
// Start the server only if called as a standalone script
if (require.main === module) {
  server.listen(8181);
  console.log("listening on port 8181");
}
