import type { ObservedInput } from "@dezoomify/wasm-bindings";
import { address } from "../viewers/metadata.ts";
import { PageObject } from "../viewers/page-object.ts";
import type { MetadataContext } from "../viewers/types.ts";

const shapes = [
  "cube",
  "cylinder",
  "flat",
  "sphere",
  "left",
  "right",
  "front",
  "back",
  "up",
  "down",
];

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

function xmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function levelShapes(
  runtime: PageObject,
  image: PageObject,
  level: PageObject,
  base: string,
): string {
  return shapes
    .flatMap((name) => {
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
      return [`<${name} url="${xmlAttribute(address(resolved, base))}"/>`];
    })
    .join("");
}

/** Call only with a DOM-identified krpano runtime. Snapshot its active static
 * grid after includes, decryption and multires expansion. Read-only getArray and
 * parsepath APIs (https://krpano.com/docu/js/) supply the configuration; Rust owns
 * tile templates and geometry. Unsupported layouts retain ordinary discovery. */
export function projectImage(
  runtime: PageObject,
  image: PageObject,
  context: MetadataContext,
  base: string,
): ObservedInput {
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
  let tilesize = 0;
  const contents = Array.from({ length: levels.length }, (_, index) => {
    const level = array?.reference(index);
    if (!level) throw new Error("unsupported image level");
    const width = integer(level, "tiledimagewidth");
    const height = integer(level, "tiledimageheight");
    const size = integer(level, "tilesize", integer(image, "tilesize"));
    if (!width || !height || !size || (tilesize && tilesize !== size))
      throw new Error("unsupported image geometry");
    tilesize = size;
    const shapes = levelShapes(runtime, image, level, base);
    if (!shapes) throw new Error("unsupported image projection");
    return `<level tiledimagewidth="${width}" tiledimageheight="${height}">${shapes}</level>`;
  });
  const url = new URL(context.documentUrl);
  url.hash = `dezoomify-krpano-${context.imageIndex}`;
  return {
    kind: "observed-metadata",
    url: url.href,
    contents: `<krpano><image tilesize="${tilesize}" baseindex="${integer(image, "baseindex", 1)}">${contents.join("")}</image></krpano>`,
  };
}
