import type { Catalog, Tile } from "@dezoomify/wasm-bindings";

export interface ImageChoice {
  catalog: Catalog;
  previews: Map<number, string>;
  choose(index: number): void;
}

export interface ImagePreviewResource {
  url: string;
  dispose(): void;
}

/** One picker owns its answer, sequential previews, and display resources. */
export async function chooseCatalogImage(
  catalog: Catalog,
  deps: {
    signal: AbortSignal;
    changed(choice: ImageChoice | undefined): void;
    preview(tile: Tile, signal: AbortSignal): Promise<ImagePreviewResource | undefined>;
    failed(tile: Tile, error: unknown): void;
  },
): Promise<number> {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([deps.signal, lifetime.signal]);
  signal.throwIfAborted();
  const resources: ImagePreviewResource[] = [];
  let resolve!: (index: number) => void;
  let reject!: (error: unknown) => void;
  const answer = new Promise<number>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const cancel = () => reject({ kind: "cancelled" });
  signal.addEventListener("abort", cancel, { once: true });
  const choice: ImageChoice = {
    catalog,
    previews: new Map(),
    choose(index) {
      if (
        !signal.aborted &&
        Number.isInteger(index) &&
        index >= 0 &&
        index < catalog.entries.length
      )
        resolve(index);
    },
  };
  deps.changed(choice);
  const previews = loadPreviews();
  try {
    return await answer;
  } finally {
    signal.removeEventListener("abort", cancel);
    lifetime.abort();
    deps.changed(undefined);
    await previews;
    for (const resource of resources) resource.dispose();
  }

  async function loadPreviews(): Promise<void> {
    for (const [index, entry] of catalog.entries.entries()) {
      if (signal.aborted) return;
      if (!entry.preview) continue;
      await loadPreview(index, entry.preview);
    }
  }

  async function loadPreview(index: number, tile: Tile): Promise<void> {
    try {
      const resource = await deps.preview(tile, signal);
      if (!resource) return;
      resources.push(resource);
      if (signal.aborted) return;
      choice.previews.set(index, resource.url);
      deps.changed(choice);
    } catch (error) {
      if (!signal.aborted) deps.failed(tile, error);
    }
  }
}
