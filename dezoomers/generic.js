var generic_viewer = (function(){
  return {
    "name" : "Generic dezoomer",
    "description": "Just put the url of a tile, replacing it's horizontal coordinate by {{X}} and vertical coordinate by {{Y}}.",
    "urls" : [
      /\{\{X\}\}/
    ],
    "open" : function (url) {
      var current_dimension = 0;
      var dimensions_interval = [[0,1000], [0,1000]];
      var tileSize = 256;
      function middle(interval) {
        return Math.floor((interval[0] + interval[1]) / 2);
      }
      function dichotomy_step() {
        var img = new Image;
        var coords = dimensions_interval.map(function(interval, i){
          return i === current_dimension ? middle(interval) : 0;
        });
        img.src = url.replace("{{X}}", coords[0]).replace("{{Y}}", coords[1]);
        function next_image(border) {
          var interval = dimensions_interval[current_dimension];
          var new_coord = middle(interval);
          return function update() {
            interval[border] = new_coord;
            console.log(dimensions_interval);
            if (interval[0] + 1 == interval[1])
              current_dimension ++;
            if (current_dimension >= dimensions_interval.length) {
              return ZoomManager.readyToRender({
                "origin" : url,
                "width" : dimensions_interval[0][1]*tileSize,
                "height" : dimensions_interval[1][1]*tileSize,
                "tileSize" : tileSize
              });
            }
            if (img.height > 0 && img.width > 0) {
              // Try to guess tilesize.
              // There can be overlap between tiles, but there cannot be blanks.
              // (In most cases, width and height will be the same)
              tileSize = Math.min(img.width, img.height);
            }
            return dichotomy_step();
          }
        }
        img.onload = next_image(0);
        img.onerror = next_image(1);
      }
      return dichotomy_step();
    },
    "getTileURL" : function (x, y, zoom, data) {
      return data.origin.replace("{{X}}", x).replace("{{Y}}", y);
    }
  };
})();
ZoomManager.addDezoomer(generic_viewer);
