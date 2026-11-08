import { address } from "../viewers/metadata.ts";
import { PageObject } from "../viewers/page-object.ts";
import {
  type KrpanoLevel,
  type KrpanoShape,
  type KrpanoSource,
  krpanoShapes,
} from "../viewers/types.ts";

function integer(object: PageObject, key: string, fallback = 0): number {
  // Explicit XML levels retain numeric strings; normalized multires levels use numbers.
  if (!object.has(key)) return fallback;
  const value = object.boundedString(key, 10);
  const number = value === undefined ? object.number(key, NaN) : Number(value);
  if (
    !Number.isInteger(number) ||
    number < 0 ||
    number > 0xffffffff ||
    (value !== undefined && !/^\d+$/.test(value))
  )
    throw new Error("unsupported image geometry");
  return number;
}

function readShapes(
  runtime: PageObject,
  image: PageObject,
  level: PageObject,
  base: string,
): KrpanoShape[] {
  return krpanoShapes.flatMap((name) => {
    const url = level.reference(name)?.string("url");
    if (!url) return [];
    if (/^(get|calc):/i.test(url)) throw new Error("dynamic tile address");
    if (
      name === "cube" &&
      /%0*s/.test(url) &&
      image.string("cubelabels", "l|f|r|b|u|d") !== "l|f|r|b|u|d"
    )
      throw new Error("unsupported cube labels");
    const resolved = runtime.call("parsepath", url);
    if (typeof resolved !== "string" || resolved.length > 2048)
      throw new Error("unsupported tile address");
    return [{ type: name, url: address(resolved, base) }];
  });
}

/** Call only with a DOM-identified krpano runtime. Snapshot its active static
 * grid after includes, decryption and multires expansion. Read-only getArray and
 * parsepath APIs (https://krpano.com/docu/js/) supply the configuration. Return
 * detached data so metadata encoding never invokes page code. */
export function readTileSource(runtime: PageObject, image: PageObject, base: string): KrpanoSource {
  if (
    runtime.truthy("customParseTilePath") ||
    image.truthy("stereo") ||
    image.truthy("tileoverlap") ||
    integer(image, "frames", 1) > 1
  )
    throw new Error("unsupported image layout");
  const levels = image.reference("level")?.call("getArray");
  if (!Array.isArray(levels) || !levels.length || levels.length > 64)
    throw new Error("unsupported image levels");
  const array = PageObject.from(levels);
  const snapshots: KrpanoLevel[] = [];
  let tileSize = 0;
  for (let index = 0; index < levels.length; index++) {
    const level = array?.reference(index);
    if (!level) throw new Error("unsupported image level");
    const width = integer(level, "tiledimagewidth");
    const height = integer(level, "tiledimageheight");
    const size = integer(level, "tilesize", integer(image, "tilesize"));
    if (!width || !height || !size || (tileSize && tileSize !== size))
      throw new Error("unsupported image geometry");
    tileSize = size;
    const shapes = readShapes(runtime, image, level, base);
    if (!shapes.length) throw new Error("unsupported image projection");
    snapshots.push({ width, height, shapes });
  }
  return {
    protocol: "krpano",
    tileSize,
    baseIndex: integer(image, "baseindex", 1),
    levels: snapshots,
  };
}
