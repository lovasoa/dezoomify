import type { ViewerAdapter } from "../viewers/adapter.ts";
import { PageObject } from "../viewers/page-object.ts";
import { projectImage } from "./metadata.ts";

function isViewer(object: PageObject): boolean {
  return ["get", "set", "call", "screentosphere", "spheretoscreen", "unload"].every((key) =>
    object.method(key),
  );
}

/** krpano exposes its public API on the embedded DOM element, even when the
 * embedding script keeps the full interface in a closure. Read only the loaded
 * image; loading scenes or replaying actions would change the source page. */
export const krpanoAdapter: ViewerAdapter = {
  anchors(element) {
    const object = PageObject.from(element);
    return object && isViewer(object) ? [element] : [];
  },
  identify(object, access) {
    const element = access.element(object);
    return element && isViewer(object) ? element : undefined;
  },
  images(viewer) {
    const runtime = PageObject.from(viewer.call("get", "global"));
    const image = runtime?.reference("image");
    return runtime && image
      ? [
          {
            identity: image.identity,
            read: (context, base) => ({ input: projectImage(runtime, image, context, base) }),
          },
        ]
      : [];
  },
};
