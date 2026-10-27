import type { ObservedInput } from "@dezoomify/wasm-bindings";
import type { PageObject } from "../viewers/page-object.ts";
import type {
  DziSource,
  IiifSource,
  IiifTile,
  IipSource,
  MetadataContext,
  SourceGeometry,
  TileSource,
  ZoomifySource,
} from "../viewers/types.ts";

function address(value: string, baseURI: string): string {
  const url = new URL(value, baseURI);
  if (url.href.length > 2048 || !["http:", "https:"].includes(url.protocol))
    throw new Error("unsupported address");
  return url.href;
}

function geometry(source: PageObject): SourceGeometry {
  const dimensions = source.reference("dimensions");
  const width = dimensions?.number("x", source.number("width")) ?? source.number("width");
  const height = dimensions?.number("y", source.number("height")) ?? source.number("height");
  if (!width || !height || source.matches("ready", false) || source.has("downloadTileStart"))
    throw new Error("unsupported source");
  const format = source.string(
    "fileFormat",
    source.string("tileFormat", source.string("format", "jpg")),
  );
  if (!/^[a-z0-9]{1,64}$/i.test(format)) throw new Error("unsupported format");
  return {
    width,
    height,
    format,
    tileWidth: source.number("_tileWidth", source.number("tileSize")),
    tileHeight: source.number("_tileHeight", source.number("tileSize")),
  };
}

function readTiledSource(
  source: PageObject,
  shape: SourceGeometry,
  baseURI: string,
  tilesUrl = source.string("tilesUrl"),
): DziSource | ZoomifySource {
  const base = address(tilesUrl, baseURI);
  if (!shape.tileWidth || shape.tileWidth !== shape.tileHeight)
    throw new Error("unsupported tiles");
  if (source.isArray("imageSizes")) {
    if (!["jpg", "jpeg"].includes(shape.format)) throw new Error("unsupported Zoomify format");
    const tileCount = source
      .objects("gridSize", 33)
      .reduce((total, grid) => total + grid.number("x") * grid.number("y"), 0);
    return { ...shape, protocol: "zoomify", base, tileCount };
  }
  if (
    source.arrayLength("displayRects", 256) ||
    source.queryPresent("queryParams") ||
    source.number("minLevel") !== 0 ||
    source.number("maxLevel") !== Math.ceil(Math.log2(Math.max(shape.width, shape.height)))
  )
    throw new Error("unsupported DZI pyramid");
  return { ...shape, protocol: "dzi", base, overlap: source.number("tileOverlap") };
}

function readIiifTile(tile: PageObject): IiifTile {
  return {
    width: tile.number("width"),
    height: tile.number("height", tile.number("width")),
    scaleFactors: tile.scaleFactors("scaleFactors"),
  };
}

function readIiifSource(source: PageObject, shape: SourceGeometry, baseURI: string): IiifSource {
  const version = source.number("version", 2);
  if ((version !== 2 && version !== 3) || source.matches("isLevel0", true))
    throw new Error("unsupported IIIF service");
  const id = address(iiifId(source), baseURI);
  const tiles = source.objects("tiles", 64).map(readIiifTile);
  if (!tiles.length) throw new Error("untiled IIIF");
  return { ...shape, protocol: "iiif", id, version, tiles };
}

function readIipSource(source: PageObject, shape: SourceGeometry, baseURI: string): IipSource {
  if (
    !["jpg", "jpeg"].includes(shape.format) ||
    !shape.tileWidth ||
    !shape.tileHeight ||
    source.number("maxLevel") > 31
  )
    throw new Error("unsupported IIP pyramid");
  const server = address(source.string("iipsrv"), baseURI);
  const image = source.string("image");
  const transforms = readIipTransforms(source.reference("transform"));
  return {
    ...shape,
    protocol: "iip",
    server,
    image,
    transforms,
    levels: source.number("maxLevel") + 1,
  };
}

function readIipTransforms(transform: PageObject | undefined): string {
  return (
    transform
      ?.keys()
      .map((key) => {
        const value = transform.scalar(key, 256);
        if (value === undefined) return "";
        if (!["contrast", "twist"].includes(String(key)))
          throw new Error("unsupported IIP transform");
        return `&${key === "contrast" ? "CNT" : "CTW"}=${value}`;
      })
      .join("") ?? ""
  );
}

