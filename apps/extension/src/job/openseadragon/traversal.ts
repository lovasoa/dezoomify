import { PageAccess, PageObject } from "./page-object.ts";
import { type ScanState, scanLimits } from "./scan-state.ts";
import type { PageRealm } from "./types.ts";
import { ViewerCollector } from "./viewers.ts";

function recordDocument(
  state: ScanState,
  doc: Document,
  openSeadragon: PageObject | undefined,
): void {
  state.diagnostics.documents++;
  if (doc.URL.length <= 2048) state.diagnostics.frames.push(doc.URL);
  const version = openSeadragon?.reference("version")?.boundedString("versionStr", 64);
  if (version !== undefined && !state.diagnostics.versions.includes(version))
    state.diagnostics.versions += `${state.diagnostics.versions ? "," : ""}${version}`;
}

export class PageTraversal {
  private readonly access = new PageAccess();
  private readonly viewers: ViewerCollector;
  private readonly seenFrames = new Set<Window>();

  private readonly state: ScanState;

  constructor(state: ScanState) {
    this.state = state;
    this.viewers = new ViewerCollector(state, this.access);
  }

  async scan(win: Window): Promise<void> {
    if (this.seenFrames.has(win) || this.state.expired(this.state.end)) return;
    if (this.frameLimit()) return;
    const realm = this.access.realm(win);
    const doc = realm.document;
    this.seenFrames.add(win);
    const root = PageObject.from(win);
    const openSeadragon = root?.reference("OpenSeadragon");
    recordDocument(this.state, doc, openSeadragon);
    const until = Math.min(this.state.end, Date.now() + scanLimits.documentMs);
    const queue = [root, openSeadragon].filter((value): value is PageObject => !!value);
    const registry = openSeadragon?.registry(realm);
    if (registry) await this.viewers.readAll(registry, doc, until);
    const elements = await this.collectElements(doc, queue, until);
    // Probe known canvases before broad reference traversal can exhaust the budget.
    await this.viewers.probe(realm, elements, until);
    await this.scanReferences(realm, queue, until);
    await this.scanFrames(win);
  }

  private frameLimit(): boolean {
    if (this.state.diagnostics.documents < scanLimits.documents) return false;
    this.state.truncate("frame-limit");
    return true;
  }

  private async collectElements(
    doc: Document,
    queue: PageObject[],
    until: number,
  ): Promise<Element[]> {
    const elements: Element[] = [];
    const walker = doc.createTreeWalker(doc, 1);
    while (!this.state.expired(until) && this.state.diagnostics.nodes < scanLimits.nodes) {
      const node = walker.nextNode();
      if (!node) break;
      const reference = PageObject.from(node);
      const element = this.access.element(reference);
      if (!reference || !element) continue;
      this.state.diagnostics.nodes++;
      elements.push(element);
      queue.push(reference);
      await this.state.yieldSlice();
    }
    if (this.state.diagnostics.nodes >= scanLimits.nodes) this.state.truncate("node-limit");
    return elements;
  }

  private async enqueueProperties(
    value: PageObject,
    queue: PageObject[],
    until: number,
  ): Promise<void> {
    if (value.nativeFunction()) return;
    for (const key of value.keys()) {
      if (this.state.expired(until) || queue.length >= scanLimits.references) break;
      const reference = value.reference(key);
      if (reference) queue.push(reference);
      await this.state.yieldSlice();
    }
  }

  private async readReference(
    value: PageObject,
    realm: PageRealm,
    queue: PageObject[],
    until: number,
  ): Promise<boolean> {
    if (await this.viewers.read(value, realm.document, until)) return true;
    const registry = value.registry(realm);
    if (registry) {
      await this.viewers.readAll(registry, realm.document, until, false);
      return true;
    }
    await this.enqueueProperties(value, queue, until);
    return false;
  }

  private async scanReferences(
    realm: PageRealm,
    queue: PageObject[],
    until: number,
  ): Promise<void> {
    const seen = new Set<object>();
    for (
      let head = 0;
      head < queue.length &&
      !this.state.expired(until) &&
      this.state.diagnostics.references < scanLimits.references;
      head++
    ) {
      const value = queue[head];
      if (seen.has(value.identity)) continue;
      seen.add(value.identity);
      this.state.diagnostics.references++;
      try {
        if (await this.readReference(value, realm, queue, until)) continue;
      } catch {
        this.state.diagnostics.rejected++;
      }
      await this.state.yieldSlice();
    }
    if (
      this.state.diagnostics.references >= scanLimits.references ||
      queue.length >= scanLimits.references
    )
      this.state.truncate("reference-limit");
  }

  private async scanFrames(win: Window): Promise<void> {
    for (let index = 0; index < win.length && !this.state.expired(this.state.end); index++) {
      if (this.frameLimit()) break;
      try {
        await this.scan(win[index]);
      } catch {}
      await this.state.yieldSlice();
    }
  }
}
