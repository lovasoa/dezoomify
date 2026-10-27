import { openLayersAdapter } from "../openlayers/adapter.ts";
import { openSeadragonAdapter } from "../openseadragon/adapter.ts";
import type { ViewerImage } from "./adapter.ts";
import { type PageAccess, PageObject } from "./page-object.ts";
import type { ScanState } from "./scan-state.ts";
import { releaseViewerTiles } from "./session.ts";
import type { PageRealm } from "./types.ts";

const adapters = [openSeadragonAdapter, openLayersAdapter];

/** One collector deduplicates image sources across adapters and discovery paths. */
export class ViewerCollector {
  private readonly seenViewers = new Set<object>();
  private readonly seenSources = new Set<object>();
  private readonly seenElements = new Set<Element>();
  constructor(
    private readonly state: ScanState,
    private readonly access: PageAccess,
  ) {}

  roots(root: PageObject): PageObject[] {
    for (const adapter of adapters) {
      const version = adapter.version?.(root);
      if (version && !this.state.diagnostics.versions.includes(version))
        this.state.diagnostics.versions += `${this.state.diagnostics.versions ? "," : ""}${version}`;
    }
    return adapters.flatMap((adapter) => adapter.roots?.(root) ?? []);
  }

  anchors(element: Element): PageObject[] {
    return adapters.flatMap((adapter) =>
      (adapter.anchors?.(element) ?? []).flatMap((value) => {
        const object = PageObject.from(value);
        return object ? [object] : [];
      }),
    );
  }

  async read(object: PageObject, doc: Document): Promise<boolean> {
    for (const adapter of adapters) {
      const element = adapter.identify(object, this.access);
      if (!element) continue;
      if (this.seenViewers.has(object.identity)) return true;
      this.seenViewers.add(object.identity);
      this.seenElements.add(element);
      doc = this.access.document(element, doc);
      this.state.diagnostics.viewers++;
      await this.readImages(adapter.images(object), doc);
      return true;
    }
    return false;
  }

  private async readImages(images: ViewerImage[], doc: Document): Promise<void> {
    for (const image of images) {
      if (this.state.full()) break;
      if (this.seenSources.has(image.identity)) continue;
      this.seenSources.add(image.identity);
      try {
        const evidence = image.read(
          {
            documentUrl: doc.URL.startsWith("http") ? doc.URL : this.state.documentUrl,
            imageIndex: this.state.inputs.length,
          },
          doc.baseURI,
        );
        if (this.state.collect(evidence) === "full") {
          if (evidence.handle) releaseViewerTiles([evidence.handle]);
          break;
        }
      } catch {
        this.state.diagnostics.rejected++;
      }
      await this.state.yieldSlice();
    }
  }

  private async readAll(values: Iterable<PageObject | undefined>, doc: Document): Promise<void> {
    for (const value of values) {
      if (!this.state.takeReference()) break;
      try {
        if (value) await this.read(value, doc);
      } catch {
        this.state.diagnostics.rejected++;
      }
      await this.state.yieldSlice();
    }
  }

  async registry(object: PageObject, realm: PageRealm): Promise<boolean> {
    for (const adapter of adapters) {
      const values = adapter.registry?.(object, realm);
      if (!values) continue;
      await this.readAll(values, realm.document);
      return true;
    }
    return false;
  }

  async probe(realm: PageRealm, elements: Element[]): Promise<void> {
    for (const adapter of adapters) {
      const values = await adapter.probe?.(realm, elements, this.seenElements, this.state);
      if (values) await this.readAll(values, realm.document);
    }
  }
}
