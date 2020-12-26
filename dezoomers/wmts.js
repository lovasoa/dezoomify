/**
 * @param {string} text textual coordinates ("1.2 3.8")
 * @returns {[number, number]} parsed coordinates ([1.2, 3.8])
 */
function parseCoordinates(text) {
  return text
    .match(/(-?[\d\.]+)\s+(-?[\d\.]+)/)
    .slice(1)
    .map((s) => parseFloat(s));
}

// See the standard: https://www.ogc.org/standards/wmts
ZoomManager.addDezoomer({
  name: "WMTS",
  description: "OpenGIS Web Map Tile Service Implementation Standard",
  urls: [/\bwmts\b/],
  findFile(baseUrl, callback) {
    // metadata file URL extraction is not implemented yet
    return callback(baseUrl);
  },
  open(url) {
    ZoomManager.getFile(url, { type: "xml" }, function (doc, xhr) {
      const layer = doc.getElementsByTagName("Layer")[0];
      if (!layer) throw new Error("Not a valid WMTS file: no <Layer> element");
      const origin = layer
        .getElementsByTagName("ResourceURL")[0]
        .getAttribute("template");
      var bboxEl = layer.getElementsByTagName("ows:WGS84BoundingBox")[0];
      const [[bboxMinX, bboxMinY], [bboxMaxX, bboxMaxY]] = [
        "ows:LowerCorner",
        "ows:UpperCorner",
      ].map((name) =>
        parseCoordinates(bboxEl.getElementsByTagName(name)[0].textContent)
      );
      const tileMatrixSet = Array.from(layer.parentElement.children).filter(
        (set) =>
          set.tagName === "TileMatrixSet" &&
          set.getElementsByTagName("ows:Identifier")[0].textContent === "WGS84"
      )[0];
      const tileMatrices = Array.from(
        tileMatrixSet.getElementsByTagName("TileMatrix")
      ).map((m) => {
        const tileWidth = parseInt(
          m.getElementsByTagName("TileWidth")[0].textContent
        );
        const tileHeight = parseInt(
          m.getElementsByTagName("TileHeight")[0].textContent
        );
        const matrixWidth = parseInt(
          m.getElementsByTagName("MatrixWidth")[0].textContent
        );
        const matrixHeight = parseInt(
          m.getElementsByTagName("MatrixHeight")[0].textContent
        );
        const identifier = String(
          m.getElementsByTagName("ows:Identifier")[0].textContent
        );
        const scaleDenominator = parseFloat(
          m.getElementsByTagName("ScaleDenominator")[0].textContent
        );
        const [tileMatrixMaxY, tileMatrixMinX] = parseCoordinates(
          m.getElementsByTagName("TopLeftCorner")[0].textContent
        );
        const metersPerUnit = (6378137 * Math.PI) / 180;
        const pixelSpan = scaleDenominator * 0.28e-3 / metersPerUnit;
        const tileSpanX = tileWidth * pixelSpan;
        const tileSpanY = tileHeight * pixelSpan;
        const epsilon = 1e-6;
        const tileMinCol = Math.floor(
          (bboxMinX - tileMatrixMinX) / tileSpanX + epsilon
        );
        const tileMaxCol = Math.floor(
          (bboxMaxX - tileMatrixMinX) / tileSpanX - epsilon
        );
        const tileMinRow = Math.floor(
          (tileMatrixMaxY - bboxMaxY) / tileSpanY + epsilon
        );
        const tileMaxRow = Math.floor(
          (tileMatrixMaxY - bboxMinY) / tileSpanY - epsilon
        );
        return {
          tileSize: tileWidth,
          width: tileMaxCol - tileMinCol,
          height: tileMaxRow - tileMinRow,
          identifier,
          tileMinCol,
          tileMinRow,
          tileMaxCol,
          tileMaxRow,
        };
      });
      const tileMatrix = tileMatrices.sort((a, b) => a.scale - b.scale)[0];
      ZoomManager.readyToRender(tileMatrix);
    });
  },
  getTileURL: function (x, y, z, data) {
    return data.origin + "?cmd=tile&x=" + x + "&y=" + y + "&z=" + z;
  },
});
