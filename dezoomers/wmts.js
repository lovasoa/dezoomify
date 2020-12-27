/**
 * Earth radius according to WGS84
 **/
const RADIUS = 6378137;
const HALF_SIZE = Math.PI * RADIUS;

/**
 * @param {string} text textual coordinates ("1.26E3 3.8")
 * @returns {[number, number]} parsed coordinates ([1260, 3.8])
 */
function parseCoordinates(text) {
  return text
    .match(/(-?[\d\.Ee\+\-]+)\s+(-?[\d\.Ee\+\-]+)/)
    .slice(1)
    .map((s) => parseFloat(s));
}

/** EPSG::3857 coordinates */
class Coords {
  /**
   *
   * @param {number} x
   * @param {number} y
   */
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
  static fromCRS(x, y, crs) {
    switch (crs) {
      case "urn:ogc:def:crs:EPSG::3857": // We make all calculations in EPSG::3857
        break;
      case "urn:ogc:def:crs:OGC:2:84":
      case "urn:ogc:def:crs:EPSG::4326":
        x = (HALF_SIZE * x) / 180;
        y = RADIUS * Math.log(Math.tan((Math.PI * (y + 90)) / 360));
        break;
      default:
        throw new Error("Unsupprted coordinate reference system: " + crs);
    }
    return new Coords(x, y);
  }
}

/**
 * @param {Element} root an XML tree
 * @returns {Element} the first child with the given tag name
 */
function xmlChild(root, tagName) {
  const children = root.getElementsByTagName(tagName);
  if (children.length === 0)
    throw new Error(`${root.tagName} has no children of type ${tagName}`);
  return children[0];
}

/**
 * @param {Element} root an XML tree
 * @param {string} tagName
 * @returns {string} the text contents of the element with the given name
 */
function xmlText(root, tagName) {
  return xmlChild(root, tagName).textContent;
}

/**
 * @param {Element} root an XML tree
 * @param {string} tagName
 * @returns {number} the text contents of the element with the given name
 */
function xmlNumber(root, tagName) {
  return parseFloat(xmlText(root, tagName));
}

const floor = (x) => Math.floor(x);

// See the standard: https://www.ogc.org/standards/wmts
ZoomManager.addDezoomer({
  name: "WMTS",
  description: "OpenGIS Web Map Tile Service Implementation Standard",
  urls: [/\bwmts\b/i],
  findFile(baseUrl, callback) {
    // metadata file URL extraction is not implemented yet
    return callback(baseUrl);
  },
  open(url) {
    ZoomManager.getFile(url, { type: "xml" }, function (doc, xhr) {
      const layer = xmlChild(doc, "Layer");
      const urlTemplate = xmlChild(layer, "ResourceURL").getAttribute(
        "template"
      );
      let layerStyle = "default";
      try {
        layerStyle = xmlText(xmlChild(layer, "Style"), "ows:Identifier");
      } catch (e) {
        console.log("No layer style", e);
      }
      let bboxEl = [
        ...layer.getElementsByTagName("ows:BoundingBox"),
        ...layer.getElementsByTagName("ows:WGS84BoundingBox"),
      ][0];
      const [[bboxMinX, bboxMinY], [bboxMaxX, bboxMaxY]] = [
        "ows:LowerCorner",
        "ows:UpperCorner",
      ].map((name) => parseCoordinates(xmlText(bboxEl, name)));
      const crs = bboxEl.getAttribute("crs");
      const bbox = {
        topLeft: Coords.fromCRS(bboxMinX, bboxMaxY, crs),
        bottomRight: Coords.fromCRS(bboxMaxX, bboxMinY, crs),
      };
      const tileMatrixSet = Array.from(layer.parentElement.children).filter(
        (set) =>
          set.tagName === "TileMatrixSet" &&
          xmlText(set, "ows:SupportedCRS") === "urn:ogc:def:crs:EPSG::3857"
      )[0];
      if (!tileMatrixSet) throw new Error("no supported tile matrix set found");
      const tileMatrices = Array.from(
        tileMatrixSet.getElementsByTagName("TileMatrix")
      ).map((m) => {
        const tileSize = xmlNumber(m, "TileWidth");
        const tileHeight = xmlNumber(m, "TileHeight");
        if (tileHeight !== tileSize)
          throw new Error("Non-square tiles are not supported");
        const matrixWidth = xmlNumber(m, "MatrixWidth");
        const matrixHeight = xmlNumber(m, "MatrixHeight");
        const scaleDenominator = xmlNumber(m, "ScaleDenominator");
        const [tileMatrixMinX, tileMatrixMaxY] = parseCoordinates(
          xmlText(m, "TopLeftCorner")
        );
        const topLeft = new Coords(tileMatrixMinX, tileMatrixMaxY);
        const pixelSpan = scaleDenominator * 0.28e-3; // metersPerUnit=1 in EPSG3857
        const span = tileSize * pixelSpan; // number of meters represented on a tile
        const tileMinCol = floor((bbox.topLeft.x - topLeft.x) / span);
        const tileMinRow = floor((topLeft.y - bbox.topLeft.y) / span);
        const tileMaxCol = floor((bbox.bottomRight.x - topLeft.x) / span);
        const tileMaxRow = floor((topLeft.y - bbox.bottomRight.y) / span);
        return {
          tileSize,
          width: (tileMaxCol + 1 - tileMinCol) * tileSize,
          height: (tileMaxRow + 1 - tileMinRow) * tileSize,
          urlTemplate,
          context: {
            TileMatrix: xmlText(m, "ows:Identifier"),
            TileMatrixSet: xmlText(tileMatrixSet, "ows:Identifier"),
            Style: layerStyle,
          },
          tileMinCol,
          tileMinRow,
          tileMaxCol,
          tileMaxRow,
          matrixHeight,
          matrixWidth,
          maxZoomLevel: 1,
        };
      });
      const tileMatrix = tileMatrices
        .filter((m) => m.width * m.height < window.UI.MAX_CANVAS_AREA)
        .sort((a, b) => b.width - a.width)[0];
      ZoomManager.readyToRender(tileMatrix);
    });
  },
  getTileURL: function (x, y, _z, tileMatrix) {
    const TileCol = tileMatrix.tileMinCol + x;
    const TileRow = tileMatrix.tileMinRow + y;
    if (
      TileCol < tileMatrix.tileMinCol ||
      TileCol > tileMatrix.tileMaxCol ||
      TileRow < tileMatrix.tileMinRow ||
      TileRow > tileMatrix.tileMaxRow
    ) {
      throw new Error(`Invalid tile coordinates at ${x}, ${y}`);
    }
    return tileMatrix.urlTemplate.replace(
      /\{([^\}]+)\}/g,
      (original, varName) => {
        const result = { ...tileMatrix.context, TileCol, TileRow }[varName];
        return result == null ? original : result;
      }
    );
  },
});
