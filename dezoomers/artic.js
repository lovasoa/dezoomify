var artic = (function () {
  var artworkUrlReg = /^https?:\/\/www\.artic\.edu\/artworks\/(\d+)(?:[/?#]|$)/;

  function apiUrl(artworkId) {
    return "https://api.artic.edu/api/v1/artworks/" + artworkId +
      "?fields=id,title,image_id,thumbnail,alt_image_ids";
  }

  function open(url) {
    var match = url.match(artworkUrlReg);
    if (!match) throw new Error("Unsupported Art Institute of Chicago URL.");

    ZoomManager.getFile(apiUrl(match[1]), { type: "json" }, function (response) {
      var artwork = response && response.data;
      var iiifUrl = response && response.config && response.config.iiif_url;
      var thumbnail = artwork && artwork.thumbnail;
      var imageId = artwork && artwork.image_id;

      if (!iiifUrl || !imageId || !thumbnail || !thumbnail.width || !thumbnail.height) {
        throw new Error("No Art Institute of Chicago IIIF image found.");
      }

      ZoomManager.readyToRender({
        origin: iiifUrl.replace(/\/$/, "") + "/" + imageId,
        width: parseInt(thumbnail.width),
        height: parseInt(thumbnail.height),
        tileSize: 1024,
        maxZoomLevel: 1,
        quality: "default",
        format: "jpg"
      });
    });
  }

  return {
    name: "Art Institute of Chicago",
    description: "Artwork pages from the Art Institute of Chicago",
    urls: [artworkUrlReg],
    open: open,
    getTileURL: iiif.getTileURL
  };
})();

ZoomManager.addDezoomer(artic);
