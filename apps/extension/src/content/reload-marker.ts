/**
 * Content-script reload marker (Phase 12).
 *
 * Records the scan generation that caused a reload so the extension page can
 * correlate candidates without rearming. Non-secret, bounded, memory-first
 * with an injected storage fallback for tests.
 *
 * Plain JavaScript + JSDoc.
 */

export const RELOAD_MARKER_KEY = "dezoomify-reload-generation";
export const MAX_GENERATION_LENGTH = 64;

/**
 * @param {{ getItem: (k: string) => string | null, setItem: (k: string, v: string) => void, removeItem: (k: string) => void }} [storage]
 */
export function createReloadMarker(storage) {
  /** @type {string|null} */
  let memory = null;
  const store = storage ?? {
    getItem: () => memory,
    setItem: (_k, v) => {
      memory = v;
    },
    removeItem: () => {
      memory = null;
    },
  };

  function markReload(generation) {
    const g = String(generation ?? "");
    if (!g || g.length > MAX_GENERATION_LENGTH) throw new Error("bad generation");
    if (!/^[a-zA-Z0-9-]+$/.test(g)) throw new Error("bad generation");
    store.setItem(RELOAD_MARKER_KEY, g);
    memory = g;
    return true;
  }

  function readReloadMark() {
    try {
      return store.getItem(RELOAD_MARKER_KEY);
    } catch {
      return memory;
    }
  }

  function clearReloadMark() {
    try {
      store.removeItem(RELOAD_MARKER_KEY);
    } catch {
      // ignore
    }
    memory = null;
  }

  return { markReload, readReloadMark, clearReloadMark };
}
