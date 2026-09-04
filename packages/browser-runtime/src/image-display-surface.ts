// Ordinary image display surface: <img> without crossorigin, taint tracking.
// Dependency-injected DOM so unit tests run without a browser.
import type { TileSurface } from "./types.ts";

export const DISPLAY_SAVE_GUIDANCE =
  "This preview is display only. To keep a copy, right-click the image where your browser supports it. Programmatic save needs readable tile bytes.";

export interface FakeImageElement {
  tagName: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: (...args: unknown[]) => void): void;
  removeEventListener(type: string, listener: (...args: unknown[]) => void): void;
  remove(): void;
  // Allow property-style access used by tests (e.g. el.src, el.crossOrigin).
  [key: string]: unknown;
}

export interface DisplayDom {
  createElement(tag: string): FakeImageElement;
}

export interface FakeDisplayCanvas {
  drawImage(image: unknown, dx: number, dy: number): void;
}

export interface DisplaySurface extends TileSurface {
  readonly tileCount: number;
  loadTile(url: string): Promise<"displayed" | "failed">;
  drawToCanvas(image: unknown, dx?: number, dy?: number): void;
  cancel(): void;
}

export function createDisplaySurface(
  dom: DisplayDom,
  opts?: { canvas?: FakeDisplayCanvas },
): DisplaySurface {
  let originClean = true;
  let disposed = false;
  const live: Array<{ el: FakeImageElement; onLoad: () => void; onError: () => void }> = [];

  function drawToCanvas(image: unknown, dx?: number, dy?: number): void {
    // Taint FIRST before any other operation.
    originClean = false;
    if (opts?.canvas) {
      opts.canvas.drawImage(image, dx ?? 0, dy ?? 0);
    }
  }

  function loadTile(url: string): Promise<"displayed" | "failed"> {
    if (disposed) return Promise.resolve("failed");
    const el = dom.createElement("img");
    // Deliberately never set crossorigin / crossOrigin.
    return new Promise((resolve) => {
      const onLoad = (): void => {
        cleanup();
        resolve("displayed");
      };
      const onError = (): void => {
        cleanup();
        // Remove failed node immediately.
        try {
          el.remove();
        } catch {
          // ignore
        }
        resolve("failed");
      };
      const cleanup = (): void => {
        try {
          el.removeEventListener("load", onLoad as (...a: unknown[]) => void);
        } catch {
          // ignore
        }
        try {
          el.removeEventListener("error", onError as (...a: unknown[]) => void);
        } catch {
          // ignore
        }
        const idx = live.findIndex((e) => e.el === el);
        if (idx >= 0) live.splice(idx, 1);
      };
      live.push({ el, onLoad, onError });
      el.addEventListener("load", onLoad as (...a: unknown[]) => void);
      el.addEventListener("error", onError as (...a: unknown[]) => void);
      el.setAttribute("src", url);
    });
  }

  function cancel(): void {
    // Remove nodes and listeners; idempotent.
    for (const entry of [...live]) {
      try {
        entry.el.removeEventListener("load", entry.onLoad as (...a: unknown[]) => void);
      } catch {
        // ignore
      }
      try {
        entry.el.removeEventListener("error", entry.onError as (...a: unknown[]) => void);
      } catch {
        // ignore
      }
      try {
        entry.el.remove();
      } catch {
        // ignore
      }
    }
    live.length = 0;
    disposed = true;
  }

  const surface: DisplaySurface = {
    get originClean(): boolean {
      return originClean;
    },
    saveGuidance: DISPLAY_SAVE_GUIDANCE,
    get tileCount(): number {
      return live.length;
    },
    loadTile,
    drawToCanvas,
    cancel,
    dispose(): void {
      cancel();
    },
  };
  return surface;
}
