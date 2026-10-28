import { address, geometry, readTiledSource } from "../viewers/metadata.ts";
import type { PageObject } from "../viewers/page-object.ts";
import type {
  IiifSource,
  IiifTile,
  IipSource,
  SourceGeometry,
  TileSource,
} from "../viewers/types.ts";

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
