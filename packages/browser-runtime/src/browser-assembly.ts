import { type CanvasAssemblyDeps, createCanvasAssembly } from "./assembly.ts";
import type { BrowserAssemblyArgs } from "./browser-job-service.ts";
import { canvasToPngBlob, isCanvasTaintError } from "./canvas-save.ts";
import { canvasAllocationFailure, canvasSurfaceFailure } from "./plan-gates.ts";

/** Products place the canvas and save the Blob; the runtime owns its execution. */
export function createBrowserAssembly(
  deps: BrowserAssemblyArgs &
    Pick<CanvasAssemblyDeps, "limits" | "save" | "log" | "onDisplayOnly"> & {
      canvas(): HTMLCanvasElement;
      showCanvas?(canvas: HTMLCanvasElement): void;
    },
) {
  return createCanvasAssembly({
    ...deps,
    decode: (bytes) => deps.decoder.decode(bytes, deps.signal),
    disposeDecoder: () => deps.decoder.dispose(),
    createCanvas(width, height) {
      const element = deps.canvas();
      try {
        element.width = width;
        element.height = height;
      } catch {
        throw canvasAllocationFailure(width, height, deps.sourceUrl);
      }
      if (element.width !== width || element.height !== height)
        throw canvasAllocationFailure(width, height, deps.sourceUrl);
      const ctx2d = element.getContext("2d");
      if (!ctx2d) throw canvasSurfaceFailure(width, height, deps.sourceUrl);
      deps.showCanvas?.(element);
      return { width, height, ctx2d, element };
    },
    encode: (canvas, signal) => canvasToPngBlob(canvas.element, signal),
    isTaintError: isCanvasTaintError,
  });
}
