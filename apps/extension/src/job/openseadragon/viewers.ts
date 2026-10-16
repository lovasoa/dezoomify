import { projectMetadata, readTileSource } from "./metadata.ts";
import { createElementProbe, type PageAccess, type PageObject } from "./page-object.ts";
import { type ScanState, scanLimits } from "./scan-state.ts";
import type { PageRealm } from "./types.ts";

interface PageViewer {
  object: PageObject;
  canvas: Element;
}

function readViewer(object: PageObject, access: PageAccess): PageViewer | undefined {
  const canvas = access.element(object.reference("canvas"));
  const tracker = object.reference("innerTracker");
  if (!canvas || !tracker || !object.truthy("viewport")) return undefined;
  const container = object.reference("container");
  return tracker.matches("element", canvas) ||
    (container && tracker.matches("element", container.identity))
    ? { object, canvas }
    : undefined;
}

function sources(viewer: PageViewer): PageObject[] {
  const world = viewer.object.reference("world");
  if (!world) {
    const source = viewer.object.reference("source");
    return source ? [source] : [];
  }
  return world.objects("_items", scanLimits.images).flatMap((item) => {
    const source = item.reference("source");
    return source ? [source] : [];
  });
}

export class ViewerCollector {
  private readonly seenViewers = new Set<object>();
  private readonly seenSources = new Set<object>();
  private readonly seenCanvases = new Set<Element>();

  private readonly state: ScanState;
  private readonly access: PageAccess;

  constructor(state: ScanState, access: PageAccess) {
    this.state = state;
    this.access = access;
  }

  async read(object: PageObject, doc: Document, until: number): Promise<boolean> {
    const viewer = readViewer(object, this.access);
    if (!viewer) return false;
    if (this.seenViewers.has(object.identity)) return true;
    this.seenViewers.add(object.identity);
    this.seenCanvases.add(viewer.canvas);
    doc = this.access.document(viewer.canvas, doc);
    this.state.diagnostics.viewers++;
    await this.readSources(sources(viewer), doc, until);
    return true;
  }

  private async readSources(values: PageObject[], doc: Document, until: number): Promise<void> {
    for (const source of values) {
      if (this.state.expired(until)) break;
      if (this.seenSources.has(source.identity)) continue;
      this.seenSources.add(source.identity);
      try {
        const metadata = projectMetadata(readTileSource(source, doc.baseURI), {
          documentUrl: doc.URL.startsWith("http") ? doc.URL : this.state.documentUrl,
          imageIndex: this.state.inputs.length,
        });
        const collected = this.state.collect(metadata);
        if (collected === "duplicate") continue;
        if (collected === "full") break;
      } catch {
        this.state.diagnostics.rejected++;
      }
      await this.state.yieldSlice();
    }
  }

  async readAll(
    values: Iterable<PageObject>,
    doc: Document,
    until: number,
    tolerateErrors = true,
  ): Promise<void> {
    for (const value of values) {
      if (this.state.expired(until)) break;
      try {
        await this.read(value, doc, until);
      } catch (cause) {
        if (!tolerateErrors) throw cause;
        this.state.diagnostics.rejected++;
      }
    }
  }

  async probe(realm: PageRealm, elements: Element[], until: number): Promise<void> {
    const probe = createElementProbe(realm, scanLimits.images);
    if (!probe) return;
    for (const element of elements) {
      if (this.state.expired(until)) break;
      if (!element.classList.contains("openseadragon-canvas") || this.seenCanvases.has(element))
        continue;
      this.state.diagnostics.probes++;
      probe.dispatch(element, (value) => !!readViewer(value, this.access));
      await this.state.yieldSlice();
    }
    await this.readAll(probe.captured, realm.document, until);
  }
}
