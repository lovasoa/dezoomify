import type { JobInput } from "@dezoomify/wasm-bindings";

/** Serialized by scripting.executeScript: all runtime helpers must stay local.
 * Page objects are untrusted. Budgets are cooperative, not preemption of page code.
 */
export async function scanOpenSeadragon(deadlineAt: number) {
  const limits = {
    documents: 16,
    nodes: 5000,
    references: 12000,
    images: 100,
    bytes: 1024 * 1024,
    sliceMs: 8,
    documentMs: 250,
  };
  const documentUrl = location.href;
  const inputs: JobInput[] = [];
  const diagnostics = {
    documents: 0,
    nodes: 0,
    references: 0,
    viewers: 0,
    probes: 0,
    rejected: 0,
    bytes: 0,
    truncated: false,
    elapsedMs: 0,
    versions: "",
    stopped: "",
    frames: [] as string[],
  };
  const started = Date.now();
  const end = Math.min(deadlineAt, started + 1000);
  const get = Object.getOwnPropertyDescriptor;
  const apply = Reflect.apply;
  const nodeType = get(Node.prototype, "nodeType")?.get;
  const ownerDocument = get(Node.prototype, "ownerDocument")?.get;
  const seenFrames = new Set<Window>();
  const seenSources = new Set<unknown>();
  const seenImages = new Set<string>();
  const seenViewers = new Set<unknown>();
  const seenCanvases = new Set<unknown>();
  let slice = Date.now();
  const truncated = (reason: string) => {
    diagnostics.truncated = true;
    if (!diagnostics.stopped.includes(reason))
      diagnostics.stopped += `${diagnostics.stopped ? "," : ""}${reason}`;
  };
  const data = (object: unknown, key: PropertyKey): unknown => {
    if (!object || (typeof object !== "object" && typeof object !== "function")) return undefined;
    try {
      return get(object, key)?.value;
    } catch {
      return undefined;
    }
  };
  const number = (o: unknown, key: PropertyKey, fallback = 0): number => {
    const value = data(o, key);
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff
      ? value
      : fallback;
  };
  const string = (o: unknown, key: PropertyKey, fallback = ""): string => {
    const value = data(o, key);
    if (value === undefined) return fallback;
    if (typeof value !== "string" || value.length > 2048) throw new Error("unsupported string");
    return value;
  };
  const array = (o: unknown, key: PropertyKey, max: number): unknown[] => {
    const value = data(o, key);
    if (value === undefined) return [];
    if (!Array.isArray(value) || number(value, "length") > max)
      throw new Error("unsupported array");
    return Array.from({ length: number(value, "length") }, (_, i) => data(value, i));
  };
  const expired = (until: number) => {
    const stop = Date.now() >= until || inputs.length >= limits.images;
    if (stop) truncated(Date.now() >= until ? "time-budget" : "image-limit");
    return stop;
  };
  const yieldSlice = async () => {
    if (Date.now() - slice >= limits.sliceMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      slice = Date.now();
    }
  };
  function project(source: unknown, doc: Document) {
    const dimensions = data(source, "dimensions");
    const width = number(dimensions, "x", number(source, "width"));
    const height = number(dimensions, "y", number(source, "height"));
    const tileWidth = number(source, "_tileWidth", number(source, "tileSize"));
    const tileHeight = number(source, "_tileHeight", number(source, "tileSize"));
    if (
      !width ||
      !height ||
      data(source, "ready") === false ||
      data(source, "getTileUrl") !== undefined
    )
      throw new Error("unsupported source");
    const address = (value: string) => {
      const url = new URL(value, doc.baseURI);
      if (url.href.length > 2048 || !["http:", "https:"].includes(url.protocol))
        throw new Error("unsupported address");
      return url.href;
    };
    const format = string(
      source,
      "fileFormat",
      string(source, "tileFormat", string(source, "format", "jpg")),
    );
    if (!/^[a-z0-9]{1,64}$/i.test(format)) throw new Error("unsupported format");
    let url: string, contents: string;
    if (data(source, "tilesUrl") && data(source, "fileFormat")) {
      const base = address(string(source, "tilesUrl"));
      if (!tileWidth || tileWidth !== tileHeight) throw new Error("unsupported tiles");
      if (Array.isArray(data(source, "imageSizes"))) {
        if (!["jpg", "jpeg"].includes(format)) throw new Error("unsupported Zoomify format");
        const count = array(source, "gridSize", 33).reduce<number>(
          (total, grid) => total + number(grid, "x") * number(grid, "y"),
          0,
        );
        url = `${base.replace(/\/$/, "")}/ImageProperties.xml`;
        contents = `<IMAGE_PROPERTIES WIDTH="${width}" HEIGHT="${height}" TILESIZE="${tileWidth}" NUMTILES="${count}"/>`;
      } else {
        const query = data(source, "queryParams");
        if (
          array(source, "displayRects", 256).length ||
          (typeof query === "string" ? query : array(source, "queryParams", 1)[0]) ||
          number(source, "minLevel") !== 0 ||
          number(source, "maxLevel") !== Math.ceil(Math.log2(Math.max(width, height)))
        )
          throw new Error("unsupported DZI pyramid");
        // Unique in-memory identity keeps the original document's HTML intact.
        const identity = new URL(doc.URL.startsWith("http") ? doc.URL : documentUrl);
        identity.hash = `dezoomify-osd-${inputs.length}`;
        url = identity.href;
        contents = JSON.stringify({
          Image: {
            xmlns: "http://schemas.microsoft.com/deepzoom/2008",
            Url: base,
            Format: format,
            Overlap: number(source, "tileOverlap"),
            TileSize: tileWidth,
            Size: { Width: width, Height: height },
          },
        });
      }
    } else if (data(source, "_id") && data(source, "tileFormat")) {
      const version = number(source, "version", 2);
      if (![2, 3].includes(version) || data(source, "isLevel0") === true)
        throw new Error("unsupported IIIF service");
      const id = address(string(source, "_id"));
      const tiles = array(source, "tiles", 64).map((tile) => ({
        width: number(tile, "width"),
        height: number(tile, "height", number(tile, "width")),
        scaleFactors: array(tile, "scaleFactors", 64).map((factor) => {
          if (
            typeof factor !== "number" ||
            !Number.isInteger(factor) ||
            factor < 1 ||
            factor > 0xffffffff
          )
            throw new Error("unsupported scale factor");
          return factor;
        }),
      }));
      if (!tiles.length) throw new Error("untiled IIIF");
      url = `${id.replace(/\/$/, "")}/info.json`;
      contents = JSON.stringify({
        "@context": `http://iiif.io/api/image/${version}/context.json`,
        id,
        width,
        height,
        tiles,
        formats: [format],
        // OSD v2 uses width-only tile sizes; v3 uses width,height.
        ...(version === 2 ? { profile: [{ supports: ["sizeByW"] }] } : {}),
      });
    } else if (data(source, "iipsrv") && data(source, "image")) {
      if (
        !["jpg", "jpeg"].includes(format) ||
        !tileWidth ||
        !tileHeight ||
        number(source, "maxLevel") > 31
      )
        throw new Error("unsupported IIP pyramid");
      url = `${address(string(source, "iipsrv"))}?FIF=${string(source, "image")}`;
      const transform = data(source, "transform");
      for (const key of transform ? Reflect.ownKeys(transform as object) : []) {
        const value = data(transform, key);
        if (!value) continue;
        if (
          !["contrast", "twist"].includes(String(key)) ||
          !["string", "number"].includes(typeof value) ||
          String(value).length > 256
        )
          throw new Error("unsupported IIP transform");
        url += `&${key === "contrast" ? "CNT" : "CTW"}=${value}`;
      }
      url += "&OBJ=Max-size&OBJ=Tile-size&OBJ=Resolution-number";
      contents = `Max-size:${width} ${height}\nTile-size:${tileWidth} ${tileHeight}\nResolution-number:${number(source, "maxLevel") + 1}`;
    } else throw new Error("unsupported protocol");
    return { url, contents, kind: "observed-metadata" as const };
  }
  function viewer(value: unknown): boolean {
    const canvas = data(value, "canvas"),
      tracker = data(value, "innerTracker");
    try {
      return (
        !!nodeType &&
        apply(nodeType, canvas, []) === 1 &&
        !!data(tracker, "element") &&
        !!data(value, "viewport") &&
        !!canvas &&
        (data(tracker, "element") === canvas ||
          data(tracker, "element") === data(value, "container"))
      );
    } catch {
      return false;
    }
  }
  async function readViewer(value: unknown, doc: Document, until: number) {
    if (!viewer(value)) return false;
    if (seenViewers.has(value)) return true;
    seenViewers.add(value);
    seenCanvases.add(data(value, "canvas"));
    if (ownerDocument) doc = apply(ownerDocument, data(value, "canvas"), []) as Document;
    diagnostics.viewers++;
    const world = data(value, "world");
    const sources = world
      ? array(world, "_items", limits.images).map((item) => data(item, "source"))
      : [data(value, "source")];
    for (const source of sources) {
      if (expired(until)) break;
      if (!source || seenSources.has(source)) continue;
      seenSources.add(source);
      try {
        const input = project(source, doc);
        const serialized = input.contents; // Only newly allocated metadata.
        if (seenImages.has(serialized)) continue;
        const bytes = new TextEncoder().encode(serialized).byteLength;
        if (diagnostics.bytes + bytes > limits.bytes) {
          truncated("payload-limit");
          break;
        }
        seenImages.add(serialized);
        diagnostics.bytes += bytes;
        inputs.push(input);
      } catch {
        diagnostics.rejected++;
      }
      await yieldSlice();
    }
    return true;
  }
  async function scan(win: Window) {
    if (seenFrames.has(win) || expired(end)) return;
    if (diagnostics.documents >= limits.documents) {
      truncated("frame-limit");
      return;
    }
    const doc = win.document;
    seenFrames.add(win);
    diagnostics.documents++;
    if (doc.URL.length <= 2048) diagnostics.frames.push(doc.URL);
    const version = data(data(data(win, "OpenSeadragon"), "version"), "versionStr");
    if (
      typeof version === "string" &&
      version.length <= 64 &&
      !diagnostics.versions.includes(version)
    )
      diagnostics.versions += `${diagnostics.versions ? "," : ""}${version}`;
    const until = Math.min(end, Date.now() + limits.documentMs);
    const elements: Element[] = [];
    const queue: unknown[] = [win, data(win, "OpenSeadragon")];
    const seen = new Set<unknown>();
    const realm = win as Window & typeof globalThis;
    const registry = data(data(win, "OpenSeadragon"), "_viewers");
    if (registry instanceof realm.Map) {
      for (const value of apply(
        realm.Map.prototype.values,
        registry,
        [],
      ) as IterableIterator<unknown>) {
        if (expired(until)) break;
        try {
          await readViewer(value, doc, until);
        } catch {
          diagnostics.rejected++;
        }
      }
    }
    {
      const walker = doc.createTreeWalker(doc, 1);
      while (!expired(until) && diagnostics.nodes < limits.nodes) {
        const node = walker.nextNode();
        if (!node) break;
        const el = node as Element;
        diagnostics.nodes++;
        elements.push(el);
        queue.push(el);
        await yieldSlice();
      }
    }
    const enqueue = (value: unknown) => {
      if (
        queue.length < limits.references &&
        value &&
        (typeof value === "object" || typeof value === "function")
      )
        queue.push(value);
    };
    if (diagnostics.nodes >= limits.nodes) truncated("node-limit");
    for (
      let head = 0;
      head < queue.length && !expired(until) && diagnostics.references < limits.references;
      head++
    ) {
      const value = queue[head];
      if (!value || seen.has(value)) continue;
      seen.add(value);
      diagnostics.references++;
      try {
        if (await readViewer(value, doc, until)) continue;
        const registry = data(value, "_viewers");
        if (registry instanceof realm.Map) {
          const iterator = apply(
            realm.Map.prototype.values,
            registry,
            [],
          ) as IterableIterator<unknown>;
          for (const v of iterator) {
            if (expired(until)) break;
            await readViewer(v, doc, until);
          }
          continue;
        }
        if (
          typeof value !== "function" ||
          !apply(Function.prototype.toString, value, []).includes("[native code]")
        ) {
          // Enumeration can still invoke a Proxy trap; JavaScript cannot preempt it.
          for (const key of Reflect.ownKeys(value as object)) {
            if (expired(until) || queue.length >= limits.references) break;
            enqueue(data(value, key));
            await yieldSlice();
          }
        }
      } catch {
        diagnostics.rejected++;
      }
      await yieldSlice();
    }
    if (diagnostics.references >= limits.references || queue.length >= limits.references)
      truncated("reference-limit");
    await probe(win, elements, until);
    for (let i = 0; i < win.length && !expired(end); i++) {
      if (diagnostics.documents >= limits.documents) {
        truncated("frame-limit");
        break;
      }
      try {
        await scan(win[i]);
      } catch {}
      await yieldSlice();
    }
  }
  async function probe(win: Window, elements: Element[], until: number) {
    const realm = win as Window & typeof globalThis;
    const proto = realm.Function.prototype,
      saved = get(proto, "apply");
    if (
      !saved?.writable ||
      typeof saved.value !== "function" ||
      !apply(Function.prototype.toString, saved.value, []).includes("[native code]")
    )
      return;
    const captured: unknown[] = [];
    for (const el of elements) {
      if (expired(until)) break;
      if (!el.classList.contains("openseadragon-canvas") || seenCanvases.has(el)) continue;
      const event = new realm.KeyboardEvent("keydown", { key: "Unidentified", bubbles: false });
      try {
        Object.defineProperty(proto, "apply", {
          ...saved,
          value: function (this: unknown, receiver: unknown, args: unknown) {
            if (event && data(data(args, 0), "originalEvent") === event && viewer(receiver)) {
              if (captured.length < limits.images) captured.push(receiver);
              return true;
            }
            return apply(saved.value, this, [receiver, args]);
          },
        });
        diagnostics.probes++;
        el.dispatchEvent(event);
      } finally {
        Object.defineProperty(proto, "apply", saved);
      }
      await yieldSlice();
    }
    for (const value of captured) {
      if (expired(until)) break;
      try {
        await readViewer(value, win.document, until);
      } catch {
        diagnostics.rejected++;
      }
    }
  }
  try {
    await scan(window);
  } catch {
    diagnostics.rejected++;
  }
  diagnostics.elapsedMs = Date.now() - started;
  return { ok: true as const, documentUrl, inputs, diagnostics };
}
