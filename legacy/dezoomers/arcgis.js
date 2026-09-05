function isArcGISMapServerUrl(url) {
  try {
    return /\/MapServer\/?$/i.test(new URL(url).pathname);
  } catch (_error) {
    return false;
  }
}

function normalizeArcGISMapServerUrl(url) {
  const service = new URL(url);
  const match = service.pathname.match(/^(.*\/MapServer)\/?$/i);
  if (!match) throw new Error("Expected an ArcGIS MapServer URL.");

  service.pathname = match[1];
  const tileParameters = new URLSearchParams(service.search);
  for (const name of [...tileParameters.keys()]) {
    if (name.toLowerCase() === "f") tileParameters.delete(name);
  }
  service.search = "";

  const metadata = new URL(service);
  metadata.search = tileParameters;
  metadata.searchParams.set("f", "json");

  return {
    serviceUrl: service.toString(),
    metadataUrl: metadata.toString(),
    tileParameters: tileParameters.toString(),
  };
}

function number(value, name) {
  if (!Number.isFinite(value)) throw new Error(`Invalid ArcGIS MapServer ${name}.`);
  return value;
}

function matchingSpatialReferences(first, second) {
  if (!first || !second) return false;
  const firstId = first.latestWkid || first.wkid || first.wkt;
  const secondId = second.latestWkid || second.wkid || second.wkt;
  return firstId != null && secondId != null && firstId === secondId;
}

function tileMatrices(metadata, service) {
  if (metadata.type !== "MapServer") {
    throw new Error("ArcGIS service is not a MapServer.");
  }
  if (!metadata.singleFusedMapCache) {
    throw new Error("ArcGIS MapServer does not provide a fused tile cache.");
  }

  const tileInfo = metadata.tileInfo;
  const extent = metadata.fullExtent;
  if (!tileInfo || !extent || !Array.isArray(tileInfo.lods)) {
    throw new Error("ArcGIS MapServer is missing cached tile metadata.");
  }
  if (!matchingSpatialReferences(tileInfo.spatialReference, extent.spatialReference)) {
    throw new Error("ArcGIS MapServer tile cache and extent use different spatial references.");
  }

  const tileWidth = number(tileInfo.cols, "tile width");
  const tileHeight = number(tileInfo.rows, "tile height");
  if (tileWidth <= 0 || tileHeight <= 0 || tileWidth !== tileHeight) {
    throw new Error("ArcGIS MapServer must use square cached tiles.");
  }
  const originX = number(tileInfo.origin && tileInfo.origin.x, "tile origin x");
  const originY = number(tileInfo.origin && tileInfo.origin.y, "tile origin y");
  const xmin = number(extent.xmin, "extent xmin");
  const ymin = number(extent.ymin, "extent ymin");
  const xmax = number(extent.xmax, "extent xmax");
  const ymax = number(extent.ymax, "extent ymax");
  if (xmin > xmax || ymin > ymax) throw new Error("Invalid ArcGIS MapServer extent.");

  return tileInfo.lods.map((lod) => {
    const resolution = number(lod.resolution, "LOD resolution");
    const level = number(lod.level, "LOD level");
    if (resolution <= 0) throw new Error("Invalid ArcGIS MapServer LOD resolution.");

    const spanX = tileWidth * resolution;
    const spanY = tileHeight * resolution;
    const minColumn = Math.floor((xmin - originX) / spanX);
    const maxColumn = Math.floor((xmax - originX) / spanX);
    const minRow = Math.floor((originY - ymax) / spanY);
    const maxRow = Math.floor((originY - ymin) / spanY);
    const nbrTilesX = maxColumn - minColumn + 1;
    const nbrTilesY = maxRow - minRow + 1;

    return {
      serviceUrl: service.serviceUrl,
      tileParameters: service.tileParameters,
      level,
      resolution,
      tileSize: tileWidth,
      width: nbrTilesX * tileWidth,
      height: nbrTilesY * tileHeight,
      nbrTilesX,
      nbrTilesY,
      minColumn,
      maxColumn,
      minRow,
      maxRow,
      maxZoomLevel: 1,
    };
  });
}

ZoomManager.addDezoomer({
  name: "ArcGIS MapServer",
  description: "Cached ArcGIS REST MapServer",
  urls: [/(?:\/|%2f)MapServer(?:(?:\/|%2f)?(?:%3f|%26|[?&#]|$))/i],
  findFile(baseUrl, callback) {
    const viewerUrl = new URL(baseUrl);
    const basemapUrl = viewerUrl.searchParams.get("basemapUrl");
    callback(basemapUrl && isArcGISMapServerUrl(basemapUrl) ? basemapUrl : baseUrl);
  },
  open(url) {
    let service;
    try {
      service = normalizeArcGISMapServerUrl(url);
    } catch (error) {
      ZoomManager.error(error.message);
      return;
    }

    ZoomManager.getFile(service.metadataUrl, { type: "json" }, (metadata) => {
      try {
        const matrix = tileMatrices(metadata, service)
          .filter((candidate) => candidate.width * candidate.height < UI.MAX_CANVAS_AREA)
          .sort((first, second) => first.resolution - second.resolution)[0];
        if (!matrix) throw new Error("No ArcGIS MapServer level fits within the canvas limit.");
        ZoomManager.readyToRender(matrix);
      } catch (error) {
        ZoomManager.error(error.message);
      }
    });
  },
  getTileURL(x, y, _zoom, matrix) {
    const column = matrix.minColumn + x;
    const row = matrix.minRow + y;
    if (
      column < matrix.minColumn || column > matrix.maxColumn ||
      row < matrix.minRow || row > matrix.maxRow
    ) {
      throw new Error(`Invalid ArcGIS tile coordinates at ${x}, ${y}.`);
    }
    const url = `${matrix.serviceUrl}/tile/${matrix.level}/${row}/${column}`;
    return matrix.tileParameters ? `${url}?${matrix.tileParameters}` : url;
  },
});
