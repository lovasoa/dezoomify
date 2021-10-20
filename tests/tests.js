if (typeof BASE === "undefined") BASE = "/base";

QUnit.module("Image loads", {
  beforeEach: function (assert) {
    var done = assert.async();
    var that = this;

    var iframe = document.createElement("iframe");
    iframe.src = BASE + "/index.html";
    document.body.appendChild(iframe);

    var testwin = iframe.contentWindow;

    testwin.onload = function() {
      var ZoomManager = testwin.ZoomManager;
      // Execute the tests faster: don't wait between fake tile loads
      ZoomManager.nextTick = function(f) {return setTimeout(f,0);};
      ZoomManager.proxy_url = "http://127.0.0.1:8181/proxy.php";
      that.ZoomManager = ZoomManager;
      that.UI = testwin.UI;
      that.testwin = testwin;
      done();
    }
  }
});

test_urls.forEach(function(test) {
  QUnit.test(test.name, function( assert ) {
    var ZoomManager = this.ZoomManager,
        UI = this.UI,
        testwin = this.testwin;
    assert.expect(1);
    var done = assert.async();
    ZoomManager.reset();
    ZoomManager.open(test.url);
    ZoomManager.loadEnd = function () {
      ZoomManager.reset();
      assert.ok(true, "Image loaded")
      done();
    }
    ZoomManager.addTile = function (url, x, y) {
      //In order to save time & bandwidth, load only the last tile
      if (x*y === (ZoomManager.data.nbrTilesX-1) *
                  (ZoomManager.data.nbrTilesY-1) *
                  (ZoomManager.data.tileSize * ZoomManager.data.tileSize)) {
          var img = document.createElement("img");
          img.onload = function () {ZoomManager.status.loaded ++;};
          img.onerror = function() {
            assert.ok(false, "Invalid tile image: " + url);
            done();
          }
          img.src = url;
      } else {
        ZoomManager.status.loaded ++;
        UI.canvas.width = UI.canvas.height = UI.canvas.style.width = UI.canvas.style.height = 0;
      }
    };
    testwin.onerror = function(err, source, lineno) {
      assert.ok(false, "Dezoomify bug " + err + "\n" + source + ':' + lineno);
      done();
    }
  });
});
