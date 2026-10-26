import type { PageAccess, PageObject } from "./page-object.ts";
import type { ScanState } from "./scan-state.ts";
import type { MetadataContext, PageRealm, ViewerEvidence } from "./types.ts";

export interface ViewerImage {
  identity: object;
  read(context: MetadataContext, base: string): ViewerEvidence;
}

/** Library knowledge stays in adapters; traversal and source ownership are shared.
 * Identify without invoking arbitrary getters. Read source APIs only after a
 * viewer has been tied to a real DOM element in the inspected document. */
export interface ViewerAdapter {
  identify(object: PageObject, access: PageAccess): Element | undefined;
  images(object: PageObject): ViewerImage[];
  anchors?(element: Element): (Element | null)[];
  roots?(root: PageObject): PageObject[];
  version?(root: PageObject): string | undefined;
  registry?(object: PageObject, realm: PageRealm): Iterable<PageObject | undefined> | undefined;
  probe?(
    realm: PageRealm,
    elements: Element[],
    seen: Set<Element>,
    state: ScanState,
  ): Promise<PageObject[]>;
}
