import type { GoogleArtsMetadata, JobInput } from "@dezoomify/wasm-bindings";
import type { ViewerAdapter } from "../viewers/adapter.ts";
import { address } from "../viewers/metadata.ts";
import { PageAccess, PageObject } from "../viewers/page-object.ts";

/** Inspect own data slots only. Google renames internal fields between builds;
 * the asset record tag and native XML root identify the data, not those names. */
function findData(
  root: PageObject,
  accept: (value: PageObject) => boolean,
): PageObject | undefined {
  const queue = [{ value: root, depth: 0 }];
  const seen = new Set<object>();
  let slots = 0;
  for (let head = 0; head < queue.length; head++) {
    const { value, depth } = queue[head];
    if (seen.has(value.identity)) continue;
    seen.add(value.identity);
    if (accept(value)) return value;
    if (depth === 4) continue;
    for (const key of value.keys()) {
      if (++slots > 2048) return undefined;
      const child = value.reference(key);
      if (child) queue.push({ value: child, depth: depth + 1 });
    }
  }
  return undefined;
}

function microscope(controller: PageObject): PageObject | undefined {
  for (const key of controller.keys()) {
    const value = controller.reference(key);
    if (value?.method("GetImageMetadata") && value.method("GetState")) return value;
  }
  return undefined;
}

function snapshot(controller: PageObject, documentUrl: string): JobInput {
  const asset = controller.reference("asset");
  const viewer = microscope(controller);
  if (!asset || !viewer) throw new Error("Google Arts viewer is unavailable");
  const data = findData(asset, (value) => value.matches("0", "stella.av"));
  const access = new PageAccess();
  const xml = findData(
    viewer,
    (value) => access.documentNode(value)?.documentElement?.localName === "TileInfo",
  );
  const doc = xml && access.documentNode(xml);
  if (!data) throw new Error("Google Arts asset record is unavailable");
  if (!doc) throw new Error("Google Arts TileInfo is unavailable");
  const url = new URL(documentUrl);
  const id = data.string("1");
  if (
    !id ||
    url.hostname !== "artsandculture.google.com" ||
    !url.pathname.startsWith("/asset/") ||
    url.pathname.split("/").at(-1) !== id ||
    asset.call("getId") !== id
  )
    throw new Error("Google Arts asset does not match the document");
  validateDimensions(viewer, doc);
  const metadata: GoogleArtsMetadata = {
    format: "google_arts_and_culture",
    asset_id: id,
    title: data.string("2"),
    base_url: address(data.string("8"), documentUrl),
    token: data.matches("9", null) ? "" : data.string("9"),
    tile_info: new XMLSerializer().serializeToString(doc),
  };
  // This describes the current source document, replacing its stale SPA HTML.
  return { kind: "observed-metadata", url: url.href, contents: JSON.stringify(metadata) };
}

function validateDimensions(viewer: PageObject, doc: Document): void {
  const size = PageObject.from(viewer.call("GetImageMetadata"))?.reference("size");
  const root = doc.documentElement;
  const level = root.lastElementChild;
  if (!level || !size) throw new Error("Google Arts pyramid is unavailable");
  const width =
    Number(root.getAttribute("tile_width")) * Number(level.getAttribute("num_tiles_x")) -
    Number(level.getAttribute("empty_pels_x"));
  const height =
    Number(root.getAttribute("tile_height")) * Number(level.getAttribute("num_tiles_y")) -
    Number(level.getAttribute("empty_pels_y"));
  if (
    width <= 0 ||
    height <= 0 ||
    width !== size.number("width") ||
    height !== size.number("height")
  )
    throw new Error("Google Arts pyramid does not match the viewer");
}

/** Read only a loaded, DOM-owned Microscope viewer. The detached snapshot leaves
 * tile signing and decryption to Rust and owns no live loader/session handles. */
export const googleArtsAdapter: ViewerAdapter = {
  async probe(realm, elements, _seen, state) {
    if (realm.location.hostname !== "artsandculture.google.com") return [];
    const controllers: PageObject[] = [];
    for (const element of elements) {
      if (!state.takeReference()) break;
      const controller = PageObject.from(element)
        ?.reference("__jscontroller")
        ?.reference("pending")
        ?.reference("value");
      if (controller?.reference("asset")) controllers.push(controller);
      await state.yieldSlice();
    }
    return controllers;
  },
  identify(object, access) {
    const asset = object.reference("asset");
    if (!asset?.method("getId") || !microscope(object)) return undefined;
    for (const key of object.keys()) {
      const reference = object.reference(key);
      const element = access.element(reference);
      const owner = reference
        ?.reference("__jscontroller")
        ?.reference("pending")
        ?.reference("value");
      if (element && owner?.identity === object.identity) return element;
    }
    return undefined;
  },
  images(controller) {
    return [
      {
        identity: controller.identity,
        read: (context) => ({ input: snapshot(controller, context.documentUrl) }),
      },
    ];
  },
};