function iiifId(source: PageObject): string {
  return source.string("_id") || source.string("@id") || source.string("id");
}

export function readTileSource(source: PageObject, baseURI: string): TileSource {
  if (source.has("getTileUrl")) throw new Error("unsupported source");
  const shape = geometry(source);
  if (source.truthy("tilesUrl") && source.truthy("fileFormat"))
    return readTiledSource(source, shape, baseURI);
  if (source.truthy("tileFormat") && iiifId(source)) return readIiifSource(source, shape, baseURI);
  if (source.truthy("iipsrv") && source.truthy("image"))
    return readIipSource(source, shape, baseURI);
  throw new Error("unsupported protocol");
}

/** Call only for a source from an identified, DOM-bound Seadragon viewer. Its
 * tile-address method exposes the base URL hidden in the legacy source closure. */
export function readSeadragonSource(source: PageObject, baseURI: string): TileSource {
  const shape = geometry(source);
  const level = source.number("maxLevel");
  const suffix = `${level}/0_0.${shape.format}`;
  const url = source.call("getTileUrl", level, 0, 0);
  if (typeof url !== "string" || !url.endsWith(suffix))
    throw new Error("unsupported Seadragon address");
  const base = url.slice(0, -suffix.length);
  if (source.call("getTileUrl", 0, 0, 0) !== `${base}0/0_0.${shape.format}`)
    throw new Error("unsupported Seadragon address");
  return readTiledSource(source, shape, baseURI, base);
}

function dziMetadata(source: DziSource, context: MetadataContext): ObservedInput {
  const identity = new URL(context.documentUrl);
  identity.hash = `dezoomify-openseadragon-${context.imageIndex}`;
  return {
    kind: "observed-metadata",
    url: identity.href,
    contents: JSON.stringify({
      Image: {
        xmlns: "http://schemas.microsoft.com/deepzoom/2008",
        Url: source.base,
        Format: source.format,
        Overlap: source.overlap,
        TileSize: source.tileWidth,
        Size: { Width: source.width, Height: source.height },
      },
    }),
  };
}

function zoomifyMetadata(source: ZoomifySource): ObservedInput {
  return {
    kind: "observed-metadata",
    url: `${source.base.replace(/\/$/, "")}/ImageProperties.xml`,
    contents: `<IMAGE_PROPERTIES WIDTH="${source.width}" HEIGHT="${source.height}" TILESIZE="${source.tileWidth}" NUMTILES="${source.tileCount}"/>`,
  };
}

function iiifMetadata(source: IiifSource): ObservedInput {
  return {
    kind: "observed-metadata",
    url: `${source.id.replace(/\/$/, "")}/info.json`,
    contents: JSON.stringify({
      "@context": `http://iiif.io/api/image/${source.version}/context.json`,
      id: source.id,
      width: source.width,
      height: source.height,
      tiles: source.tiles,
      formats: [source.format],
      // OpenSeadragon's IIIF v2 sources use width-only tile sizes; v3 uses width,height.
      ...(source.version === 2 ? { profile: [{ supports: ["sizeByW"] }] } : {}),
    }),
  };
}

function iipMetadata(source: IipSource): ObservedInput {
  return {
    kind: "observed-metadata",
    url: `${source.server}?FIF=${source.image}${source.transforms}&OBJ=Max-size&OBJ=Tile-size&OBJ=Resolution-number`,
    contents: `Max-size:${source.width} ${source.height}\nTile-size:${source.tileWidth} ${source.tileHeight}\nResolution-number:${source.levels}`,
  };
}

/** Pure projection of validated page snapshots into the core's metadata input. */
export function projectMetadata(source: TileSource, context: MetadataContext): ObservedInput {
  switch (source.protocol) {
    case "dzi":
      return dziMetadata(source, context);
    case "zoomify":
      return zoomifyMetadata(source);
    case "iiif":
      return iiifMetadata(source);
    case "iip":
      return iipMetadata(source);
  }
}
