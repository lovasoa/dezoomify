import { ViewerCollector } from "./collector.ts";
import { PageAccess, PageObject } from "./page-object.ts";
import { type ScanState, scanLimits } from "./scan-state.ts";
import type { PageRealm } from "./types.ts";

function recordDocument(state: ScanState, doc: Document): void {
  state.diagnostics.documents++;
  if (doc.URL.length <= 2048) state.diagnostics.frames.push(doc.URL);
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
    if (this.seenFrames.has(win) || this.state.full()) return;
    if (this.frameLimit()) return;
    const realm = this.access.realm(win);
    const doc = realm.document;
    this.seenFrames.add(win);
    const root = PageObject.from(win);
    recordDocument(this.state, doc);
    const roots = root ? this.viewers.roots(root) : [];
    const queue = [...roots, ...(root ? [root] : [])];
    for (const value of roots) await this.viewers.registry(value, realm);
    const elements = await this.collectElements(doc, queue);
    // Image containers and their element-data stores precede the broad window
    // graph. Bundled viewers can hide their namespace while retaining a DOM link.
    for (const element of elements) {
      if (this.state.full()) break;
      const anchors = this.viewers.anchors(element);
      if (anchors.length) await this.scanReferences(realm, anchors);
      await this.state.yieldSlice();
    }
    // Broad traversal must not exhaust the budget before targeted probes or inline frames.
    await this.viewers.probe(realm, elements);
    await this.scanInlineFrames(win);
    await this.scanReferences(realm, queue);
  }

  private frameLimit(): boolean {
    if (this.state.diagnostics.documents < scanLimits.documents) return false;
    this.state.truncate("frame-limit");
    return true;
  }

  private async collectElements(doc: Document, queue: PageObject[]): Promise<Element[]> {
    const elements: Element[] = [];
    const walker = doc.createTreeWalker(doc, 1);
    while (!this.state.full() && this.state.diagnostics.nodes < scanLimits.nodes) {
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

  private async enqueueProperties(value: PageObject, queue: PageObject[]): Promise<void> {
    if (value.nativeFunction()) return;
    for (const key of value.keys()) {
      if (!this.state.takeReference() || queue.length >= scanLimits.references) break;
      const reference = value.reference(key);
      if (reference) queue.push(reference);
      await this.state.yieldSlice();
    }
  }

  private async readReference(
    value: PageObject,
    realm: PageRealm,
    queue: PageObject[],
  ): Promise<void> {
    if (await this.viewers.read(value, realm.document)) return;
    if (await this.viewers.registry(value, realm)) return;
    await this.enqueueProperties(value, queue);
  }

  private async scanReferences(realm: PageRealm, queue: PageObject[]): Promise<void> {
    const seen = new Set<object>();
    for (let head = 0; head < queue.length && this.state.takeReference(); head++) {
      await this.state.yieldSlice();
      const value = queue[head];
      if (seen.has(value.identity)) continue;
      seen.add(value.identity);
      try {
        await this.readReference(value, realm, queue);
      } catch {
        this.state.diagnostics.rejected++;
      }
    }
    if (queue.length >= scanLimits.references) this.state.truncate("reference-limit");
  }

  private async scanInlineFrames(win: Window): Promise<void> {
    for (let index = 0; index < win.length && this.state.takeReference(); index++) {
      if (this.frameLimit()) break;
      try {
        const child = win[index];
        // HTTP documents belong to the job's permission-filtered inventory.
        // Readable inline/blob documents have no HTTP inventory target.
        const protocol = child.location.protocol;
        if (protocol !== "http:" && protocol !== "https:") await this.scan(child);
      } catch {}
      await this.state.yieldSlice();
    }
  }
}
